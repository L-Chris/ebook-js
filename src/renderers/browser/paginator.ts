/**
 * Browser Paginator
 *
 * Handles paginated and scrolled rendering of book sections using
 * CSS multi-column layout in iframes.
 */

import type { Book, Section, ResolvedNavigation } from '../../core/types'
import type { Renderer, RendererConfig, RendererStyles, LayoutMode } from '../../core/renderer'
import type { LoadEvent, RelocateEvent, LinkEvent } from '../../core/types'
import { SectionProgress } from '../../utils/progress'

// ============================================================================
// Constants
// ============================================================================

/** Delay to let CSS column layout settle before scrolling to anchor */
const LAYOUT_SETTLE_MS = 50

/** Delay to emit relocate event after animated page turn */
const ANIMATION_SETTLE_MS = 300

/** Debounce interval for container resize */
const RESIZE_DEBOUNCE_MS = 200

/** Debounce interval for DOM mutation observations */
const MUTATION_DEBOUNCE_MS = 100

// ============================================================================
// Utilities
// ============================================================================

const debounce = <T extends (...args: unknown[]) => void>(
    fn: T, wait: number
): T => {
    let timeout: ReturnType<typeof setTimeout>
    return ((...args: unknown[]) => {
        clearTimeout(timeout)
        timeout = setTimeout(() => fn(...args), wait)
    }) as T
}

/**
 * Get bounding client rect, working around Firefox bug with zero-width rects.
 */
const getBoundingClientRect = (target: Range | Element): DOMRect => {
    let top = Infinity, right = -Infinity, left = Infinity, bottom = -Infinity
    for (const rect of target.getClientRects()) {
        left = Math.min(left, rect.left)
        top = Math.min(top, rect.top)
        right = Math.max(right, rect.right)
        bottom = Math.max(bottom, rect.bottom)
    }
    return new DOMRect(left, top, right - left, bottom - top)
}

/**
 * Find the visible text range within the viewport.
 */
const getVisibleRange = (
    doc: Document,
    start: number,
    end: number,
    mapRect: (rect: DOMRect) => { left: number; right: number },
): Range | null => {
    const filter: NodeFilter = {
        acceptNode(node) {
            const name = (node as Element).localName?.toLowerCase()
            if (name === 'script' || name === 'style') return NodeFilter.FILTER_REJECT
            if (node.nodeType === 1) {
                const { left, right } = mapRect((node as Element).getBoundingClientRect())
                if (left === 0 && right === 0) return NodeFilter.FILTER_REJECT
                if (right < start || left > end) return NodeFilter.FILTER_REJECT
                if (left >= start && right <= end) return NodeFilter.FILTER_ACCEPT
                return NodeFilter.FILTER_SKIP
            }
            return NodeFilter.FILTER_ACCEPT
        },
    }

    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, filter)
    const firstNode = walker.nextNode()
    if (!firstNode) return null

    const range = doc.createRange()

    if (firstNode.nodeType === 3) {
        range.setStart(firstNode, 0)
    } else {
        range.setStartBefore(firstNode)
    }

    let lastNode = firstNode
    while (walker.nextNode()) lastNode = walker.currentNode

    if (lastNode.nodeType === 3) {
        range.setEnd(lastNode, lastNode.textContent?.length ?? 0)
    } else {
        range.setEndAfter(lastNode)
    }

    return range
}

// ============================================================================
// View (iframe wrapper)
// ============================================================================

interface ViewOptions {
    container: HTMLElement
    onLink: (href: string) => void
    onResize?: () => void
}

class View {
    iframe: HTMLIFrameElement
    doc: Document | null = null
    index = -1
    columnCount = 1
    contentWidth = 0
    private mutationObserver: MutationObserver | null = null

    constructor(private options: ViewOptions) {
        this.iframe = document.createElement('iframe')
        this.iframe.setAttribute('scrolling', 'no')
        this.iframe.style.cssText = `
            border: none;
            width: 100%;
            height: 100%;
            overflow: hidden;
        `
        this.options.container.appendChild(this.iframe)
    }

