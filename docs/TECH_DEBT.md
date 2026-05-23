# Technical Debt Register

This document tracks known technical debt in rebook, including rationale for deferring fixes and plans for future resolution.

---

## TD-001: Monolithic Parser Files

**Severity**: Medium  
**Impact**: Code maintainability, review difficulty  
**Created**: 2024

### Description

Three parser files exceed the 500-line limit defined in `CODING_STANDARDS.md`:

| File | Lines | Status |
|------|-------|--------|
| `src/parsers/mobi.ts` | 1641 | Grandfathered |
| `src/parsers/epub.ts` | 876 | Grandfathered |
| `src/parsers/fb2.ts` | 710 | Grandfathered |

### Why Not Refactor Now?

1. **High coupling**: Each parser is a cohesive unit with deep internal dependencies
   - MOBI: Binary decompression, EXTH metadata, and format-specific logic are tightly intertwined
   - EPUB: OPF parsing, spine resolution, and encryption handling share significant state
   - FB2: Element conversion tables and metadata extraction are interdependent

2. **Test coverage gaps**: Current tests validate output but not internal structure
   - Refactoring requires unit tests for internal functions (e.g., `parseOpf`, `decompressHuff`)
   - Risk of introducing subtle bugs in binary parsing (MOBI) and XML processing (EPUB/FB2)

3. **Stable codebase**: These parsers are mature and rarely change
   - Last significant change: 6+ months ago
   - Most maintenance is bug fixes, not feature additions

### Proposed Future Decomposition

When test coverage improves and refactoring is needed, split as follows:

#### MOBI Parser (`mobi.ts` → `mobi/`)

```
src/parsers/mobi/
├── index.ts          # MOBIParser class + mobi() factory
├── types.ts          # MOBI-specific types (MobiHeader, ExthRecord, etc.)
├── binary.ts         # Binary reading utilities (readUint32, readString, etc.)
├── decompress.ts     # PalmDOC and HUFF/CDIC decompression
├── exth.ts           # EXTH metadata parsing
├── kf8.ts            # KF8-specific logic (FDST, fragment handling)
└── mobi6.ts          # MOBI6-specific logic (legacy format)
```

#### EPUB Parser (`epub.ts` → `epub/`)

```
src/parsers/epub/
├── index.ts          # EPUBParser class + epub() factory
├── types.ts          # EPUB-specific types (OpfManifest, SpineItem, etc.)
├── container.ts      # META-INF/container.xml parsing
├── opf.ts            # OPF package document parsing
├── ncx.ts            # NCX navigation parsing
├── encryption.ts     # Font deobfuscation (IDPF/Adobe)
└── landmarks.ts      # EPUB3 landmarks processing
```

#### FB2 Parser (`fb2.ts` → `fb2/`)

```
src/parsers/fb2/
├── index.ts          # FB2Parser class + fb2() factory
├── types.ts          # FB2-specific types (Fb2Metadata, Fb2Section, etc.)
├── elements.ts       # Element conversion tables (FB2 → XHTML)
├── metadata.ts       # Metadata extraction and normalization
└── converter.ts      # FB2Converter class (DOM traversal)
```

### Resolution Criteria

Refactor when:
1. **Test coverage improves**: Add unit tests for internal functions
2. **Feature request requires it**: New feature (e.g., encryption support) necessitates restructuring
3. **Bug frequency increases**: Multiple bugs in same area suggest structural issues
4. **Team grows**: Multiple developers working on parsers need clearer boundaries

### Mitigation

Until refactored:
- Use clear section comments (`// === OPF PARSING ===`)
- Keep related functions close together
- Extract utilities to `src/utils/` when reused
- Document complex algorithms inline

---

## TD-002: Incomplete Document Model Implementation

**Severity**: Low  
**Impact**: AI workflow capabilities  
**Created**: 2024

### Description

The Document Model (AI-friendly tree structure) is implemented but not fully integrated:

- ✅ Core types (`DocumentNode`, `SectionDocument`)
- ✅ Parsing (`parseHTML`, `domToNode`)
- ✅ Query API (`querySelector`, `querySelectorAll`)
- ✅ Mutation operations (`insertNode`, `removeNode`, `setNode`, `replaceText`)
- ✅ Serialization (`serialize`)
- ⏳ Plugin system (`withX` middleware pattern) — Planned
- ⏳ Bidirectional sync (tree ↔ DOM) — Not started
- ⏳ Diff/patch operations — Not started

### Why Not Implement Now?

1. **Current scope met**: Document Model satisfies the "AI-friendly" requirement for basic workflows
2. **Complexity**: Plugin system and bidirectional sync require significant design work
3. **Low demand**: No active use cases requiring advanced features

### Future Implementation

#### Plugin System (SlateJS-style)

```typescript
// Example: withAnnotations plugin
function withAnnotations(doc: SectionDocument): AnnotatedDocument {
    return {
        ...doc,
        addAnnotation(path: number[], data: Annotation): AnnotatedDocument {
            const newDoc = doc.setNode(path, { ...doc.getNode(path).attrs, 'data-annotation': JSON.stringify(data) })
            return withAnnotations(newDoc)
        },
        getAnnotations(): Annotation[] {
            return doc.querySelectorAll('[data-annotation]').map(node => 
                JSON.parse(node.attrs['data-annotation'])
            )
        }
    }
}

// Usage
const doc = withAnnotations(sectionDocument)
const annotated = doc.addAnnotation([0, 1, 2], { type: 'highlight', color: 'yellow' })
```

