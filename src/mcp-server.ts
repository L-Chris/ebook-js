#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod/v4'
import type { Book, Parser } from './core'
import { NodeDOMAdapter, NodeURLFactory } from './adapters/node'
import { EPUBParser } from './parsers/epub'
import { MOBIParser } from './parsers/mobi'
import { FB2Parser } from './parsers/fb2'
import { CBZParser } from './parsers/cbz'
import { getSectionSearchText, searchBook } from './search'

const SERVER_VERSION = '0.2.1'

export interface RebookMCPServerOptions {
    name?: string
    version?: string
    defaultMaxResults?: number
    maxChapterTextChars?: number
}

export async function createRebookMCPServer(
    book: Book,
    options: RebookMCPServerOptions = {},
): Promise<McpServer> {
    const server = new McpServer({
        name: options.name ?? 'rebook-mcp',
        version: options.version ?? SERVER_VERSION,
    })
    const defaultMaxResults = Math.max(1, Math.floor(options.defaultMaxResults ?? 20))
    const maxChapterTextChars = Math.max(1, Math.floor(options.maxChapterTextChars ?? 12_000))

    server.registerTool('list_chapters', {
        description: 'List the readable sections/chapters in the current e-book.',
        inputSchema: {},
    }, async () => {
        const chapters = book.sections.map((section, index) => ({
            index,
            id: section.id,
            title: getSectionTitle(book, index),
            size: section.size,
            linear: section.linear,
        }))
        return toolResult({ chapters })
    })

    server.registerTool('search_book', {
        description: 'Search the current e-book. Pass chapterIndex to search within one chapter.',
        inputSchema: {
            query: z.string().min(1).describe('Search query.'),
            chapterIndex: z.number().int().min(0).optional().describe('Optional section/chapter index to limit the search.'),
            maxResults: z.number().int().min(1).optional().describe('Maximum results to return.'),
            caseSensitive: z.boolean().optional().describe('Whether matching is case-sensitive.'),
            wholeWord: z.boolean().optional().describe('Whether to match whole words only.'),
        },
    }, async ({ query, chapterIndex, maxResults, caseSensitive, wholeWord }) => {
        const results = await searchBook(book, query, {
            scope: typeof chapterIndex === 'number' ? 'chapter' : 'book',
            chapterIndex,
            maxResults: maxResults ?? defaultMaxResults,
            caseSensitive,
            wholeWord,
        })
        return toolResult({
            query,
            results: results.map(result => ({
                sectionIndex: result.sectionIndex,
                sectionId: result.sectionId,
                chapterLabel: result.chapterLabel,
                matchIndex: result.matchIndex,
                start: result.start,
                end: result.end,
                excerpt: result.excerpt,
            })),
        })
    })

    server.registerTool('get_chapter_text', {
        description: 'Return readable text for one e-book chapter/section.',
        inputSchema: {
            chapterIndex: z.number().int().min(0).describe('Section/chapter index.'),
            maxChars: z.number().int().min(1).optional().describe('Maximum characters to return.'),
        },
    }, async ({ chapterIndex, maxChars }) => {
        const section = book.sections[chapterIndex]
        if (!section) throw new Error(`chapterIndex out of range: ${chapterIndex}`)
        const limit = Math.max(1, Math.floor(maxChars ?? maxChapterTextChars))
        const text = await getSectionSearchText(section)
        return toolResult({
            chapterIndex,
            id: section.id,
            title: getSectionTitle(book, chapterIndex),
            truncated: text.length > limit,
            text: text.slice(0, limit),
        })
    })

    return server
}

export async function openBookFile(filePath: string): Promise<Book> {
    const data = await readFile(filePath)
    const parser = getParserForPath(filePath)
    return parser.parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), {
        domAdapter: new NodeDOMAdapter(),
        urlFactory: new NodeURLFactory(),
    })
}

export async function runRebookMCPServer(argv = process.argv.slice(2)): Promise<void> {
    if (argv.includes('--help') || argv.includes('-h')) {
        printHelp()
        return
    }

    const filePath = argv.find(arg => !arg.startsWith('-'))
    if (!filePath) {
        printHelp()
        throw new Error('Missing e-book file path')
    }

    const book = await openBookFile(filePath)
    const server = await createRebookMCPServer(book, {
        name: `rebook-mcp:${basename(filePath)}`,
    })
    await server.connect(new StdioServerTransport())
    console.error(`rebook MCP server ready: ${filePath}`)
}

function getParserForPath(filePath: string): Parser {
    const lower = filePath.toLowerCase()
    if (lower.endsWith('.epub')) return new EPUBParser()
    if (lower.endsWith('.mobi') || lower.endsWith('.azw3')) return new MOBIParser()
    if (lower.endsWith('.fb2')) return new FB2Parser()
    if (lower.endsWith('.cbz') || lower.endsWith('.zip')) return new CBZParser()
    throw new Error(`Unsupported e-book format: ${filePath}`)
}

function getSectionTitle(book: Book, sectionIndex: number): string | undefined {
    const section = book.sections[sectionIndex]
    for (const item of flattenTOC(book.toc ?? [])) {
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

function toolResult(value: Record<string, unknown>) {
    return {
        content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
        structuredContent: value,
    }
}

function printHelp(): void {
    console.error(`Usage: rebook-mcp <ebook-file>

Start a stdio MCP server for one EPUB, MOBI/AZW3, FB2, or CBZ file.

Example MCP client config:
{
  "mcpServers": {
    "book": {
      "command": "npx",
      "args": ["-y", "--package", "rebook", "rebook-mcp", "/absolute/path/book.epub"]
    }
  }
}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runRebookMCPServer().catch(error => {
        console.error(error instanceof Error ? error.message : error)
        process.exit(1)
    })
}
