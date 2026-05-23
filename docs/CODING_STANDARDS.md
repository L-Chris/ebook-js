# Coding Standards — rebook

## 1. TypeScript Conventions

### Naming
- **PascalCase**: Types, interfaces, classes, enums (`BookMetadata`, `EPUBParser`, `SectionDocument`)
- **camelCase**: Functions, variables, properties (`parseHTML`, `getDocument`, `loadText`)
- **UPPER_SNAKE_CASE**: Constants (`IMAGE_EXTENSIONS`, `LOCAL_FILE_HEADER_SIG`)

### Type System
- Strict mode always enabled (`"strict": true` in tsconfig)
- Prefer `interface` for object shapes, `type` for unions/intersections/utilities
- No `any` except at adapter boundaries (where opaque types are unavoidable)
- Use `unknown` for opaque external types (e.g., `anchor` in navigation, `Document` in renderer)

### Functions
- Arrow functions for exported utilities (`export const normalizeWhitespace = ...`)
- Named functions for complex logic with recursion or closures
- Always specify return types for exported functions

### Imports
- Use `import type` for type-only imports
- Group imports: types first, then values
- Prefer named imports over namespace imports

## 2. File Organization

### Size Limits
- **Maximum 500 lines per file** (excluding test fixtures and generated code)
- Tech debt: `mobi.ts` (1641), `epub.ts` (876), `fb2.ts` (710) are grandfathered (see `TECH_DEBT.md`)

### Module Structure
- One public class/interface per file, or a cohesive group of related types
- Barrel files (`index.ts`) re-export only — no logic
- Co-locate private helpers with their consumer
- Group related files in subdirectories (`parsers/`, `adapters/`, `renderers/`)

### Naming Conventions
- File names: kebab-case (`dom-adapter.ts`, `url-factory.ts`)
- Test files: `*.test.ts` suffix
- Fixture files: `*-fixture.ts` suffix

## 3. Immutability Rules

### Core Types
Core data types MUST use `readonly`:
- `Book.sections`, `Book.toc`, `Book.landmarks`
- `Section` data properties (methods stay mutable)
- `TOCItem` (all properties)
- `Landmark` (all properties)
- `BookMetadata` (all properties except index signature)
- `DocumentNode` (all properties)
- `DocumentResource` data properties

### Arrays in Interfaces
```typescript
// Correct
readonly sections: readonly Section[]
readonly toc?: readonly TOCItem[]

// Incorrect
sections: Section[]
toc?: TOCItem[]
```

### Mutation Pattern
Mutation methods return new instances (SlateJS pattern):
```typescript
// Correct — immutable
insertNode(path: number[], node: DocumentNode): SectionDocument {
    const newNodes = cloneNodes(this.nodes)
    // ... modify newNodes ...
    return new SectionDocumentImpl(newNodes, this.domAdapter)
}

// Incorrect — mutable
insertNode(path: number[], node: DocumentNode): void {
    this.nodes.splice(path[0], 0, node)
}
```

### Parser Output
Parser output is frozen at the type level. Internal parser state during parsing may be mutable, but returned objects must satisfy `readonly` interfaces.

## 4. Error Handling

### Always Use Typed Errors
Use the error hierarchy from `core/errors.ts`:

| Error Type | Use Case |
|------------|----------|
| `ParseError` | Invalid format content (malformed XML, missing required elements) |
| `CorruptedFileError` | Severely damaged binary structures (bad headers, magic mismatches) |
| `UnsupportedFormatError` | Unrecognized file format |
| `AdapterRequiredError` | Missing required adapter in `ParserOptions` |
| `UnsupportedInputError` | Wrong input type for parser |
| `EBookError` | Base class for anything else library-specific |

### Never Use Raw Errors
```typescript
// Correct
throw new ParseError('Missing required element', 'epub')
throw new CorruptedFileError('Invalid header', 'mobi')

// Incorrect
throw new Error('Missing required element')
throw new RangeError('Index out of bounds')
throw new TypeError('Invalid input')
```

### Error Properties
- `message`: Human-readable description
- `code`: Machine-readable code (inherited from `EBookError`)
- `format`: Format name (on `ParseError`, `CorruptedFileError`)

## 5. Utility Functions

### Single Source of Truth
All shared utilities live in `core/utils.ts` — ONE canonical definition.

### No Duplicates
```typescript
// Correct — import from utils
import { escapeHTML } from '../core/utils'
const html = escapeHTML(text)

// Incorrect — local duplicate
function escapeHTML(str: string): string {
    return str.replace(/&/g, '&amp;')...
}
```

### Parser-Specific Helpers
Parser-specific helpers (e.g., `findByTag`, `parseDate`) may stay local if not shared across parsers.

## 6. Testing Standards