#### Bidirectional Sync

- **Tree → DOM**: Re-render section when tree changes
- **DOM → Tree**: Update tree when user edits content (contenteditable)
- Requires: Stable node IDs, position tracking, conflict resolution

#### Diff/Patch Operations

- **Diff**: Compare two trees, generate operation list
- **Patch**: Apply operations to tree
- Use case: Collaborative editing, undo/redo, AI-generated changes

### Resolution Criteria

Implement when:
1. **User request**: Specific use case requires advanced features
2. **AI integration**: Building AI-powered editing workflows
3. **Collaboration features**: Multi-user editing needs conflict resolution

---

## TD-003: Test Coverage Gaps

**Severity**: Low  
**Impact**: Refactoring safety, bug detection  
**Created**: 2024

### Description

Current test coverage is good but has gaps:

| Area | Coverage | Notes |
|------|----------|-------|
| Parser happy paths | ✅ High | All parsers tested with valid files |
| Parser error paths | ✅ Medium | Common errors tested, edge cases missing |
| Document Model | ✅ High | Query, mutation, serialization tested |
| Binary decompression (MOBI) | ⚠️ Low | PalmDOC tested, HUFF/CDIC not directly tested |
| Encryption (EPUB) | ⚠️ Low | Font deobfuscation not tested (no encrypted fixtures) |
| Zip loader fallbacks | ✅ High | All 3 fallback strategies tested |
| Adapters | ⚠️ Low | Browser adapter not tested (requires jsdom) |
| Utilities | ✅ High | `escapeHTML`, `parseHTML`, etc. tested |

### Why Not Improve Now?

1. **Diminishing returns**: Current 208 tests cover main use cases
2. **Fixture complexity**: Encrypted EPUBs and HUFF-compressed MOBIs are hard to generate programmatically
3. **Browser testing**: Requires jsdom or Playwright setup (significant infrastructure)

### Future Improvements

1. **Real-world fixtures**: Add 2-3 real EPUB/MOBI files (with licenses) for integration tests
2. **Browser adapter tests**: Use jsdom or Playwright for `BrowserDOMAdapter` tests
3. **Edge cases**: Add tests for:
   - Empty sections
   - Missing metadata
   - Malformed XML (graceful degradation)
   - Large files (performance regression detection)

### Resolution Criteria

Improve when:
1. **Refactoring**: Before splitting monolithic parsers (TD-001)
2. **Bug reports**: Specific edge cases reported by users
3. **CI/CD setup**: Automated testing pipeline established

---

## TD-004: Limited Renderer Features

**Severity**: Low  
**Impact**: User experience, adoption  
**Created**: 2024

### Description

The browser renderers are functional but intentionally limited:

- ✅ Legacy iframe pagination (CSS columns)
- ✅ Virtual text pagination and scrolling
- ✅ Virtual text two-column auto-spread
- ✅ Basic styling (font, colors)
- ✅ AST-derived text blocks for common Chinese/English reflowable EPUBs
- ⏳ Annotations (highlight, notes) — Not started
- ⏳ Search (find in book) — Not started
- ⏳ Accessibility (screen reader support) — Not started
- ⏳ Arbitrary EPUB CSS fidelity in virtual text mode — Out of scope; use iframe renderer
- ⏳ Images/tables/ruby/footnotes in virtual text mode — Partial or not modeled yet
- ⏳ Custom themes (user-defined CSS) — Partially supported in iframe, preset styles in virtual text
- ⏳ Progress sync (cross-device) — Not started

### Why Not Implement Now?

1. **Core library focus**: rebook is a parsing/rendering foundation, not a full reader
2. **Application-specific**: Annotations, search, and themes vary by use case
3. **Resource constraints**: Limited development time
4. **Renderer split is deliberate**: Virtual text optimizes predictable typography and small DOM; iframe optimizes EPUB CSS fidelity

### Future Implementation

These features are better implemented at the application layer:

```typescript
// Application code, not library code
class EbookReader {
    constructor(private book: Book, private container: HTMLElement) {}
    
    addAnnotation(sectionIndex: number, cfi: string, text: string): void {
        // Application-specific storage (localStorage, database, etc.)
    }
    
    search(query: string): Promise<SearchResult[]> {
        // Application-specific search (client-side, server-side, etc.)
    }
    
    syncProgress(location: Location): Promise<void> {
        // Application-specific sync (Firebase, custom API, etc.)
    }
}
```

### Resolution Criteria

Implement when:
1. **User demand**: Multiple users request specific features
2. **Reference implementation**: Building a demo reader app
3. **Partnership**: Collaborating with a reading app developer
4. **Block model extension**: Add explicit `image`, `table`, `ruby`, and `footnote` blocks before trying to emulate arbitrary EPUB CSS

---

## Summary

| ID | Issue | Severity | Status |
|----|-------|----------|--------|
| TD-001 | Monolithic parser files | Medium | Grandfathered, plan ready |
| TD-002 | Incomplete Document Model | Low | Planned, low priority |
| TD-003 | Test coverage gaps | Low | Acceptable, improve when needed |
| TD-004 | Limited renderer features | Low | Out of scope (application layer) |

## Updating This Document

When resolving technical debt:
1. Update status to "Resolved"
2. Add resolution date and PR link
3. Keep description for historical context

When discovering new debt:
1. Add new entry with unique ID
2. Include severity, impact, and rationale for deferring
3. Define resolution criteria
