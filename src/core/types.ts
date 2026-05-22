/**
 * Core types for the ebook-js library.
 * These define the contract between parsers and renderers.
 */

// ============================================================================
// Metadata
// ============================================================================

/**
 * A language map allows values to be localized.
 * Can be a plain string or an object mapping language codes to values.
 * Example: { en: "The Title", zh: "书名" }
 */
export type LanguageMap = string | Record<string, string>

/**
 * A contributor can be a simple name string or a detailed object.
 */
export type Contributor = string | {
    name: LanguageMap
    role?: string | string[]
    sortAs?: LanguageMap
}

/**
 * Book metadata following a subset of Readium WebPub Manifest conventions.
 */
export interface BookMetadata {
    title?: LanguageMap
    subtitle?: LanguageMap
    author?: Contributor | Contributor[]
    editor?: Contributor | Contributor[]
    translator?: Contributor | Contributor[]
    illustrator?: Contributor | Contributor[]
    narrator?: Contributor | Contributor[]
    contributor?: Contributor | Contributor[]
    publisher?: Contributor | LanguageMap
    published?: string
    modified?: string
    language?: string | string[]
    description?: string
    subject?: string | string[]
    identifier?: string
    rights?: string
    belongsTo?: {
        series?: { name: LanguageMap; position?: string; total?: string }
        collection?: { name: LanguageMap }
    }
    [key: string]: unknown
}

// ============================================================================
// Table of Contents
// ============================================================================

/**
 * A single item in the table of contents or page list.
 */
export interface TOCItem {
    /** Display label */
    label: string
    /** Navigation target (href string) */
    href: string
    /** Nested items */
    subitems?: TOCItem[]
}

/**
 * A landmark entry (e.g. cover, TOC, bodymatter).
 */
export interface Landmark {
    label: string
    href: string
    type: string[]
}

// ============================================================================
// Sections
// ============================================================================

/**
 * Content format types for sections.
 * - 'xhtml': XHTML document or fragment (used by EPUB, FB2, KF8)
 * - 'html': HTML document or fragment (used by MOBI6)
 * - 'image': Image data (base64 data URI or URL, used by CBZ)
 */
export type SectionFormat = 'xhtml' | 'html' | 'image'

/**
 * A section represents a renderable unit of the book (typically a chapter).
 * The renderer loads sections on demand.
 *
 * Section.load() returns content as a string. The renderer is responsible for:
 * - Wrapping fragments in a full document (if needed)
 * - Creating blob URLs (for web/iframe rendering)
 * - Converting to platform-specific formats (e.g., WXML for WeChat Mini Programs)
 */
export interface Section {
    /** Unique identifier for this section (used as Map key) */
    id: string | number
    /**
     * Load the section and return content as a string.
     * - For 'xhtml'/'html' format: returns HTML/XHTML string (may contain blob URLs for embedded resources)
     * - For 'image' format: returns data URI or base64 string
     * The renderer decides how to display this content.
     */
    load(): Promise<string> | string
    /**
     * Content format. Determines how the renderer should handle the content.
     * Default: 'xhtml'
     */
    format?: SectionFormat
    /**
     * Optional: free resources when the section is unloaded.
     */
    unload?(): void
    /**
     * Optional: return raw content string for searching or text extraction.
     * The renderer can parse this into a DOM if needed.
     */
    createDocument?(): Promise<string> | string
    /**
     * Optional: raw text content for searching.
     */
    loadText?(): Promise<string> | string
    /** Byte size of the section (for progress calculation) */
    size: number
    /**
     * Linear reading sequence flag.
     * "no" means this section is not part of the main reading flow.
     */
    linear?: string
    /** Base CFI string for this section */
    cfi?: string
    /** Resolve an href relative to this section */
    resolveHref?(href: string): string
}

// ============================================================================
// Navigation Resolution
// ============================================================================

/**
 * A resolved navigation target: which section and where within it.
 */
export interface ResolvedNavigation {
    /** Index of the target section in book.sections */
    index: number
    /**
     * A function that, given a document (renderer-specific), returns the target element/range.
     * Can also be a number (offset) or an element directly.
     * The doc parameter is opaque to the parser; the renderer provides its live DOM.
     */
    anchor?: ((doc: unknown) => unknown) | number | unknown
    /** Whether to select/highlight the target */
    select?: boolean
}

// ============================================================================
// Rendition
// ============================================================================

/**
 * Rendition hints from the book.
 */
export interface Rendition {
    layout?: 'reflowable' | 'pre-paginated'
    flow?: 'paginated' | 'scrolled'
    spread?: 'none' | 'auto' | 'landscape'
    orientation?: 'auto' | 'landscape' | 'portrait'
}

// ============================================================================
// Book (the main interface)
// ============================================================================

/**
 * The Book interface is the primary contract between parsers and renderers.
 * A parser takes a file/blob/URL and produces a Book object.
 * A renderer consumes a Book object to display it.
 */
export interface Book {
    /** The ordered list of sections (chapters) in the book */
    sections: Section[]

    /** Page progression direction */
    dir?: 'ltr' | 'rtl'

    /** Table of contents */
    toc?: TOCItem[]

    /** Page list (for page-based navigation) */
    pageList?: TOCItem[]

    /** Landmarks (cover, TOC, bodymatter, etc.) */
    landmarks?: Landmark[]

    /** Book metadata */
    metadata?: BookMetadata

    /** Rendition hints */
    rendition?: Rendition

    /**
     * Resolve an href string to a navigation target.
     * Used for internal link handling.
     */
    resolveHref?(href: string): ResolvedNavigation | null

    /**
     * Resolve a CFI string to a navigation target.
     */
    resolveCFI?(cfi: string): ResolvedNavigation | null

    /**
     * Check if a link should be opened externally.
     */
    isExternal?(href: string): boolean

    /**
     * Split a TOC href into [sectionId, fragment].
     * Used for progress tracking.
     */
    splitTOCHref?(href: string): [id: string | number, fragment: string | null]

    /**
     * Given a document (renderer-specific) and fragment ID, return the target node.
     * Used for progress tracking. The doc and return types are opaque to the parser.
     */
    getTOCFragment?(doc: unknown, id: string | number): unknown

    /**
     * Get the cover image as a Blob.
     */
    getCover?(): Promise<Blob | null> | Blob | null

    /**
     * Clean up resources.
     */
    destroy?(): void
}

// ============================================================================
// Events
// ============================================================================

/**
 * Event emitted when a section is loaded.
 */
export interface LoadEvent {
    doc: unknown
    index: number
}

/**
 * Event emitted when the reading location changes.
 */
export interface RelocateEvent {
    /** The current visible range (renderer-specific type) */
    range?: unknown
    /** Section index */
    index: number
    /** Progress within the section (0-1) */
    fraction: number
    /** Overall progress (0-1) */
    totalFraction?: number
    /** Current TOC item */
    tocItem?: TOCItem | null
    /** Current page item */
    pageItem?: TOCItem | null
    /** CFI of current position */
    cfi?: string
    /** Reason for relocation */
    reason?: string
}

/**
 * Event emitted when a link is clicked.
 */
export interface LinkEvent {
    href: string
    external: boolean
}