    async load(src: string, index: number): Promise<void> {
        this.index = index
        return new Promise((resolve, reject) => {
            this.iframe.onload = () => {
                this.doc = this.iframe.contentDocument
                if (!this.doc) {
                    reject(new Error('Failed to access iframe document'))
                    return
                }
                this.setupDocument()
                resolve()
            }
            this.iframe.onerror = () => reject(new Error('Failed to load section'))
            this.iframe.src = src
        })
    }

    private setupDocument(): void {
        if (!this.doc) return

        // Handle link clicks
        this.doc.addEventListener('click', (e) => {
            const a = (e.target as Element).closest?.('a[href]') as HTMLAnchorElement
            if (!a) return
            e.preventDefault()
            const href = a.getAttribute('href')
            if (href) this.options.onLink(href)
        })

        // Observe DOM mutations for layout changes — delegate to parent
        this.mutationObserver?.disconnect()
        if (this.options.onResize) {
            const handler = debounce(this.options.onResize, MUTATION_DEBOUNCE_MS)
            this.mutationObserver = new MutationObserver(() => handler())
            this.mutationObserver.observe(this.doc.body, {
                childList: true,
                subtree: true,
                characterData: true,
            })
        }
    }

    applyStyles(styles: RendererStyles): void {
        if (!this.doc) return
        const style = this.doc.createElement('style')
        style.textContent = `
            html, body {
                margin: 0;
                padding: 0;
            }
            body {
                font-family: ${styles.fontFamily ?? 'Georgia, serif'};
                font-size: ${styles.fontSize ?? '16px'};
                line-height: ${styles.lineHeight ?? 1.6};
                text-align: ${styles.textAlign ?? 'justify'};
                ${styles.hyphenate !== false ? `
                    -webkit-hyphens: auto;
                    hyphens: auto;
                ` : ''}
                ${styles.color ? `color: ${styles.color};` : ''}
                ${styles.background ? `background: ${styles.background};` : ''}
            }
            img { max-width: 100%; height: auto; }
            pre { white-space: pre-wrap; }
            ${styles.css ?? ''}
        `
        this.doc.head.appendChild(style)
    }

    /**
     * Set up paginated layout using CSS multi-column.
     */
    paginate(pageWidth: number, pageHeight: number, gap: number): void {
        if (!this.doc?.documentElement) return
        const html = this.doc.documentElement
        html.style.columnWidth = `${pageWidth}px`
        html.style.columnGap = `${gap}px`
        html.style.height = `${pageHeight}px`
        html.style.overflow = 'hidden'
        html.style.columnFill = 'auto'

        this.contentWidth = html.scrollWidth
        this.columnCount = Math.max(1, Math.ceil(this.contentWidth / (pageWidth + gap)))
    }

    /**
     * Set up scrolled layout (no columns).
     */
    unpaginate(): void {
        if (!this.doc?.documentElement) return
        const html = this.doc.documentElement
        html.style.columnWidth = ''
        html.style.columnGap = ''
        html.style.columnFill = ''
        html.style.height = ''
        html.style.overflow = 'auto'
        this.contentWidth = 0
        this.columnCount = 1
    }

    scrollToAnchor(anchor: ResolvedNavigation['anchor']): void {
        if (!this.doc || anchor === undefined) return
        let target: Element | Range | number | null

        if (typeof anchor === 'function') {
            target = (anchor as (doc: Document) => Element | Range | number | null)(this.doc) ?? null
        } else {
            target = anchor as Element | Range | number | null
        }

        if (typeof target === 'number') {
            this.iframe.contentWindow?.scrollTo(0, target)
        } else if (target instanceof Element) {
            target.scrollIntoView({ block: 'start' })
        } else if (target instanceof Range) {
            const rect = target.getBoundingClientRect()
            this.iframe.contentWindow?.scrollBy(0, rect.top - 20)
        }
    }

    getVisibleRange(pageWidth: number): Range | null {
        if (!this.doc) return null
        const scrollLeft = this.iframe.contentWindow?.scrollX ?? 0
        return getVisibleRange(this.doc, scrollLeft, scrollLeft + pageWidth, rect => rect)
    }

