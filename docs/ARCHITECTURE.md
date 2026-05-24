# Architecture

Design decisions and architectural rationale for rebook.

## Overview

```
┌──────────────────────────────────────────────────────────────┐
│                          rebook                             │
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

## Design Principles

### 1. Parsers are environment-agnostic

Parsers have zero browser dependencies. DOM parsing, URL creation, and other platform APIs are injected via adapters.

**Why**: Parsers should run anywhere — browser, Node.js, Web Workers, React Native, WeChat Mini Programs. A parser that calls `document.createElement` internally can only run in a browser.

**How**: Two adapter interfaces are injected via `ParserOptions`:
- `DOMAdapter` — XML/HTML parsing and querying
- `URLFactory` — Blob URL creation and revocation

### 2. Renderers own the platform

Platform-specific concerns (paginated grid layout, DOM events, WXML, WebView) live entirely in renderers.

**Why**: Different platforms render content differently. A browser uses DOM/Canvas to size the visible page window; WeChat uses `<rich-text>` with WXML; React Native uses WebView. None of these concerns belong in a parser.

### 3. Book is the contract

Parsers produce a `Book`, renderers consume it. Neither knows about the other.

**Why**: This decoupling means you can add new parsers without touching renderers, and add new renderers without touching parsers. The `Book` interface is stable.

### 4. Content strings, not URLs

`Section.load()` returns content strings, not blob URLs.

**Why**: A URL is browser-specific. A string is universal. The renderer decides what to do with the string:
- **WeChat Mini Program**: string → WXML `<rich-text>`
- **Browser**: string/blocks → Pretext lines → DOM spans component
- Node.js: extract text, generate static HTML

## Cross-Platform Rendering

| Platform | Renderer | Content Pipeline |
|----------|----------|------------------|
| Web browser | `VirtualTextRenderer` | AST blocks → Pretext lines → DOM spans |
| Virtual text / Canvas | (custom) | XHTML AST → styled segments → `@chenglou/pretext` prepare/layout → visible line ranges |
| WeChat Mini Program | (planned) | String → WXML → `<rich-text>` |
| React Native | (planned) | String → WebView |
| Node.js / SSR | (custom) | String → text extraction or static HTML |

### Custom Renderer

To build a custom renderer, implement the `Renderer` interface:

```typescript
const content = await section.load()
switch (section.format) {
    case 'xhtml': // Valid XHTML — render with XML parser
    case 'html':  // HTML — render with HTML parser
    case 'image': // Data URI — render with image component
}
```

## Browser Renderer Architecture

`createReader()` uses `VirtualTextRenderer` by default.

### Virtual Text Renderer

`VirtualTextRenderer` is the 80/20 browser path for reflowable Chinese/English EPUB text. It ignores arbitrary EPUB page CSS, extracts reading-oriented objects from the HTML AST, and re-renders with preset typography:

- `chapter` from `h1`
- `heading` from `h2`-`h6`
- `paragraph` from `p` and loose text
- `listItem` from `li`
- `blockquote` from `blockquote`
- `pre` from `pre`

The live DOM contains only visible line rows and inline spans. Block identity is preserved on rows via `data-block-id` and `data-block-type`.

For wide viewports in `paginated` mode, the same line list is projected into two columns. The renderer computes one Pretext line flow for the selected column width, then maps source line `top` offsets into `(page, column)` coordinates by page inner height. Page mode hides free scrolling and turns pages via wheel/`next()`/`prev()`, with top/bottom page padding to prevent clipped edge text. This keeps line measurement single-pass while allowing `setSpread(1)` / `setSpread(2)` to switch between single-column and auto-spread layouts.

### Text Block Boundary

`TextBlock`, `TextSegment`, and `TextStyle` live in `src/core/types.ts` because they are part of the parser-renderer contract. The Pretext module is deliberately only an adapter:

- `extractDocumentBlocks()` maps `DocumentNode[]` to normalized reading blocks
- `prepareBlocks()` maps blocks to Pretext rich-inline prepared state
- `layout()` maps Pretext line ranges back to `LineRange[]`

This avoids making the core `Section` interface depend on a concrete rendering adapter and keeps future Canvas, SVG, or native renderers able to consume the same block model.

### Renderer Lifecycle

`ReaderView` owns renderer instances. Opening a new book destroys and recreates the renderer so stale DOM, scroll listeners, and pending async section loads cannot leak between books. `VirtualTextRenderer` also tags async section loads with an internal version so a destroyed or superseded load cannot write into the active renderer state.

### 2. Rendering

The `VirtualTextRenderer` receives Pretext layout lines and renders only the visible subset to the DOM.

## Adapter System

### Why dependency injection?

The alternative — conditional imports or environment detection — creates tight coupling and makes testing difficult. With DI:

- **Browser**: `BrowserDOMAdapter` uses native `DOMParser`
- **Node.js**: `TestDOMAdapter` uses `@xmldom/xmldom`
- **Custom**: Implement `DOMAdapter` for any XML parser

### DOMAdapter responsibilities

```typescript
interface DOMAdapter {
    // Required: parse and query
    parseXML(str: string): XMLDocument
    parseHTML(str: string, mimeType?: string): XMLDocument
    serialize(doc: XMLDocument): string

