import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { Book, TextBlock } from '../src/core/types'
import { searchBook, searchChapters } from '../src/search'
import { EPUBParser } from '../src/parsers/epub'
import { NodeDOMAdapter, NodeURLFactory } from '../src/adapters/node'

const makeBook = (): Book => {
    const blocks: TextBlock[][] = [
        [
            { id: 'c1-title', type: 'chapter', segments: [{ text: 'Chapter One' }] },
            { id: 'c1-body', type: 'paragraph', segments: [{ text: 'Alpha beta gamma. Alpha appears twice.' }] },
            {
                id: 'c1-note',
                type: 'paragraph',
                segments: [{
                    text: '\uFFFC',
                    source: {
                        nodeType: 'img',
                        attrs: {
                            src: 'note.png',
                            'data-rebook-footnote-content': 'Hidden alpha note',
                        },
                    },
                }],
            },
        ],
        [
            { id: 'c2-title', type: 'chapter', segments: [{ text: 'Chapter Two' }] },
            { id: 'c2-body', type: 'paragraph', segments: [{ text: 'Beta only appears here.' }] },
        ],
    ]

    return {
        sections: blocks.map((sectionBlocks, index) => ({
            id: `chapter-${index + 1}.xhtml`,
            size: 100,
            load: () => '',
            getBlocks: () => sectionBlocks,
        })),
        toc: [
            { label: 'One', href: 'chapter-1.xhtml' },
            { label: 'Two', href: 'chapter-2.xhtml' },
        ],
        resolveHref: href => ({ index: href.includes('chapter-2') ? 1 : 0 }),
    }
}

describe('searchBook', () => {
    it('searches full text across chapters with chapter metadata', async () => {
        const results = await searchBook(makeBook(), 'beta')

        expect(results).toHaveLength(2)
        expect(results.map(result => result.sectionIndex)).toEqual([0, 1])
        expect(results[0].chapterLabel).toBe('One')
        expect(results[1].chapterLabel).toBe('Two')
        expect(results[0].excerpt).toContain('Alpha beta gamma')
    })

    it('searches within a selected chapter', async () => {
        const results = await searchBook(makeBook(), 'alpha', {
            scope: 'chapter',
            chapterIndex: 0,
        })

        expect(results).toHaveLength(2)
        expect(results.every(result => result.sectionIndex === 0)).toBe(true)
    })

    it('does not search hidden footnote content extracted from inline markers', async () => {
        const results = await searchBook(makeBook(), 'Hidden alpha note')

        expect(results).toHaveLength(0)
    })
})

describe('searchChapters', () => {
    it('groups search results by chapter', async () => {
        const groups = await searchChapters(makeBook(), 'beta')

        expect(groups).toHaveLength(2)
        expect(groups[0].chapterLabel).toBe('One')
        expect(groups[0].results).toHaveLength(1)
        expect(groups[1].chapterLabel).toBe('Two')
    })
})

describe('searchBook with real EPUB content', () => {
    it('searches all sections and can limit results to one parsed chapter', async () => {
        const parser = new EPUBParser()
        const data = await readFile('data/归我们未来经济社会的行动指南.epub')
        const book = await parser.parse(data.buffer.slice(
            data.byteOffset,
            data.byteOffset + data.byteLength,
        ), {
            domAdapter: new NodeDOMAdapter(),
            urlFactory: new NodeURLFactory(),
        })

        const allResults = await searchBook(book, 'CabNet', { maxResults: 5 })
        const firstChapterResults = await searchBook(book, 'CabNet', {
            scope: 'chapter',
            chapterIndex: 1,
            maxResults: 5,
        })
        const secondChapterResults = await searchBook(book, 'CabNet', {
            scope: 'chapter',
            chapterIndex: 2,
            maxResults: 5,
        })

        expect(allResults.length).toBeGreaterThan(0)
        expect(allResults[0].chapterLabel).toBe('第一章 另一条路')
        expect(firstChapterResults.length).toBeGreaterThan(0)
        expect(firstChapterResults.every(result => result.sectionIndex === 1)).toBe(true)
        expect(secondChapterResults).toHaveLength(0)
    })
})
