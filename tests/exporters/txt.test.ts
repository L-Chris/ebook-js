import { describe, expect, it, beforeEach } from 'vitest'
import { createTestEPUB } from '../fixtures/epub-fixture'
import { createTestCBZ } from '../fixtures/cbz-fixture'
import { createTestFB2Buffer } from '../fixtures/fb2-fixture'
import { createTestMOBI } from '../fixtures/mobi-fixture'
import { TestDOMAdapter, TestURLFactory } from '../../src/adapters/test'
import {
    cbz,
    epub,
    exportBook,
    exporterRegistry,
    exportFirstSections,
    fb2,
    firstSectionsSelection,
    mobi,
    registry,
} from '../../src'

const parserOptions = {
    domAdapter: new TestDOMAdapter(),
    urlFactory: new TestURLFactory(),
}

describe('TXT exporter', () => {
    beforeEach(() => {
        registry.unregister('epub')
        registry.unregister('cbz')
        exporterRegistry.unregister('test-format')
    })

    it('is registered in exporterRegistry by default', () => {
        expect(exporterRegistry.list()).toContain('txt')
        expect(exporterRegistry.get('txt')?.extension).toBe('.txt')
        expect(exporterRegistry.get('txt')?.mediaType).toBe('text/plain')
    })

    it('exports EPUB text sections as plain text', async () => {
        const input = await createTestEPUB({
            title: 'Export Source',
            chapters: [
                { id: 'chapter1', title: 'Chapter 1', content: '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>One</h1><p>First paragraph.</p></body></html>' },
                { id: 'chapter2', title: 'Chapter 2', content: '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Two</h1><p>Second paragraph.</p></body></html>' },
                { id: 'chapter3', title: 'Chapter 3', content: '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Three</h1><p>Third paragraph.</p></body></html>' },
            ],
        })
        const book = await epub().parse(input, parserOptions)

        const exported = await exportBook(book, firstSectionsSelection(2), { format: 'txt' })
        const text = await exported.text()

        expect(text).toContain('First paragraph.')
        expect(text).toContain('Second paragraph.')
        expect(text).not.toContain('Third paragraph.')
    })

    it('includes a book header with title and author', async () => {
        const input = await createTestEPUB({
            title: 'My Book',
            chapters: [
                { id: 'ch1', title: 'Chapter 1', content: '<html><body><p>Content.</p></body></html>' },
            ],
        })
        const book = await epub().parse(input, parserOptions)

        const exported = await exportBook(book, firstSectionsSelection(1), { format: 'txt' })
        const text = await exported.text()

        expect(text).toContain('My Book')
    })

    it('includes chapter titles as section headers', async () => {
        const input = await createTestEPUB({
            chapters: [
                { id: 'intro', title: 'Introduction', content: '<html><body><h1>Introduction</h1><p>Intro text.</p></body></html>' },
            ],
        })
        const book = await epub().parse(input, parserOptions)

        const exported = await exportBook(book, firstSectionsSelection(1), { format: 'txt' })
        const text = await exported.text()

        expect(text).toContain('Introduction')
        expect(text).toContain('Intro text.')
    })

    it('emits image section placeholders for CBZ image pages', async () => {
        const input = await createTestCBZ({ title: 'Comic', pages: 2 })
        const book = await cbz().parse(input, parserOptions)

        const exported = await exportBook(book, firstSectionsSelection(2), { format: 'txt' })
        const text = await exported.text()

        // Image sections should produce some placeholder output, not be empty
        expect(text.trim().length).toBeGreaterThan(0)
    })

    it('strips HTML tags from section content', async () => {
        const book = {
            sections: [
                {
                    id: 'ch1',
                    size: 100,
                    format: 'xhtml' as const,
                    load: () => '<html><body><h1>Title</h1><p>Plain <strong>bold</strong> text.</p></body></html>',
                },
            ],
        }

        const exported = await exportFirstSections(book, 1, { format: 'txt' })
        const text = await exported.text()

        expect(text).toContain('Plain')
        expect(text).toContain('bold')
        expect(text).toContain('text.')
        expect(text).not.toContain('<strong>')
        expect(text).not.toContain('<h1>')
    })

    it('exports FB2 sections as plain text', async () => {
        const input = createTestFB2Buffer({
            sections: [
                { title: 'One', paragraphs: ['FB2 first.'] },
                { title: 'Two', paragraphs: ['FB2 second.'] },
                { title: 'Three', paragraphs: ['FB2 third.'] },
            ],
        })
        const book = await fb2().parse(input, parserOptions)

        const exported = await exportBook(book, firstSectionsSelection(2), { format: 'txt' })
        const text = await exported.text()

        expect(text).toContain('FB2 first.')
        expect(text).toContain('FB2 second.')
        expect(text).not.toContain('FB2 third.')
    })

    it('exports MOBI sections as plain text', async () => {
        const input = createTestMOBI({
            sections: [
                { html: '<html><body><h1>One</h1><p>MOBI first.</p></body></html>' },
                { html: '<html><body><h1>Two</h1><p>MOBI second.</p></body></html>' },
            ],
        })
        const book = await mobi().parse(input, parserOptions)

        const exported = await exportFirstSections(book, 1, { format: 'txt' })
        const text = await exported.text()

        expect(text).toContain('MOBI first.')
        expect(text).not.toContain('MOBI second.')
    })

    it('exported blob has text/plain MIME type', async () => {
        const book = {
            sections: [
                {
                    id: 'ch1',
                    size: 50,
                    format: 'xhtml' as const,
                    load: () => '<html><body><p>Text.</p></body></html>',
                },
            ],
        }

        const exported = await exportFirstSections(book, 1, { format: 'txt' })
        expect(exported.type).toContain('text/plain')
    })

    it('rejects invalid section counts', async () => {
        const input = await createTestEPUB()
        const book = await epub().parse(input, parserOptions)

        await expect(exportBook(book, firstSectionsSelection(0), { format: 'txt' })).rejects.toThrow('sectionCount')
    })

    it('uses loadText() when available for text extraction', async () => {
        const loadTextCalls: string[] = []
        const book = {
            sections: [
                {
                    id: 'ch1',
                    size: 50,
                    format: 'xhtml' as const,
                    load: () => '<html><body><p>Raw HTML.</p></body></html>',
                    loadText: () => {
                        loadTextCalls.push('called')
                        return 'Extracted plain text.'
                    },
                },
            ],
        }

        const exported = await exportFirstSections(book, 1, { format: 'txt' })
        const text = await exported.text()

        expect(loadTextCalls).toContain('called')
        expect(text).toContain('Extracted plain text.')
    })

    it('handles books without metadata gracefully', async () => {
        const book = {
            sections: [
                {
                    id: 'ch1',
                    size: 50,
                    format: 'xhtml' as const,
                    load: () => '<html><body><p>Content here.</p></body></html>',
                },
            ],
        }

        const exported = await exportFirstSections(book, 1, { format: 'txt' })
        const text = await exported.text()

        expect(text).toContain('Content here.')
    })

    it('canExport returns true for first-sections selection', () => {
        const exporter = exporterRegistry.get('txt')!
        expect(exporter.canExport?.({} as never, { type: 'first-sections', count: 3 })).toBe(true)
    })
})
