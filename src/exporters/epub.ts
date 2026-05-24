import type { Book, BookMetadata, Contributor, LanguageMap, Section, TOCItem } from '../core/types'
import type { Exporter, ExportOptions, ExportSelection } from '../core/exporter'
import { selectSections } from './section-selection'

export type { ExportOptions, ExportSelection } from '../core/exporter'

interface ExportChapter {
    id: string
    href: string
    title: string
    content: string
}

interface ExportResource {
    href: string
    mediaType: string
    data: Uint8Array
}

interface ExportNavItem {
    label: string
    href: string
    subitems?: ExportNavItem[]
}

const MIME_EPUB = 'application/epub+zip'
const MIME_XHTML = 'application/xhtml+xml'

const containerXML = `<?xml version="1.0" encoding="UTF-8"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`

export class EPUBExporter implements Exporter {
    readonly format = 'epub'
    readonly mediaType = MIME_EPUB
    readonly extension = '.epub'

    canExport(_book: Book, selection: ExportSelection): boolean {
        return selection.type === 'first-pages' && (!selection.unit || selection.unit === 'section')
    }

    async exportBook(book: Book, selection: ExportSelection, options: ExportOptions = {}): Promise<Blob> {
        return createEPUB(book, selection, options)
    }
}

export const epubExporter = () => new EPUBExporter()

async function createEPUB(
    book: Book,
    selection: ExportSelection,
    options: ExportOptions = {},
): Promise<Blob> {
    const selected = selectSections(book, selection)
    const resources: ExportResource[] = []
    const resourceBySource = new Map<string, ExportResource>()
    const chapters: ExportChapter[] = []

    for (let i = 0; i < selected.length; i++) {
        const entry = selected[i]
        const chapterId = `page-${i + 1}`
        const chapterHref = `text/${chapterId}.xhtml`
        const section = entry.section

        if (section.format === 'image') {
            const image = await readImageSection(section, i)
            const title = entry.title ?? sectionTitleFromId(section) ?? `Image ${i + 1}`
            if (image) resources.push(image)
            chapters.push({
                id: chapterId,
                href: chapterHref,
                title,
                content: createImageXHTML(title, image?.href ?? String(await section.load()), i + 1),
            })
            continue
        }

        const html = await loadSectionDocument(section)
        const title = entry.title ?? extractDocumentTitle(html) ?? sectionTitleFromId(section) ?? `Section ${i + 1}`
        const content = await inlineReferencedResources(
            normalizeXHTML(html, title),
            resources,
            resourceBySource,
            options,
        )
        chapters.push({
            id: chapterId,
            href: chapterHref,
            title,
            content,
        })
    }

    return buildEPUB({
        title: options.title ?? buildExportTitle(book.metadata),
        identifier: options.identifier ?? buildIdentifier(book.metadata),
        language: normalizeLanguage(book.metadata?.language),
        author: stringifyContributor(book.metadata?.author),
        chapters,
        resources,
        navItems: createExportNavItems(book, selected, chapters),
    })
}

async function loadSectionDocument(section: Section): Promise<string> {
    const content = await section.load()
    return String(content)
}

async function inlineReferencedResources(
    html: string,
    resources: ExportResource[],
    resourceBySource: Map<string, ExportResource>,
    options: ExportOptions,
): Promise<string> {
    let result = await replaceResourceAttributes(html, /\s(src|poster|data)=["']([^"']+)["']/gi, resources, resourceBySource, options)
    result = await replaceResourceAttributes(result, /\s(?:xlink:)?href=["']([^"']+)["']/gi, resources, resourceBySource, options, 'href')
    return result
}

async function replaceResourceAttributes(
    html: string,
    regex: RegExp,
    resources: ExportResource[],
    resourceBySource: Map<string, ExportResource>,
    options: ExportOptions,
    fixedAttr?: string,
): Promise<string> {
    let result = ''
    let lastIndex = 0
    let match: RegExpExecArray | null

    while ((match = regex.exec(html)) !== null) {
        const attr = fixedAttr ?? match[1]
        const url = fixedAttr ? match[1] : match[2]
        result += html.slice(lastIndex, match.index)
        const resource = await getOrCreateReferencedResource(url, resources, resourceBySource, options)
        result += resource
            ? ` ${attr}="../${escapeAttr(resource.href)}"`
            : match[0]
        lastIndex = regex.lastIndex
    }

    return result + html.slice(lastIndex)
}

