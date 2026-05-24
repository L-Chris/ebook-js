/**
 * rebook - A modular e-book parsing and rendering library
 *
 * @example
 * ```typescript
 * import { createReader } from 'rebook'
 * import { epub } from 'rebook/parsers/epub'
 * import { registry } from 'rebook'
 *
 * // Register parsers
 * registry.register('epub', epub)
 *
 * // Create reader
 * const reader = createReader({ container: document.getElementById('viewer')! })
 *
 * // Open a book
 * await reader.open(file)
 *
 * // Navigate
 * await reader.next()
 * await reader.prev()
 *
 * // Access document model (AI-friendly)
 * const section = reader.sections[0]
 * const doc = await section.getDocument()
 * const paragraphs = doc.query('p')
 * ```
 */

// Core types and interfaces
export type {
    Book,
    BookMetadata,
    Section,
    SectionFormat,
    TOCItem,
    Landmark,
    Rendition,
    ResolvedNavigation,
    LanguageMap,
    Contributor,
    LoadEvent,
    RelocateEvent,
    LinkEvent,
    // Document Model
    DocumentNode,
    SectionDocument,
    DocumentResource,
    TextStyle,
    TextSegment,
    ImageStyle,
    TextImage,
    TextBlock,
    TextBlockType,
} from './core/types'

export type {
    PreparedTextBlock,
    PreparedText,
    PrepareOptions,
    LayoutOptions,
    LinePosition,
    LineSegmentRange,
    LineRange,
    VisibleLineWindow,
    PretextRichInlineLineRange,
} from './core/pretext'

export type {
    Parser,
    ParserInput,
    ParserOptions,
    ParserFactory,
} from './core/parser'

export type {
    Renderer,
    RendererConfig,
    RendererStyles,
    LayoutMode,
    RendererFactory,
} from './core/renderer'

export type {
    Loader,
    LoaderEntry,
} from './core/loader'

// Adapter interfaces
export type {
    DOMAdapter,
    XMLDocument,
    XMLElement,
    XMLAttr,
} from './core/dom-adapter'

export type {
    URLFactory,
} from './core/url-factory'

// Adapter implementations
export {
    BrowserDOMAdapter,
    BrowserURLFactory,
} from './adapters/browser'

// Parser registry
export { registry } from './core/parser'

// Error types
export {
    EBookError,
    ParseError,
    UnsupportedFormatError,
    CorruptedFileError,
    AdapterRequiredError,
    UnsupportedInputError,
} from './core/errors'

// Metadata normalization helpers
export {
    normalizeLanguage,
    normalizeTitle,
    normalizePublisher,
    normalizeContributors,
    normalizeSubjects,
} from './core/metadata'

// Document Model helpers
export {
    parseHTML,
    createSectionDocument,
    textNode,
    elementNode,
    isTextNode,
    isElementNode,
} from './core/document'

export {
    extractDocumentBlocks,
    extractDocumentSegments,
    prepare,
    prepareBlocks,
    layout,
    getVisibleLines,
} from './core/pretext'

// Parsers
export { epub, EPUBParser } from './parsers/epub'
export { cbz, CBZParser } from './parsers/cbz'
export { fb2, FB2Parser } from './parsers/fb2'
export { mobi, MOBIParser } from './parsers/mobi'

// Loaders
export { createZipLoader, isZipFile } from './loaders'

// Progress utilities
export { SectionProgress, TOCProgress } from './utils/progress'

// Exporters
export {
    exportBook,
    exportBookAsBuffer,
    exporterRegistry,
    exportFirstSections,
    exportFirstSectionsAsBuffer,
    firstSectionsSelection,
    EPUBExporter,
    epubExporter,
    CBZExporter,
    cbzExporter,
    TXTExporter,
    txtExporter,
    HTMLExporter,
    htmlExporter,
} from './exporters'
export type {
    Exporter,
    ExporterFactory,
    ExportOptions,
    ExportFirstSectionsOptions,
    ExportFormat,
    ExportSectionUnit,
    ExportSelection,
    ExportSelectionType,
} from './exporters'

// Browser renderer
export {
    VirtualTextRenderer,
    createVirtualTextRenderer,
    ReaderView,
    createReader,
} from './renderers/browser'
export type { ReaderConfig } from './renderers/browser'
