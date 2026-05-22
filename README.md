# ebook-js

[中文文档](./README.zh-CN.md)

A modular, extensible e-book parsing and rendering library for the web.

Inspired by [foliate-js](https://github.com/johnfactotum/foliate-js), but restructured with a clean separation between **parsers** (file format handling) and **renderers** (platform-specific display).

## Features

- **Modular architecture**: Parsers and renderers are independent — mix and match
- **TypeScript**: Full type safety with comprehensive interfaces
- **Multi-format support**: EPUB 2.x/3.x, MOBI/AZW/AZW3, FictionBook 2, and CBZ
- **Environment-agnostic parsers**: All parsers run in browser, Node.js, or workers via adapter injection
- **Browser renderer**: Paginated and scrolled reading modes
- **Progress tracking**: Section and TOC-level progress reporting
- **Framework-agnostic**: Core library works with any framework; React/Vue wrappers coming

## Installation

```bash
npm install ebook-js
```

## Supported Formats

| Format | Extensions | Parser | Notes |
|--------|-----------|--------|-------|
| EPUB 2/3 | `.epub` | `EPUBParser` | Full support: navigation, spine, font deobfuscation, landmarks |
| Mobipocket / Kindle | `.mobi`, `.azw`, `.azw3` | `MOBIParser` | MOBI6 + KF8, PalmDOC + HUFF/CDIC, EXTH metadata, NCX |
| FictionBook 2 | `.fb2`, `.fbz`, `.fb2.zip` | `FB2Parser` | FB2 XML to XHTML conversion, FBZ archive support (use `fb2DefaultStyles` for rendering) |
| Comic Book Zip | `.cbz` | `CBZParser` | Sequential images from zip archives |

## Quick Start

```typescript
import {
    registry,
    createReader,
    BrowserDOMAdapter,
    BrowserURLFactory,
    UnsupportedFormatError,
} from 'ebook-js'
import { epub } from 'ebook-js/parsers/epub'
import { mobi } from 'ebook-js/parsers/mobi'
import { fb2 } from 'ebook-js/parsers/fb2'
import { cbz } from 'ebook-js/parsers/cbz'

// 1. Register parsers for auto-detection (priorities are automatic)
registry.register('epub', epub)
registry.register('mobi', mobi)
registry.register('fb2', fb2)
registry.register('cbz', cbz)

// 2. Create reader (adapters are auto-injected in browser)
const reader = createReader({
    container: document.getElementById('viewer')!,
})

// 3. Open a book (auto-detects format)
try {
    const book = await reader.open(file)

    // 4. Navigate
    await reader.next()
    await reader.prev()
    await reader.goTo('/path/to/chapter.xhtml#section')
} catch (e) {
    if (e instanceof UnsupportedFormatError) {
        alert('Unsupported file format')
    } else {
        throw e
    }
}
```

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                          ebook-js                             │
├────────────────────────────┬─────────────────────────────────┤
│         Parsers            │           Renderers             │
│                            │                                 │
│  ┌──────────────────────┐  │  ┌───────────────────────────┐  │
│  │  EPUB Parser         │  │  │  Browser Renderer         │  │
│  │  MOBI/AZW3 Parser    │  │  │  (paginated/scrolled)     │  │
│  │  FB2 Parser          │  │  └───────────────────────────┘  │
│  │  CBZ Parser          │  │  ┌───────────────────────────┐  │
│  │  (all env-agnostic)  │  │  │  React/Vue Wrappers       │  │
│  └──────────┬───────────┘  │  │  (planned)                │  │
│             │              │  └───────────────────────────┘  │
│  ┌──────────┴───────────┐  │                                 │
│  │  Adapters (injected) │  │                                 │
│  │  - DOMAdapter        │  │                                 │
│  │  - URLFactory        │  │                                 │
│  └──────────────────────┘  │                                 │
│                            │                                 │
│         │                  │            ▲                    │
│         ▼                  │            │                    │
│      Book Interface ───────┼────────────┘                    │
│   (common contract)        │                                 │
└────────────────────────────┴─────────────────────────────────┘
```

### Design Principles

1. **Parsers are environment-agnostic**: Parsers have no browser dependencies. DOM parsing and URL creation are injected via adapters.
2. **Renderers own the browser**: Browser-specific concerns (iframe, CSS columns, DOM events) live in renderers.
3. **Book is the contract**: Parsers produce a `Book`, renderers consume it. Neither knows about the other.

### Key Interfaces

#### `Book` (output of parsers, input to renderers)
```typescript
interface Book {
    sections: Section[]        // Ordered list of chapters
    dir?: 'ltr' | 'rtl'       // Page progression direction
    toc?: TOCItem[]           // Table of contents
    metadata?: BookMetadata   // Title, author, etc.
    rendition?: Rendition     // Layout hints
    resolveHref?(href): ResolvedNavigation | null
    getCover?(): Promise<Blob | null>
}
```

#### `Section` (a single chapter/document)
```typescript
interface Section {
    id: string | number
    load(): Promise<string>              // Returns URL for content (via URLFactory)
    unload?(): void                      // Free resources
    createDocument?(): Promise<string>   // Returns raw HTML string for searching
    size: number                         // Byte size for progress
}
```

#### `Parser`
```typescript
interface Parser {
    parse(input, options?): Promise<Book>
    canParse(input): Promise<boolean>
    priority?: number    // Detection priority (higher = checked first, default 0)
}

interface ParserOptions {
    domAdapter?: DOMAdapter    // Injected DOM parser (required for all parsers)
    urlFactory?: URLFactory    // Injected URL factory (required for all parsers)
    sha1?: (data: ArrayBuffer) => Promise<ArrayBuffer>
    onProgress?: (progress: number, message?: string) => void
}
```

#### `Renderer`
```typescript
interface Renderer {
    open(book): Promise<void>
    goTo(target): Promise<void>
    next(): Promise<void>
    prev(): Promise<void>
    setStyles(styles): void
    on(event, listener): void
}
```

## Adapter System

The EPUB parser uses dependency injection to remain environment-agnostic. Two adapters must be provided via `ParserOptions`:

### `DOMAdapter`

Abstracts DOM parsing and querying:

```typescript
interface DOMAdapter {
    parseXML(str: string): XMLDocument
    parseHTML(str: string, mimeType?: string): XMLDocument
    serialize(doc: XMLDocument): string
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

| Adapter | Package | Environment |
|---------|---------|-------------|
| `BrowserDOMAdapter` | `ebook-js` | Browser |
| `BrowserURLFactory` | `ebook-js` | Browser |
| `TestDOMAdapter` | `ebook-js/adapters/test` | Node.js (uses @xmldom/xmldom) |
| `TestURLFactory` | `ebook-js/adapters/test` | Node.js (fake URLs) |

### Browser Usage (Auto-wired)

When using `createReader()`, browser adapters are auto-injected:

```typescript
import { createReader, registry } from 'ebook-js'
import { epub } from 'ebook-js/parsers/epub'

registry.register('epub', epub)
const reader = createReader({ container: element })
// Browser adapters are automatically provided
await reader.open(file)
```

### Node.js / Worker Usage

Provide adapters explicitly when parsing outside the browser:

```typescript
import { registry } from 'ebook-js'
import { epub } from 'ebook-js/parsers/epub'
import { TestDOMAdapter, TestURLFactory } from 'ebook-js/adapters/test'

registry.register('epub', epub)

const domAdapter = new TestDOMAdapter()
const urlFactory = new TestURLFactory()

const book = await registry.open(arrayBuffer, { domAdapter, urlFactory })
```

## Error Handling

ebook-js provides a hierarchy of typed errors for better error handling:

```typescript
import {
    EBookError,            // Base class for all ebook-js errors
    ParseError,            // Parsing failed (malformed content)
    UnsupportedFormatError, // Format not recognized
    CorruptedFileError,    // File is severely corrupted
    AdapterRequiredError,  // Required adapter not provided
    UnsupportedInputError, // Input type not supported
} from 'ebook-js'

try {
    const book = await registry.open(file, { domAdapter, urlFactory })
} catch (e) {
    if (e instanceof UnsupportedFormatError) {
        console.error('Please open an EPUB, MOBI, FB2, or CBZ file.')
    } else if (e instanceof AdapterRequiredError) {
        console.error('Please provide domAdapter and urlFactory in options.')
    } else if (e instanceof ParseError) {
        console.error(`Parse error (${e.format}): ${e.message}`)
    } else if (e instanceof CorruptedFileError) {
        console.error(`Corrupted file (${e.format}): ${e.message}`)
    } else if (e instanceof EBookError) {
        console.error(`Error [${e.code}]: ${e.message}`)
    } else {
        throw e // Re-throw unexpected errors
    }
}
```

All errors have:
- `message`: Human-readable error description
- `code`: Machine-readable error code (e.g., `'PARSE_ERROR'`)
- `name`: Error class name

Format-specific errors also have a `format` property (e.g., `'epub'`, `'mobi'`).

## Parser Detection Priority

When using auto-detection (`registry.open()` or `registry.detect()`), parsers are checked in priority order (highest first). Each parser has a default priority:

| Parser | Priority | Notes |
|--------|----------|-------|
| EPUB | 10 | Checked first — most specific format detection |
| MOBI | 5 | Checks BOOKMOBI magic bytes |
| FB2 | 5 | Checks FictionBook XML or .fb2 in zip |
| CBZ | 0 | Checked last — generic zip with images |

You can override priority when registering:

```typescript
// Give CBZ higher priority for your use case
registry.register('cbz', cbz, 20)
```

## Metadata Normalization

All parsers normalize metadata to consistent types, making it safe to consume without format-specific handling:

| Field | Type | Notes |
|-------|------|-------|
| `title` | `string` | Always a plain string |
| `subtitle` | `string` | Always a plain string |
| `author` | `Contributor[]` | Always an array of `{ name, sortAs?, role? }` objects |
| `translator` | `Contributor[]` | Always an array |
| `editor` | `Contributor[]` | Always an array |
| `publisher` | `string` | Always a plain string |
| `language` | `string` | Always a single string (first language if multiple) |
| `subject` | `string[]` | Always an array of strings |
| `identifier` | `string` | Plain string |
| `published` | `string` | Plain string (date) |
| `modified` | `string` | Plain string (date) |
| `description` | `string` | Plain string (may contain HTML) |

### Accessing Metadata

```typescript
const book = await registry.open(file, options)

// Title is always a string
console.log(book.metadata?.title) // "My Book"

// Author is always an array of Contributor objects
const authors = book.metadata?.author ?? []
for (const author of authors) {
    console.log(author.name) // "John Doe"
    if (author.sortAs) console.log(author.sortAs) // "Doe, John"
}

// Publisher is always a string
console.log(book.metadata?.publisher) // "Publisher Inc"

// Language is always a string (first language if multiple)
console.log(book.metadata?.language) // "en"
```

### Normalization Helpers

For advanced use cases, normalization helpers are exported:

```typescript
import {
    normalizeLanguage,
    normalizeTitle,
    normalizePublisher,
    normalizeContributors,
    normalizeSubjects,
} from 'ebook-js'
```

## FB2 Styles

Unlike EPUB and MOBI which have embedded stylesheets, FB2 is a pure XML format without styling information. The parser converts FB2 to clean XHTML without any CSS.

To render FB2 content with proper styling, use the exported default stylesheet:

```typescript
import { fb2DefaultStyles } from 'ebook-js'

// Apply default FB2 styles to the renderer
reader.setStyles({ css: fb2DefaultStyles })
```

You can also customize or replace the styles entirely:

```typescript
// Use custom FB2 styles
reader.setStyles({ css: `
    .title h1 { text-align: center; font-size: 1.5em; }
    p { text-indent: 1.5em; }
    .stanza { margin: 2em 0; }
` })

// Or combine default with custom overrides
reader.setStyles({ css: fb2DefaultStyles + `
    p { color: #333; }
` })
```

## MOBI6 Styles

Like FB2, legacy MOBI6 content (older Mobipocket files, typically `.mobi`) lacks embedded stylesheets. The parser provides clean content and exports default styles for proper rendering:

```typescript
import { mobi6DefaultStyles } from 'ebook-js'

// Apply default MOBI6 styles to the renderer
reader.setStyles({ css: mobi6DefaultStyles })
```

Modern KF8/AZW3 files (`.azw3`) have embedded styles and don't need this — applying `mobi6DefaultStyles` won't hurt them, as the book's own styles take precedence.

## Malformed EPUB Handling

Many EPUB files in the wild have structural issues in their zip archives — particularly incorrect Central Directory offsets that prevent standard zip libraries from reading entry data. ebook-js includes multiple fallback strategies to handle these files gracefully:

1. **Prepended data correction** — Detects and corrects uniformly-shifted offsets (common in self-extracting archives or files with prepended data) by patching Central Directory entries before retrying.
2. **Per-entry local header scanning** — When individual entries have incorrect offsets, scans the entire file for actual Local File Header positions and extracts data directly using `DecompressionStream`.
3. **Full local-header-only fallback** — When the Central Directory is completely unreadable, builds the entry list and loader entirely from Local File Headers.
4. **Graceful degradation** — Entries that cannot be recovered return `null` instead of throwing, allowing the rest of the book to load normally.

This makes ebook-js significantly more resilient than raw `@zip.js/zip.js` or libraries like foliate-js when dealing with EPUB files produced by various authoring tools.

## API Reference

### Parser Registry

```typescript
import { registry } from 'ebook-js'

// Register a parser
registry.register('epub', epub)

// Auto-detect and parse
const book = await registry.open(file, { domAdapter, urlFactory })

// Check what parsers are available
registry.list() // ['epub']
```

### Reader View (High-Level API)

```typescript
import { createReader } from 'ebook-js'

const reader = createReader({
    container: element,
    layout: 'paginated', // or 'scrolled'
    styles: {
        fontFamily: 'Georgia, serif',
        fontSize: '16px',
        lineHeight: 1.6,
        textAlign: 'justify',
        hyphenate: true,
    },
})

// Open
await reader.open(file)

// Navigation
await reader.next()
await reader.prev()
await reader.goLeft()    // Respects RTL
await reader.goRight()   // Respects RTL
await reader.goTo(href)
await reader.goToFraction(0.5)

// Styling
reader.setStyles({ fontSize: '18px' })
reader.setLayout('scrolled')

// Events
reader.on('load', (e) => console.log('Section loaded:', e.index))
reader.on('relocate', (e) => console.log('Location:', e))
reader.on('link', (e) => {
    if (e.external) window.open(e.href)
})

// Metadata
const metadata = reader.getMetadata()
const toc = reader.getTOC()
const location = reader.getLocation()
const fractions = reader.getSectionFractions() // For progress bar ticks

// Cleanup
reader.destroy()
```

### Styles

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

## Development

```bash
# Install dependencies
npm install

# Run demo
npm run dev

# Type check
npm run typecheck

# Build
npm run build

# Run tests
npm test

# Run tests in watch mode
npm run test:watch
```

### Project Structure

```
src/
├── core/               # Shared interfaces and types
│   ├── types.ts        # Book, Section, TOCItem, etc.
│   ├── parser.ts       # Parser interface and registry
│   ├── renderer.ts     # Renderer interface
│   ├── dom-adapter.ts  # DOMAdapter interface
│   └── url-factory.ts  # URLFactory interface
├── adapters/
│   ├── browser.ts      # Browser DOM/URL adapters
│   └── test.ts         # Node.js test adapters
├── parsers/
│   ├── epub.ts         # EPUB parser
│   ├── mobi.ts         # MOBI/AZW/AZW3 parser
│   ├── fb2.ts          # FictionBook 2 parser
│   └── cbz.ts          # Comic Book Zip parser
├── loaders/
│   └── zip-loader.ts   # Zip archive loader
├── renderers/
│   └── browser/        # Browser renderer
│       ├── paginator.ts
│       └── view.ts     # High-level ReaderView
└── utils/
    └── progress.ts     # Progress tracking

tests/
├── fixtures/           # Test file generators (EPUB, MOBI, FB2, CBZ, zip)
├── loaders/            # Zip loader tests (malformed zip recovery)
├── parsers/            # Parser tests (EPUB, MOBI, FB2, CBZ)
└── utils/              # Progress utility tests
```

## Comparison with foliate-js

| Feature | foliate-js | ebook-js |
|---------|-----------|----------|
| Language | JavaScript | TypeScript |
| Architecture | Monolithic view.js | Separated parser/renderer |
| Browser coupling | Parser uses DOM APIs | Parser is env-agnostic (adapters) |
| Entry point | Custom element | Function API |
| Framework support | None | Planned React/Vue |
| Format support | EPUB, MOBI, FB2, CBZ, PDF | EPUB, MOBI/AZW3, FB2, CBZ |
| Module system | ESM | ESM + typed exports |
| Build | None (raw ESM) | Vite + TypeScript |
| Testing | None | Vitest (140 tests) |
| Malformed EPUB recovery | None (zip.js only) | CD correction + per-entry LFH scan |

## License

MIT

## Credits

Based on the excellent [foliate-js](https://github.com/johnfactotum/foliate-js) by John Factotum.
