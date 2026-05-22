/**
 * CBZ Parser unit tests
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { CBZParser, cbz } from '../../src/parsers/cbz'
import { createTestCBZ, createTestCBZWithoutMetadata } from '../fixtures/cbz-fixture'

describe('CBZParser', () => {
    let parser: CBZParser

    beforeAll(() => {
        parser = new CBZParser()
    })

    describe('canParse', () => {
        it('should return true for .cbz file extension', async () => {
            expect(await parser.canParse('comic.cbz')).toBe(true)
            expect(await parser.canParse('path/to/my-comic.cbz')).toBe(true)
        })

        it('should return false for non-cbz extensions', async () => {
            expect(await parser.canParse('book.epub')).toBe(false)
            expect(await parser.canParse('book.pdf')).toBe(false)
            expect(await parser.canParse('book.txt')).toBe(false)
        })

        it('should return true for CBZ ArrayBuffer with images', async () => {
            const buffer = await createTestCBZ()
            expect(await parser.canParse(buffer)).toBe(true)
        })

        it('should return false for non-image zip ArrayBuffer', async () => {
            // Create a zip with no images (just text files)
            const { configure, ZipWriter, BlobWriter, TextReader } = await import('@zip.js/zip.js')
            configure({ useWebWorkers: false })
            const blobWriter = new BlobWriter()
            const zipWriter = new ZipWriter(blobWriter)
            await zipWriter.add('readme.txt', new TextReader('Hello'))
            await zipWriter.close()
            const blob = await blobWriter.getData()
            const buffer = await blob.arrayBuffer()
            expect(await parser.canParse(buffer)).toBe(false)
        })
    })

    describe('parse', () => {
        it('should parse a CBZ with metadata', async () => {
            const buffer = await createTestCBZ({
                title: 'Test Comic',
                writer: 'John Doe',
                series: 'Test Series',
                number: '5',
                count: '10',
                pages: 3,
            })
            const book = await parser.parse(buffer)

            expect(book).toBeDefined()
            expect(book.sections).toHaveLength(3)
            expect(book.metadata?.title).toBe('Test Comic')
            expect(book.metadata?.author).toBe('John Doe')
            expect(book.metadata?.belongsTo?.series?.name).toBe('Test Series')
            expect(book.metadata?.belongsTo?.series?.position).toBe('5')
            expect(book.metadata?.belongsTo?.series?.total).toBe('10')
        })

        it('should parse a CBZ without metadata', async () => {
            const buffer = await createTestCBZWithoutMetadata(2)
            const book = await parser.parse(buffer)

            expect(book).toBeDefined()
            expect(book.sections).toHaveLength(2)
            // No metadata from ComicInfo.xml
            expect(book.metadata?.title).toBeUndefined()
        })

        it('should have pre-paginated rendition', async () => {
            const buffer = await createTestCBZ({ pages: 2 })
            const book = await parser.parse(buffer)

            expect(book.rendition?.layout).toBe('pre-paginated')
        })

        it('should have a flat TOC with all pages', async () => {
            const buffer = await createTestCBZ({ pages: 4 })
            const book = await parser.parse(buffer)

            expect(book.toc).toHaveLength(4)
            expect(book.toc![0].label).toBe('page001.jpg')
            expect(book.toc![0].href).toBe('page001.jpg')
        })

        it('should sort image files alphabetically', async () => {
            const buffer = await createTestCBZ({ pages: 3 })
            const book = await parser.parse(buffer)

            const ids = book.sections.map(s => s.id)
            expect(ids).toEqual(['page001.jpg', 'page002.jpg', 'page003.jpg'])
        })

        it('should load section content as blob URL', async () => {
            const buffer = await createTestCBZ({ pages: 1 })
            const book = await parser.parse(buffer)

            const url = await book.sections[0].load()
            expect(url).toBeDefined()
            expect(typeof url).toBe('string')
            // Should be a blob URL
            expect(url.startsWith('blob:')).toBe(true)
        })

        it('should unload section and revoke URL', async () => {
            const buffer = await createTestCBZ({ pages: 1 })
            const book = await parser.parse(buffer)

            const url = await book.sections[0].load()
            expect(url).toBeDefined()

            book.sections[0].unload?.()
            // After unload, loading again should create a new URL
            const url2 = await book.sections[0].load()
            expect(url2).not.toBe(url)
        })

        it('should return cover as first image blob', async () => {
            const buffer = await createTestCBZ({ pages: 2 })
            const book = await parser.parse(buffer)

            const cover = await book.getCover?.()
            expect(cover).toBeInstanceOf(Blob)
        })

        it('should resolve href to section index', async () => {
            const buffer = await createTestCBZ({ pages: 3 })
            const book = await parser.parse(buffer)

            const result = book.resolveHref?.('page002.jpg')
            expect(result?.index).toBe(1)
        })

        it('should return null for unknown href', async () => {
            const buffer = await createTestCBZ({ pages: 2 })
            const book = await parser.parse(buffer)

            const result = book.resolveHref?.('nonexistent.jpg')
            expect(result).toBeNull()
        })

        it('should cleanup URLs on destroy', async () => {
            const buffer = await createTestCBZ({ pages: 2 })
            const book = await parser.parse(buffer)

            await book.sections[0].load()
            await book.sections[1].load()

            // Should not throw
            book.destroy?.()
        })

        it('should throw if no images found', async () => {
            const { configure, ZipWriter, BlobWriter, TextReader } = await import('@zip.js/zip.js')
            configure({ useWebWorkers: false })
            const blobWriter = new BlobWriter()
            const zipWriter = new ZipWriter(blobWriter)
            await zipWriter.add('readme.txt', new TextReader('No images here'))
            await zipWriter.close()
            const blob = await blobWriter.getData()
            const buffer = await blob.arrayBuffer()

            await expect(parser.parse(buffer)).rejects.toThrow('No image files found')
        })
    })

    describe('factory', () => {
        it('should create parser via factory function', () => {
            const p = cbz()
            expect(p).toBeInstanceOf(CBZParser)
        })
    })
})
