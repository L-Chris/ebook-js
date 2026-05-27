/**
 * Core types for the rebook library.
 * These define the contract between parsers and renderers.
 */

// ============================================================================
// Document Model (AI-friendly structured content)
// ============================================================================

/**
 * A node in the document tree, following a SlateJS-inspired model.
 * Used for AI-friendly content manipulation.
 */
export interface DocumentNode {
    /** Node type: 'element', 'text', 'p', 'h1', 'img', etc. */
    readonly type: string
    /** Node attributes (class, id, src, href, etc.) */
    readonly attrs?: Readonly<Record<string, string>>
    /** Child nodes (for element nodes) */
    readonly children?: readonly DocumentNode[]
    /** Text content (for text nodes) */
    readonly text?: string
}

/**
 * A structured document with query and mutation capabilities.
 * Represents parsed HTML/XHTML content in a tree structure.
 * Immutable — mutations return new instances.
 */
export interface SectionDocument {
    /** Root nodes of the document */
    readonly nodes: readonly DocumentNode[]

    /** Query nodes using CSS-like selectors */
    query(selector: string): DocumentNode[]

    /** Get plain text content of the document */
    getText(): string

    /** Get all image resources */
    getImages(): DocumentResource[]

    /** Insert a node at the given path */
    insertNode(path: number[], node: DocumentNode): SectionDocument

    /** Remove a node at the given path */
    removeNode(path: number[]): SectionDocument

    /** Update node attributes at the given path */
    setNode(path: number[], attrs: Record<string, string>): SectionDocument

    /** Replace text at the given path */
    replaceText(path: number[], text: string): SectionDocument

    /** Serialize back to HTML string */
    serialize(): string
}

/**
 * A resource (image, font, CSS, etc.) with metadata and mutation support.
 */
export interface DocumentResource {
    /** Unique resource ID */
    readonly id: string
    /** Resource type */
    readonly type: 'image' | 'font' | 'css' | 'audio' | 'video'
    /** MIME type */
    readonly mimeType: string
    /** URL or data URI */
    readonly url: string
    /** Load the resource data */
    load?(): Promise<Blob | ArrayBuffer>
    /** Replace the resource with new data */
    replace?(data: Blob | ArrayBuffer): void
}

// ============================================================================
// Text Blocks (normalized reading model)
// ============================================================================

/**
 * Preset inline text style used by the virtual text rendering pipeline.
 * This is intentionally smaller than CSS: it captures the portable subset
 * needed for Pretext measurement and DOM/Canvas rendering.
 */
export interface TextStyle {
    fontFamily?: string
    fontSize?: number
    fontWeight?: string
    fontStyle?: string
    fontVariant?: string
    lineHeight?: number
    color?: string
    textDecoration?: string
    verticalAlign?: string
    letterSpacing?: number
}

/**
 * A contiguous inline text fragment with optional style metadata.
 */
export interface TextSegment {
    text: string
    style?: TextStyle
    break?: 'normal' | 'never'
    extraWidth?: number
    source?: {
        nodeType?: string
        attrs?: Readonly<Record<string, string>>
    }
}

/**
 * Portable image sizing/alignment metadata used by virtual renderers.
 */
export interface ImageStyle {
    width?: number
    height?: number
    maxWidth?: number
    maxHeight?: number
    objectFit?: 'contain' | 'cover' | 'fill' | 'none' | 'scale-down'
    align?: 'start' | 'center' | 'end'
}

/**
 * Image payload for normalized reading blocks.
 */
export interface TextImage {
    src: string
    originalSrc?: string
    alt?: string
    title?: string
    width?: number
    height?: number
    aspectRatio?: number
    isCover?: boolean
    role?: string
    style?: ImageStyle
}

/**
 * Normalized table payload for virtual reading blocks.
 */
export interface TextTableCell {
    text: string
    header?: boolean
    colspan?: number
    rowspan?: number
    align?: 'start' | 'center' | 'end'
    attrs?: Readonly<Record<string, string>>
}

export interface TextTableRow {
    cells: readonly TextTableCell[]
}

export interface TextTable {
    columnCount: number
    columnWeights?: readonly number[]
    rowIndex: number
    rowCount: number
    rows: readonly TextTableRow[]
}

/**
 * Normalized reading block extracted from the HTML AST.
 */
export type TextBlockType = 'container' | 'chapter' | 'heading' | 'paragraph' | 'listItem' | 'blockquote' | 'pre' | 'break' | 'separator' | 'image' | 'table'

