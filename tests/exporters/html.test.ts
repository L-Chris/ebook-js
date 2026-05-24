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

// Minimal 1x1 PNG bytes
const tinyPNG = new Uint8Array([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
    0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,
    0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
    0x00, 0x00, 0x03, 0x00, 0x01, 0x36, 0x28, 0x68,
    0x47, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E,
    0x44, 0xAE, 0x42, 0x60, 0x82,
])

describe('HTML exporter', () => {
    beforeEach(() => {
        registry.unregister('epub')
        registry.unregister('cbz')
        exporterRegistry.unregister('test-format')
    })

    it('is registered in exporterRegistry by default', () => {
        expect(exporterRegistry.list()).toContain('html')
        expect(exporterRegistry.get('html')?.extension).toBe('.html')
        expect(exporterRegistry.get('html')?.mediaType).toBe('text/html')
    })

    it('exports EPUB sections as a valid HTML document', async () => {
        const input = await createTestEPUB({
            title: 'Export Source',
            chapters: [
                { id: 'chapter1', title: 'Chapter 1', content: '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>One</h1><p>First.</p></body></html>' },
                { id: 'chapter2', title: 'Chapter 2', content: '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Two</h1><p>Second.</p></body></html>' },
                { id: 'chapter3', title: 'Chapter 3', content: '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Three</h1><p>Third.</p></body></html>' },
            ],
        })
        const book = await epub().parse(input, parserOptions)

        const exported = await exportBook(book, firstSectionsSelection(2), { format: 'html' })
        const html = await exported.text()

        expect(html).toContain('<!DOCTYPE html>')
        expect(html).toContain('<html')
        expect(html).toContain('<head>')
        expect(html).toContain('<body>')
        expect(html).toContain('First.')
        expect(html).toContain('Second.')
        expect(html).not.toContain('Third.')
    })

    it('includes a table of contents with links to sections', async () => {
        const input = await createTestEPUB({
            chapters: [
                { id: 'ch1', title: 'Introduction', content: '<html><body><p>Intro.</p></body></html>' },
                { id: 'ch2', title: 'Chapter One', content: '<html><body><p>Chapter.</p></body></html>' },
            ],
        })
        const book = await epub().parse(input, parserOptions)

        const exported = await exportBook(book, firstSectionsSelection(2), { format: 'html' })
        const html = await exported.text()

        expect(html).toContain('<nav')
        expect(html).toContain('Introduction')
        expect(html).toContain('Chapter One')
        // Links should point to section anchors
        expect(html).toMatch(/href="#section-\d+"/)
    })

    it('includes section anchor ids matching the TOC links', async () => {
        const input = await createTestEPUB({
            chapters: [
                { id: 'ch1', title: 'Chapter 1', content: '<html><body><p>Text.</p></body></html>' },
            ],
        })
        const book = await epub().parse(input, parserOptions)

        const exported = await exportBook(book, firstSectionsSelection(1), { format: 'html' })
        const html = await exported.text()

        // TOC href and section id must match
        const tocHrefMatch = /href="(#section-\d+)"/.exec(html)
        expect(tocHrefMatch).toBeTruthy()
        const sectionId = tocHrefMatch![1].slice(1) // remove '#'
        expect(html).toContain(`id="${sectionId}"`)
    })

    it('includes the book title in the <title> tag', async () => {
        const input = await createTestEPUB({
            title: 'My Exported Book',
            chapters: [
                { id: 'ch1', title: 'Chapter 1', content: '<html><body><p>Content.</p></body></html>' },
            ],
        })
        const book = await epub().parse(input, parserOptions)

        const exported = await exportBook(book, firstSectionsSelection(1), { format: 'html' })
        const html = await exported.text()

        expect(html).toMatch(/<title>[^<]*My Exported Book/)
    })

    it('sets the lang attribute from book metadata', async () => {
        const book = {
            metadata: { language: 'fr' },
            sections: [
                {
                    id: 'ch1',
                    size: 50,
                    format: 'xhtml' as const,
                    load: () => '<html><body><p>Bonjour.</p></body></html>',
                },
            ],
        }

        const exported = await exportFirstSections(book, 1, { format: 'html' })
        const html = await exported.text()

        expect(html).toContain('lang="fr"')
    })

    it('inlines embedded images as data URIs', async () => {
        registry.register('epub', epub)
        const input = await createTestEPUB({
            chapters: [
                {
                    id: 'chapter1',
                    title: 'Chapter 1',
                    content: '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter 1</h1><img src="images/pic.png" alt="pic"/></body></html>',
                },
            ],
            resources: [
                { id: 'pic', href: 'images/pic.png', mediaType: 'image/png', data: tinyPNG },
            ],
        })

        const exported = await exportFirstSections(input, 1, { format: 'html', parserOptions })
        const html = await exported.text()

        // The image should be inlined as a data URI
        expect(html).toMatch(/src="data:image\/png;base64,/)
        // The original test:// URL should not appear
        expect(html).not.toMatch(/src="test:\/\//)
    })

    it('wraps CBZ image sections in img tags', async () => {
        const input = await createTestCBZ({ title: 'Comic', pages: 2 })
        const book = await cbz().parse(input, parserOptions)

        const exported = await exportBook(book, firstSectionsSelection(2), { format: 'html' })
        const html = await exported.text()

        // CBZ pages should appear as img tags (may be data: or empty if no resource loaded)
        expect(html).toContain('<img')
    })

    it('exports FB2 sections as HTML', async () => {
        const input = createTestFB2Buffer({
            sections: [
                { title: 'One', paragraphs: ['FB2 first.'] },
                { title: 'Two', paragraphs: ['FB2 second.'] },
                { title: 'Three', paragraphs: ['FB2 third.'] },
            ],
        })
        const book = await fb2().parse(input, parserOptions)

        const exported = await exportBook(book, firstSectionsSelection(2), { format: 'html' })
        const html = await exported.text()

        expect(html).toContain('FB2 first.')
        expect(html).toContain('FB2 second.')
        expect(html).not.toContain('FB2 third.')
    })

    it('exports MOBI sections as HTML', async () => {
        const input = createTestMOBI({
            sections: [
                { html: '<html><body><h1>One</h1><p>MOBI first.</p></body></html>' },
                { html: '<html><body><h1>Two</h1><p>MOBI second.</p></body></html>' },
            ],
        })
        const book = await mobi().parse(input, parserOptions)

        const exported = await exportFirstSections(book, 1, { format: 'html' })
        const html = await exported.text()

        expect(html).toContain('MOBI first.')
        expect(html).not.toContain('MOBI second.')
    })

    it('exported blob has text/html MIME type', async () => {
        const book = {
            sections: [
                {
                    id: 'ch1',
                    size: 50,
                    format: 'xhtml' as const,
                    load: () => '<html><body><p>Content.</p></body></html>',
                },
            ],
        }

        const exported = await exportFirstSections(book, 1, { format: 'html' })
        expect(exported.type).toContain('text/html')
    })

    it('escapes special characters in titles and content', async () => {
        const book = {
            metadata: { title: 'Book & Title <Test>', author: 'Author "Name"' },
            sections: [
                {
                    id: 'ch1',
                    size: 50,
                    format: 'xhtml' as const,
                    load: () => '<html><body><p>Safe content.</p></body></html>',
                },
            ],
            toc: [
                { label: 'Chapter <1> & More', href: 'ch1' },
            ],
            resolveHref: (href: string) => ({ index: href === 'ch1' ? 0 : -1 }),
        }

        const exported = await exportFirstSections(book, 1, { format: 'html' })
        const html = await exported.text()

        // Should not have raw unescaped & or < in attributes/elements
        // The title should be escaped
        expect(html).toContain('&amp;')
        expect(html).toContain('&lt;')
    })

    it('rejects invalid section counts', async () => {
        const input = await createTestEPUB()
        const book = await epub().parse(input, parserOptions)

        await expect(exportBook(book, firstSectionsSelection(0), { format: 'html' })).rejects.toThrow('sectionCount')
    })

    it('handles books without metadata gracefully', async () => {
        const book = {
            sections: [
                {
                    id: 'ch1',
                    size: 50,
                    format: 'xhtml' as const,
                    load: () => '<html><body><p>No metadata content.</p></body></html>',
                },
            ],
        }

        const exported = await exportFirstSections(book, 1, { format: 'html' })
        const html = await exported.text()

        expect(html).toContain('<!DOCTYPE html>')
        expect(html).toContain('No metadata content.')
    })

    it('includes CSS styles for readable typography', async () => {
        const book = {
            sections: [
                {
                    id: 'ch1',
                    size: 50,
                    format: 'xhtml' as const,
                    load: () => '<html><body><p>Styled content.</p></body></html>',
                },
            ],
        }

        const exported = await exportFirstSections(book, 1, { format: 'html' })
        const html = await exported.text()

        expect(html).toContain('<style>')
        expect(html).toContain('font-family')
    })

    it('canExport returns true for first-sections selection', () => {
        const exporter = exporterRegistry.get('html')!
        expect(exporter.canExport?.({} as never, { type: 'first-sections', count: 3 })).toBe(true)
    })
})
