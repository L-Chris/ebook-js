import { parseHTML } from 'linkedom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Book } from '../../src/core/types'
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
})
