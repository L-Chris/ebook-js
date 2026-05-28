import { describe, expect, it } from 'vitest'
import type { Book } from '../src/core/types'
import { callBookMCPTool, createBookMCPTools } from '../src/mcp'

const book: Book = {
    sections: [
        {
            id: 'one.xhtml',
            size: 100,
            load: () => '',
            getBlocks: () => [{ id: 'one-body', type: 'paragraph', segments: [{ text: 'First chapter searchable text.' }] }],
        },
        {
            id: 'two.xhtml',
            size: 80,
            load: () => '',
            getBlocks: () => [{ id: 'two-body', type: 'paragraph', segments: [{ text: 'Second chapter has another match.' }] }],
        },
    ],
    toc: [
        { label: 'First', href: 'one.xhtml' },
        { label: 'Second', href: 'two.xhtml' },
    ],
    resolveHref: href => ({ index: href === 'two.xhtml' ? 1 : 0 }),
}

describe('createBookMCPTools', () => {
    it('creates list, search, and chapter text tools', async () => {
        const tools = createBookMCPTools(book)

        expect(tools.map(tool => tool.name)).toEqual([
            'list_chapters',
            'search_book',
            'get_chapter_text',
        ])

        const chapters = await callBookMCPTool(tools, 'list_chapters')
        expect(chapters.structuredContent).toEqual([
            { index: 0, id: 'one.xhtml', title: 'First', size: 100 },
            { index: 1, id: 'two.xhtml', title: 'Second', size: 80 },
        ])
    })

    it('searches all chapters or one chapter through MCP handlers', async () => {
        const tools = createBookMCPTools(book)
        const all = await callBookMCPTool(tools, 'search_book', { query: 'chapter' })
        const one = await callBookMCPTool(tools, 'search_book', { query: 'chapter', chapterIndex: 1 })

        expect((all.structuredContent as { results: unknown[] }).results).toHaveLength(2)
        expect((one.structuredContent as { results: Array<{ sectionIndex: number }> }).results).toEqual([
            expect.objectContaining({ sectionIndex: 1 }),
        ])
    })

    it('returns truncated chapter text', async () => {
        const tools = createBookMCPTools(book)
        const result = await callBookMCPTool(tools, 'get_chapter_text', {
            chapterIndex: 0,
            maxChars: 5,
        })

        expect(result.structuredContent).toEqual({
            chapterIndex: 0,
            id: 'one.xhtml',
            title: 'First',
            truncated: true,
            text: 'First',
        })
    })
})