### Test File Location
- Every parser must have tests in `tests/parsers/{name}.test.ts`
- Test fixtures live in `tests/fixtures/` and generate in-memory data (no binary files)

### Test Adapter Imports
```typescript
// Correct — direct import
import { TestDOMAdapter, TestURLFactory } from '../../src/adapters/test'

// Incorrect — barrel import (test adapters not in production barrel)
import { TestDOMAdapter } from '../../src/adapters'
```

### Test Coverage
- Parser happy path (valid file → correct `Book` structure)
- Error paths (malformed file → typed error)
- Metadata extraction (title, author, language)
- Content loading (`section.load()` returns expected content)

### Test Framework
Use Vitest with descriptive test names:
```typescript
describe('EPUB Parser', () => {
    it('should parse valid EPUB3 with navigation', async () => {
        // ...
    })
    
    it('should throw ParseError for malformed OPF', async () => {
        // ...
    })
})
```

## 7. Documentation (JSDoc)

### Requirements
Every exported function, class, and interface MUST have a JSDoc comment:

```typescript
/**
 * Parse an EPUB file into a Book structure.
 * 
 * @param input - File, Blob, ArrayBuffer, or URL string
 * @param options - Parser options (adapters, progress callback)
 * @returns Parsed Book with sections, metadata, and TOC
 * @throws ParseError if EPUB structure is invalid
 * @throws AdapterRequiredError if domAdapter or urlFactory not provided
 * 
 * @example
 * const book = await parser.parse(file, {
 *     domAdapter: new BrowserDOMAdapter(),
 *     urlFactory: new BrowserURLFactory(),
 * })
 */
async parse(input: ParserInput, options?: ParserOptions): Promise<Book>
```

### Tags
- `@param` for non-obvious parameters
- `@returns` for complex return types
- `@throws` for functions that throw typed errors
- `@example` for public API functions
- `@internal` for implementation details that must be exported for testing

## 8. Export Rules

### Public API
- Exported from `src/index.ts`
- Only types, classes, and functions intended for external use

### Barrel Files
- `src/core/index.ts` — re-exports core types and utilities
- `src/parsers/index.ts` — re-exports parser factories
- `src/adapters/index.ts` — re-exports production adapters only

### Test Code Isolation
Test adapters MUST NOT be exported from production barrel files:
```typescript
// src/adapters/index.ts — Correct
export { BrowserDOMAdapter, BrowserURLFactory } from './browser'
// Test adapters: import from 'rebook/adapters/test'

// Incorrect
export { BrowserDOMAdapter, TestDOMAdapter } from './adapters'
```

### Export Style
- Use explicit named exports — no `export *` except in internal barrel files
- Use `export type` for type-only exports

## 9. Dependency Injection

### DOM Operations
All DOM operations go through `DOMAdapter` interface (`core/dom-adapter.ts`):
- `parseXML(str)` — parse XML string
- `parseHTML(str, mimeType?)` — parse HTML string
- `serialize(doc)` — serialize document to string
- Optional: `getChildNodes`, `createDocument`, `createElement`, `createTextNode`, `appendChild`

### URL Creation
All URL creation goes through `URLFactory` interface (`core/url-factory.ts`):
- `createURL(data, mimeType?)` — create blob URL
- `revokeURL(url)` — revoke blob URL

### Injection Pattern
Both injected via `ParserOptions` — never imported directly:
```typescript
// Correct
const book = await parser.parse(file, {
    domAdapter: new BrowserDOMAdapter(),
    urlFactory: new BrowserURLFactory(),
})

// Incorrect — direct browser API usage
const url = URL.createObjectURL(blob)
const doc = new DOMParser().parseFromString(str, 'text/html')
```

### Browser Implementations
- `adapters/browser.ts` — `BrowserDOMAdapter`, `BrowserURLFactory`

### Test Implementations
- `adapters/test.ts` — `TestDOMAdapter` (uses `@xmldom/xmldom`), `TestURLFactory` (fake URLs)

## 10. Code Review Checklist

Before merging, verify:

- [ ] No raw `throw new Error(...)` — use typed error hierarchy
- [ ] No duplicate utility definitions (check `core/utils.ts` first)
- [ ] `readonly` on all core type properties (Book, Section, TOCItem, etc.)
- [ ] No test-only exports in production barrel files
- [ ] JSDoc on all new exports
- [ ] File under 500 lines (or documented in `TECH_DEBT.md`)
- [ ] No browser globals used outside `adapters/browser.ts`
- [ ] No direct DOM API usage in parsers (use `DOMAdapter`)
- [ ] No direct `URL.createObjectURL` in parsers (use `URLFactory`)
- [ ] Tests pass: `npm test`
- [ ] Typecheck passes: `npm run typecheck`
