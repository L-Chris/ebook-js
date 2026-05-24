import { readFile } from 'node:fs/promises'
import { describe, expect, it, beforeEach } from 'vitest'
import { createTestEPUB } from '../fixtures/epub-fixture'
import { createTestCBZ } from '../fixtures/cbz-fixture'
import { createTestFB2Buffer } from '../fixtures/fb2-fixture'
import { createTestMOBI } from '../fixtures/mobi-fixture'
import { TestDOMAdapter, TestURLFactory } from '../../src/adapters/test'
import type { Exporter } from '../../src'
import {
    cbz,
    epub,
    exportBook,
    exportBookAsBuffer,
    exporterRegistry,
    exportFirstSections,
    exportFirstSectionsAsBuffer,
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

describe('EPUB first-sections exporter', () => {
    beforeEach(() => {
        registry.unregister('epub')
        registry.unregister('cbz')
        exporterRegistry.unregister('test-format')
    })

    it('exposes a generic exporter registry for future output formats', async () => {
        const input = await createTestEPUB()
        const book = await epub().parse(input, parserOptions)
        const calls: string[] = []
        const testExporter: Exporter = {
            format: 'test-format',
            mediaType: 'text/plain',
            extension: '.txt',
            canExport: (_book, selection) => selection.type === 'first-sections',
            exportBook: async (_book, selection) => {
                calls.push(`${selection.type}:${selection.count}`)
                return new Blob([`format=${selection.type};count=${selection.count}`], { type: 'text/plain' })
            },
        }

        exporterRegistry.register('test-format', () => testExporter)
        const blob = await exportBook(book, firstSectionsSelection(2), { format: 'test-format' })

        expect(exporterRegistry.list()).toContain('test-format')
        expect(exporterRegistry.get('test-format')?.extension).toBe('.txt')
        expect(await blob.text()).toBe('format=first-sections;count=2')
        expect(calls).toEqual(['first-sections:2'])
    })

    it('exports the first N reflowable sections as a new EPUB', async () => {
        const input = await createTestEPUB({
            title: 'Export Source',
            chapters: [
                { id: 'chapter1', title: 'Chapter 1', content: '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>One</h1><p>First.</p></body></html>' },
                { id: 'chapter2', title: 'Chapter 2', content: '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Two</h1><p>Second.</p></body></html>' },
                { id: 'chapter3', title: 'Chapter 3', content: '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Three</h1><p>Third.</p></body></html>' },
            ],
        })
        const book = await epub().parse(input, parserOptions)

        const exported = await exportBook(book, firstSectionsSelection(2), { format: 'epub' })
        const parsed = await epub().parse(await exported.arrayBuffer(), parserOptions)

        expect(parsed.sections).toHaveLength(2)
        expect(parsed.toc?.map(item => item.label)).toEqual(['Chapter 1', 'Chapter 2'])
        const exportedTexts = await Promise.all(parsed.sections.map(section => section.loadText?.() ?? ''))
        expect(exportedTexts[0]).toContain('First.')
        expect(exportedTexts[1]).toContain('Second.')
        expect(exportedTexts.join('\n')).not.toContain('Third.')
    })

    it('uses document headings instead of generated Page labels when the source has no TOC', async () => {
        const book = {
            sections: [
                {
                    id: 'intro.xhtml',
                    size: 80,
                    format: 'xhtml' as const,
                    load: () => '<html><body><h1>Introduction</h1><p>Intro text.</p></body></html>',
                    createDocument: () => '<html><body><h1>Introduction</h1><p>Intro text.</p></body></html>',
                },
                {
                    id: 'chapter.xhtml',
                    size: 80,
                    format: 'xhtml' as const,
                    load: () => '<html><head><title>Main Chapter</title></head><body><p>Chapter text.</p></body></html>',
                    createDocument: () => '<html><head><title>Main Chapter</title></head><body><p>Chapter text.</p></body></html>',
                },
            ],
        }

        const exported = await exportFirstSections(book, 2, { format: 'epub' })
        const parsed = await epub().parse(await exported.arrayBuffer(), parserOptions)

        expect(parsed.toc?.map(item => item.label)).toEqual(['Introduction', 'Main Chapter'])
        expect(parsed.toc?.map(item => item.label).join('\n')).not.toMatch(/Page \d+/)
    })

    it('preserves the original TOC labels when exporting selected sections', async () => {
        const book = {
            sections: [
                {
                    id: 'intro.xhtml',
                    size: 80,
                    format: 'xhtml' as const,
                    load: () => '<html><body><h1>Generated Intro Heading</h1><p>Intro text.</p></body></html>',
                    createDocument: () => '<html><body><h1>Generated Intro Heading</h1><p>Intro text.</p></body></html>',
                },
                {
                    id: 'chapter.xhtml',
                    size: 80,
                    format: 'xhtml' as const,
                    load: () => '<html><body><h1>Generated Chapter Heading</h1><p>Chapter text.</p></body></html>',
                    createDocument: () => '<html><body><h1>Generated Chapter Heading</h1><p>Chapter text.</p></body></html>',
                },
                {
                    id: 'appendix.xhtml',
                    size: 80,
                    format: 'xhtml' as const,
                    load: () => '<html><body><h1>Appendix</h1><p>Appendix text.</p></body></html>',
                    createDocument: () => '<html><body><h1>Appendix</h1><p>Appendix text.</p></body></html>',
                },
            ],
            toc: [
                { label: 'Original Intro', href: 'intro.xhtml' },
                { label: 'Original Chapter', href: 'chapter.xhtml' },
                { label: 'Original Appendix', href: 'appendix.xhtml' },
            ],
            resolveHref: (href: string) => {
                const index = ['intro.xhtml', 'chapter.xhtml', 'appendix.xhtml'].indexOf(href)
                return index >= 0 ? { index } : null
            },
        }

        const exported = await exportFirstSections(book, 2, { format: 'epub' })
        const parsed = await epub().parse(await exported.arrayBuffer(), parserOptions)

        expect(parsed.toc?.map(item => item.label)).toEqual(['Original Intro', 'Original Chapter'])
        expect(parsed.toc?.map(item => item.label).join('\n')).not.toContain('Generated')
        expect(parsed.toc?.map(item => item.label).join('\n')).not.toMatch(/Page \d+/)
    })

    it('packages referenced images into the exported EPUB', async () => {
        registry.register('epub', epub)
        const input = await createTestEPUB({
            chapters: [
                {
                    id: 'chapter1',
                    title: 'Chapter 1',
                    content: '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter 1</h1><img src="images/pic.png" alt="pic"/><svg xmlns="http://www.w3.org/2000/svg"><image href="images/pic.png"/></svg></body></html>',
                },
            ],
            resources: [
                { id: 'pic', href: 'images/pic.png', mediaType: 'image/png', data: tinyPNG },
            ],
        })

        const exported = await exportFirstSections(input, 1, { parserOptions })
        const loader = await createZipLoader(await exported.arrayBuffer())
        const chapter = await loader.loadText('OEBPS/text/page-1.xhtml')
        const image = await loader.loadBlob('OEBPS/images/resource-1.png')
        const opf = await loader.loadText('OEBPS/content.opf')
        const parsed = await epub().parse(await exported.arrayBuffer(), parserOptions)
        const loaded = await parsed.sections[0].load()
        const blocks = await parsed.sections[0].getBlocks?.()
        const imageBlock = blocks?.find(block => block.type === 'image')

        expect(chapter).toContain('../images/resource-1.png')
        expect(chapter).not.toContain('test://')
        expect(image?.size).toBe(tinyPNG.byteLength)
        expect(opf).toContain('href="images/resource-1.png"')
        expect(opf).toContain('media-type="image/png"')
        expect(imageBlock?.image?.src.startsWith('test://resource-')).toBe(true)
        expect(imageBlock?.image?.src).not.toContain('images/resource-1.png')
        expect(imageBlock?.image?.originalSrc).toBe('OEBPS/images/resource-1.png')
        expect(loaded).not.toContain('href="../images/resource-1.png"')
        expect(loaded).toMatch(/<image[^>]+href="test:\/\/resource-/)
    })

    it('can parse a raw supported source through the registry before exporting', async () => {
        registry.register('epub', epub)
        const input = await createTestEPUB({
            chapters: [
                { id: 'chapter1', title: 'Chapter 1', content: '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Keep me.</p></body></html>' },
                { id: 'chapter2', title: 'Chapter 2', content: '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Drop me.</p></body></html>' },
            ],
        })

        const exported = await exportFirstSections(input, 1, { parserOptions })
        const parsed = await epub().parse(await exported.arrayBuffer(), parserOptions)

        expect(parsed.sections).toHaveLength(1)
        expect(await parsed.sections[0].loadText?.()).toContain('Keep me.')
    })

    it('exports the first N CBZ image sections as EPUB sections', async () => {
        const input = await createTestCBZ({ title: 'Comic', pages: 3 })
        const book = await cbz().parse(input, parserOptions)

        const exported = await exportBook(book, firstSectionsSelection(2), { format: 'epub' })
        const parsed = await epub().parse(await exported.arrayBuffer(), parserOptions)

        expect(parsed.sections).toHaveLength(2)
        expect(parsed.toc?.map(item => item.label)).toEqual(['page001.jpg', 'page002.jpg'])
        expect(await parsed.sections[0].loadText?.()).toContain('img')
    })

    it('exports the first N FB2 sections as EPUB sections', async () => {
        const input = createTestFB2Buffer({
            sections: [
                { title: 'One', paragraphs: ['FB2 first.'] },
                { title: 'Two', paragraphs: ['FB2 second.'] },
                { title: 'Three', paragraphs: ['FB2 third.'] },
            ],
        })
        const book = await fb2().parse(input, parserOptions)

        const exported = await exportBook(book, firstSectionsSelection(2), { format: 'epub' })
        const parsed = await epub().parse(await exported.arrayBuffer(), parserOptions)
        const exportedTexts = await Promise.all(parsed.sections.map(section => section.loadText?.() ?? ''))

        expect(parsed.sections).toHaveLength(2)
        expect(exportedTexts.join('\n')).toContain('FB2 first.')
        expect(exportedTexts.join('\n')).toContain('FB2 second.')
        expect(exportedTexts.join('\n')).not.toContain('FB2 third.')
    })

    it('exports the first N MOBI sections as EPUB sections', async () => {
        const input = createTestMOBI({
            sections: [
                { html: '<html><body><h1>One</h1><p>MOBI first.</p></body></html>' },
                { html: '<html><body><h1>Two</h1><p>MOBI second.</p></body></html>' },
            ],
        })
        const book = await mobi().parse(input, parserOptions)

        const exported = await exportFirstSections(book, 1, { format: 'epub' })
        const parsed = await epub().parse(await exported.arrayBuffer(), parserOptions)

        expect(parsed.sections).toHaveLength(1)
        expect(await parsed.sections[0].loadText?.()).toContain('MOBI first.')
    })

    it('keeps real MOBI/AZW3 exported images loadable after reopening the EPUB', async () => {
        registry.register('mobi', mobi)

        for (const filename of ['data/1.mobi', 'data/1.azw3']) {
            const data = await readFile(filename)
            const source = await mobi().parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), parserOptions)
            const exported = await exportFirstSections(source, 3, { format: 'epub', parserOptions })
            const loader = await createZipLoader(await exported.arrayBuffer())
            const imageEntries = loader.entries.filter(entry => entry.filename.startsWith('OEBPS/images/'))
            const parsed = await epub().parse(await exported.arrayBuffer(), parserOptions)
            const blocks = (await Promise.all(parsed.sections.map(section => section.getBlocks?.() ?? []))).flat()
            const imageSources = blocks
                .filter(block => block.type === 'image')
                .map(block => block.image?.src ?? '')

            expect(imageEntries.length, filename).toBeGreaterThan(0)
            expect(imageSources.length, filename).toBeGreaterThan(0)
            expect(imageSources.every(src => src.startsWith('test://resource-')), filename).toBe(true)
            expect(imageSources.some(src => /(?:^|\/)images\/resource-\d+/i.test(src)), filename).toBe(false)
        }
    })

    it('rejects invalid section counts', async () => {
        const input = await createTestEPUB()
        const book = await epub().parse(input, parserOptions)

        await expect(exportBook(book, firstSectionsSelection(0), { format: 'epub' })).rejects.toThrow('sectionCount')
    })

    it('exports through generic buffer helpers', async () => {
        const input = await createTestEPUB({
            chapters: [
                { id: 'chapter1', title: 'Chapter 1', content: '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Buffer one.</p></body></html>' },
                { id: 'chapter2', title: 'Chapter 2', content: '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Buffer two.</p></body></html>' },
            ],
        })
        const book = await epub().parse(input, parserOptions)

        const viaBook = await exportBookAsBuffer(book, firstSectionsSelection(1), { format: 'epub' })
        const viaSource = await exportFirstSectionsAsBuffer(book, 1, { format: 'epub' })

        expect(viaBook.byteLength).toBeGreaterThan(0)
        expect(viaSource.byteLength).toBeGreaterThan(0)
    })
})