export interface TextBlock {
    id: string
    type: TextBlockType
    depth?: number
    attrs?: Readonly<Record<string, string>>
    style?: TextStyle
    blockGapBefore?: number
    blockGapAfter?: number
    image?: TextImage
    table?: TextTable
    segments: readonly TextSegment[]
}

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
    readonly title?: LanguageMap
    readonly subtitle?: LanguageMap
    readonly author?: Contributor | Contributor[]
    readonly editor?: Contributor | Contributor[]
    readonly translator?: Contributor | Contributor[]
    readonly illustrator?: Contributor | Contributor[]
    readonly narrator?: Contributor | Contributor[]
    readonly contributor?: Contributor | Contributor[]
    readonly publisher?: Contributor | LanguageMap
    readonly published?: string
    readonly modified?: string
    readonly language?: string | string[]
    readonly description?: string
    readonly subject?: string | string[]
    readonly identifier?: string
    readonly rights?: string
    readonly belongsTo?: {
        readonly series?: { readonly name: LanguageMap; readonly position?: string; readonly total?: string }
        readonly collection?: { readonly name: LanguageMap }
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
    readonly label: string
    /** Navigation target (href string) */
    readonly href: string
    /** Nested items */
    readonly subitems?: readonly TOCItem[]
}

/**
 * A landmark entry (e.g. cover, TOC, bodymatter).
 */
export interface Landmark {
    readonly label: string
    readonly href: string
    readonly type: readonly string[]
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
    readonly id: string | number
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
    readonly format?: SectionFormat
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
     * Optional: return structured document model for AI-friendly manipulation.
     * Lazily parses HTML/XHTML into a tree structure with query and mutation APIs.
     * Returns null if the section format doesn't support document model (e.g., 'image').
     */
    getDocument?(): Promise<SectionDocument | null>
    /**
     * Optional: return text/style segments for pre-measured layout engines.
     * This is useful for renderers that avoid full chapter DOM layout and
     * instead virtualize line ranges or paint text on Canvas.
     */
    getSegments?(): Promise<TextSegment[]> | TextSegment[]
    /**
     * Optional: return AST-derived structural blocks for preset text rendering.
     * A block is a normalized chapter heading, paragraph, list item, quote, or
     * similar reading unit with inline text/style segments.
     */
    getBlocks?(): Promise<TextBlock[]> | TextBlock[]
    /**
     * Optional: raw text content for searching.
     */
    loadText?(): Promise<string> | string
    /** Byte size of the section (for progress calculation) */
    readonly size: number
    /**
     * Linear reading sequence flag.
     * "no" means this section is not part of the main reading flow.
     */
    readonly linear?: string
    /** Base CFI string for this section */
    readonly cfi?: string
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
    readonly index: number
    /**
     * A function that, given a document (renderer-specific), returns the target element/range.
     * Can also be a number (offset) or an element directly.
     * The doc parameter is opaque to the parser; the renderer provides its live DOM.
     */
    readonly anchor?: ((doc: unknown) => unknown) | number | unknown
    /** Whether to select/highlight the target */
    readonly select?: boolean
}

// ============================================================================
// Rendition
// ============================================================================

/**
 * Rendition hints from the book.
 */
export interface Rendition {
    readonly layout?: 'reflowable' | 'pre-paginated'
    readonly flow?: 'paginated' | 'scrolled'
    readonly spread?: 'none' | 'auto' | 'landscape'
    readonly orientation?: 'auto' | 'landscape' | 'portrait'
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
    readonly sections: readonly Section[]

    /** Page progression direction */
    readonly dir?: 'ltr' | 'rtl'

    /** Table of contents */
    readonly toc?: readonly TOCItem[]

    /** Page list (for page-based navigation) */
    readonly pageList?: readonly TOCItem[]

    /** Landmarks (cover, TOC, bodymatter, etc.) */
    readonly landmarks?: readonly Landmark[]

    /** Book metadata */
    readonly metadata?: BookMetadata

    /** Rendition hints */
    readonly rendition?: Rendition

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

/**
 * Event emitted when a renderer knows which blocks are near the current viewport.
 * Consumers can use this to prefetch expensive block-level work such as AI translation.
 */
export interface BlockWindowEvent {
    /** Section index */
    index: number
    /** Block ids in reading order within the current prefetch window */
    blockIds: string[]
    /** Current renderer page index when available */
    pageIndex?: number
    /** Number of pages ahead included after the current viewport */
    pageCount?: number
    /** Reason for the window update */
    reason?: string
}

// ============================================================================
// Plugins
// ============================================================================

/**
 * A plugin is a middleware that wraps the Book instance.
 * It can intercept Book methods (e.g. section.getBlocks) to modify behavior or content.
 */
export type RebookPlugin = (book: Book) => Book | Promise<Book>
