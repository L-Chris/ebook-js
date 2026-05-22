/**
 * ebook-js - A modular e-book parsing and rendering library
 *
 * @example
 * ```typescript
 * import { createReader } from 'ebook-js'
 * import { epub } from 'ebook-js/parsers/epub'
 * import { registry } from 'ebook-js'
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
} from './core/types'

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

// Parsers
export { epub, EPUBParser } from './parsers/epub'
export { cbz, CBZParser } from './parsers/cbz'
export { fb2, FB2Parser, fb2DefaultStyles } from './parsers/fb2'
export { mobi, MOBIParser, mobi6DefaultStyles } from './parsers/mobi'

// Loaders
export { createZipLoader, isZipFile } from './loaders'

// Progress utilities
export { SectionProgress, TOCProgress } from './utils/progress'

// Browser renderer
export {
    BrowserRenderer,
    createBrowserRenderer,
    ReaderView,
    createReader,
} from './renderers/browser'
export type { ReaderConfig } from './renderers/browser'