async function getOrCreateReferencedResource(
    url: string,
    resources: ExportResource[],
    resourceBySource: Map<string, ExportResource>,
    options: ExportOptions,
): Promise<ExportResource | null> {
    if (!shouldPackageResource(url)) return null
    const cached = resourceBySource.get(url)
    if (cached) return cached

    const loaded = await loadReferencedResource(url, options)
    if (!loaded) return null

    const extension = extensionFromMime(loaded.mimeType, url)
    const resource: ExportResource = {
        href: `images/resource-${resources.length + 1}${extension}`,
        mediaType: loaded.mimeType,
        data: loaded.bytes,
    }
    resources.push(resource)
    resourceBySource.set(url, resource)
    return resource
}

function shouldPackageResource(url: string): boolean {
    if (!url || url.startsWith('#')) return false
    if (/^(https?:|mailto:|tel:|filepos:)/i.test(url)) return false
    return /^(blob:|data:|test:)/i.test(url)
}

async function loadReferencedResource(url: string, options: ExportOptions): Promise<{ mimeType: string; bytes: Uint8Array } | null> {
    const data = parseDataURI(url)
    if (data) return data

    const urlFactory = options.parserOptions?.urlFactory as unknown as {
        getData?(url: string): { data: string | ArrayBuffer | Blob; mimeType: string } | undefined
    } | undefined
    const stored = urlFactory?.getData?.(url)
    if (stored) {
        return {
            mimeType: stored.mimeType,
            bytes: await toBytes(stored.data),
        }
    }

    if (typeof fetch !== 'function') return null
    try {
        const response = await fetch(url)
        if (!response.ok) return null
        const blob = await response.blob()
        return {
            mimeType: blob.type || response.headers.get('content-type') || getMimeTypeFromPath(url),
            bytes: await toBytes(blob),
        }
    } catch {
        return null
    }
}

async function toBytes(data: string | ArrayBuffer | Blob): Promise<Uint8Array> {
    if (typeof data === 'string') return new TextEncoder().encode(data)
    if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer())
    return new Uint8Array(data)
}

async function readImageSection(section: Section, index: number): Promise<ExportResource | null> {
    const src = String(await section.load())
    const data = parseDataURI(src)
    if (!data) return null
    const extension = extensionFromMime(data.mimeType)
    return {
        href: `images/page-${index + 1}${extension}`,
        mediaType: data.mimeType,
        data: data.bytes,
    }
}

function parseDataURI(src: string): { mimeType: string; bytes: Uint8Array } | null {
    const match = /^data:([^;,]+)?((?:;[^,]+)*),(.*)$/s.exec(src)
    if (!match) return null
    const mimeType = match[1] || 'application/octet-stream'
    const flags = match[2] || ''
    const data = match[3] || ''
    const bytes = flags.includes(';base64')
        ? decodeBase64(data)
        : new TextEncoder().encode(decodeURIComponent(data))
    return { mimeType, bytes }
}

function decodeBase64(base64: string): Uint8Array {
    if (typeof atob === 'function') {
        const binary = atob(base64)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        return bytes
    }
    const bufferCtor = (globalThis as unknown as { Buffer?: { from(value: string, encoding: string): Uint8Array } }).Buffer
    if (!bufferCtor) throw new Error('No base64 decoder available')
    return new Uint8Array(bufferCtor.from(base64, 'base64'))
}

function extensionFromMime(mimeType: string, path = ''): string {
    switch (mimeType) {
        case 'image/jpeg': return '.jpg'
        case 'image/png': return '.png'
        case 'image/gif': return '.gif'
        case 'image/webp': return '.webp'
        case 'image/svg+xml': return '.svg'
        case 'image/avif': return '.avif'
        default: return extensionFromPath(path) ?? '.bin'
    }
}

