/**
 * FB2 Parser unit tests
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { FB2Parser, fb2 } from '../../src/parsers/fb2'
import { createTestFB2, createTestFB2Buffer, createTestFBZ } from '../fixtures/fb2-fixture'
import { TestDOMAdapter, TestURLFactory } from '../../src/adapters/test'
import type { ParserOptions } from '../../src/core/parser'

describe('FB2Parser', () => {
    let parser: FB2Parser
    let options: ParserOptions

    beforeAll(() => {
        parser = new FB2Parser()
        options = {
            domAdapter: new TestDOMAdapter(),
            urlFactory: new TestURLFactory(),
        }
    })

    describe('canParse', () => {
        it('should return true for .fb2 file extension', async () => {
            expect(await parser.canParse('book.fb2')).toBe(true)
            expect(await parser.canParse('path/to/my-book.fb2')).toBe(true)
        })

        it('should return true for .fbz file extension', async () => {
            expect(await parser.canParse('book.fbz')).toBe(true)
        })

        it('should return true for .fb2.zip file extension', async () => {
            expect(await parser.canParse('book.fb2.zip')).toBe(true)
        })

        it('should return false for non-fb2 extensions', async () => {
            expect(await parser.canParse('book.epub')).toBe(false)
            expect(await parser.canParse('book.pdf')).toBe(false)
            expect(await parser.canParse('book.mobi')).toBe(false)
        })

        it('should return true for FB2 ArrayBuffer with FictionBook element', async () => {
            const buffer = createTestFB2Buffer()
            expect(await parser.canParse(buffer)).toBe(true)
        })

        it('should return false for non-FB2 ArrayBuffer', async () => {
            const buffer = new TextEncoder().encode('<html>not fb2</html>').buffer
            expect(await parser.canParse(buffer)).toBe(false)
        })

        it('should return true for FBZ archive', async () => {
            const buffer = await createTestFBZ()
            expect(await parser.canParse(buffer)).toBe(true)
        })

        it('should return false for zip without .fb2 file', async () => {
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
        it('should parse a basic FB2 document', async () => {
            const buffer = createTestFB2Buffer({
                title: 'My Test Book',
                language: 'en',
                sections: [
                    { title: 'Chapter 1', paragraphs: ['Hello'] },
                    { title: 'Chapter 2', paragraphs: ['World'] },
                ],
            })
            const book = await parser.parse(buffer, options)

            expect(book).toBeDefined()
            expect(book.sections.length).toBeGreaterThanOrEqual(2)
        })

        it('should extract metadata: title', async () => {
            const buffer = createTestFB2Buffer({ title: 'The Great Novel' })
            const book = await parser.parse(buffer, options)

            expect(book.metadata?.title).toBe('The Great Novel')
        })

        it('should extract metadata: author with first/last name', async () => {
            const buffer = createTestFB2Buffer({
                author: { firstName: 'Jane', lastName: 'Austen' },
            })
            const book = await parser.parse(buffer, options)

            expect(book.metadata?.author).toBeDefined()
            const authors = Array.isArray(book.metadata?.author)
                ? book.metadata!.author
                : [book.metadata?.author]
            const author = authors[0] as { name: string; sortAs?: string }
            expect(author.name).toContain('Jane')
            expect(author.name).toContain('Austen')
            expect(author.sortAs).toContain('Austen')
        })

        it('should extract metadata: author with nickname', async () => {
            const buffer = createTestFB2Buffer({
                author: { nickname: 'MarkTwain' },
            })
            const book = await parser.parse(buffer, options)

            const authors = Array.isArray(book.metadata?.author)
                ? book.metadata!.author
                : [book.metadata?.author]
            const author = authors[0] as { name: string }
            expect(author.name).toBe('MarkTwain')
        })

        it('should extract metadata: language', async () => {
            const buffer = createTestFB2Buffer({ language: 'ru' })
            const book = await parser.parse(buffer, options)

            expect(book.metadata?.language).toBe('ru')
        })

        it('should extract metadata: genres as subjects', async () => {
            const buffer = createTestFB2Buffer({ genres: ['sf', 'fantasy'] })
            const book = await parser.parse(buffer, options)

            expect(book.metadata?.subject).toBeDefined()
            const subjects = Array.isArray(book.metadata?.subject)
                ? book.metadata!.subject
                : [book.metadata?.subject]
            expect(subjects).toContain('sf')
            expect(subjects).toContain('fantasy')
        })

        it('should extract metadata: publisher', async () => {
            const buffer = createTestFB2Buffer({ publisher: 'Penguin Books' })
            const book = await parser.parse(buffer, options)

            expect(book.metadata?.publisher).toBe('Penguin Books')
        })

        it('should extract metadata: document ID', async () => {
            const buffer = createTestFB2Buffer({ docId: 'unique-id-456' })
            const book = await parser.parse(buffer, options)

            expect(book.metadata?.identifier).toBe('unique-id-456')
        })

        it('should extract metadata: published date', async () => {
            const buffer = createTestFB2Buffer({ published: '2024-01-15' })
            const book = await parser.parse(buffer, options)

            expect(book.metadata?.published).toBe('2024-01-15')
        })

        it('should create TOC entries from section titles', async () => {
            const buffer = createTestFB2Buffer({
                sections: [
                    { title: 'Introduction', paragraphs: ['Intro text'] },
                    { title: 'Main Story', paragraphs: ['Story text'] },
                    { title: 'Epilogue', paragraphs: ['End text'] },
                ],
            })
            const book = await parser.parse(buffer, options)

            expect(book.toc).toBeDefined()
            expect(book.toc!.length).toBeGreaterThanOrEqual(3)
            const labels = book.toc!.map(item => item.label)
            expect(labels).toContain('Introduction')
            expect(labels).toContain('Main Story')
            expect(labels).toContain('Epilogue')
        })

        it('should split first body into separate sections', async () => {
            const buffer = createTestFB2Buffer({
                sections: [
                    { title: 'A', paragraphs: ['text a'] },
                    { title: 'B', paragraphs: ['text b'] },
                ],
            })
            const book = await parser.parse(buffer, options)

            // Each section in the first body becomes its own section
            expect(book.sections.length).toBeGreaterThanOrEqual(2)
        })

        it('should handle notes body as non-linear section', async () => {
            const buffer = createTestFB2Buffer({
                sections: [{ title: 'Chapter', paragraphs: ['Main text'] }],
                notesBody: { title: 'Notes', paragraphs: ['Note 1'] },
            })
            const book = await parser.parse(buffer, options)

            // Should have main sections + notes section
            const nonLinear = book.sections.filter(s => s.linear === 'no')
            expect(nonLinear.length).toBeGreaterThanOrEqual(1)
        })

        it('should load section content as URL', async () => {
            const buffer = createTestFB2Buffer({
                sections: [{ title: 'Chapter', paragraphs: ['Hello'] }],
            })
            const book = await parser.parse(buffer, options)

            const url = await book.sections[0].load()
            expect(url).toBeDefined()
            expect(typeof url).toBe('string')
        })

        it('should create document from section', async () => {
            const buffer = createTestFB2Buffer({
                sections: [{ title: 'Chapter', paragraphs: ['Content here'] }],
            })
            const book = await parser.parse(buffer, options)

            const doc = book.sections[0].createDocument?.()
            expect(doc).toBeDefined()
            expect(typeof doc).toBe('string')
        })

        it('should have section sizes > 0', async () => {
            const buffer = createTestFB2Buffer({
                sections: [{ title: 'Ch1', paragraphs: ['Some text content'] }],
            })
            const book = await parser.parse(buffer, options)

            for (const section of book.sections) {
                expect(section.size).toBeGreaterThan(0)
            }
        })

        it('should resolve section href by index', async () => {
            const buffer = createTestFB2Buffer({
                sections: [
                    { title: 'First', paragraphs: ['text'] },
                    { title: 'Second', paragraphs: ['text'] },
                ],
            })
            const book = await parser.parse(buffer, options)

            const result = book.resolveHref?.('1')
            expect(result).toBeDefined()
            expect(result!.index).toBe(1)
        })

        it('should return null for unknown href', async () => {
            const buffer = createTestFB2Buffer()
            const book = await parser.parse(buffer, options)

            const result = book.resolveHref?.('unknown-nonsense')
            expect(result).toBeNull()
        })

        it('should split TOC href into parts', async () => {
            const buffer = createTestFB2Buffer()
            const book = await parser.parse(buffer, options)

            const [id, fragment] = book.splitTOCHref?.('0#someId') ?? []
            expect(id).toBe('0')
            expect(fragment).toBe('someId')
        })

        it('should cleanup URLs on destroy', async () => {
            const urlFactory = new TestURLFactory()
            const buffer = createTestFB2Buffer({
                sections: [{ title: 'Ch', paragraphs: ['text'] }],
            })
            const book = await parser.parse(buffer, { ...options, urlFactory })

            // Verify URLs were created
            await book.sections[0].load()

            // Destroy should not throw
            book.destroy?.()
        })

        it('should parse FBZ (zipped FB2) archive', async () => {
            const buffer = await createTestFBZ({
                title: 'Zipped Book',
                sections: [{ title: 'Chapter', paragraphs: ['Zipped content'] }],
            })
            const book = await parser.parse(buffer, options)

            expect(book).toBeDefined()
            expect(book.metadata?.title).toBe('Zipped Book')
            expect(book.sections.length).toBeGreaterThanOrEqual(1)
        })
    })

    describe('error handling', () => {
        it('should throw without domAdapter', async () => {
            const buffer = createTestFB2Buffer()
            await expect(parser.parse(buffer, { urlFactory: new TestURLFactory() }))
                .rejects.toThrow('domAdapter')
        })

        it('should throw without urlFactory', async () => {
            const buffer = createTestFB2Buffer()
            await expect(parser.parse(buffer, { domAdapter: new TestDOMAdapter() }))
                .rejects.toThrow('urlFactory')
        })
    })

    describe('factory', () => {
        it('should create parser via factory function', () => {
            const p = fb2()
            expect(p).toBeInstanceOf(FB2Parser)
        })
    })
})
