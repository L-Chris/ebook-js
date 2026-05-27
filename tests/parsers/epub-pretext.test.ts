import { readFile } from 'node:fs/promises'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { EPUBParser } from '../../src/parsers/epub'
import { NodeDOMAdapter, NodeURLFactory } from '../../src/adapters/node'
import { layout, prepare, prepareBlocks, type TextSegment } from '../../src/core/pretext'
import { createTestEPUB } from '../fixtures/epub-fixture'

beforeAll(() => {
    vi.stubGlobal('OffscreenCanvas', class {
        getContext() {
            return {
                font: '16px serif',
                measureText(text: string) {
                    const fontSize = Number(this.font.match(/([\d.]+)px/)?.[1] ?? 16)
                    const width = Array.from(text).reduce((sum, char) => {
                        if (char === ' ') return sum + fontSize * 0.32
                        if (/[\u4e00-\u9fff]/.test(char)) return sum + fontSize
                        return sum + fontSize * 0.54
                    }, 0)
                    return { width }
                },
            }
        }
    })
})

describe('EPUB Pretext segments', () => {
    it('exposes styled segments on EPUB sections', async () => {
        const parser = new EPUBParser()
        const book = await parser.parse(await createTestEPUB({
            chapters: [{
                id: 'styled',
                title: 'Styled',
                content: '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Plain <strong>bold</strong> <em style="color: red">red</em></p></body></html>',
            }],
        }), {
            domAdapter: new NodeDOMAdapter(),
            urlFactory: new NodeURLFactory(),
        })

        const segments = await book.sections[0].getSegments?.()
        expect(segments).toBeDefined()
        expect(segments?.map(segment => segment.text).join('')).toBe('Plain bold red')
        expect(segments?.some(segment => segment.style?.fontWeight === '700')).toBe(true)
        expect(segments?.some(segment => segment.style?.color === 'red')).toBe(true)

        const blocks = await book.sections[0].getBlocks?.()
        expect(blocks?.map(block => block.type)).toEqual(['paragraph'])
        expect(blocks?.[0].segments.some(segment => segment.style?.fontWeight === '700')).toBe(true)
    })

    it('rewrites inline style elements without adapter textContent errors', async () => {
        const parser = new EPUBParser()
        const book = await parser.parse(await createTestEPUB({
            chapters: [{
                id: 'styled-css',
                title: 'Styled CSS',
                content: '<html xmlns="http://www.w3.org/1999/xhtml"><head><style>body { background-image: url("images/bg.png"); }</style></head><body><p>Hello</p></body></html>',
            }],
            resources: [{
                id: 'bg-image',
                href: 'images/bg.png',
                mediaType: 'image/png',
                data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
            }],
        }), {
            domAdapter: new NodeDOMAdapter(),
            urlFactory: new NodeURLFactory(),
        })

        const html = await book.sections[0].load()

        expect(html).toContain('background-image: url("test://resource-')
    })

    it('can prepare and layout a real EPUB from data/', async () => {
        const parser = new EPUBParser()
        const data = await readFile('data/1.epub')
        const book = await parser.parse(data.buffer.slice(
            data.byteOffset,
            data.byteOffset + data.byteLength,
        ), {
            domAdapter: new NodeDOMAdapter(),
            urlFactory: new NodeURLFactory(),
        })

        let segments: TextSegment[] = []
        for (const section of book.sections) {
            const candidate = await section.getSegments?.()
            if (candidate?.some(segment => segment.text.trim())) {
                segments = candidate
                break
            }
        }
        expect(segments?.length).toBeGreaterThan(0)

        const prepared = prepare(segments!, { baseStyle: { fontSize: 16, lineHeight: 1.5 } })
        const lines = layout(prepared, { inlineSize: 360 })

        expect(prepared.blocks.length).toBeGreaterThan(0)
        expect(lines.length).toBeGreaterThan(0)
        expect(lines[0].segments.length).toBeGreaterThan(0)
        expect(lines.every(line => line.width <= 360 || line.segments.length === 1)).toBe(true)
    })

    it('loads text blocks from data/4.epub', async () => {
        const parser = new EPUBParser()
        const data = await readFile('data/4.epub')
        const book = await parser.parse(data.buffer.slice(
            data.byteOffset,
            data.byteOffset + data.byteLength,
        ), {
            domAdapter: new NodeDOMAdapter(),
            urlFactory: new NodeURLFactory(),
        })

        let blockCount = 0
        for (const section of book.sections) {
            const blocks = await section.getBlocks?.()
            blockCount += blocks?.length ?? 0
        }

        expect(blockCount).toBeGreaterThan(0)
    })

    it('extracts tables and figure blocks from The Accidental Taxonomist', async () => {
        const parser = new EPUBParser()
        const data = await readFile('data/The Accidental Taxonomist.epub')
        const book = await parser.parse(data.buffer.slice(
            data.byteOffset,
            data.byteOffset + data.byteLength,
        ), {
            domAdapter: new NodeDOMAdapter(),
            urlFactory: new NodeURLFactory(),
        })

        const chapter1 = book.sections.find(section => String(section.id).endsWith('Chapter01.xhtml'))
        const figuresAndTables = book.sections.find(section => String(section.id).endsWith('List.xhtml'))
        expect(chapter1).toBeDefined()
        expect(figuresAndTables).toBeDefined()

        const chapterBlocks = await chapter1!.getBlocks?.()
        const listBlocks = await figuresAndTables!.getBlocks?.()
        const chapterTableRows = chapterBlocks?.filter(block => block.type === 'table') ?? []
        const listTableRows = listBlocks?.filter(block => block.type === 'table') ?? []
        const chapterImages = chapterBlocks?.filter(block => block.type === 'image') ?? []

        expect(chapterTableRows.length).toBeGreaterThan(5)
        expect(chapterTableRows[0].table?.columnCount).toBe(4)
        expect(chapterTableRows[0].table?.columnWeights).toEqual([25, 25, 25, 25])
        expect(chapterTableRows[0].table?.rows[0]?.cells.map(cell => cell.text)).toEqual([
            'Year',
            '“taxonomies” in article titles',
            '“taxonomies” in article text',
            '“controlled vocabularies” Subject',
        ])

        expect(listTableRows.length).toBeGreaterThan(20)
        expect(listTableRows[0].table?.columnCount).toBe(2)
        expect(listTableRows[0].table?.columnWeights).toEqual([20, 80])
        expect(listTableRows[0].table?.rows[0]?.cells.map(cell => cell.text)).toEqual([
            'Figure 1.1',
            'Terms in a synonym ring',
        ])

        const alphaNumericImage = chapterImages.find(block => block.image?.originalSrc?.endsWith('f0011-01.jpg'))
        expect(alphaNumericImage?.image?.width).toBe(297)
        expect(alphaNumericImage?.image?.height).toBe(330)

        const prepared = prepareBlocks([
            ...chapterTableRows.slice(0, 2),
            alphaNumericImage!,
        ], { baseStyle: { fontSize: 16, lineHeight: 1.5 } })
        const lines = layout(prepared, { inlineSize: 360, maxBlockHeight: 420 })
        expect(lines.some(line => line.kind === 'table')).toBe(true)
        expect(lines.some(line => line.kind === 'image')).toBe(true)
        expect(lines.every(line => (line.top % 420) + line.height <= 420)).toBe(true)
    })

    it('exposes image blocks with renderable URLs and cover hints', async () => {
        const parser = new EPUBParser()
        const urlFactory = new NodeURLFactory()
        const book = await parser.parse(await createTestEPUB({
            chapters: [{
                id: 'cover',
                title: 'Cover',
                content: '<html xmlns="http://www.w3.org/1999/xhtml"><body><p><img src="images/cover.png" alt="Cover image" width="600" height="900" style="max-width: 320px; object-fit: contain"/></p></body></html>',
            }],
            resources: [{
                id: 'cover-image',
                href: 'images/cover.png',
                mediaType: 'image/png',
                properties: 'cover-image',
                data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
            }],
        }), {
            domAdapter: new NodeDOMAdapter(),
            urlFactory,
        })

        const blocks = await book.sections[0].getBlocks?.()
        const image = blocks?.find(block => block.type === 'image')

        expect(image?.image?.src.startsWith('test://resource-')).toBe(true)
        expect(image?.image?.originalSrc).toBe('OEBPS/images/cover.png')
        expect(image?.image?.isCover).toBe(true)
        expect(image?.image?.alt).toBe('Cover image')
        expect(image?.image?.width).toBe(600)
        expect(image?.image?.height).toBe(900)
        expect(image?.image?.style?.maxWidth).toBe(320)
        expect(urlFactory.hasURL(image!.image!.src)).toBe(true)
    })

    it('does not promote footnote marker images from Gui Women to block images', async () => {
        const parser = new EPUBParser()
        const data = await readFile('data/归我们未来经济社会的行动指南.epub')
        const book = await parser.parse(data.buffer.slice(
            data.byteOffset,
            data.byteOffset + data.byteLength,
        ), {
            domAdapter: new NodeDOMAdapter(),
            urlFactory: new NodeURLFactory(),
        })

        const firstChapter = book.sections.find(section => String(section.id).endsWith('Section0002.xhtml'))
        expect(firstChapter).toBeDefined()

        const blocks = await firstChapter!.getBlocks?.()
        const footnoteImages = blocks?.filter(block =>
            block.type === 'image' && block.image?.role?.includes('epub-footnote')
        ) ?? []
        const inlineFigure = blocks?.find(block =>
            block.type === 'image' && block.image?.originalSrc?.endsWith('image_010.jpg')
        )

        expect(footnoteImages).toHaveLength(0)
        expect(inlineFigure?.image?.width).toBe(150)
    })
})
