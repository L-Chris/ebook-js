import { readFile } from 'node:fs/promises'
import { parseHTML } from 'linkedom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Book } from '../../src/core/types'
import { TestDOMAdapter, TestURLFactory } from '../../src/adapters/test'
import { epub } from '../../src/parsers/epub'
import { mobi } from '../../src/parsers/mobi'
import { createReader, VirtualTextRenderer } from '../../src/renderers/browser'

class MockResizeObserver {
    observe() {}
    disconnect() {}
}

beforeEach(() => {
    const { window } = parseHTML('<!doctype html><html><body></body></html>')
    vi.stubGlobal('window', window)
    vi.stubGlobal('document', window.document)
    vi.stubGlobal('HTMLElement', window.HTMLElement)
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    vi.stubGlobal('OffscreenCanvas', class {
        getContext() {
            return {
                font: '16px serif',
                measureText(text: string) {
                    const fontSize = Number(this.font.match(/([\d.]+)px/)?.[1] ?? 16)
                    return { width: Array.from(text).length * fontSize * 0.54 }
                },
            }
        }
    })

    Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', {
        configurable: true,
        get() { return Number(this.getAttribute('data-width')) || 800 },
    })
    Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', {
        configurable: true,
        get() { return Number(this.getAttribute('data-height')) || 120 },
    })
    Object.defineProperty(window.HTMLElement.prototype, 'scrollHeight', {
        configurable: true,
        get() {
            const child = this.firstElementChild as HTMLElement | null
            return parseFloat(child?.style.height || this.style.height || '') || this.clientHeight
        },
    })
})

