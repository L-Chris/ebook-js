# rebook

[中文文档](./README.zh-CN.md) | [API Reference](./docs/API.md) | [Architecture](./docs/ARCHITECTURE.md) | [Experience & Lessons](./docs/EXPERIENCE.md)

A modular, extensible e-book parsing and rendering library for the web.

Inspired by [foliate-js](https://github.com/johnfactotum/foliate-js), but restructured with a clean separation between **parsers** (file format handling) and **renderers** (platform-specific display).

## Features

- **Modular architecture**: Parsers and renderers are independent — mix and match
- **TypeScript**: Full type safety with comprehensive interfaces
- **Multi-format support**: EPUB 2.x/3.x, MOBI/AZW/AZW3, FictionBook 2, and CBZ
- **AI-friendly Document Model**: SlateJS-inspired tree structure with query and mutation APIs for content manipulation (translation, annotation, restructuring)
- **Pretext layout pipeline**: EPUB sections can expose styled text segments for one-time measurement and pure in-memory line slicing
- **Environment-agnostic parsers**: All parsers run in browser, Node.js, or workers via adapter injection
- **Pluggable exporters**: Export parsed books through a format-neutral exporter registry, with EPUB output built in
- **Browser renderer**: Fast AST/Pretext virtual text renderer built-in
- **Malformed EPUB recovery**: Multi-layer fallback for broken zip archives
- **Framework-agnostic**: Core library works with any framework; React/Vue wrappers coming

## Installation

```bash
npm install rebook
```

## Supported Formats

| Format | Extensions | Parser | Notes |
|--------|-----------|--------|-------|
| EPUB 2/3 | `.epub` | `EPUBParser` | Full support: navigation, spine, font deobfuscation, landmarks |
| Mobipocket / Kindle | `.mobi`, `.azw`, `.azw3` | `MOBIParser` | MOBI6 + KF8, PalmDOC + HUFF/CDIC, EXTH metadata, NCX |
| FictionBook 2 | `.fb2`, `.fbz`, `.fb2.zip` | `FB2Parser` | FB2 XML to XHTML conversion, FBZ archive support |
| Comic Book Zip | `.cbz` | `CBZParser` | Sequential images from zip archives |

## Quick Start

```typescript
import { registry, createReader, UnsupportedFormatError } from 'rebook'
import { epub } from 'rebook/parsers/epub'
import { mobi } from 'rebook/parsers/mobi'
import { fb2 } from 'rebook/parsers/fb2'
import { cbz } from 'rebook/parsers/cbz'

// Register parsers for auto-detection
registry.register('epub', epub)
registry.register('mobi', mobi)
registry.register('fb2', fb2)
registry.register('cbz', cbz)

// Create reader with the default virtual text renderer
const reader = createReader({
    container: document.getElementById('viewer')!,
    styles: {
        fontSize: '18px',
        lineHeight: 1.7,
        maxInlineSize: '720px',
    },
})

// Open and navigate
const book = await reader.open(file)
await reader.next()
await reader.goTo('/path/to/chapter.xhtml#section')
```

### Export First Sections

```typescript
import { exportFirstSections } from 'rebook'

const blob = await exportFirstSections(file, 5, {
    format: 'epub',
    parserOptions: { domAdapter, urlFactory },
})
```

Exporters are registered through `exporterRegistry`, so future output formats can be added without changing parser or renderer code. Exporting by count uses linear reading sections: CBZ maps sections to image pages, while EPUB/MOBI/FB2 map them to spine or parser-split sections rather than visual pages after layout.

### Browser Rendering

`createReader()` uses `VirtualTextRenderer` by default. It parses XHTML into structural reading blocks (`chapter`, `heading`, `paragraph`, `listItem`, `blockquote`, `pre`), applies preset Chinese/English-friendly text styles, uses Pretext for measurement/layout, and renders only the visible line rows.

In `paginated` layout, wheel and `next()` / `prev()` turn viewport-height pages instead of allowing free vertical drift. On wide containers it supports auto-spread two-column reading: when the available width fits `2 × maxInlineSize + gap`, visible rows are flowed into left and right columns with page padding so text does not touch the clipped edge. `reader.setSpread(1)` forces single column, and `reader.setSpread(2)` restores auto-spread.

## Document Model (AI-friendly)

Each section exposes a structured document tree with query and mutation APIs:

```typescript
const section = book.sections[0]
const doc = await section.getDocument()

// Query with CSS-like selectors
const paragraphs = doc.query('p')
const images = doc.getImages()
const text = doc.getText()

// Immutable mutations (returns new document)
const newDoc = doc
    .setNode([0], { class: 'highlight' })
    .insertNode([1], elementNode('p', {}, [textNode('Added by AI')]))
    .replaceText([0, 0], 'Translated text')

// Serialize back to HTML
const html = newDoc.serialize()
```

This enables AI-powered workflows: translation, content summarization, annotation, accessibility enhancement, layout adaptation, and more. See [API Reference](./docs/API.md#document-model) for details.

## Pretext Line Layout

For renderers that need fast style changes or virtualized text, EPUB sections expose structural blocks and styled segments that can be measured once and laid out repeatedly without reflowing a full chapter DOM:

```typescript
import { prepare, layout, getVisibleLines } from 'rebook'

const blocks = await book.sections[0].getBlocks!()
const prepared = prepareBlocks(blocks, {
    baseStyle: { fontSize: 18, lineHeight: 1.6 },
})

const lines = layout(prepared, { inlineSize: 680, lineHeight: 32 })
const visible = getVisibleLines(lines, scrollTop, viewportHeight)
```

`prepare()` delegates to `@chenglou/pretext` for one-time Canvas measurement, while `layout()` walks Pretext line ranges and maps every visible fragment back to its EPUB segment/style source. The resulting `LineRange` objects can feed a virtual list or Canvas renderer while keeping the live DOM minimal.

The browser package also exports `VirtualTextRenderer` / `createVirtualTextRenderer`, which uses this pipeline to render only visible line rows as simple DOM spans.

## Documentation

- [**API Reference**](./docs/API.md) — Full API documentation: parsers, renderer, adapters, Document Model, Pretext layout, error types, metadata normalization
- [**Architecture**](./docs/ARCHITECTURE.md) — Design decisions, parser/renderer separation, adapter system, cross-platform rendering
- [**Experience & Lessons**](./docs/EXPERIENCE.md) — AI-friendly design rationale, SlateJS patterns, malformed EPUB handling, performance notes

## Development

```bash
npm install       # Install dependencies
npm run dev       # Run demo
npm run typecheck # Type check
npm run build     # Build
npm test          # Run tests
```

## Comparison with foliate-js

| Feature | foliate-js | rebook |
|---------|-----------|----------|
| Language | JavaScript | TypeScript |
| Architecture | Monolithic view.js | Separated parser/renderer |
| Browser coupling | Parser uses DOM APIs | Parser is env-agnostic (adapters) |
| Document Model | None | SlateJS-inspired tree with mutations |
| Format support | EPUB, MOBI, FB2, CBZ, PDF | EPUB, MOBI/AZW3, FB2, CBZ |
| Testing | None | Vitest (208 tests) |
| Malformed EPUB recovery | None | CD correction + per-entry LFH scan |

## License

MIT

## Credits

Based on the excellent [foliate-js](https://github.com/johnfactotum/foliate-js) by John Factotum.