    destroy(): void {
        this.mutationObserver?.disconnect()
        this.iframe.remove()
    }
}

// ============================================================================
// Browser Renderer
// ============================================================================

interface RendererEventMap {
    load: LoadEvent
    relocate: RelocateEvent
    link: LinkEvent
}

type Listener<T> = (event: T) => void

export class BrowserRenderer implements Renderer {
    private container: HTMLElement
    private wrapper: HTMLElement
    private view: View | null = null
    private book: Book | null = null
    private sections: Section[] = []
    private currentIndex = -1
    private currentFraction = 0
    private pageWidth = 0
    private pageHeight = 0
    private layout: LayoutMode
    private styles: RendererStyles
    private animated: boolean
    private listeners = new Map<string, Set<Listener<unknown>>>()
    private progress: SectionProgress | null = null
    private lastLocation: RelocateEvent | null = null
    private resizeObserver: ResizeObserver
    private isNavigating = false

    constructor(config: RendererConfig) {
        this.container = config.container
        this.layout = config.layout ?? 'paginated'
        this.styles = config.styles ?? {}
        this.animated = config.animated ?? true

        // Create wrapper
        this.wrapper = document.createElement('div')
        this.wrapper.style.cssText = `
            width: 100%;
            height: 100%;
            overflow: hidden;
            position: relative;
        `
        this.container.appendChild(this.wrapper)

        // Handle container resize
        this.resizeObserver = new ResizeObserver(debounce(() => {
            this.onResize()
        }, RESIZE_DEBOUNCE_MS))
        this.resizeObserver.observe(this.container)
    }

    async open(book: Book): Promise<void> {
        this.book = book
        this.sections = book.sections

        // Use SectionProgress for consistent progress calculation
        this.progress = new SectionProgress(this.sections)

        // Check if this is a fixed-layout book
        if (book.rendition?.layout === 'pre-paginated') {
            this.layout = 'scrolled'
        }
    }

    private getPageSize(): { width: number; height: number; gap: number } {
        const rect = this.wrapper.getBoundingClientRect()
        const margin = parseInt(this.styles.margin ?? '48') || 48
        const gap = parseInt(this.styles.gap ?? '48') || 48
        const maxWidth = parseInt(this.styles.maxInlineSize ?? '720') || 720
        const maxHeight = parseInt(this.styles.maxBlockSize ?? '0') || 0

        const width = Math.min(maxWidth, rect.width - margin * 2)
        const height = maxHeight > 0 ? Math.min(maxHeight, rect.height - margin * 2) : rect.height - margin * 2

        return { width: Math.max(200, width), height: Math.max(200, height), gap }
    }

    private async loadSection(index: number, anchor?: ResolvedNavigation['anchor']): Promise<void> {
        if (index < 0 || index >= this.sections.length) return
        if (this.isNavigating) return
        this.isNavigating = true

        try {
            // Unload current section
            if (this.view && this.currentIndex >= 0) {
                this.sections[this.currentIndex]?.unload?.()
                this.view.destroy()
            }

            // Create new view — delegate resize notifications to paginator
            this.view = new View({
                container: this.wrapper,
                onLink: (href) => this.handleLink(href),
                onResize: () => this.onResize(),
            })

            // Load section content
            const src = await this.sections[index].load()
            await this.view.load(src, index)

            // Apply styles
            this.view.applyStyles(this.styles)

            // Set up layout
            const { width, height, gap } = this.getPageSize()
            if (this.layout === 'paginated') {
                this.view.paginate(width, height, gap)
                this.pageWidth = width
                this.pageHeight = height
            } else {
                this.view.unpaginate()
            }

            // Scroll to anchor if provided
            if (anchor !== undefined) {
                await new Promise(r => setTimeout(r, LAYOUT_SETTLE_MS))
                this.view.scrollToAnchor(anchor)
            }

            this.currentIndex = index

            // Emit events
            this.emit('load', { doc: this.view.doc!, index })
            this.emitRelocate('snap')
        } finally {
            this.isNavigating = false
        }
    }