function extensionFromPath(path: string): string | null {
    const clean = path.split(/[?#]/)[0]
    const match = /\.(jpe?g|png|gif|webp|svg|avif|bmp)$/i.exec(clean)
    return match ? `.${match[1].toLowerCase().replace('jpeg', 'jpg')}` : null
}

function getMimeTypeFromPath(path: string): string {
    switch (extensionFromPath(path)) {
        case '.jpg': return 'image/jpeg'
        case '.png': return 'image/png'
        case '.gif': return 'image/gif'
        case '.webp': return 'image/webp'
        case '.svg': return 'image/svg+xml'
        case '.avif': return 'image/avif'
        case '.bmp': return 'image/bmp'
        default: return 'application/octet-stream'
    }
}

function normalizeXHTML(html: string, title: string): string {
    const trimmed = html.trim()
    const body = extractBody(trimmed)
    const content = body ?? trimmed
    return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${escapeXML(title)}</title></head>
<body>
${normalizeHTMLFragment(content)}
</body>
</html>`
}

function extractBody(html: string): string | null {
    const match = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)
    return match?.[1] ?? null
}

function extractDocumentTitle(html: string): string | null {
    const match = /<(?:title|h[1-6])\b[^>]*>([\s\S]*?)<\/(?:title|h[1-6])>/i.exec(html)
    const text = normalizeTitleText(match?.[1])
    return text || null
}

function sectionTitleFromId(section: Section): string | null {
    const id = String(section.id).split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '')
    const text = normalizeTitleText(id?.replace(/[-_]+/g, ' '))
    return text || null
}

function normalizeTitleText(value: string | undefined): string {
    if (!value) return ''
    return value
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/\s+/g, ' ')
        .trim()
}

function normalizeHTMLFragment(html: string): string {
    return html
        .replace(/<\?xml[^>]*>/gi, '')
        .replace(/<!DOCTYPE[^>]*>/gi, '')
        .replace(/<\/?html\b[^>]*>/gi, '')
        .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
        .replace(/<body\b[^>]*>/gi, '')
        .replace(/<\/body>/gi, '')
        .replace(
            /<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b([^<>]*?)(?<!\/)>/gi,
            '<$1$2/>',
        )
}

function createImageXHTML(title: string, src: string, pageNumber: number): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>${escapeXML(title)}</title>
  <style>html,body{margin:0;padding:0;}body{display:flex;align-items:center;justify-content:center;min-height:100vh;}img{max-width:100%;max-height:100vh;object-fit:contain;}</style>
</head>
<body>
  <img src="../${escapeAttr(src)}" alt="Page ${pageNumber}"/>
</body>
</html>`
}

async function buildEPUB(input: {
    title: string
    identifier: string
    language: string
    author?: string
    chapters: ExportChapter[]
    resources: ExportResource[]
    navItems: ExportNavItem[]
}): Promise<Blob> {
    const { configure, ZipWriter, BlobWriter, TextReader, Uint8ArrayReader } = await import('@zip.js/zip.js')
    configure({ useWebWorkers: false })

    const writer = new BlobWriter(MIME_EPUB)
    const zip = new ZipWriter(writer)

    await zip.add('mimetype', new TextReader(MIME_EPUB), { level: 0 })
    await zip.add('META-INF/container.xml', new TextReader(containerXML))
    await zip.add('OEBPS/content.opf', new TextReader(createOPF(input)))
    await zip.add('OEBPS/nav.xhtml', new TextReader(createNav(input.navItems, input.chapters)))

    for (const chapter of input.chapters) {
        await zip.add(`OEBPS/${chapter.href}`, new TextReader(chapter.content))
    }
    for (const resource of input.resources) {
        await zip.add(`OEBPS/${resource.href}`, new Uint8ArrayReader(resource.data))
    }

    await zip.close()
    return writer.getData()
}

function createOPF(input: {
    title: string
    identifier: string
    language: string
    author?: string
    chapters: ExportChapter[]
    resources: ExportResource[]
}): string {
    const author = input.author ? `    <dc:creator>${escapeXML(input.author)}</dc:creator>\n` : ''
    const manifestChapters = input.chapters.map(ch =>
        `    <item id="${escapeAttr(ch.id)}" href="${escapeAttr(ch.href)}" media-type="${MIME_XHTML}"/>`,
    ).join('\n')
    const manifestResources = input.resources.map((resource, index) =>
        `    <item id="resource-${index + 1}" href="${escapeAttr(resource.href)}" media-type="${escapeAttr(resource.mediaType)}"/>`,
    ).join('\n')
    const spine = input.chapters.map(ch => `    <itemref idref="${escapeAttr(ch.id)}"/>`).join('\n')

    return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="${escapeAttr(input.language)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">${escapeXML(input.identifier)}</dc:identifier>
    <dc:title>${escapeXML(input.title)}</dc:title>
${author}    <dc:language>${escapeXML(input.language)}</dc:language>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="${MIME_XHTML}" properties="nav"/>
${manifestChapters}
${manifestResources ? `${manifestResources}\n` : ''}  </manifest>
  <spine>
${spine}
  </spine>
</package>`
}

function createExportNavItems(
    book: Book,
    selected: readonly { sourceIndex: number }[],
    chapters: readonly ExportChapter[],
): ExportNavItem[] {
    const chapterHrefBySourceIndex = new Map<number, string>()
    selected.forEach((entry, index) => {
        const href = chapters[index]?.href
        if (href) chapterHrefBySourceIndex.set(entry.sourceIndex, href)
    })

    const fromOriginalTOC = filterTOCItems(book, book.toc ?? [], chapterHrefBySourceIndex)
    if (fromOriginalTOC.length > 0) return fromOriginalTOC

    return chapters.map(ch => ({
        label: ch.title,
        href: ch.href,
    }))
}

function filterTOCItems(
    book: Book,
    items: readonly TOCItem[],
    chapterHrefBySourceIndex: ReadonlyMap<number, string>,
): ExportNavItem[] {
    const result: ExportNavItem[] = []

    for (const item of items) {
        const subitems = filterTOCItems(book, item.subitems ?? [], chapterHrefBySourceIndex)
        const href = chapterHrefBySourceIndex.get(resolveTOCIndex(book, item.href))

        if (href) {
            result.push({
                label: item.label,
                href,
                ...(subitems.length > 0 ? { subitems } : {}),
            })
        } else {
            result.push(...subitems)
        }
    }

    return result
}

function resolveTOCIndex(book: Book, href: string): number {
    const resolved = book.resolveHref?.(href)
    if (resolved && resolved.index >= 0) return resolved.index

    const [id] = book.splitTOCHref?.(href) ?? href.split('#')
    const sectionId = String(id)
    return book.sections.findIndex(section => String(section.id) === sectionId || String(section.id) === decodeURI(sectionId))
}

function createNav(navItems: readonly ExportNavItem[], chapters: readonly ExportChapter[]): string {
    const items = renderNavItems(navItems, 3)
    const firstHref = chapters[0]?.href ?? 'nav.xhtml'

    return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Table of Contents</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Table of Contents</h1>
    <ol>
${items}
    </ol>
  </nav>
  <nav epub:type="landmarks">
    <h1>Landmarks</h1>
    <ol>
      <li><a epub:type="toc" href="nav.xhtml">Table of Contents</a></li>
      <li><a epub:type="bodymatter" href="${escapeAttr(firstHref)}">Begin Reading</a></li>
    </ol>
  </nav>
</body>
</html>`
}

function renderNavItems(items: readonly ExportNavItem[], depth: number): string {
    const indent = '  '.repeat(depth)
    const nestedIndent = '  '.repeat(depth + 1)
    return items.map(item => {
        const nested = item.subitems?.length
            ? `\n${nestedIndent}<ol>\n${renderNavItems(item.subitems, depth + 2)}\n${nestedIndent}</ol>\n${indent}`
            : ''
        return `${indent}<li><a href="${escapeAttr(item.href)}">${escapeXML(item.label)}</a>${nested}</li>`
    }).join('\n')
}

function buildExportTitle(metadata: BookMetadata | undefined): string {
    const title = stringifyLanguageMap(metadata?.title)
    return title ? `${title} - First Pages` : 'First Pages'
}

function buildIdentifier(metadata: BookMetadata | undefined): string {
    return `${metadata?.identifier ?? 'rebook-export'}-first-pages-${Date.now()}`
}

function stringifyLanguageMap(value: LanguageMap | undefined): string {
    if (!value) return ''
    if (typeof value === 'string') return value
    return value[Object.keys(value)[0]] ?? ''
}

function normalizeLanguage(value: string | string[] | undefined): string {
    if (Array.isArray(value)) return value[0] ?? 'und'
    return value || 'und'
}

function stringifyContributor(value: Contributor | readonly Contributor[] | undefined): string | undefined {
    if (!value) return undefined
    if (Array.isArray(value)) return (value as readonly Contributor[]).map(item => stringifyContributor(item)).filter(Boolean).join(', ')
    if (typeof value === 'string') return value
    return stringifyLanguageMap((value as Exclude<Contributor, string>).name)
}

function escapeXML(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
}

function escapeAttr(value: string): string {
    return escapeXML(value).replace(/"/g, '&quot;')
}
