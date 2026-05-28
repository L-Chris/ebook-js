import type { Book } from './core/types'
import { getSectionSearchText, searchBook, type SearchOptions, type SearchResult } from './search'

type JSONSchema = Record<string, unknown>

export interface MCPToolDefinition<TArgs extends Record<string, unknown> = Record<string, unknown>, TResult = unknown> {
    name: string
    description: string
    inputSchema: JSONSchema
    handler(args: TArgs): Promise<TResult> | TResult
}

export interface MCPToolCallResult {
    content: Array<{ type: 'text'; text: string }>
    structuredContent?: unknown
}

export interface BookMCPOptions {
    /** Defaults to 20. */
    defaultMaxResults?: number
    /** Defaults to 100. */
    maxChapterTextChars?: number
}

export interface SearchBookToolArgs extends Record<string, unknown> {
    query?: string
    chapterIndex?: number
    maxResults?: number
    caseSensitive?: boolean
    wholeWord?: boolean
}

export interface GetChapterTextToolArgs extends Record<string, unknown> {
    chapterIndex?: number
    maxChars?: number
}

/**
 * Create Model Context Protocol style tools for a parsed Book. The returned
 * objects are SDK-agnostic: adapters can register `name`, `description`,
 * `inputSchema`, and call `handler(args)` from any MCP server implementation.
 */
export function createBookMCPTools(book: Book, options: BookMCPOptions = {}): MCPToolDefinition[] {
    const defaultMaxResults = Math.max(1, Math.floor(options.defaultMaxResults ?? 20))
    const maxChapterTextChars = Math.max(1, Math.floor(options.maxChapterTextChars ?? 12_000))

    return [
        {
            name: 'list_chapters',
            description: 'List the readable sections/chapters in the current e-book.',
            inputSchema: objectSchema({}),
            handler: () => toToolResult(book.sections.map((section, index) => ({
                index,
                id: section.id,
                title: getSectionTitle(book, index),
                size: section.size,
                linear: section.linear,
            }))),
        },
        {
            name: 'search_book',
            description: 'Search the current e-book. Pass chapterIndex to search within one chapter.',
            inputSchema: objectSchema({
                query: { type: 'string', description: 'Search query.' },
                chapterIndex: { type: 'number', description: 'Optional section/chapter index to limit the search.' },
                maxResults: { type: 'number', description: 'Maximum results to return.' },
                caseSensitive: { type: 'boolean', description: 'Whether matching is case-sensitive.' },
                wholeWord: { type: 'boolean', description: 'Whether to match whole words only.' },
            }, ['query']),
            handler: async (args: SearchBookToolArgs) => {
                const query = getRequiredString(args.query, 'query')
                const searchOptions: SearchOptions = {
                    maxResults: getPositiveInteger(args.maxResults, defaultMaxResults),
                    caseSensitive: args.caseSensitive === true,
                    wholeWord: args.wholeWord === true,
                }
                if (typeof args.chapterIndex === 'number') {
                    searchOptions.scope = 'chapter'
                    searchOptions.chapterIndex = args.chapterIndex
                }
                const results = await searchBook(book, query, searchOptions)
                return toToolResult({
                    query,
                    results: results.map(toMCPSearchResult),
                })
            },
        },
        {
            name: 'get_chapter_text',
            description: 'Return readable text for one e-book chapter/section.',
            inputSchema: objectSchema({
                chapterIndex: { type: 'number', description: 'Section/chapter index.' },
                maxChars: { type: 'number', description: 'Maximum characters to return.' },
            }, ['chapterIndex']),
            handler: async (args: GetChapterTextToolArgs) => {
                const chapterIndex = getChapterIndex(book, args.chapterIndex)
                const maxChars = getPositiveInteger(args.maxChars, maxChapterTextChars)
                const section = book.sections[chapterIndex]
                const text = await getSectionSearchText(section)
                return toToolResult({
                    chapterIndex,
                    id: section.id,
                    title: getSectionTitle(book, chapterIndex),
                    truncated: text.length > maxChars,
                    text: text.slice(0, maxChars),
                })
            },
        },
    ]
}

export async function callBookMCPTool(
    tools: readonly MCPToolDefinition[],
    name: string,
    args: Record<string, unknown> = {},
): Promise<MCPToolCallResult> {
    const tool = tools.find(item => item.name === name)
    if (!tool) throw new Error(`Unknown MCP tool: ${name}`)
    return tool.handler(args) as Promise<MCPToolCallResult>
}

function toMCPSearchResult(result: SearchResult) {
    return {
        sectionIndex: result.sectionIndex,
        sectionId: result.sectionId,
        chapterLabel: result.chapterLabel,
        matchIndex: result.matchIndex,
        start: result.start,
        end: result.end,
        excerpt: result.excerpt,
    }
}

function toToolResult(value: unknown): MCPToolCallResult {
    return {
        content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        structuredContent: value,
    }
}

function getSectionTitle(book: Book, sectionIndex: number): string | undefined {
    const section = book.sections[sectionIndex]
    const items = flattenTOC(book.toc ?? [])
    for (const item of items) {
        const resolved = book.resolveHref?.(item.href)
        if (resolved?.index === sectionIndex) return item.label
        const [id] = book.splitTOCHref?.(item.href) ?? [item.href]
        if (id === section.id) return item.label
    }
    return undefined
}

function flattenTOC(items: NonNullable<Book['toc']>): NonNullable<Book['toc']>[number][] {
    return items.flatMap(item => item.subitems?.length ? [item, ...flattenTOC(item.subitems)] : [item])
}

function objectSchema(properties: Record<string, JSONSchema>, required: string[] = []): JSONSchema {
    return {
        type: 'object',
        properties,
        required,
        additionalProperties: false,
    }
}

function getRequiredString(value: unknown, name: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing required string argument: ${name}`)
    return value
}

function getChapterIndex(book: Book, value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('chapterIndex must be a number')
    const index = Math.floor(value)
    if (index < 0 || index >= book.sections.length) throw new Error(`chapterIndex out of range: ${index}`)
    return index
}

function getPositiveInteger(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.max(1, Math.floor(value))
}