    // Optional: document manipulation (for Document Model serialization)
    getChildNodes?(element: XMLElement): XMLNode[]
    createDocument?(): XMLDocument
    createElement?(doc: XMLDocument, tag: string): XMLElement
    createTextNode?(doc: XMLDocument, text: string): XMLNode
    appendChild?(parent: XMLElement, child: XMLNode): void
}
```

The optional methods enable Document Model serialization back to HTML. If not provided, `serialize()` falls back to string-based HTML generation.

## Pretext Segment Layout

The Pretext path is a separate rendering pipeline for EPUB text that needs fast style changes, font scaling, or virtualized display:

```
EPUB zip
  → XHTML string
  → DocumentNode AST
  → TextBlock[] (chapter/heading/paragraph/listItem/blockquote/pre/image)
  → TextSegment[] with inline style metadata
  → @chenglou/pretext prepareRichInline() for one-time Canvas measurement
  → @chenglou/pretext line range walking for width changes
  → rebook LineRange[] with source segment/style/image mapping
  → virtual DOM rows, Canvas, SVG, or WebGL
```

rebook does not implement the text measurement or Unicode line-breaking engine. That responsibility belongs to `@chenglou/pretext`. The local `src/core/pretext.ts` module is an adapter that:

- extracts structural reading blocks and text/style segments from `DocumentNode`
- converts each segment into a Pretext rich-inline item with a Canvas font string
- applies preset block typography for Chinese/English text
- maps Pretext line fragments back to the source EPUB segment index and style
- computes visible line windows for virtualized renderers

These capabilities are decoupled from the parser. The parser only guarantees that `book.sections` exists and can produce `getDocument()` and `getBlocks()`.

### URLFactory responsibilities

```typescript
interface URLFactory {
    createURL(data: string | ArrayBuffer | Blob, mimeType?: string): string
    revokeURL(url: string): void
}
```

Browser implementation wraps `URL.createObjectURL` / `URL.revokeObjectURL`. Test implementation uses fake URLs for deterministic testing.

## Document Model

Inspired by [SlateJS](https://docs.slatejs.org/), the Document Model provides a tree-based representation of section content with query and mutation capabilities.

### Why a tree model?

HTML is already a tree (the DOM). But the DOM is:
- Mutable (side effects everywhere)
- Platform-specific (browser-only)
- Verbose (Node interface has dozens of methods)

The Document Model is:
- **Immutable**: mutations return new instances, enabling undo/redo and safe concurrent access
- **Platform-agnostic**: plain JavaScript objects, no DOM dependency
- **Minimal**: `type`, `attrs`, `children`, `text` — four properties cover everything

### Node structure

```typescript
interface DocumentNode {
    type: string                    // Tag name or 'text'
    attrs?: Record<string, string>  // HTML attributes
    children?: DocumentNode[]       // Child nodes (element nodes)
    text?: string                   // Text content (text nodes only)
}
```

Text nodes are leaf nodes with `type: 'text'`. Element nodes have a tag-name `type` and optional `children`.

### Path-based addressing

Nodes are addressed by path (array of indices), following SlateJS convention:

```
[0]       → first root node
[0, 1]    → second child of first root node
[0, 1, 2] → third child of second child of first root node
```

Paths are stable across reads but invalidated by mutations (which return new documents).

### Immutability pattern

All mutations clone the tree before modifying:

```typescript
const doc = await section.getDocument()
const newDoc = doc.setNode([0], { class: 'highlight' })

