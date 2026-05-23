# Experience & Lessons Learned

Design rationale, patterns borrowed, and lessons from building rebook.

## AI-Friendly Design

### The Problem

Most e-book libraries treat content as opaque HTML to be rendered. This works for reading, but breaks down for AI-powered features:

- **Translation**: need to walk text nodes and replace them
- **Summarization**: need to extract clean text without markup noise
- **Annotation**: need to mark specific passages with metadata
- **Accessibility**: need to add alt text, ARIA labels, reading order hints
- **Content restructuring**: need to move, duplicate, or remove sections
- **Image enhancement**: need to find images, process them, replace src

### The Solution: Document Model

A tree-based representation with query and mutation APIs:

```typescript
const doc = await section.getDocument()

// AI pipeline: extract → process → inject
const text = doc.getText()
const translation = await translate(text)
const translated = replaceTextInDoc(doc, translation)
const html = translated.serialize()
```

### Why not just use the DOM?

The DOM is:
1. **Mutable** — side effects make undo/redo and concurrent access dangerous
2. **Browser-only** — can't run in Node.js workers or server-side
3. **Verbose** — Node has ~100 properties/methods, most irrelevant for content manipulation
4. **Format-specific** — EPUB uses XHTML, MOBI uses HTML, FB2 uses custom XML

The Document Model normalizes all formats into the same tree structure.

### Why not Markdown / plain text?

E-book content is rich: headings, images, links, footnotes, styled text. Converting to Markdown loses fidelity (attributes, class names, exact structure). The Document Model preserves the full tree.

## SlateJS Patterns Borrowed