    private emitRelocate(reason: string): void {
        if (!this.view?.doc) return

        const range = this.layout === 'paginated'
            ? this.view.getVisibleRange(this.pageWidth)
            : null

        const scrollLeft = this.view.iframe.contentWindow?.scrollX ?? 0
        const maxScroll = this.view.contentWidth - this.pageWidth
        const fraction = maxScroll > 0 ? scrollLeft / maxScroll : 0

        this.currentFraction = fraction

        const event: RelocateEvent = {
            range: range ?? undefined,
            index: this.currentIndex,
            fraction,
            totalFraction: this.getTotalFraction(),
            reason,
        }

        this.lastLocation = event
        this.emit('relocate', event)
    }

    private getTotalFraction(): number {
        if (!this.progress) return 0
        return this.progress.getProgress(this.currentIndex, this.currentFraction).fraction
    }

    /**
     * Resolve a link href using the Book's resolveHref/isExternal methods
     * when available, falling back to a basic implementation.
     */
    private handleLink(href: string): void {
        // Delegate external check to Book if available
        const isExt = this.book?.isExternal
            ? this.book.isExternal(href)
            : /^(?!blob)\w+:/i.test(href)

        if (isExt) {
            this.emit('link', { href, external: true })
            return
        }

        // Delegate resolution to Book if available
        const resolved = this.book?.resolveHref
            ? this.book.resolveHref(href)
            : this.resolveHrefFallback(href)

        if (resolved) {
            this.emit('link', { href, external: false })
            this.loadSection(resolved.index, resolved.anchor)
        } else {
            this.emit('link', { href, external: true })
        }
    }

    /**
     * Fallback href resolution when Book.resolveHref is not available.
     */
    private resolveHrefFallback(href: string): ResolvedNavigation | null {
        const [path, hash] = href.split('#')
        const index = this.sections.findIndex(s => {
            if (typeof s.id === 'string') {
                return s.id === path || s.id.endsWith(path)
            }
            return false
        })
        if (index < 0) return null
        const anchor = hash ? (doc: Document) => doc.getElementById(hash) : undefined
        return { index, anchor }
    }

    private onResize(): void {
        if (this.view && this.layout === 'paginated') {
            const { width, height, gap } = this.getPageSize()
            this.view.paginate(width, height, gap)
            this.pageWidth = width
            this.pageHeight = height
            this.emitRelocate('resize')
        }
    }

    // ---- Public API ----

    async goTo(target: number | string): Promise<void> {
        if (typeof target === 'number') {
            await this.loadSection(target)
        } else {
            const resolved = this.book?.resolveHref?.(target)
                ?? this.resolveHrefFallback(target)
            if (resolved) {
                await this.loadSection(resolved.index, resolved.anchor)
            }
        }
    }

    async next(): Promise<void> {
        if (!this.view) return

        if (this.layout === 'paginated') {
            const scrollLeft = this.view.iframe.contentWindow?.scrollX ?? 0
            const maxScroll = this.view.contentWidth - this.pageWidth

            if (scrollLeft < maxScroll - 1) {
                const newScroll = Math.min(maxScroll, scrollLeft + this.pageWidth)
                this.view.iframe.contentWindow?.scrollTo({
                    left: newScroll,
                    behavior: this.animated ? 'smooth' : 'instant',
                })
                setTimeout(() => this.emitRelocate('page'), ANIMATION_SETTLE_MS)
            } else {
                if (this.currentIndex < this.sections.length - 1) {
                    await this.loadSection(this.currentIndex + 1)
                }
            }
        } else {
            const win = this.view.iframe.contentWindow
            if (!win) return
            const { height } = this.getPageSize()
            const maxScroll = this.view.doc!.documentElement.scrollHeight - height

            if (win.scrollY < maxScroll - 1) {
                win.scrollBy({ top: height, behavior: this.animated ? 'smooth' : 'instant' })
                setTimeout(() => this.emitRelocate('scroll'), ANIMATION_SETTLE_MS)
            } else if (this.currentIndex < this.sections.length - 1) {
                await this.loadSection(this.currentIndex + 1)
            }
        }
    }

