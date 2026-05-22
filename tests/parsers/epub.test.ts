/**
 * EPUB Parser unit tests
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { EPUBParser, epub } from '../../src/parsers/epub'
import { TestDOMAdapter, TestURLFactory } from '../../src/adapters/test'
import { createTestEPUB, createTestEPUBWithNCX } from '../fixtures/epub-fixture'

describe('EPUBParser', () => {
    let parser: EPUBParser
    let domAdapter: TestDOMAdapter
    let urlFactory: TestURLFactory

    beforeAll(() => {
        parser = new EPUBParser()
        domAdapter = new TestDOMAdapter()
        urlFactory = new TestURLFactory()
    })

    describe('canParse', () => {
        it('should return true for .epub file extension', async () => {
            expect(await parser.canParse('book.epub')).toBe(true)
            expect(await parser.canParse('path/to/my-book.epub')).toBe(true)
        })

        it('should return false for non-epub extensions', async () => {
            expect(await parser.canParse('book.pdf')).toBe(false)
            expect(await parser.canParse('book.txt')).toBe(false)
            expect(await parser.canParse('book.html')).toBe(false)
        })

        it('should return true for valid EPUB ArrayBuffer', async () => {
            const epubBuffer = await createTestEPUB()
            expect(await parser.canParse(epubBuffer)).toBe(true)
        })

        it('should return false for invalid ArrayBuffer', async () => {
            const invalidBuffer = new ArrayBuffer(4)
            expect(await parser.canParse(invalidBuffer)).toBe(false)
        })
    })

    describe('parse', () => {
        it('should parse a minimal EPUB', async () => {
            const epubBuffer = await createTestEPUB()
            const book = await parser.parse(epubBuffer, { domAdapter, urlFactory })

            expect(book).toBeDefined()
            expect(book.sections).toBeDefined()
            expect(book.sections.length).toBe(1)
        })

        it('should extract metadata correctly', async () => {
            const epubBuffer = await createTestEPUB({
                title: 'My Test Book',
                author: 'Jane Doe',
                language: 'en',
                identifier: 'unique-id-456',
            })
            const book = await parser.parse(epubBuffer, { domAdapter, urlFactory })

            expect(book.metadata).toBeDefined()
            expect(book.metadata?.title).toBe('My Test Book')
            expect(book.metadata?.language).toContain('en')
            expect(book.metadata?.identifier).toBe('unique-id-456')
        })

        it('should parse table of contents from nav document', async () => {
            const epubBuffer = await createTestEPUB({
                chapters: [
                    { id: 'ch1', title: 'First Chapter', content: '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Ch 1</p></body></html>' },
                    { id: 'ch2', title: 'Second Chapter', content: '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Ch 2</p></body></html>' },
                    { id: 'ch3', title: 'Third Chapter', content: '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Ch 3</p></body></html>' },
                ],
            })
            const book = await parser.parse(epubBuffer, { domAdapter, urlFactory })

            expect(book.toc).toBeDefined()
            expect(book.toc?.length).toBe(3)
            expect(book.toc?.[0].label).toBe('First Chapter')
            expect(book.toc?.[1].label).toBe('Second Chapter')
            expect(book.toc?.[2].label).toBe('Third Chapter')
        })

        it('should parse NCX as fallback for TOC', async () => {
            const epubBuffer = await createTestEPUBWithNCX({
                chapters: [
                    { id: 'ch1', title: 'NCX Chapter 1', content: '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Ch 1</p></body></html>' },
                    { id: 'ch2', title: 'NCX Chapter 2', content: '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Ch 2</p></body></html>' },
                ],
            })
            const book = await parser.parse(epubBuffer, { domAdapter, urlFactory })

            expect(book.toc).toBeDefined()
            expect(book.toc?.length).toBe(2)
            expect(book.toc?.[0].label).toBe('NCX Chapter 1')
            expect(book.toc?.[1].label).toBe('NCX Chapter 2')
        })

        it('should create correct number of sections', async () => {
            const epubBuffer = await createTestEPUB({
                chapters: [
                    { id: 'a', title: 'A', content: '<html xmlns="http://www.w3.org/1999/xhtml"><body>A</body></html>' },
                    { id: 'b', title: 'B', content: '<html xmlns="http://www.w3.org/1999/xhtml"><body>B</body></html>' },
                    { id: 'c', title: 'C', content: '<html xmlns="http://www.w3.org/1999/xhtml"><body>C</body></html>' },
                    { id: 'd', title: 'D', content: '<html xmlns="http://www.w3.org/1999/xhtml"><body>D</body></html>' },
                ],
            })
            const book = await parser.parse(epubBuffer, { domAdapter, urlFactory })

            expect(book.sections.length).toBe(4)
            // Section IDs include the OEBPS/ path prefix since OPF is in OEBPS/
            expect(book.sections[0].id).toBe('OEBPS/a.xhtml')
            expect(book.sections[1].id).toBe('OEBPS/b.xhtml')
            expect(book.sections[2].id).toBe('OEBPS/c.xhtml')
            expect(book.sections[3].id).toBe('OEBPS/d.xhtml')
        })

        it('should parse landmarks from nav document', async () => {
            const epubBuffer = await createTestEPUB()
            const book = await parser.parse(epubBuffer, { domAdapter, urlFactory })

            expect(book.landmarks).toBeDefined()
            expect(book.landmarks?.length).toBeGreaterThan(0)

            const tocLandmark = book.landmarks?.find(l => l.type.includes('toc'))
            expect(tocLandmark).toBeDefined()
        })

        it('should load section content', async () => {
            const epubBuffer = await createTestEPUB({
                chapters: [
                    { id: 'ch1', title: 'Chapter', content: '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Test content</p></body></html>' },
                ],
            })
            const book = await parser.parse(epubBuffer, { domAdapter, urlFactory })

            const section = book.sections[0]
            const content = await section.load()

            expect(content).toBeDefined()
            expect(typeof content).toBe('string')
            // Section.load() returns HTML string, not a blob URL
            expect(content).toContain('Test content')
        })

        it('should set section format to xhtml', async () => {
            const epubBuffer = await createTestEPUB()
            const book = await parser.parse(epubBuffer, { domAdapter, urlFactory })

            for (const section of book.sections) {
                expect(section.format).toBe('xhtml')
            }
        })

        it('should provide section sizes', async () => {
            const epubBuffer = await createTestEPUB()
            const book = await parser.parse(epubBuffer, { domAdapter, urlFactory })

            for (const section of book.sections) {
                expect(section.size).toBeGreaterThan(0)
            }
        })

        it('should provide createDocument that returns raw string', async () => {
            const epubBuffer = await createTestEPUB({
                chapters: [
                    { id: 'ch1', title: 'Chapter', content: '<html xmlns="http://www.w3.org/1999/xhtml"><body><p id="test">Content</p></body></html>' },
                ],
            })
            const book = await parser.parse(epubBuffer, { domAdapter, urlFactory })

            const section = book.sections[0]
            const content = await section.createDocument!()

            expect(typeof content).toBe('string')
            expect(content).toContain('<p id="test">Content</p>')
        })

        it('should throw error without adapters', async () => {
            const epubBuffer = await createTestEPUB()
            await expect(parser.parse(epubBuffer, {})).rejects.toThrow('domAdapter and urlFactory')
        })
    })

    describe('Book navigation methods', () => {
        it('resolveHref should return correct section index', async () => {
            const epubBuffer = await createTestEPUB({
                chapters: [
                    { id: 'ch1', title: 'One', content: '<html xmlns="http://www.w3.org/1999/xhtml"><body><p id="p1">One</p></body></html>' },
                    { id: 'ch2', title: 'Two', content: '<html xmlns="http://www.w3.org/1999/xhtml"><body><p id="p2">Two</p></body></html>' },
                ],
            })
            const book = await parser.parse(epubBuffer, { domAdapter, urlFactory })

            // Use full path including OEBPS/ prefix
            const resolved1 = book.resolveHref?.('OEBPS/ch1.xhtml')
            expect(resolved1).toBeDefined()
            expect(resolved1?.index).toBe(0)

            const resolved2 = book.resolveHref?.('OEBPS/ch2.xhtml')
            expect(resolved2).toBeDefined()
            expect(resolved2?.index).toBe(1)
        })

        it('resolveHref should handle fragment identifiers', async () => {
            const epubBuffer = await createTestEPUB({
                chapters: [
                    { id: 'ch1', title: 'One', content: '<html xmlns="http://www.w3.org/1999/xhtml"><body><p id="target">Content</p></body></html>' },
                ],
            })
            const book = await parser.parse(epubBuffer, { domAdapter, urlFactory })

            const resolved = book.resolveHref?.('OEBPS/ch1.xhtml#target')
            expect(resolved).toBeDefined()
            expect(resolved?.index).toBe(0)
            expect(resolved?.anchor).toBeDefined()
            expect(typeof resolved?.anchor).toBe('function')
        })

        it('resolveHref should return null for unknown href', async () => {
            const epubBuffer = await createTestEPUB()
            const book = await parser.parse(epubBuffer, { domAdapter, urlFactory })

            const resolved = book.resolveHref?.('nonexistent.xhtml')
            expect(resolved).toBeNull()
        })

        it('isExternal should identify external URLs', async () => {
            const epubBuffer = await createTestEPUB()
            const book = await parser.parse(epubBuffer, { domAdapter, urlFactory })

            expect(book.isExternal?.('https://example.com')).toBe(true)
            expect(book.isExternal?.('http://example.com')).toBe(true)
            expect(book.isExternal?.('mailto:test@example.com')).toBe(true)
            expect(book.isExternal?.('chapter1.xhtml')).toBe(false)
            expect(book.isExternal?.('#section')).toBe(false)
        })

        it('splitTOCHref should split href and fragment', async () => {
            const epubBuffer = await createTestEPUB()
            const book = await parser.parse(epubBuffer, { domAdapter, urlFactory })

            expect(book.splitTOCHref?.('chapter.xhtml#section1')).toEqual(['chapter.xhtml', 'section1'])
            expect(book.splitTOCHref?.('chapter.xhtml')).toEqual(['chapter.xhtml', null])
        })

        it('destroy should clean up resources', async () => {
            const epubBuffer = await createTestEPUB()
            const book = await parser.parse(epubBuffer, { domAdapter, urlFactory })

            // Load a section to create URLs
            await book.sections[0].load()

            // Destroy should not throw
            expect(() => book.destroy?.()).not.toThrow()
        })
    })

    describe('epub factory function', () => {
        it('should create a parser instance', () => {
            const p = epub()
            expect(p).toBeInstanceOf(EPUBParser)
        })
    })
})
