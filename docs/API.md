# API Reference

Complete API documentation for rebook.

## Table of Contents

- [Parser Registry](#parser-registry)
- [First Sections Export](#first-sections-export)
- [ReaderView](#readerview)
- [Book](#book)
- [Section](#section)
- [Document Model](#document-model)
- [Pretext Layout](#pretext-layout)
- [Parser Interface](#parser-interface)
- [Renderer Interface](#renderer-interface)
- [Adapter System](#adapter-system)
- [Error Types](#error-types)
- [Metadata Normalization](#metadata-normalization)
- [Styles](#styles)
- [Default Format Styles](#default-format-styles)
- [Parser Detection Priority](#parser-detection-priority)

---

## Parser Registry

The central hub for registering and auto-detecting parsers.

```typescript
import { registry } from 'rebook'

// Register a parser factory
registry.register('epub', epub)
registry.register('mobi', mobi)
registry.register('fb2', fb2)
registry.register('cbz', cbz)

// Register with custom priority (higher = checked first)
registry.register('cbz', cbz, 20)

// Auto-detect format and parse
const book = await registry.open(file, { domAdapter, urlFactory })

// Detect format only (without parsing)
const parser = await registry.detect(file)

// List registered parsers
registry.list() // ['epub', 'mobi', 'fb2', 'cbz']
```

### `registry.open(input, options?)`

Auto-detect format and parse. `input` can be a `File`, `Blob`, `ArrayBuffer`, or URL string.

### `registry.detect(input)`

Returns the first parser whose `canParse()` returns `true`, or `null`.

### `registry.list()`

Returns an array of registered parser names.

---

## First Sections Export

Exporters convert a normalized `Book` back into a downloadable file. The default registered exporter is `epub`, but the API is format-neutral so additional output formats can be added later without changing call sites.

`exportFirstSections()` parses any registered supported input format and exports the first N linear reading sections using the requested exporter format. The API works in browsers and Node-compatible runtimes.

Important: this count is not based on rendered visual pages. For CBZ one section usually means one image page. For EPUB/MOBI/FB2 it means the parser's linear spine/reading section, often a chapter or parser-split section. Visual-page export needs renderer layout inputs such as viewport size, font size, line height, margins, and spread mode.

```typescript
import {
    registry,
    exporterRegistry,
    epub,
    mobi,
    fb2,
    cbz,
    exportFirstSections,
} from 'rebook'

registry.register('epub', epub)
registry.register('mobi', mobi)
registry.register('fb2', fb2)
registry.register('cbz', cbz)

const blob = await exportFirstSections(file, 5, {
    format: 'epub',
    parserOptions: { domAdapter, urlFactory },
})

exporterRegistry.list() // ['epub']
```

For an already parsed `Book`, use `exportBook()` with an explicit selection:

```typescript
import { exportBook, firstSectionsSelection } from 'rebook'

const book = await registry.open(file, { domAdapter, urlFactory })
const blob = await exportBook(book, firstSectionsSelection(5), { format: 'epub' })
```

In Node, write the exported buffer:

```typescript
import { exportBookAsBuffer, firstSectionsSelection } from 'rebook'

const buffer = await exportBookAsBuffer(book, firstSectionsSelection(5), { format: 'epub' })
await fs.writeFile('first-5.epub', Buffer.from(buffer))
```

Non-linear sections are skipped by default.

### Custom Exporters

Register output formats with `exporterRegistry`:

```typescript
import type { Exporter } from 'rebook'
import { exporterRegistry } from 'rebook'

const txtExporter: Exporter = {
    format: 'txt',
    mediaType: 'text/plain',
    extension: '.txt',
    canExport: (_book, selection) => selection.type === 'first-sections',
    exportBook: async (book, selection) => {
        const sections = book.sections.slice(0, selection.count)
        const text = await Promise.all(sections.map(section => section.loadText?.() ?? section.load()))
        return new Blob([text.join('\n\n')], { type: 'text/plain' })
    },
}

exporterRegistry.register('txt', () => txtExporter)
```

---

## ReaderView

High-level API combining parser registry, renderer, and navigation.

```typescript
import { createReader } from 'rebook'

const reader = createReader({
    container: document.getElementById('viewer')!,
    renderer: 'virtual-text', // default
    styles: {
        fontSize: '18px',
        lineHeight: 1.7,
        maxInlineSize: '720px',
    },
})
```

The default browser backend is `VirtualTextRenderer`: XHTML AST → structural blocks → preset styles → Pretext line ranges → visible DOM rows.

### Opening

```typescript
await reader.open(file)           // File, Blob, ArrayBuffer, or URL string
await reader.openBook(book)       // Pre-parsed Book instance
```

### Navigation

```typescript
await reader.next()              // Next section/page
await reader.prev()              // Previous section/page
await reader.goLeft()            // Respects RTL direction
await reader.goRight()           // Respects RTL direction
await reader.goTo(href)          // Navigate to TOC href
await reader.goToFraction(0.5)   // Navigate to 50% progress
```

### Styling & Layout

```typescript
reader.setStyles({ fontSize: '18px', theme: 'dark' })
reader.setLayout('scrolled')

// Control spread (two-page layout)
reader.setSpread(2) // Auto-spread: 2 pages on wide screens, 1 on narrow
reader.setSpread(1) // Force single page
```

#### Auto-Spread Layout

In the default virtual text renderer, wide containers display two text columns side-by-side using the Pretext line list.

- **Container width ≥ 2 × `maxInlineSize` + `gap`**: Shows 2 pages (spread)
- **Container width < 2 × `maxInlineSize` + `gap`**: Shows 1 page (single)
- **Resizing**: Recomputes the grid span and switches between spread and single-page

The `maxColumnCount` config option (default: `2`) controls the maximum number of visible pages. Set to `1` to always use single-page layout.

### Events

```typescript
reader.on('load', (e) => {
    // Section loaded
    console.log('index:', e.index)
})

reader.on('relocate', (e) => {
    // Location changed
    console.log('section index:', e.index)
    console.log('fraction within section:', e.fraction)
    console.log('overall progress fraction:', e.totalFraction)
    console.log('CFI of current position:', e.cfi)
    
    // Automatically tracked active TOC item (chapter)
    if (e.tocItem) {
        console.log('active chapter:', e.tocItem.label, e.tocItem.href)
    }
})

reader.on('link', (e) => {
    // Link clicked
    if (e.external) window.open(e.href)
    else reader.goTo(e.href)
})
```

### State

```typescript
const metadata = reader.getMetadata()    // BookMetadata
const toc = reader.getTOC()              // TOCItem[]
const location = reader.getLocation()    // Current location (contains index, fraction, tocItem, cfi)
const fractions = reader.getSectionFractions() // Per-section progress ticks
```

### Cleanup

```typescript
reader.destroy() // Release all resources
```

---

## Book

The output of parsers and input to renderers. This is the central contract.

```typescript
interface Book {
    sections: Section[]              // Ordered list of sections (chapters)
    dir?: 'ltr' | 'rtl'             // Page progression direction
    toc?: TOCItem[]                  // Table of contents
    landmarks?: Landmark[]           // Named locations (cover, toc, bodymatter...)
    metadata?: BookMetadata          // Title, author, etc.
    rendition?: Rendition            // Layout hints
    resolveHref?(href: string): ResolvedNavigation | null
    getCover?(): Promise<Blob | null>
    destroy(): void                  // Release all resources
}
```

### `BookMetadata`

All parsers normalize metadata to these consistent types:

| Field | Type | Notes |
|-------|------|-------|
| `title` | `string` | Plain string |
| `subtitle` | `string` | Plain string |
| `author` | `Contributor[]` | Array of `{ name, sortAs?, role? }` |
| `translator` | `Contributor[]` | Array |
| `editor` | `Contributor[]` | Array |
| `publisher` | `string` | Plain string |
| `language` | `string` | Single string (first if multiple) |
| `subject` | `string[]` | Array of strings |
| `identifier` | `string` | Plain string |
| `published` | `string` | Date string |
| `modified` | `string` | Date string |
| `description` | `string` | May contain HTML |
| `belongsTo` | `{ series?, collection? }` | Series info with `{ name, position?, total? }` |

### `TOCItem`

```typescript
interface TOCItem {
    label: string
    href: string
    subitems?: TOCItem[]
}
```

### `Landmark`

```typescript
interface Landmark {
    label: string
    href: string
    type: string // 'cover', 'toc', 'bodymatter', etc.
}
```

### `Rendition`

```typescript
interface Rendition {
    layout?: 'reflowable' | 'pre-paginated'
    flow?: 'paginated' | 'scrolled' | 'continuous'
    spread?: 'none' | 'auto' | 'landscape'
}
```

---

## Section

A single chapter or content unit.

```typescript
type SectionFormat = 'xhtml' | 'html' | 'image'

interface Section {
    id: string | number
    size: number                           // Byte size for progress
    format?: SectionFormat                 // Content type (default: 'xhtml')
    load(): Promise<string> | string       // Returns content string
    unload?(): void                        // Free cached resources
    getDocument?(): Promise<SectionDocument | null>  // AI-friendly doc tree
    getSegments?(): Promise<TextSegment[]> | TextSegment[]  // Styled text segments
    getBlocks?(): Promise<TextBlock[]> | TextBlock[]         // Structural reading blocks
    createDocument?(): Promise<string>     // Raw HTML string for searching
}
```

### `load()`

Returns a **content string** — the renderer decides how to display it:
- `'xhtml'`/`'html'`: Full HTML/XHTML document or fragment
- `'image'`: Data URI or base64 string

### `getDocument()`

Returns a `SectionDocument` with query and mutation APIs. Returns `null` for formats without document structure (e.g., `'image'`). See [Document Model](#document-model).

### `getSegments()`

Returns styled text fragments extracted from the parsed XHTML tree. EPUB sections use this as the input to the Pretext adapter so renderers can avoid full chapter DOM layout during font or viewport changes.

### `getBlocks()`

Returns AST-derived reading blocks such as `chapter`, `heading`, `paragraph`, `listItem`, `blockquote`, and `pre`. The virtual browser renderer uses these blocks as its primary input and applies preset styles instead of trusting arbitrary EPUB CSS.

---

## Document Model

SlateJS-inspired tree structure for AI-friendly content manipulation.

### `DocumentNode`

A node in the document tree:

```typescript
interface DocumentNode {
    type: string                    // 'p', 'h1', 'img', 'text', etc.
    attrs?: Record<string, string>  // class, id, src, href, etc.
    children?: DocumentNode[]       // Child nodes (element nodes)
    text?: string                   // Text content (text nodes only)
}
```

Text nodes have `type: 'text'` and `text` set. Element nodes have `type` set to the tag name and optional `children`.

### `SectionDocument`

```typescript
interface SectionDocument {
    nodes: DocumentNode[]

    // Query
    query(selector: string): DocumentNode[]

    // Content extraction
    getText(): string
    getImages(): DocumentResource[]

    // Immutable mutations (return new SectionDocument)
    insertNode(path: number[], node: DocumentNode): SectionDocument
    removeNode(path: number[]): SectionDocument
    setNode(path: number[], attrs: Record<string, string>): SectionDocument
    replaceText(path: number[], text: string): SectionDocument

    // Output
    serialize(): string
}
```

#### `query(selector)`

CSS-like selectors:
- Tag name: `'p'`, `'h1'`, `'img'`
- Class: `'.intro'`, `'.highlight'`
- ID: `'#chapter1'`
- Attribute: `'[href]'`, `'[src="image.jpg"]'`
- Multiple: `'h1, h2, h3'`

#### `getText()`

Returns plain text content of the entire document.

#### `getImages()`

Returns all images as `DocumentResource[]`:

```typescript
interface DocumentResource {
    id: string
    type: string    // 'image', 'font', 'style'
    mimeType: string
    url: string
}
```

#### Mutation Operations

All mutations are **immutable** — they return a new `SectionDocument` without modifying the original.

```typescript
import { textNode, elementNode } from 'rebook'

// Path is an array of indices into the tree
// [0] = first root node
// [0, 1] = second child of first root node

const doc = await section.getDocument()

// Insert at root level (after first paragraph)
const withNewPara = doc.insertNode([1], elementNode('p', {}, [textNode('New paragraph')]))

// Remove a node
const withoutFirst = doc.removeNode([0])

// Update attributes
const highlighted = doc.setNode([0], { class: 'highlight' })

// Replace text content
const translated = doc.replaceText([0, 0], 'Translated text')

// Chain mutations
const result = doc
    .setNode([0], { lang: 'en' })
    .replaceText([0, 0], 'Hello')
    .insertNode([1], elementNode('p', {}, [textNode('World')]))
```

#### `serialize()`

Converts the document tree back to an HTML string.

### Node Helpers

```typescript
import {
    textNode,
    elementNode,
    isTextNode,
    isElementNode,
    parseHTML,
    createSectionDocument,
} from 'rebook'

// Create nodes
const text = textNode('Hello world')
const para = elementNode('p', { class: 'intro' }, [text])
const img = elementNode('img', { src: 'cover.jpg', alt: 'Cover' })

// Type guards
isTextNode(text)    // true
isElementNode(para) // true

// Parse HTML string into DocumentNode[]
const nodes = parseHTML('<p>Hello</p><p>World</p>', domAdapter)

// Create SectionDocument from nodes
const doc = createSectionDocument(nodes, domAdapter)
```

### AI Use Cases

The Document Model enables these AI-powered workflows:

| Use Case | How |
|----------|-----|
| Translation | `getText()` → translate → `replaceText()` per text node |
| Content summary | `getText()` → summarize |
| Annotation | `setNode([path], { class: 'annotation' })` |
| Accessibility | Walk tree, add `alt` attrs to images via `setNode()` |
| Content injection | `insertNode()` to add AI-generated content |
| Restructuring | `removeNode()` + `insertNode()` to reorder sections |
| Image enhancement | `getImages()` → process → replace via `setNode()` |

---

## Pretext Layout

rebook integrates the community package `@chenglou/pretext` instead of implementing text measurement itself. The library extracts EPUB/XHTML structure into styled `TextSegment[]`, then delegates measurement and line breaking to Pretext.

```typescript
import { prepareBlocks, layout, getVisibleLines } from 'rebook'

const blocks = await section.getBlocks!()
const prepared = prepareBlocks(blocks, {
    baseStyle: {
        fontFamily: 'Georgia, serif',
        fontSize: 18,
        lineHeight: 1.6,
    },
})

const lines = layout(prepared, {
    inlineSize: 680,
    lineHeight: 29,
    blockGap: 8,
})

const visible = getVisibleLines(lines, scrollTop, viewportHeight, 2)
```

### `TextSegment`

```typescript
interface TextSegment {
    text: string
    style?: TextStyle
    break?: 'normal' | 'never'
    extraWidth?: number
    source?: {
        nodeType?: string
        attrs?: Record<string, string>
    }
}
```

`extractDocumentSegments(nodes)` converts a `DocumentNode[]` tree into these segments, preserving inline style markers such as bold, italic, color, font size, and text decoration.

### `TextBlock`

```typescript
type TextBlockType = 'container' | 'chapter' | 'heading' | 'paragraph' | 'listItem' | 'blockquote' | 'pre' | 'image'

interface TextImage {
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

interface TextBlock {
    id: string
    type: TextBlockType
    depth?: number
    attrs?: Record<string, string>
    style?: TextStyle
    blockGapBefore?: number
    blockGapAfter?: number
    image?: TextImage
    segments: TextSegment[]
}
```

These types are defined in the core parser-renderer contract, not inside the browser renderer. Any renderer can consume `section.getBlocks()` without depending on the Pretext adapter. Image blocks carry a renderable `src`; EPUB sections also preserve `originalSrc` so renderers or tooling can distinguish OPF cover images from regular illustrations.

### `prepareBlocks(blocks, options?)`

Compiles structural reading blocks into Pretext rich-inline items. This is the preferred path for browser rendering because block type and depth drive preset styles and spacing.

### `prepare(segments, options?)`

Compiles segment text into Pretext rich-inline items. This is the expensive step because Pretext uses Canvas text measurement. Run it when the text or font changes, not on every resize.

### `layout(prepared, options)`

Runs the cheap layout step for a given inline size and line height. It returns `LineRange[]`:

```typescript
interface LineRange {
    index: number
    start: LinePosition | null
    end: LinePosition | null
    text: string
    width: number
    top: number
    height: number
    segments: LineSegmentRange[]
}
```

Each `LineSegmentRange` maps a rendered fragment back to the original EPUB segment index and Pretext cursor range, which is the data a virtual list, Canvas renderer, or SVG renderer needs to render only visible lines.

### `getVisibleLines(lines, scrollTop, viewportHeight, overscan?)`

Returns a virtual window:

```typescript
{
    startIndex: number
    endIndex: number
    offsetTop: number
    totalHeight: number
    lines: LineRange[]
}
```

This is intentionally framework-agnostic. React, Vue, Canvas, and custom renderers can consume the same line window.

---

## Parser Interface

```typescript
interface Parser {
    parse(input: ParserInput, options?: ParserOptions): Promise<Book>
    canParse(input: ParserInput): Promise<boolean>
    priority?: number  // Higher = checked first (default 0)
}

type ParserInput = string | File | Blob | ArrayBuffer

interface ParserOptions {
    domAdapter?: DOMAdapter
    urlFactory?: URLFactory
    sha1?: (data: ArrayBuffer) => Promise<ArrayBuffer>
    onProgress?: (progress: number, message?: string) => void
}
```

### Parser Factories

```typescript
import { epub } from 'rebook/parsers/epub'    // or from 'rebook'
import { mobi } from 'rebook/parsers/mobi'    // or from 'rebook'
import { fb2 } from 'rebook/parsers/fb2'      // or from 'rebook'
import { cbz } from 'rebook/parsers/cbz'      // or from 'rebook'

// Each returns a Parser instance
const parser = epub()
```

### Direct Parser Usage

```typescript
import { EPUBParser } from 'rebook'

const parser = new EPUBParser()
if (await parser.canParse(file)) {
    const book = await parser.parse(file, { domAdapter, urlFactory })
}
```

---

## Renderer Interface

```typescript
interface Renderer {
    open(book: Book): Promise<void>
    goTo(target: string | number): Promise<void>
    next(): Promise<void>
    prev(): Promise<void>
    setStyles(styles: RendererStyles): void
    setLayout(layout: LayoutMode): void
    setSpread(maxColumns: number): void  // Control two-page layout
    on(event: string, listener: (e: any) => void): void
    off(event: string, listener: (e: any) => void): void
    destroy(): void
}
```

### Browser Renderer

`VirtualTextRenderer` consumes `section.getBlocks()`, Pretext prepared blocks, and `LineRange[]` to render only the visible text rows as simple DOM spans. It supports auto-spread two-column layout through `maxColumnCount`, `maxInlineSize`, `gap`, and `setSpread()`.

```typescript
import { createVirtualTextRenderer } from 'rebook'

const renderer = createVirtualTextRenderer({
    container: document.getElementById('viewer')!,
    styles: {
        fontSize: '18px',
        lineHeight: 1.6,
        maxInlineSize: '680px',
    },
})

await renderer.open(book)
await renderer.goTo(0)
```

In `paginated` mode, this renderer hides free scrolling, maps wheel/`next()`/`prev()` to page turns, and keeps page-block padding so text is not clipped at the viewport edge. In `scrolled` mode it falls back to continuous vertical scrolling.

---

## Adapter System

Parsers are environment-agnostic via dependency injection.

### `DOMAdapter`

Abstracts DOM parsing and querying:

```typescript
interface DOMAdapter {
    parseXML(str: string): XMLDocument
    parseHTML(str: string, mimeType?: string): XMLDocument
    serialize(doc: XMLDocument): string

    // Optional: document manipulation (for Document Model)
    getChildNodes?(element: XMLElement): XMLNode[]
    createDocument?(): XMLDocument
    createElement?(doc: XMLDocument, tag: string): XMLElement
    createTextNode?(doc: XMLDocument, text: string): XMLNode
    appendChild?(parent: XMLElement, child: XMLNode): void
}
```

### `URLFactory`

Abstracts blob URL creation:

```typescript
interface URLFactory {
    createURL(data: string | ArrayBuffer | Blob, mimeType?: string): string
    revokeURL(url: string): void
}
```

### Built-in Adapters

| Adapter | Import | Environment |
|---------|--------|-------------|
| `BrowserDOMAdapter` | `rebook` | Browser |
| `BrowserURLFactory` | `rebook` | Browser |
| `TestDOMAdapter` | `rebook/adapters/test` | Node.js (@xmldom/xmldom) |
| `TestURLFactory` | `rebook/adapters/test` | Node.js (fake URLs) |

### Browser Usage (auto-wired)

```typescript
import { createReader, registry } from 'rebook'
import { epub } from 'rebook/parsers/epub'

registry.register('epub', epub)
const reader = createReader({ container: element })
await reader.open(file) // Browser adapters auto-injected
```

### Node.js / Worker Usage

```typescript
import { registry } from 'rebook'
import { epub } from 'rebook/parsers/epub'
import { TestDOMAdapter, TestURLFactory } from 'rebook/adapters/test'

registry.register('epub', epub)

const book = await registry.open(arrayBuffer, {
    domAdapter: new TestDOMAdapter(),
    urlFactory: new TestURLFactory(),
})
```

---

## Error Types

```typescript
import {
    EBookError,            // Base class for all rebook errors
    ParseError,            // Parsing failed (malformed content)
    UnsupportedFormatError, // Format not recognized
    CorruptedFileError,    // File is severely corrupted
    AdapterRequiredError,  // Required adapter not provided
    UnsupportedInputError, // Input type not supported
} from 'rebook'
```

### Error Properties

| Property | Type | Description |
|----------|------|-------------|
| `message` | `string` | Human-readable description |
| `code` | `string` | Machine-readable code (e.g., `'PARSE_ERROR'`) |
| `name` | `string` | Error class name |
| `format` | `string` | Format name (on `ParseError`, `CorruptedFileError`) |

### Usage

```typescript
try {
    const book = await registry.open(file, options)
} catch (e) {
    if (e instanceof UnsupportedFormatError) {
        console.error('Unsupported file format')
    } else if (e instanceof ParseError) {
        console.error(`Parse error (${e.format}): ${e.message}`)
    } else if (e instanceof EBookError) {
        console.error(`[${e.code}] ${e.message}`)
    } else {
        throw e
    }
}
```

---

## Metadata Normalization

All parsers normalize metadata to consistent types:

```typescript
const book = await registry.open(file, options)

// Title: always a string
book.metadata?.title // "My Book"

// Author: always Contributor[]
const authors = book.metadata?.author ?? []
for (const a of authors) {
    a.name    // "John Doe"
    a.sortAs  // "Doe, John" (optional)
    a.role    // "aut" (optional)
}

// Language: always a single string
book.metadata?.language // "en"

// Subject: always string[]
book.metadata?.subject // ["Fiction", "Fantasy"]
```

### Normalization Helpers

```typescript
import {
    normalizeLanguage,      // (input) => string
    normalizeTitle,         // (input) => string
    normalizePublisher,     // (input) => string
    normalizeContributors,  // (input) => Contributor[]
    normalizeSubjects,      // (input) => string[]
} from 'rebook'
```

---

## Styles

### `RendererStyles`

```typescript
interface RendererStyles {
    fontFamily?: string
    fontSize?: string
    lineHeight?: number | string
    textAlign?: 'start' | 'justify' | 'center'
    hyphenate?: boolean
    css?: string           // Custom CSS
    theme?: 'light' | 'dark' | 'sepia'
    color?: string
    background?: string
    gap?: string           // Column gap (paginated)
    maxInlineSize?: string // Max column width
    maxBlockSize?: string  // Max page height
    margin?: string        // Header/footer margin
}
```

### Usage

```typescript
reader.setStyles({
    fontFamily: 'Georgia, serif',
    fontSize: '18px',
    lineHeight: 1.6,
    theme: 'sepia',
    css: 'p { text-indent: 2em; }',
})
```

---

## Default Format Styles

### FB2 Styles

FB2 is pure XML without embedded CSS. Use the default stylesheet:

```typescript
import { fb2DefaultStyles } from 'rebook'

reader.setStyles({ css: fb2DefaultStyles })

// Or combine with custom overrides
reader.setStyles({ css: fb2DefaultStyles + 'p { color: #333; }' })
```

### MOBI6 Styles

Legacy MOBI6 files (`.mobi`) lack embedded stylesheets:

```typescript
import { mobi6DefaultStyles } from 'rebook'

reader.setStyles({ css: mobi6DefaultStyles })
```

Modern KF8/AZW3 files (`.azw3`) have embedded styles — `mobi6DefaultStyles` won't conflict.

---

## Parser Detection Priority

When using `registry.open()` or `registry.detect()`, parsers are checked in priority order (highest first):

| Parser | Default Priority | Detection Method |
|--------|-----------------|------------------|
| EPUB | 10 | `PK` magic + `mimetype` entry = `application/epub+zip` |
| MOBI | 5 | `BOOKMOBI` magic at bytes 60-68 |
| FB2 | 5 | `<FictionBook` XML or `.fb2` in zip |
| CBZ | 0 | `.cbz` extension or zip containing image files |

Override priority when registering:

```typescript
registry.register('cbz', cbz, 20) // Check CBZ first
```