doc.nodes[0].attrs     // undefined (original unchanged)
newDoc.nodes[0].attrs  // { class: 'highlight' }
```

This enables:
- **Undo/redo**: keep a stack of previous documents
- **Diffing**: compare two documents to compute changes
- **Safe iteration**: query a document while building mutations

## Plugin System (Planned)

The Document Model sets the foundation for a SlateJS-style plugin system:

```typescript
// Future API sketch
const reader = createReader({
    container: element,
    plugins: [
        withTranslation({ targetLanguage: 'zh-CN' }),
        withAnnotations({ storage: localStorage }),
        withImageEnhancement({ maxWidth: 800 }),
    ],
})
```

Plugins would follow SlateJS's `withX(editor)` middleware pattern, wrapping the Document Model to add behavior without modifying core code.

## Error Hierarchy

```
EBookError (base)
├── ParseError           — Content parsing failed
├── UnsupportedFormatError — Format not recognized
├── CorruptedFileError   — File severely corrupted
├── AdapterRequiredError — Missing required adapter
└── UnsupportedInputError — Input type not supported
```

**Why typed errors?** Consumers can handle specific failure modes:
- `UnsupportedFormatError` → show "unsupported format" dialog
- `ParseError` → show "file is corrupted" with format name
- `AdapterRequiredError` → developer error, log and report

## Malformed EPUB Recovery

Many EPUB files in the wild have broken zip archives. The `zip-loader` implements a multi-layer recovery strategy:

1. **Standard parse** — Try `@zip.js/zip.js` first
2. **Prepended data correction** — Detect uniformly-shifted Central Directory offsets and patch them
3. **Per-entry LFH scan** — Scan the file for actual Local File Header positions
4. **Full LFH fallback** — Build entry list entirely from Local File Headers
5. **Graceful degradation** — Return `null` for unrecoverable entries

This makes the library significantly more resilient than raw zip.js or foliate-js when dealing with EPUB files from various authoring tools.

## Project Structure

```
src/
├── core/               # Shared interfaces and types
│   ├── types.ts        # Book, Section, DocumentNode, etc.
│   ├── parser.ts       # Parser interface and registry
│   ├── renderer.ts     # Renderer interface
│   ├── document.ts     # Document Model implementation
│   ├── pretext.ts      # TextBlock extraction and Pretext adapter
│   ├── dom-adapter.ts  # DOMAdapter interface
│   ├── url-factory.ts  # URLFactory interface
│   ├── errors.ts       # Error hierarchy
│   ├── metadata.ts     # Metadata normalization helpers
│   └── utils.ts        # Shared utilities
├── adapters/
│   ├── browser.ts      # Browser DOM/URL adapters
│   └── test.ts         # Node.js test adapters
├── parsers/
│   ├── epub.ts         # EPUB parser
│   ├── mobi.ts         # MOBI/AZW/AZW3 parser
│   ├── fb2.ts          # FictionBook 2 parser
│   └── cbz.ts          # Comic Book Zip parser
├── loaders/
│   └── zip-loader.ts   # Zip archive loader (with malformed recovery)
├── renderers/
│   └── browser/        # Browser renderer
│       ├── paginator.ts
│       ├── virtual-text.ts # Pretext-backed virtual line renderer
│       └── view.ts     # ReaderView high-level API
└── utils/
    └── progress.ts     # Progress tracking

tests/
├── fixtures/           # Test file generators (EPUB, MOBI, FB2, CBZ)
├── loaders/            # Zip loader tests
├── parsers/            # Parser tests
├── renderers/          # Renderer tests
├── utils/              # Utility tests
└── document.test.ts    # Document Model tests
```