    async prev(): Promise<void> {
        if (!this.view) return

        if (this.layout === 'paginated') {
            const scrollLeft = this.view.iframe.contentWindow?.scrollX ?? 0

            if (scrollLeft > 1) {
                const newScroll = Math.max(0, scrollLeft - this.pageWidth)
                this.view.iframe.contentWindow?.scrollTo({
                    left: newScroll,
                    behavior: this.animated ? 'smooth' : 'instant',
                })
                setTimeout(() => this.emitRelocate('page'), ANIMATION_SETTLE_MS)
            } else {
                if (this.currentIndex > 0) {
                    await this.loadSection(this.currentIndex - 1, (_doc: Document) => {
                        return null // Will scroll to end after load
                    })
                    // Scroll to end after loading
                    if (this.view) {
                        const maxScroll = this.view.contentWidth - this.pageWidth
                        this.view.iframe.contentWindow?.scrollTo(maxScroll, 0)
                    }
                }
            }
        } else {
            const win = this.view.iframe.contentWindow
            if (!win) return
            const { height } = this.getPageSize()

            if (win.scrollY > 1) {
                win.scrollBy({ top: -height, behavior: this.animated ? 'smooth' : 'instant' })
                setTimeout(() => this.emitRelocate('scroll'), ANIMATION_SETTLE_MS)
            } else if (this.currentIndex > 0) {
                await this.loadSection(this.currentIndex - 1)
            }
        }
    }

    async goToFraction(fraction: number): Promise<void> {
        fraction = Math.max(0, Math.min(1, fraction))

        if (!this.progress) return

        const [index, fractionInSection] = this.progress.getSection(fraction)
        await this.loadSection(index)

        // Scroll to fraction within section
        if (this.view && this.layout === 'paginated') {
            const maxScroll = this.view.contentWidth - this.pageWidth
            this.view.iframe.contentWindow?.scrollTo(maxScroll * fractionInSection, 0)
            this.emitRelocate('fraction')
        }
    }

    setStyles(styles: RendererStyles): void {
        this.styles = { ...this.styles, ...styles }
        this.view?.applyStyles(this.styles)

        if (this.layout === 'paginated' && this.view) {
            const { width, height, gap } = this.getPageSize()
            this.view.paginate(width, height, gap)
            this.pageWidth = width
            this.pageHeight = height
        }
    }

    setLayout(mode: LayoutMode): void {
        if (this.layout === mode) return
        this.layout = mode

        if (this.view) {
            if (mode === 'paginated') {
                const { width, height, gap } = this.getPageSize()
                this.view.paginate(width, height, gap)
                this.pageWidth = width
                this.pageHeight = height
            } else {
                this.view.unpaginate()
            }
        }
    }

    getLocation(): RelocateEvent | null {
        return this.lastLocation
    }

    getSectionFractions(): number[] {
        return this.progress?.getFractions() ?? []
    }

    on<K extends keyof RendererEventMap>(event: K, listener: Listener<RendererEventMap[K]>): void
    on(event: string, listener: Listener<unknown>): void
    on(event: string, listener: Listener<unknown>): void {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set())
        }
        this.listeners.get(event)!.add(listener)
    }

    off<K extends keyof RendererEventMap>(event: K, listener: Listener<RendererEventMap[K]>): void
    off(event: string, listener: Listener<unknown>): void
    off(event: string, listener: Listener<unknown>): void {
        this.listeners.get(event)?.delete(listener)
    }

    private emit<K extends keyof RendererEventMap>(event: K, data: RendererEventMap[K]): void {
        this.listeners.get(event)?.forEach(fn => fn(data))
    }

    destroy(): void {
        this.resizeObserver.disconnect()
        this.view?.destroy()
        this.wrapper.remove()
        this.listeners.clear()
        this.book = null
    }
}

/**
 * Create a browser renderer instance.
 */
export const createBrowserRenderer = (config: RendererConfig): Renderer => {
    return new BrowserRenderer(config)
}