describe('VirtualTextRenderer', () => {
    it('renders only visible Pretext line ranges into minimal DOM rows', async () => {
        const container = document.createElement('div')
        container.setAttribute('data-width', '360')
        container.setAttribute('data-height', '72')
        document.body.appendChild(container)

        const text = Array.from({ length: 80 }, (_, index) => `word${index}`).join(' ')
        const book: Book = {
            sections: [{
                id: 'chapter.xhtml',
                size: text.length,
                format: 'xhtml',
                load: () => `<p>${text}</p>`,
                getBlocks: () => [{
                    id: 'chapter-body',
                    type: 'paragraph',
                    segments: [{ text }],
                }],
            }],
        }

        const renderer = new VirtualTextRenderer({
            container,
            styles: { fontSize: '16px', lineHeight: 1.5, maxInlineSize: '260px' },
        })
        let loadedLines = 0
        renderer.on('load', event => {
            loadedLines = (event.doc as { lines: unknown[] }).lines.length
        })

        await renderer.open(book)
        await renderer.goTo(0)

        const renderedRows = container.querySelectorAll('span').length
        expect(loadedLines).toBeGreaterThan(5)
        expect(renderedRows).toBeGreaterThan(0)
        expect(renderedRows).toBeLessThan(loadedLines)
        expect(container.textContent).toContain('word0')

        renderer.destroy()
    })

    it('is the default createReader browser renderer', async () => {
        const container = document.createElement('div')
        container.setAttribute('data-width', '360')
        container.setAttribute('data-height', '72')
        document.body.appendChild(container)

        const book: Book = {
            sections: [{
                id: 'chapter.xhtml',
                size: 20,
                format: 'xhtml',
                load: () => '<p>Hello browser</p>',
                getBlocks: () => [{
                    id: 'chapter-heading',
                    type: 'chapter',
                    segments: [{ text: 'Hello browser' }],
                }],
            }],
        }

        const reader = createReader({ container })
        await reader.openBook(book)
        await reader.goTo(0)

        expect(container.querySelector('[data-block-type="chapter"]')).toBeDefined()
        expect(container.querySelector('iframe')).toBeNull()

        reader.destroy()
    })

    it('replaces the renderer DOM when opening another book through ReaderView', async () => {
        const container = document.createElement('div')
        container.setAttribute('data-width', '360')
        container.setAttribute('data-height', '72')
        document.body.appendChild(container)

        const makeBook = (id: string, text: string): Book => ({
            sections: [{
                id,
                size: text.length,
                format: 'xhtml',
                load: () => `<p>${text}</p>`,
                getBlocks: () => [{
                    id: `${id}-body`,
                    type: 'paragraph',
                    segments: [{ text }],
                }],
            }],
        })

        const reader = createReader({ container })
        await reader.openBook(makeBook('one.xhtml', 'First book'))
        await reader.goTo(0)
        await reader.openBook(makeBook('two.xhtml', 'Second book'))
        await reader.goTo(0)

        expect(container.textContent).toContain('Second book')
        expect(container.textContent).not.toContain('First book')
        expect(container.children.length).toBe(1)

        reader.destroy()
    })

    it('uses two columns when spread is enabled and the viewport is wide enough', async () => {
        const container = document.createElement('div')
        container.setAttribute('data-width', '1200')
        container.setAttribute('data-height', '96')
        document.body.appendChild(container)

        const text = Array.from({ length: 140 }, (_, index) => `word${index}`).join(' ')
        const book: Book = {
            sections: [{
                id: 'chapter.xhtml',
                size: text.length,
                format: 'xhtml',
                load: () => `<p>${text}</p>`,
                getBlocks: () => [{
                    id: 'chapter-body',
                    type: 'paragraph',
                    segments: [{ text }],
                }],
            }],
        }

        const renderer = new VirtualTextRenderer({
            container,
            maxColumnCount: 2,
            styles: { fontSize: '16px', lineHeight: 1.5, maxInlineSize: '320px', gap: '48px' },
        })

        await renderer.open(book)
        await renderer.goTo(0)

        const rows = Array.from(container.querySelectorAll('[data-block-type="paragraph"]')) as HTMLElement[]
        const lefts = new Set(rows.map(row => row.style.left))
        expect(lefts.size).toBeGreaterThan(1)
        expect(rows.some(row => row.style.left === '368px')).toBe(true)
        const content = rows[0].parentElement as HTMLElement
        expect(content.style.left).toBe('56px')
        expect(content.style.width).toBe('688px')

        renderer.setSpread(1)
        const singleColumnRows = Array.from(container.querySelectorAll('[data-block-type="paragraph"]')) as HTMLElement[]
        const singleColumnLefts = new Set(singleColumnRows.map(row => row.style.left))
        expect(singleColumnLefts).toEqual(new Set(['0px']))
        const singleColumnContent = singleColumnRows[0].parentElement as HTMLElement
        expect(singleColumnContent.style.left).toBe('240px')
        expect(singleColumnContent.style.width).toBe('320px')

        renderer.destroy()
    })

    it('paginates by viewport groups and keeps text away from the clipped edge', async () => {
        const container = document.createElement('div')
        container.setAttribute('data-width', '760')
        container.setAttribute('data-height', '120')
        document.body.appendChild(container)

        const text = Array.from({ length: 120 }, (_, index) => `word${index}`).join(' ')
        const book: Book = {
            sections: [{
                id: 'chapter.xhtml',
                size: text.length,
                format: 'xhtml',
                load: () => `<p>${text}</p>`,
                getBlocks: () => [{
                    id: 'chapter-body',
                    type: 'paragraph',
                    segments: [{ text }],
                }],
            }],
        }

        const renderer = new VirtualTextRenderer({
            container,
            layout: 'paginated',
            maxColumnCount: 2,
            styles: { fontSize: '16px', lineHeight: 1.5, maxInlineSize: '320px', gap: '48px', margin: '32px' },
        })

        await renderer.open(book)
        await renderer.goTo(0)

        const scroller = container.firstElementChild as HTMLElement
        const firstRow = container.querySelector('[data-block-type="paragraph"]') as HTMLElement
        expect(scroller.style.overflow).toBe('hidden')
        expect(parseFloat(firstRow.style.top)).toBeGreaterThan(0)

        await renderer.next()
        expect(scroller.scrollTop).toBe(120)

        renderer.setLayout('scrolled')
        expect(scroller.style.overflow).toBe('auto')

        renderer.destroy()
    })

    it('renders image blocks and marks covers', async () => {
        const container = document.createElement('div')
        container.setAttribute('data-width', '360')
        container.setAttribute('data-height', '160')
        document.body.appendChild(container)

        const book: Book = {
            sections: [{
                id: 'cover.xhtml',
                size: 120,
                format: 'xhtml',
                load: () => '<p><img src="test://cover.png" alt="Cover"/></p>',
                getBlocks: () => [{
                    id: 'cover-image',
                    type: 'image',
                    image: {
                        src: 'test://cover.png',
                        originalSrc: 'images/cover.png',
                        alt: 'Cover',
                        width: 600,
                        height: 900,
                        isCover: true,
                        style: { maxWidth: 280, objectFit: 'contain', align: 'center' },
                    },
                    segments: [],
                }],
            }],
        }

        const renderer = new VirtualTextRenderer({
            container,
            layout: 'paginated',
            styles: { margin: '20px', fontSize: '16px', lineHeight: 1.5 },
        })

        await renderer.open(book)
        await renderer.goTo(0)

        const figure = container.querySelector('[data-block-type="image"]') as HTMLElement
        const img = container.querySelector('img') as HTMLImageElement
        expect(figure.dataset.cover).toBe('true')
        expect(img.src).toBe('test://cover.png')
        expect(img.alt).toBe('Cover')
        expect(parseFloat(figure.style.height)).toBeLessThanOrEqual(120)

        renderer.destroy()
    })

    it('navigates to anchors inside a virtual text section and reports the active TOC item', async () => {
        const container = document.createElement('div')
        container.setAttribute('data-width', '360')
        container.setAttribute('data-height', '96')
        document.body.appendChild(container)

        const book: Book = {
            sections: [{
                id: 0,
                size: 2000,
                format: 'xhtml',
                load: () => '<h1 id="first">First</h1><p>One</p><h1 id="second">Second</h1><p>Two</p>',
                getBlocks: () => [
                    {
                        id: 'first',
                        type: 'chapter',
                        attrs: { id: 'first' },
                        segments: [{ text: 'First' }],
                    },
                    {
                        id: 'first-body',
                        type: 'paragraph',
                        segments: [{ text: Array.from({ length: 120 }, (_, index) => `one${index}`).join(' ') }],
                    },
                    {
                        id: 'second',
                        type: 'chapter',
                        attrs: { id: 'second' },
                        segments: [{ text: 'Second' }],
                    },
                    {
                        id: 'second-body',
                        type: 'paragraph',
                        segments: [{ text: Array.from({ length: 80 }, (_, index) => `two${index}`).join(' ') }],
                    },
                ],
            }],
            toc: [
                { label: 'First', href: 'first' },
                { label: 'Second', href: 'second' },
            ],
            resolveHref: href => ({ index: 0, anchor: () => `[id="${href}"]` }),
        }

        const renderer = new VirtualTextRenderer({
            container,
            layout: 'scrolled',
            styles: { fontSize: '16px', lineHeight: 1.5, maxInlineSize: '280px', margin: '16px' },
        })
        let lastLabel: string | null = null
        renderer.on('relocate', event => {
            lastLabel = event.tocItem?.label ?? null
        })

        await renderer.open(book)
        await renderer.goTo('first')
        expect(lastLabel).toBe('First')

        await renderer.goTo('second')
        const scroller = container.firstElementChild as HTMLElement
        expect(scroller.scrollTop).toBeGreaterThan(0)
        expect(lastLabel).toBe('Second')

        renderer.destroy()
    })

    it('ignores unresolved TOC anchors in the current virtual text section', async () => {
        const container = document.createElement('div')
        container.setAttribute('data-width', '360')
        container.setAttribute('data-height', '96')
        document.body.appendChild(container)

        const book: Book = {
            sections: [{
                id: 0,
                size: 2000,
                format: 'xhtml',
                load: () => '<h1 id="cover">Cover</h1><p>Body</p>',
                getBlocks: () => [
                    {
                        id: 'cover',
                        type: 'chapter',
                        attrs: { id: 'cover' },
                        segments: [{ text: 'Cover' }],
                    },
                    {
                        id: 'cover-body',
                        type: 'paragraph',
                        segments: [{ text: Array.from({ length: 120 }, (_, index) => `body${index}`).join(' ') }],
                    },
                ],
            }],
            toc: [
                { label: 'Cover', href: 'cover' },
                { label: 'Missing Later Item', href: 'missing' },
            ],
            resolveHref: href => ({ index: 0, anchor: () => `[id="${href}"]` }),
        }

        const renderer = new VirtualTextRenderer({
            container,
            layout: 'scrolled',
            styles: { fontSize: '16px', lineHeight: 1.5, maxInlineSize: '280px', margin: '16px' },
        })
        let lastLabel: string | null = null
        renderer.on('relocate', event => {
            lastLabel = event.tocItem?.label ?? null
        })

        await renderer.open(book)
        await renderer.goTo('cover')

        expect(lastLabel).toBe('Cover')

        renderer.destroy()
    })

    it('reports the clicked TOC item for explicit paginated anchor navigation', async () => {
        const container = document.createElement('div')
        container.setAttribute('data-width', '760')
        container.setAttribute('data-height', '180')
        document.body.appendChild(container)

        const book: Book = {
            sections: [{
                id: 0,
                size: 2000,
                format: 'xhtml',
                load: () => '<p>Intro</p><h1 id="cover">Cover</h1><p>Body</p>',
                getBlocks: () => [
                    {
                        id: 'intro',
                        type: 'paragraph',
                        segments: [{ text: Array.from({ length: 24 }, (_, index) => `intro${index}`).join(' ') }],
                    },
                    {
                        id: 'cover',
                        type: 'chapter',
                        attrs: { id: 'cover' },
                        segments: [{ text: 'Cover' }],
                    },
                    {
                        id: 'cover-body',
                        type: 'paragraph',
                        segments: [{ text: Array.from({ length: 80 }, (_, index) => `body${index}`).join(' ') }],
                    },
                ],
            }],
            toc: [
                { label: 'Cover', href: 'cover' },
            ],
            resolveHref: href => ({ index: 0, anchor: () => `[id="${href}"]` }),
        }

        const renderer = new VirtualTextRenderer({
            container,
            layout: 'paginated',
            maxColumnCount: 2,
            styles: { fontSize: '16px', lineHeight: 1.5, maxInlineSize: '320px', margin: '32px' },
        })
        let lastLabel: string | null = null
        renderer.on('relocate', event => {
            lastLabel = event.tocItem?.label ?? null
        })

        await renderer.open(book)
        await renderer.goTo('cover')

        expect(lastLabel).toBe('Cover')

        renderer.destroy()
    })

    it('selects the active TOC item by reading order instead of TOC declaration order', async () => {
        const container = document.createElement('div')
        container.setAttribute('data-width', '360')
        container.setAttribute('data-height', '96')
        document.body.appendChild(container)

        const makeSection = (id: string, text: string) => ({
            id,
            size: text.length,
            format: 'xhtml' as const,
            load: () => `<p>${text}</p>`,
            getBlocks: () => [{
                id: `${id}-body`,
                type: 'paragraph' as const,
                segments: [{ text }],
            }],
        })
        const book: Book = {
            sections: [
                makeSection('one.xhtml', 'One'),
                makeSection('two.xhtml', 'Two'),
            ],
            toc: [
                { label: 'Two', href: 'two.xhtml' },
                { label: 'One', href: 'one.xhtml' },
            ],
            resolveHref: href => ({ index: href === 'two.xhtml' ? 1 : 0, anchor: 0 }),
        }

        const renderer = new VirtualTextRenderer({
            container,
            layout: 'paginated',
            styles: { fontSize: '16px', lineHeight: 1.5, maxInlineSize: '280px', margin: '16px' },
        })
        let lastLabel: string | null = null
        renderer.on('relocate', event => {
            lastLabel = event.tocItem?.label ?? null
        })

        await renderer.open(book)
        await renderer.goTo(0)
        expect(lastLabel).toBe('One')

        await renderer.next()
        expect(lastLabel).toBe('Two')

        renderer.destroy()
    })

    it('activates a TOC item that starts inside the visible paginated spread', async () => {
        const container = document.createElement('div')
        container.setAttribute('data-width', '760')
        container.setAttribute('data-height', '120')
        document.body.appendChild(container)

        const book: Book = {
            sections: [{
                id: 0,
                size: 2000,
                format: 'xhtml',
                load: () => '<p>Intro</p><h1 id="chapter">Chapter</h1>',
                getBlocks: () => [
                    {
                        id: 'intro',
                        type: 'paragraph',
                        segments: [{ text: Array.from({ length: 10 }, (_, index) => `intro${index}`).join(' ') }],
                    },
                    {
                        id: 'chapter',
                        type: 'chapter',
                        attrs: { id: 'chapter' },
                        segments: [{ text: 'Chapter' }],
                    },
                ],
            }],
            toc: [
                { label: 'Intro', href: 'intro' },
                { label: 'Chapter', href: 'chapter' },
            ],
            resolveHref: href => ({ index: 0, anchor: () => `[id="${href}"]` }),
        }

        const renderer = new VirtualTextRenderer({
            container,
            layout: 'paginated',
            maxColumnCount: 2,
            styles: { fontSize: '16px', lineHeight: 1.5, maxInlineSize: '320px', gap: '48px', margin: '32px' },
        })
        let lastLabel: string | null = null
        renderer.on('relocate', event => {
            lastLabel = event.tocItem?.label ?? null
        })

        await renderer.open(book)
        await renderer.goTo(0)

        expect(lastLabel).toBe('Chapter')

        renderer.destroy()
    })

    it('activates real EPUB TOC entries whose anchors resolve to section start offsets', async () => {
        const buf = await readFile('data/4.epub')
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
        const book = await epub().parse(ab, {
            domAdapter: new TestDOMAdapter(),
            urlFactory: new TestURLFactory(),
        })
        const flatTOC = flattenTestTOC(book.toc ?? [])
        const target = flatTOC
            .map(item => ({ item, resolved: book.resolveHref?.(item.href) }))
            .find(({ item, resolved }) => resolved && resolved.index > 0 && !item.href.includes('#'))

        expect(target).toBeDefined()

        const container = document.createElement('div')
        container.setAttribute('data-width', '760')
        container.setAttribute('data-height', '180')
        document.body.appendChild(container)

        const renderer = new VirtualTextRenderer({
            container,
            layout: 'paginated',
            maxColumnCount: 2,
            styles: { fontSize: '16px', lineHeight: 1.5, maxInlineSize: '320px', margin: '32px' },
        })
        let lastHref: string | null = null
        renderer.on('relocate', event => {
            lastHref = event.tocItem?.href ?? null
        })

        await renderer.open(book)
        await renderer.goTo(target!.resolved!.index)

        expect(lastHref).toBe(target!.item.href)

        renderer.destroy()
        book.destroy?.()
    })

    it('does not replace an explicit null renderer TOC item with ReaderView section fallback', async () => {
        const container = document.createElement('div')
        container.setAttribute('data-width', '360')
        container.setAttribute('data-height', '96')
        document.body.appendChild(container)

        const book: Book = {
            sections: [{
                id: 0,
                size: 120,
                format: 'xhtml',
                load: () => '<p>No matching heading here</p>',
                getBlocks: () => [{
                    id: 'body',
                    type: 'paragraph',
                    segments: [{ text: 'No matching heading here' }],
                }],
            }],
            toc: [
                { label: 'Missing Anchor', href: 'missing' },
            ],
            resolveHref: () => ({ index: 0, anchor: () => '[id="missing"]' }),
            splitTOCHref: () => [0, null],
        }

        const reader = createReader({
            container,
            layout: 'paginated',
            styles: { fontSize: '16px', lineHeight: 1.5, maxInlineSize: '280px', margin: '16px' },
        })
        let lastLabel = 'not-called'
        reader.on('relocate', event => {
            lastLabel = event.tocItem?.label ?? 'null'
        })

        await reader.openBook(book)
        await reader.goTo(0)

        expect(lastLabel).toBe('null')
        expect(reader.getLocation()?.tocItem).toBeNull()

        reader.destroy()
    })

    it('keeps the clicked cover active for data/1.azw3 when a follow-up scroll relocate fires', async () => {
        const buf = await readFile('data/1.azw3')
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
        const book = await mobi().parse(ab, {
            domAdapter: new TestDOMAdapter(),
            urlFactory: new TestURLFactory(),
        })
        const cover = book.toc?.[0]
        const last = flattenTestTOC(book.toc ?? []).at(-1)

        expect(cover?.label).toBe('封面')
        expect(last?.href).not.toBe(cover?.href)

        const container = document.createElement('div')
        container.setAttribute('data-width', '960')
        container.setAttribute('data-height', '480')
        document.body.appendChild(container)

        const reader = createReader({
            container,
            layout: 'paginated',
            maxColumnCount: 2,
            styles: { fontSize: '16px', lineHeight: 1.7, minColumnWidth: '320px', maxColumnWidth: '720px', margin: '32px' },
        })
        let activeHref: string | null = null
        reader.on('relocate', event => {
            const href = event.tocItem?.href ?? null
            if (!href || href === activeHref) return
            activeHref = href
        })

        await reader.openBook(book)
        await reader.goTo(cover!.href)
        ;(container.firstElementChild as HTMLElement).dispatchEvent(new window.Event('scroll'))

        expect(activeHref).toBe(cover!.href)
        expect(activeHref).not.toBe(last!.href)

        reader.destroy()
        book.destroy?.()
    }, 10000)

    it('activates the first TOC entry on initial load for data/1.mobi', async () => {
        const buf = await readFile('data/1.mobi')
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
        const book = await mobi().parse(ab, {
            domAdapter: new TestDOMAdapter(),
            urlFactory: new TestURLFactory(),
        })

        expect(book.toc?.[0]?.label).toBe('版权信息')

        const container = document.createElement('div')
        container.setAttribute('data-width', '960')
        container.setAttribute('data-height', '480')
        document.body.appendChild(container)

        const reader = createReader({
            container,
            layout: 'paginated',
            maxColumnCount: 2,
            styles: { fontSize: '16px', lineHeight: 1.7, minColumnWidth: '320px', maxColumnWidth: '720px', margin: '32px' },
        })
        let activeLabel: string | null = null
        reader.on('relocate', event => {
            activeLabel = event.tocItem?.label ?? null
        })

        await reader.openBook(book)
        await reader.goTo(0)

        expect(activeLabel).toBe('版权信息')

        reader.destroy()
        book.destroy?.()
    })

    it('keeps data/1.mobi active TOC order monotonic while paging forward', async () => {
        const buf = await readFile('data/1.mobi')
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
        const book = await mobi().parse(ab, {
            domAdapter: new TestDOMAdapter(),
            urlFactory: new TestURLFactory(),
        })
        const tocOrder = new Map(flattenTestTOC(book.toc ?? []).map((item, index) => [item.href, index]))

        const container = document.createElement('div')
        container.setAttribute('data-width', '960')
        container.setAttribute('data-height', '480')
        document.body.appendChild(container)

        const reader = createReader({
            container,
            layout: 'paginated',
            maxColumnCount: 2,
            styles: { fontSize: '16px', lineHeight: 1.7, minColumnWidth: '320px', maxColumnWidth: '720px', margin: '32px' },
        })
        const activeIndexes: number[] = []
        reader.on('relocate', event => {
            const href = event.tocItem?.href
            const index = href ? tocOrder.get(href) : undefined
            if (index != null) activeIndexes.push(index)
        })

        await reader.openBook(book)
        await reader.goTo(0)
        for (let i = 0; i < 40; i++) await reader.next()

        expect(activeIndexes.length).toBeGreaterThan(0)
        for (let i = 1; i < activeIndexes.length; i++) {
            expect(activeIndexes[i]).toBeGreaterThanOrEqual(activeIndexes[i - 1])
        }

        reader.destroy()
        book.destroy?.()
    })
})

function flattenTestTOC(items: NonNullable<Book['toc']>): NonNullable<Book['toc']>[number][] {
    return items.flatMap(item =>
        item.subitems?.length
            ? [item, ...flattenTestTOC(item.subitems)]
            : [item]
    )
}
