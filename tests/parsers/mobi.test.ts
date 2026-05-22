/**
 * MOBI Parser unit tests
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { MOBIParser, mobi } from '../../src/parsers/mobi'
import { createTestMOBI, createTestMOBIBlob } from '../fixtures/mobi-fixture'
import { TestDOMAdapter, TestURLFactory } from '../../src/adapters/test'
import type { ParserOptions } from '../../src/core/parser'

describe('MOBIParser', () => {
    let parser: MOBIParser
    let options: ParserOptions

    beforeAll(() => {
        parser = new MOBIParser()
        options = {
            domAdapter: new TestDOMAdapter(),
            urlFactory: new TestURLFactory(),
        }
    })

    describe('canParse', () => {
        it('should return true for .mobi file extension', async () => {
            expect(await parser.canParse('book.mobi')).toBe(true)
            expect(await parser.canParse('path/to/my-book.mobi')).toBe(true)
        })

        it('should return true for .azw file extension', async () => {
            expect(await parser.canParse('book.azw')).toBe(true)
        })

        it('should return true for .azw3 file extension', async () => {
            expect(await parser.canParse('book.azw3')).toBe(true)
        })

        it('should return false for non-mobi extensions', async () => {
            expect(await parser.canParse('book.epub')).toBe(false)
            expect(await parser.canParse('book.pdf')).toBe(false)
            expect(await parser.canParse('book.fb2')).toBe(false)
        })

        it('should return true for MOBI ArrayBuffer with BOOKMOBI magic', async () => {
            const buffer = createTestMOBI({
                title: 'Magic Test',
                sections: [{ html: '<html><body><p>Hello</p></body></html>' }],
            })
            expect(await parser.canParse(buffer)).toBe(true)
        })

        it('should return true for MOBI Blob', async () => {
            const blob = createTestMOBIBlob({
                sections: [{ html: '<html><body><p>Hello</p></body></html>' }],
            })
            expect(await parser.canParse(blob)).toBe(true)
        })

        it('should return false for non-MOBI ArrayBuffer', async () => {
            const buffer = new TextEncoder().encode('not a mobi file at all').buffer
            expect(await parser.canParse(buffer)).toBe(false)
        })
    })

    describe('parse', () => {
        it('should parse a basic MOBI6 document', async () => {
            const buffer = createTestMOBI({
                title: 'My Test Book',
                sections: [
                    { html: '<html><body><h1>Chapter 1</h1><p>First paragraph.</p></body></html>' },
                    { html: '<html><body><h1>Chapter 2</h1><p>Second paragraph.</p></body></html>' },
                ],
            })
            const book = await parser.parse(buffer, options)

            expect(book).toBeDefined()
            expect(book.sections.length).toBeGreaterThanOrEqual(1)
        })

        it('should extract metadata: title', async () => {
            const buffer = createTestMOBI({
                title: 'The Great Novel',
                sections: [{ html: '<html><body><p>Content</p></body></html>' }],
            })
            const book = await parser.parse(buffer, options)

            expect(book.metadata?.title).toBe('The Great Novel')
        })

        it('should extract metadata: author', async () => {
            const buffer = createTestMOBI({
                author: 'Jane Austen',
                sections: [{ html: '<html><body><p>Content</p></body></html>' }],
            })
            const book = await parser.parse(buffer, options)

            expect(book.metadata?.author).toBeDefined()
            const authors = Array.isArray(book.metadata?.author)
                ? book.metadata!.author
                : [book.metadata?.author]
            expect(authors[0]).toBe('Jane Austen')
        })

        it('should extract metadata: language', async () => {
            const buffer = createTestMOBI({
                language: 'en',
                sections: [{ html: '<html><body><p>Content</p></body></html>' }],
            })
            const book = await parser.parse(buffer, options)

            expect(book.metadata?.language).toBeDefined()
        })

        it('should extract metadata: publisher', async () => {
            const buffer = createTestMOBI({
                publisher: 'Penguin Books',
                sections: [{ html: '<html><body><p>Content</p></body></html>' }],
            })
            const book = await parser.parse(buffer, options)

            expect(book.metadata?.publisher).toBe('Penguin Books')
        })

        it('should create sections from pagebreak splits', async () => {
            const buffer = createTestMOBI({
                sections: [
                    { html: '<html><body><p>Part one</p></body></html>' },
                    { html: '<html><body><p>Part two</p></body></html>' },
                    { html: '<html><body><p>Part three</p></body></html>' },
                ],
            })
            const book = await parser.parse(buffer, options)

            // Multiple sections should be created from pagebreak splits
            expect(book.sections.length).toBeGreaterThanOrEqual(3)
        })

        it('should load section content as URL', async () => {
            const buffer = createTestMOBI({
                sections: [{ html: '<html><body><p>Hello, world!</p></body></html>' }],
            })
            const book = await parser.parse(buffer, options)

            const url = await book.sections[0].load()
            expect(url).toBeDefined()
            expect(typeof url).toBe('string')
        })

        it('should create document from section', async () => {
            const buffer = createTestMOBI({
                sections: [{ html: '<html><body><p>Content here</p></body></html>' }],
            })
            const book = await parser.parse(buffer, options)

            const doc = book.sections[0].createDocument?.()
            expect(doc).toBeDefined()
        })

        it('should have section sizes > 0', async () => {
            const buffer = createTestMOBI({
                sections: [{ html: '<html><body><p>Some text content</p></body></html>' }],
            })
            const book = await parser.parse(buffer, options)

            for (const section of book.sections) {
                expect(section.size).toBeGreaterThan(0)
            }
        })

        it('should resolve filepos href', async () => {
            const buffer = createTestMOBI({
                sections: [{ html: '<html><body><p id="target">Target text</p></body></html>' }],
            })
            const book = await parser.parse(buffer, options)

            // filepos:0 should resolve to the first section
            const result = book.resolveHref?.('filepos:0')
            expect(result).toBeDefined()
            expect(result!.index).toBe(0)
        })

        it('should return null for unknown href', async () => {
            const buffer = createTestMOBI({
                sections: [{ html: '<html><body><p>text</p></body></html>' }],
            })
            const book = await parser.parse(buffer, options)

            const result = book.resolveHref?.('unknown-nonsense')
            expect(result).toBeNull()
        })

        it('should detect external URIs', async () => {
            const buffer = createTestMOBI({
                sections: [{ html: '<html><body><p>text</p></body></html>' }],
            })
            const book = await parser.parse(buffer, options)

            expect(book.isExternal?.('https://example.com')).toBe(true)
            expect(book.isExternal?.('http://example.com')).toBe(true)
            expect(book.isExternal?.('filepos:12345')).toBe(false)
        })

        it('should cleanup on destroy', async () => {
            const urlFactory = new TestURLFactory()
            const buffer = createTestMOBI({
                sections: [{ html: '<html><body><p>text</p></body></html>' }],
            })
            const book = await parser.parse(buffer, { ...options, urlFactory })

            // Load a section to create URLs
            await book.sections[0].load()

            // Destroy should not throw
            book.destroy?.()
        })

        it('should parse MOBI with PalmDOC compression', async () => {
            const buffer = createTestMOBI({
                title: 'Compressed Book',
                compression: 2,
                sections: [
                    { html: '<html><body><p>This is compressed content with some repeated text text text.</p></body></html>' },
                ],
            })
            const book = await parser.parse(buffer, options)

            expect(book).toBeDefined()
            expect(book.metadata?.title).toBe('Compressed Book')
            expect(book.sections.length).toBeGreaterThanOrEqual(1)
        })

        it('should handle multiple sections with pagebreaks', async () => {
            const html1 = '<html><body><h1>Introduction</h1><p>Welcome to the book.</p></body></html>'
            const html2 = '<html><body><h1>Chapter 1</h1><p>The story begins.</p></body></html>'
            const html3 = '<html><body><h1>Chapter 2</h1><p>The story continues.</p></body></html>'

            const buffer = createTestMOBI({
                title: 'Multi-Chapter Book',
                sections: [
                    { html: html1 },
                    { html: html2 },
                    { html: html3 },
                ],
            })
            const book = await parser.parse(buffer, options)

            expect(book.sections.length).toBeGreaterThanOrEqual(3)
            expect(book.metadata?.title).toBe('Multi-Chapter Book')

            // Each section should be loadable
            for (const section of book.sections) {
                const url = await section.load()
                expect(typeof url).toBe('string')
            }
        })
    })

    describe('error handling', () => {
        it('should throw for string input', async () => {
            await expect(parser.parse('book.mobi', options))
                .rejects.toThrow()
        })

        it('should throw for non-MOBI ArrayBuffer', async () => {
            const buffer = new TextEncoder().encode('not a mobi file').buffer
            await expect(parser.parse(buffer, options))
                .rejects.toThrow()
        })
    })

    describe('factory', () => {
        it('should create parser via factory function', () => {
            const p = mobi()
            expect(p).toBeInstanceOf(MOBIParser)
        })
    })
})
