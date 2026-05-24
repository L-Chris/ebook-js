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
    createZipLoader,
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

describe('CBZ exporter', () => {
    beforeEach(() => {
        registry.unregister('epub')
        registry.unregister('cbz')
        exporterRegistry.unregister('test-format')
    })

    it('is registered in exporterRegistry by default', () => {
        expect(exporterRegistry.list()).toContain('cbz')
        expect(exporterRegistry.get('cbz')?.extension).toBe('.cbz')
        expect(exporterRegistry.get('cbz')?.mediaType).toBe('application/vnd.comicbook+zip')
    })

    it('exports CBZ image sections as image files in a zip', async () => {
        const input = await createTestCBZ({ title: 'Comic', pages: 3 })
        const book = await cbz().parse(input, parserOptions)

        const exported = await exportBook(book, firstSectionsSelection(2), { format: 'cbz' })
        expect(exported.size).toBeGreaterThan(0)
        expect(exported.type).toContain('zip')

        const loader = await createZipLoader(await exported.arrayBuffer())
        const imageEntries = loader.entries.filter(e =>
            /\.(jpg|jpeg|png|gif|webp|avif)$/i.test(e.filename),
        )
        expect(imageEntries).toHaveLength(2)
    })

    it('numbers output files with zero-padded page numbers', async () => {
        const input = await createTestCBZ({ pages: 3 })
        const book = await cbz().parse(input, parserOptions)

        const exported = await exportBook(book, firstSectionsSelection(3), { format: 'cbz' })
        const loader = await createZipLoader(await exported.arrayBuffer())
        const imageEntries = loader.entries
            .filter(e => /\.(jpg|png)$/i.test(e.filename))
            .map(e => e.filename)
            .sort()

        // All filenames should start with 'page' and have zero-padded numbers
        for (const name of imageEntries) {
            expect(name).toMatch(/^page\d{4}/)
        }
    })

    it('includes a ComicInfo.xml with book metadata', async () => {
        const input = await createTestEPUB({
            title: 'My Comic',
            chapters: [
                { id: 'ch1', title: 'Chapter 1', content: '<html><body><p>Text.</p></body></html>' },
            ],
        })
        const book = await epub().parse(input, parserOptions)

        const exported = await exportBook(book, firstSectionsSelection(1), { format: 'cbz' })
        const loader = await createZipLoader(await exported.arrayBuffer())
        const comicInfo = await loader.loadText('ComicInfo.xml')

        expect(comicInfo).toBeTruthy()
        expect(comicInfo).toContain('<ComicInfo')
        expect(comicInfo).toContain('My Comic')
    })

    it('exports EPUB text sections as text files when no images are present', async () => {
        const input = await createTestEPUB({
            chapters: [
                { id: 'ch1', title: 'Chapter 1', content: '<html><body><p>Hello text.</p></body></html>' },
                { id: 'ch2', title: 'Chapter 2', content: '<html><body><p>World text.</p></body></html>' },
            ],
        })
        const book = await epub().parse(input, parserOptions)

        const exported = await exportBook(book, firstSectionsSelection(2), { format: 'cbz' })
        const loader = await createZipLoader(await exported.arrayBuffer())
        const txtEntries = loader.entries.filter(e => e.filename.endsWith('.txt'))

        expect(txtEntries.length).toBeGreaterThanOrEqual(2)
        const content = await loader.loadText(txtEntries[0].filename)
        expect(content).toContain('Hello text.')
    })

    it('exports EPUB sections with embedded images as image files', async () => {
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

        const exported = await exportFirstSections(input, 1, { format: 'cbz', parserOptions })
        const loader = await createZipLoader(await exported.arrayBuffer())
        const imageEntries = loader.entries.filter(e =>
            /\.(jpg|jpeg|png|gif|webp|avif)$/i.test(e.filename),
        )

        expect(imageEntries.length).toBeGreaterThan(0)
    })

    it('exports FB2 sections to CBZ', async () => {
        const input = createTestFB2Buffer({
            sections: [
                { title: 'One', paragraphs: ['FB2 first.'] },
                { title: 'Two', paragraphs: ['FB2 second.'] },
            ],
        })
        const book = await fb2().parse(input, parserOptions)

        const exported = await exportBook(book, firstSectionsSelection(2), { format: 'cbz' })
        expect(exported.size).toBeGreaterThan(0)

        const loader = await createZipLoader(await exported.arrayBuffer())
        expect(loader.entries.length).toBeGreaterThan(0)
    })

    it('exports MOBI sections to CBZ', async () => {
        const input = createTestMOBI({
            sections: [
                { html: '<html><body><h1>One</h1><p>MOBI first.</p></body></html>' },
            ],
        })
        const book = await mobi().parse(input, parserOptions)

        const exported = await exportFirstSections(book, 1, { format: 'cbz' })
        expect(exported.size).toBeGreaterThan(0)
    })

    it('rejects invalid section counts', async () => {
        const input = await createTestCBZ({ pages: 2 })
        const book = await cbz().parse(input, parserOptions)

        await expect(exportBook(book, firstSectionsSelection(0), { format: 'cbz' })).rejects.toThrow('sectionCount')
    })

    it('respects the count limit when exporting fewer sections than available', async () => {
        const input = await createTestCBZ({ pages: 5 })
        const book = await cbz().parse(input, parserOptions)

        const exported = await exportBook(book, firstSectionsSelection(2), { format: 'cbz' })
        const loader = await createZipLoader(await exported.arrayBuffer())
        const imageEntries = loader.entries.filter(e =>
            /\.(jpg|jpeg|png|gif|webp)$/i.test(e.filename),
        )

        expect(imageEntries).toHaveLength(2)
    })

    it('canExport returns true for first-sections selection', () => {
        const exporter = exporterRegistry.get('cbz')!
        expect(exporter.canExport?.({} as never, { type: 'first-sections', count: 3 })).toBe(true)
    })
})