[SlateJS](https://docs.slatejs.org/) is a rich text editor framework known for its clean architecture. We borrowed several patterns:

### 1. Tree Value Model

SlateJS represents documents as a tree of `Element` and `Text` nodes. We do the same with `DocumentNode`:

```typescript
// SlateJS
{ type: 'paragraph', children: [{ text: 'Hello' }] }

// rebook DocumentNode
{ type: 'p', children: [{ type: 'text', text: 'Hello' }] }
```

### 2. Path-Based Addressing

SlateJS uses arrays of indices to address nodes:

```typescript
// [0, 1, 2] = third child of second child of first root node
doc.setNode([0, 1, 2], { class: 'highlight' })
```

This is simpler than CSS selectors for precise targeting and avoids the ambiguity of selectors like `p:nth-child(2)`.

### 3. Immutable Operations

SlateJS operations return new values without mutating the original. We follow the same pattern:

```typescript
const newDoc = doc.insertNode([1], newNode)
// doc is unchanged, newDoc has the insertion
```

This enables undo/redo stacks, diff computation, and safe iteration.

### 4. Plugin Middleware (Planned)

SlateJS plugins use `withX(editor)` to wrap the editor with new behavior:

```typescript
// SlateJS pattern
const editor = withHistory(withReact(createEditor()))

// rebook future pattern
const doc = withTranslation(withAnnotations(baseDoc))
```

We haven't implemented this yet, but the Document Model is designed to support it.

### What we didn't borrow

- **Selection/Cursor**: rebook is for reading, not editing — no cursor state needed
- **Normalization**: SlateJS auto-normalizes invalid trees — we trust parser output
- **Commands**: SlateJS has a command system — we use direct method calls
- **React integration**: SlateJS is React-coupled — we're framework-agnostic

## Immutability Pattern

### The naive approach (broken)

```typescript
class SectionDocument {
    insertNode(path, node) {
        this.nodes.splice(path[0], 0, node) // MUTATES
        return this
    }
}
```

Problems: callers holding references to the old doc see it change unexpectedly.

### The clone-on-mutate approach

```typescript
class SectionDocument {
    insertNode(path, node) {
        const newNodes = cloneNodes(this.nodes)  // deep clone
        // ... modify newNodes ...
        return new SectionDocument(newNodes)
    }
}
```

Each mutation clones the tree first. This is more expensive than in-place mutation, but:
- Documents are small (a chapter, not a whole book)
- The cost is O(nodes in affected subtree), not O(entire document)
- The safety benefits far outweigh the cost for AI use cases

### Critical lesson: clone attrs too

```typescript
// BUG: attrs is shared between original and clone
function cloneNode(node) {
    return { type: node.type, attrs: node.attrs, children: ... }
    //                                ^^^ shared reference!
}

// FIX: spread attrs
function cloneNode(node) {
    return { type: node.type, attrs: node.attrs ? { ...node.attrs } : undefined, ... }
}
```

Without deep-cloning attrs, `setNode` on the clone modifies the original's attrs. This was a real bug caught in testing.

## Adapter Lessons

### xmldom vs browser DOMParser

`@xmldom/xmldom` (used in `TestDOMAdapter`) behaves differently from browser `DOMParser` in several ways:

1. **No `<body>` wrapping**: Browser `DOMParser` wraps HTML fragments in `<html><body>`. xmldom does not.
   - **Fix**: Wrap HTML in `<html><body>...</body></html>` before parsing.

2. **No `querySelector`**: xmldom elements lack `querySelector` / `querySelectorAll`.
   - **Fix**: Implement basic selector matching manually (tag name, class, ID, attribute).

3. **Text nodes in `childNodes`**: xmldom includes text nodes in `childNodes` but they don't implement the full Node interface.
   - **Fix**: Check `nodeType === 3` and extract `textContent` directly.

### URLFactory: don't leak browser globals

The original design had `URL.createObjectURL` calls scattered across parsers. This made Node.js testing impossible.

**Lesson**: Every `URL.createObjectURL` call should go through `URLFactory`. Even if the browser adapter is just a thin wrapper, the indirection enables testing and alternative environments.

## MOBI Parser Lessons

### MOBI6 vs KF8 are fundamentally different formats

Despite sharing the `.mobi` extension (and PDB container format), MOBI6 and KF8 have completely different content structures:

- **MOBI6**: Single HTML stream, split at `<mbp:pagebreak>` tags. Resources referenced by recindex.
- **KF8**: Skeleton + fragments. Content is split by FDST section boundaries, then reassembled from SKEL + FRAG tables.

Trying to unify these into one code path produces confusing code. We keep them as separate classes (`MOBI6` and `KF8`) with a shared `MOBI` base.

### HUFF/CDIC decompression needs BigInt

The Huffman decoder in HUFF/CDIC compression reads variable-length bit streams. JavaScript's `Number` loses precision for the 64-bit bit manipulation needed.

**Fix**: Use `BigInt` for the bitstream reader. The performance cost is negligible for typical book content.

### EXTH metadata is messy

EXTH records have ~20 defined types, but real-world files often have:
- Duplicate records (same type, different values)
- Unknown record types (safely ignored)
- Encoding mismatches (UTF-8 declared, CP1252 actual)

**Lesson**: Parse EXTH defensively. Collect all records, then merge with format-specific logic.

## FB2 Parser Lessons

### FB2 is XML, not HTML

FB2 uses a custom XML schema with namespaced elements. Converting it to XHTML requires:
- Mapping FB2 elements to HTML equivalents (`<section>` → `<div>`, `<p>` → `<p>`, `<image>` → `<img>`)
- Converting binary images to data URIs
- Handling the "body" concept (FB2 has main body + notes body)

### FBZ (zipped FB2) detection

FBZ files can have either `.fbz` or `.fb2.zip` extension. The zip might contain:
- A single `.fb2` file (easy case)
- Multiple `.fb2` files (rare, use first)
- Images referenced by the FB2 (need to resolve relative paths)

## Malformed EPUB Handling

### Why EPUB files break

EPUB is a zip archive with specific structure. Common breakage:

1. **Prepended data**: Some DRM systems or download managers prepend bytes to the file, shifting all zip offsets.
2. **Wrong Central Directory offsets**: Authoring tools sometimes write incorrect offsets in the CD.
3. **Missing or corrupt CD**: The Central Directory might be truncated or have invalid entries.

### Recovery strategy (layered)

Each layer tries a broader recovery:

1. **zip.js standard parse** — works for well-formed files
2. **CD offset correction** — detect uniform shift and patch all entries
3. **Per-entry LFH scan** — find actual data by scanning for Local File Headers
4. **LFH-only fallback** — ignore CD entirely, build from LFH chain
5. **Graceful null** — return `null` for individual entries that can't be recovered

**Lesson**: The key insight is that Local File Headers are self-contained — each has its own filename, sizes, and compressed data. You don't need the Central Directory at all if you're willing to scan the entire file.

### Impact

This recovery stack makes rebook handle ~90% of broken EPUB files that fail in other libraries, based on testing with real-world files from various sources.

## Performance Notes

### Lazy loading

`Section.load()` is async and called on demand. A 100-chapter book only loads the current chapter's content.

`getDocument()` is also lazy — the HTML is parsed into a DocumentNode tree only when first accessed. Subsequent calls return the cached tree.

### Zip entry access

The zip loader reads only the Central Directory initially (a few KB even for large books). Individual entries are decompressed on demand using `DecompressionStream`.

### MOBI text loading

MOBI6 loads and decompresses all text records upfront (they're small). KF8 loads text records lazily per-section, since KF8 books can have much larger content.

### Document Model serialization

`SectionDocument.serialize()` uses DOM manipulation when available (faster for complex documents) and falls back to string concatenation (simpler, works everywhere).

## Testing Strategy

### Fixture generators over fixture files

Instead of shipping binary test files (which are hard to review and update), we generate test fixtures programmatically:

```typescript
const epub = createTestEPUB({
    title: 'Test Book',
    sections: [
        { id: 'ch1', content: '<p>Chapter 1</p>' },
        { id: 'ch2', content: '<p>Chapter 2</p>' },
    ],
})
```

**Benefits**:
- Test fixtures are reviewable in code review
- Easy to create edge cases (missing metadata, empty sections, etc.)
- No binary blobs in the repository
- Tests are self-documenting

### Adapter-based testing

`TestDOMAdapter` (using `@xmldom/xmldom`) enables testing parsers in Node.js without jsdom. This is faster and more reliable than browser-based testing.

### Test coverage

208 tests across 9 test files:
- 4 parser test suites (EPUB, MOBI, FB2, CBZ)
- Document Model tests (query, mutation, serialization)
- Zip loader tests (including malformed zip recovery)
- Utility tests (progress tracking)

## CSS Multi-Column Layout Lessons

### The `column-width` trap

CSS `column-width` is **not** a fixed width — it's a suggestion. The browser adjusts actual column width to fill the container:

```css
html {
    column-width: 720px;  /* Suggestion only! */
}
```

If the container is 1200px wide, the browser creates 1 column × 1200px (not 720px). This causes content to overflow the visible area.

**Fix**: Constrain the iframe width to exactly the desired visible span:

```typescript
// Single page
iframe.style.width = `${pageWidth + gap}px`

// Two-page spread
iframe.style.width = `${pageWidth * 2 + gap}px`
```

With the iframe width constrained, the browser creates columns that are exactly `pageWidth` wide.

### Scrolling through columns

We use CSS multi-column for horizontal pagination: columns flow left-to-right, and we scroll horizontally to reveal them:

```typescript
html.style.columnWidth = '720px'
html.style.columnGap = '48px'
html.style.height = '800px'
html.style.overflow = 'hidden'
html.style.columnFill = 'auto'

// Scroll to next page
iframe.contentWindow.scrollTo({ left: 720, behavior: 'smooth' })
```

**Key insight**: `contentWidth` captures the total width of all columns. For a spread (2 visible pages), scroll by `pageWidth * 2 + gap` to advance one "view".

### Auto-spread detection

To dynamically switch between single-page and spread layouts:

```typescript
const divisor = Math.min(
    maxColumnCount,  // e.g., 2
    Math.max(1, Math.ceil(availableWidth / maxInlineSize)),
)
// divisor = 1 when narrow, 2 when wide
```

On resize, recalculate `divisor` and update iframe width. The browser automatically reflows content into the correct number of columns.

### XML declaration parsing

EPUB sections are serialized by `XMLSerializer`, which prepends `<?xml version="1.0" encoding="UTF-8"?>`. The renderer must detect this:

```typescript
const isFullDocument = /^\s*(<\?xml|<!DOCTYPE|<html[\s>])/i.test(content)
```

Without detecting `<?xml`, the content is treated as a fragment and wrapped in another document, causing double XML declarations and parse errors.

**Lesson**: Always serve full documents as `text/html` (lenient parsing) rather than `application/xhtml+xml` (strict XML parsing), since real-world EPUBs often have quirks.

## Future Directions

### Plugin system

The Document Model is designed to support SlateJS-style plugins:

```typescript
const doc = withTranslation(baseDoc, { target: 'zh-CN' })
// Translation plugin intercepts getText() and replaceText()
```

### Bidirectional sync

Currently, Document Model mutations produce new documents. The next step is bidirectional sync: mutations to the Document Model reflect in the rendered view, and DOM selections map back to DocumentNode paths.

### Diff and patch

With immutable documents, computing diffs is straightforward:

```typescript
const diff = diffDocuments(original, modified)
// [{ op: 'replaceText', path: [0, 0], text: 'new' }, ...]
```

This enables collaborative editing, change tracking, and AI-generated change proposals.
