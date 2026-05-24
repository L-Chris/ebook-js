/**
 * High-level view that ties together a parser and a renderer.
 * Provides a simple API for opening and reading books.
 */

import type { Book, RelocateEvent, LoadEvent, TOCItem } from '../../core/types'
import type { ParserInput, ParserOptions } from '../../core/parser'
import type { RendererConfig, RendererStyles, LayoutMode, Renderer } from '../../core/renderer'
import { registry } from '../../core/parser'
import { VirtualTextRenderer } from './virtual-text'
import { BrowserDOMAdapter, BrowserURLFactory } from '../../adapters/browser'

// ============================================================================
// Reader View
// ============================================================================

export interface ReaderConfig extends Omit<RendererConfig, 'container'> {
    /** Container element */
    container: HTMLElement
    /**
     * Browser rendering backend.
     * Default: 'virtual-text' (AST -> preset blocks -> Pretext -> visible DOM rows).
     */
    renderer?: 'virtual-text'
    /** Parser options */
    parserOptions?: ParserOptions
    /** Auto-register default parsers */
    autoRegister?: boolean
}

/**
 * High-level reader that combines parsing and rendering.
 */
export class ReaderView {
    private renderer: Renderer
    private book: Book | null = null
    private config: ReaderConfig
    private registeredListeners: Array<{
        event: string
        listener: (e: any) => void
        wrappedListener: (e: any) => void
    }> = []

    constructor(config: ReaderConfig) {
        this.config = config
        this.renderer = this.createRenderer()
    }

    /**
     * Open a book from a file, URL, or blob.
     */
    async open(input: ParserInput): Promise<Book> {
        this.close()
        this.resetRenderer()

        // Auto-wire browser adapters if not provided
        const options: ParserOptions = {
            domAdapter: new BrowserDOMAdapter(),
            urlFactory: new BrowserURLFactory(),
            ...this.config.parserOptions,
        }

        // Use registry to auto-detect and parse
        const book = await registry.open(input, options)
        this.book = book

        // Open in renderer
        await this.renderer.open(book)

        return book
    }

    /**
     * Open an already-parsed book.
     */
    async openBook(book: Book): Promise<void> {
        this.close()
        this.resetRenderer()
        this.book = book
        await this.renderer.open(book)
    }

    /**
     * Get the current book.
     */
    getBook(): Book | null {
        return this.book
    }

    /**
     * Get book metadata.
     */
    getMetadata() {
        return this.book?.metadata
    }

    /**
     * Get table of contents.
     */
    getTOC(): readonly TOCItem[] | undefined {
        return this.book?.toc
    }

    /**
     * Navigate to a location.
     */
    async goTo(target: number | string): Promise<void> {
        await this.renderer.goTo(target)
    }

    /**
     * Go to next page.
     */
    async next(): Promise<void> {
        await this.renderer.next()
    }

    /**
     * Go to previous page.
     */
    async prev(): Promise<void> {
        await this.renderer.prev()
    }

    /**
     * Navigate right (respects RTL).
     */
    async goRight(): Promise<void> {
        if (this.book?.dir === 'rtl') {
            await this.prev()
        } else {
            await this.next()
        }
    }

    /**
     * Navigate left (respects RTL).
     */
    async goLeft(): Promise<void> {
        if (this.book?.dir === 'rtl') {
            await this.next()
        } else {
            await this.prev()
        }
    }

    /**
     * Navigate by fraction (0-1).
     */
    async goToFraction(fraction: number): Promise<void> {
        await this.renderer.goToFraction(fraction)
    }

    /**
     * Get section fractions for progress bar.
     */
    getSectionFractions(): number[] {
        return this.renderer.getSectionFractions()
    }

    /**
     * Get current reading location.
     */
    getLocation(): RelocateEvent | null {
        const location = this.renderer.getLocation()
        if (location && !location.tocItem) {
            location.tocItem = this.getCurrentTOCItem(location)
        }
        return location
    }

    /**
     * Get current TOC item based on location
     */
    getCurrentTOCItem(location?: RelocateEvent | null): TOCItem | null {
        if (!this.book || !this.book.toc) return null
        const loc = location ?? this.getLocation()
        if (!loc) return null

        let activeItem: TOCItem | null = null
        let maxIndex = -1

        const checkItem = (item: TOCItem) => {
            if (this.book!.splitTOCHref) {
                try {
                    const parts = this.book!.splitTOCHref(item.href)
                    if (parts && Array.isArray(parts)) {
                        const [id] = parts
                        const index = this.book!.sections.findIndex(s => s.id === id)
                        if (index >= 0) {
                            if (index <= loc.index && index >= maxIndex) {
                                maxIndex = index
                                activeItem = item
                            }
                        }
                    }
                } catch (e) {
                    console.error('Error in splitTOCHref:', e)
                }
            }
            if (item.subitems) {
                for (const sub of item.subitems) checkItem(sub)
            }
        }

        for (const item of this.book.toc) {
            checkItem(item)
        }
        return activeItem
    }

    /**
     * Update styles.
     */
    setStyles(styles: RendererStyles): void {
        this.renderer.setStyles(styles)
    }

    /**
     * Set layout mode.
     */
    setLayout(mode: LayoutMode): void {
        this.renderer.setLayout(mode)
    }

    /**
     * Set maximum number of visible columns (pages).
     * 1 = single page, 2 = auto spread (two pages when wide enough).
     */
    setSpread(maxColumns: number): void {
        this.renderer.setSpread(maxColumns)
    }

    /**
     * Register an event listener.
     */
    on(event: 'load', listener: (e: LoadEvent) => void): void
    on(event: 'relocate', listener: (e: RelocateEvent) => void): void
    on(event: 'link', listener: (e: { href: string; external: boolean }) => void): void
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, listener: (e: any) => void): void {
        let wrappedListener = listener
        if (event === 'relocate') {
            wrappedListener = (e: RelocateEvent) => {
                if (!e.tocItem) e.tocItem = this.getCurrentTOCItem(e)
                listener(e)
            }
        }

        this.renderer.on(event, wrappedListener)
        this.registeredListeners.push({ event, listener, wrappedListener })
    }

    /**
     * Remove an event listener.
     */
    off(event: string, listener: (e: unknown) => void): void {
        const index = this.registeredListeners.findIndex(
            item => item.event === event && item.listener === listener
        )
        if (index >= 0) {
            const { wrappedListener } = this.registeredListeners[index]
            this.renderer.off(event, wrappedListener)
            this.registeredListeners.splice(index, 1)
        }
    }

    /**
     * Close the current book and clean up.
     */
    close(): void {
        this.book?.destroy?.()
        this.book = null
    }

    /**
     * Destroy the reader and release all resources.
     */
    destroy(): void {
        this.close()
        this.renderer.destroy()
        this.registeredListeners = []
    }

    private createRenderer(): Renderer {
        return new VirtualTextRenderer(this.config)
    }

    private resetRenderer(): void {
        this.renderer.destroy()
        this.renderer = this.createRenderer()
        // Re-bind all registered listeners to the new renderer
        for (const item of this.registeredListeners) {
            this.renderer.on(item.event, item.wrappedListener)
        }
    }
}

/**
 * Create a new ReaderView instance.
 */
export const createReader = (config: ReaderConfig): ReaderView => {
    return new ReaderView(config)
}
