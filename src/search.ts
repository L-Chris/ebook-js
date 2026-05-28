import type { Book, Section, TextBlock, TextSegment, TOCItem } from './core/types'

export type SearchScope = 'book' | 'chapter'

export interface SearchOptions {
    /** Search all chapters or a selected chapter. Defaults to 'book'. */
    scope?: SearchScope
    /** Chapter/section index used when scope is 'chapter'. */
    chapterIndex?: number
    /** Search only these section indexes. Overrides scope/chapterIndex. */
    sectionIndexes?: readonly number[]
    /** Defaults to false. */
    caseSensitive?: boolean
    /** Match whole words only. Defaults to false. */
    wholeWord?: boolean
    /** Maximum result count. Defaults to 100. */
    maxResults?: number
    /** Number of context characters on each side. Defaults to 48. */
    contextChars?: number
}

export interface SearchResult {
    query: string
    sectionIndex: number
    sectionId: string | number
    chapterLabel?: string
    matchIndex: number
    start: number
    end: number
    excerpt: string
    before: string
    match: string
    after: string
}

export interface ChapterSearchResult {
    sectionIndex: number
    sectionId: string | number
    chapterLabel?: string
    results: SearchResult[]
}

interface SectionText {
    sectionIndex: number
    section: Section
    chapterLabel?: string
    text: string
}

/**
 * Search a book's readable text. By default this scans every section; pass
 * `{ scope: 'chapter', chapterIndex }` to search a single chapter.
 */
export async function searchBook(
    book: Book,
    query: string,
    options: SearchOptions = {},
): Promise<SearchResult[]> {
    const normalizedQuery = options.caseSensitive ? query : query.toLocaleLowerCase()
    if (!normalizedQuery) return []

    const maxResults = Math.max(0, Math.floor(options.maxResults ?? 100))
    if (maxResults === 0) return []

    const sections = await getSearchableSections(book, options)
    const results: SearchResult[] = []

    for (const item of sections) {
        const haystack = options.caseSensitive ? item.text : item.text.toLocaleLowerCase()
        let fromIndex = 0
        let matchIndex = 0

        while (results.length < maxResults) {
            const index = haystack.indexOf(normalizedQuery, fromIndex)
            if (index < 0) break
            const end = index + query.length
            fromIndex = Math.max(index + 1, end)

            if (options.wholeWord && !isWholeWordMatch(item.text, index, end)) continue

            results.push(createSearchResult(item, query, index, end, matchIndex++, options.contextChars ?? 48))
        }

        if (results.length >= maxResults) break
    }

    return results
}

/**
 * Search every chapter and return grouped results. This is useful for chapter
 * search UIs that show a chapter list with per-chapter matches.
 */
export async function searchChapters(
    book: Book,
    query: string,
    options: Omit<SearchOptions, 'scope' | 'chapterIndex' | 'sectionIndexes'> = {},
): Promise<ChapterSearchResult[]> {
    const groups: ChapterSearchResult[] = []

    for (let sectionIndex = 0; sectionIndex < book.sections.length; sectionIndex++) {
        const results = await searchBook(book, query, {
            ...options,
            scope: 'chapter',
            chapterIndex: sectionIndex,
        })
        if (!results.length) continue
        const section = book.sections[sectionIndex]
        groups.push({
            sectionIndex,
            sectionId: section.id,
            chapterLabel: getChapterLabel(book, sectionIndex, section),
            results,
        })
    }

    return groups
}

export async function getSectionSearchText(section: Section): Promise<string> {
    if (section.getBlocks) return blocksToText(await section.getBlocks())
    if (section.getSegments) return segmentsToText(await section.getSegments())
    if (section.getDocument) {
        const document = await section.getDocument()
        if (document) return normalizeSearchText(document.getText())
    }
    if (section.loadText) return normalizeSearchText(await section.loadText())
    if (section.format === 'image') return ''
    return htmlToText(await section.load())
}

function createSearchResult(
    item: SectionText,
    query: string,
    start: number,
    end: number,
    matchIndex: number,
    contextChars: number,
): SearchResult {
    const contextStart = Math.max(0, start - Math.max(0, contextChars))
    const contextEnd = Math.min(item.text.length, end + Math.max(0, contextChars))
    const before = item.text.slice(contextStart, start)
    const match = item.text.slice(start, end)
    const after = item.text.slice(end, contextEnd)

    return {
        query,
        sectionIndex: item.sectionIndex,
        sectionId: item.section.id,
        chapterLabel: item.chapterLabel,
        matchIndex,
        start,
        end,
        before,
        match,
        after,
        excerpt: `${contextStart > 0 ? '...' : ''}${before}${match}${after}${contextEnd < item.text.length ? '...' : ''}`,
    }
}

async function getSearchableSections(book: Book, options: SearchOptions): Promise<SectionText[]> {
    const indexes = getSectionIndexes(book, options)
    return Promise.all(indexes.map(async sectionIndex => {
        const section = book.sections[sectionIndex]
        return {
            sectionIndex,
            section,
            chapterLabel: getChapterLabel(book, sectionIndex, section),
            text: await getSectionSearchText(section),
        }
    }))
}

function getSectionIndexes(book: Book, options: SearchOptions): number[] {
    if (options.sectionIndexes) return uniqueValidIndexes(book, options.sectionIndexes)
    if (options.scope === 'chapter') return uniqueValidIndexes(book, [options.chapterIndex ?? 0])
    return book.sections.map((_, index) => index)
}

function uniqueValidIndexes(book: Book, indexes: readonly number[]): number[] {
    return [...new Set(indexes)]
        .map(index => Math.floor(index))
        .filter(index => index >= 0 && index < book.sections.length)
}

function getChapterLabel(book: Book, sectionIndex: number, section: Section): string | undefined {
    const tocItem = findTOCItemForSection(book, sectionIndex, section)
    return tocItem?.label
}

function findTOCItemForSection(book: Book, sectionIndex: number, section: Section): TOCItem | null {
    const items = flattenTOC(book.toc ?? [])
    if (!items.length) return null

    for (const item of items) {
        const resolved = book.resolveHref?.(item.href)
        if (resolved?.index === sectionIndex) return item
        const [id] = book.splitTOCHref?.(item.href) ?? [item.href]
        if (id === section.id) return item
    }

    return null
}

function flattenTOC(items: readonly TOCItem[]): TOCItem[] {
    return items.flatMap(item => item.subitems?.length ? [item, ...flattenTOC(item.subitems)] : [item])
}

function blocksToText(blocks: readonly TextBlock[]): string {
    return normalizeSearchText(blocks.map(block => {
        if (block.type === 'image') return block.image?.alt ?? block.image?.title ?? ''
        if (block.type === 'table') return block.table?.rows
            .flatMap(row => row.cells.map(cell => cell.text))
            .join(' ') ?? ''
        return segmentsToText(block.segments)
    }).filter(Boolean).join('\n'))
}

function segmentsToText(segments: readonly TextSegment[]): string {
    return normalizeSearchText(segments
        .filter(segment => segment.source?.nodeType !== 'img')
        .map(segment => segment.text)
        .join(''))
}

function htmlToText(html: string): string {
    return normalizeSearchText(html
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'"))
}

function normalizeSearchText(value: string): string {
    return value.replace(/\s+/g, ' ').trim()
}

function isWholeWordMatch(text: string, start: number, end: number): boolean {
    return !isWordCharacter(text[start - 1]) && !isWordCharacter(text[end])
}

function isWordCharacter(value: string | undefined): boolean {
    return Boolean(value && /[\p{L}\p{N}_]/u.test(value))
}
