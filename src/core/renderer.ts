/**
 * Renderer interface.
 *
 * A renderer takes a Book object and displays it on a specific platform.
 * It handles pagination, scrolling, navigation, and user interactions.
 */

import type { Book, RelocateEvent, LoadEvent } from './types'

/**
 * Style options for the renderer.
 */
export interface RendererStyles {
    /** Font family */
    fontFamily?: string
    /** Font size (CSS value) */
    fontSize?: string
    /** Line height (number or CSS value) */
    lineHeight?: number | string
    /** Text alignment */
    textAlign?: 'start' | 'justify' | 'center'
    /** Enable hyphenation */
    hyphenate?: boolean
    /** Custom CSS to inject */
    css?: string
    /** Theme: light, dark, or custom */
    theme?: 'light' | 'dark' | 'sepia'
    /** Text color */
    color?: string
    /** Background color */
    background?: string
    /** Column gap (for paginated mode) */
    gap?: string
    /** Maximum column width (for paginated mode) */
    maxInlineSize?: string
    /** Minimum column width — switch to single column below this (virtual-text renderer) */
    minColumnWidth?: string
    /** Maximum column width per column (virtual-text renderer) */
    maxColumnWidth?: string
    /** Maximum page height (for paginated mode) */
    maxBlockSize?: string
    /** Header/footer margin */
    margin?: string
}

/**
 * Layout mode for the renderer.
 */
export type LayoutMode = 'paginated' | 'scrolled'

/**
 * Configuration for creating a renderer.
 */
export interface RendererConfig {
    /** The container element to render into */
    container: HTMLElement
    /** Initial layout mode */
    layout?: LayoutMode
    /** Initial styles */
    styles?: RendererStyles
    /** Enable page turn animations */
    animated?: boolean
    /** Maximum number of columns in paginated mode */
    maxColumnCount?: number
}

/**
 * Event listener type.
 */
export type EventListener<T = unknown> = (event: T) => void

/**
 * The Renderer interface.
 * Implement this to add support for a new platform.
 */
export interface Renderer {
    /**
     * Open a book for rendering.
     */
    open(book: Book): Promise<void>

    /**
     * Navigate to a specific location.
     * @param target - Section index, href string, or CFI string
     */
    goTo(target: number | string): Promise<void>

    /**
     * Go to the next page/section.
     */
    next(): Promise<void>

    /**
     * Go to the previous page/section.
     */
    prev(): Promise<void>

    /**
     * Navigate by fraction (0-1) of total book progress.
     */
    goToFraction(fraction: number): Promise<void>

    /**
     * Update rendering styles.
     */
    setStyles(styles: RendererStyles): void

    /**
     * Set the layout mode.
     */
    setLayout(mode: LayoutMode): void

    /**
     * Set the maximum number of visible columns (pages) in paginated mode.
     * 1 = single page, 2 = two-page spread when the container is wide enough.
     * In 'auto' mode (value 2), the renderer dynamically switches between
     * 1 and 2 columns based on the available container width.
     */
    setSpread(maxColumns: number): void

    /**
     * Get the current reading location.
     */
    getLocation(): RelocateEvent | null

    /**
     * Get section progress fractions (for progress bar tick marks).
     */
    getSectionFractions(): number[]

    /**
     * Register an event listener.
     */
    on(event: string, listener: EventListener): void

    /**
     * Remove an event listener.
     */
    off(event: string, listener: EventListener): void

    /**
     * Clean up and release resources.
     */
    destroy(): void
}

/**
 * A renderer factory creates renderer instances.
 */
export type RendererFactory = (config: RendererConfig) => Renderer
