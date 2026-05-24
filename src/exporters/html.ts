/**
 * HTML (single-file) exporter.
 *
 * Exports selected sections as a self-contained HTML file. All sections are
 * concatenated under a single document. Referenced images and other binary
 * resources are inlined as data URIs so the file can be opened offline.
 * A navigation table-of-contents is generated at the top.
 */

import type { Book } from '../core/types'
import type { Exporter, ExportOptions, ExportSelection } from '../core/exporter'
import { selectSections } from './section-selection'
import {
    parseDataURI,
    extensionFromMime,
    shouldPackageResource,
    loadReferencedResource,
    extractDocumentTitle,
    sectionTitleFromId,
    stringifyLanguageMap,
    stringifyContributor,
    buildExportTitle,
    normalizeLanguage,
    escapeXML,
    escapeAttr,
    htmlToText,
} from './utils'

export type { ExportOptions, ExportSelection } from '../core/exporter'

const MIME_HTML = 'text/html'

export class HTMLExporter implements Exporter {
    readonly format = 'html'
    readonly mediaType = MIME_HTML
    readonly extension = '.html'

    canExport(_book: Book, selection: ExportSelection): boolean {
        return selection.type === 'first-sections' && (!selection.unit || selection.unit === 'section')
    }

    async exportBook(book: Book, selection: ExportSelection, options: ExportOptions = {}): Promise<Blob> {
        return createHTML(book, selection, options)
    }
}

export const htmlExporter = () => new HTMLExporter()

// ---------------------------------------------------------------------------
// HTML creation
// ---------------------------------------------------------------------------

interface HTMLSection {
    id: string
    title: string
    content: string
}

async function createHTML(
    book: Book,
    selection: ExportSelection,
    options: ExportOptions,
): Promise<Blob> {
    const selected = selectSections(book, selection)
    const sections: HTMLSection[] = []

    for (let i = 0; i < selected.length; i++) {
        const entry = selected[i]
        const section = entry.section
        const sectionId = `section-${i + 1}`

        if (section.format === 'image') {
            const src = String(await section.load())
            const title = entry.title ?? sectionTitleFromId(section) ?? `Image ${i + 1}`
            const inlinedSrc = await inlineImageSrc(src, options)
            sections.push({
                id: sectionId,
                title,
                content: `<div class="image-section"><img src="${escapeAttr(inlinedSrc)}" alt="${escapeAttr(title)}" style="max-width:100%;height:auto;display:block;margin:0 auto;"/></div>`,
            })
            continue
        }

        const html = String(await section.load())
        const title = entry.title ?? extractDocumentTitle(html) ?? sectionTitleFromId(section) ?? `Section ${i + 1}`
        const content = await inlineHTMLResources(extractBodyContent(html), options)

        sections.push({
            id: sectionId,
            title,
            content,
        })
    }

    const bookTitle = options.title ?? buildExportTitle(book.metadata)
    const author = stringifyContributor(book.metadata?.author)
    const lang = normalizeLanguage(book.metadata?.language)

    const html = buildHTMLDocument({
        title: bookTitle,
        author,
        lang,
        sections,
    })

    return new Blob([html], { type: `${MIME_HTML};charset=utf-8` })
}

// ---------------------------------------------------------------------------
// Resource inlining
// ---------------------------------------------------------------------------

async function inlineImageSrc(src: string, options: ExportOptions): Promise<string> {
    if (src.startsWith('data:')) return src

    const loaded = await loadReferencedResource(src, options)
    if (!loaded) return src

    const base64 = bytesToBase64(loaded.bytes)
    return `data:${loaded.mimeType};base64,${base64}`
}

async function inlineHTMLResources(html: string, options: ExportOptions): Promise<string> {
    // Inline src / poster attributes
    let result = await replaceAttributes(
        html,
        /\s(src|poster|data)=["']([^"']+)["']/gi,
        options,
    )
    // Inline href attributes (for images in SVG etc.)
    result = await replaceAttributes(
        result,
        /\s(?:xlink:)?href=["']([^"']+)["']/gi,
        options,
        'href',
    )
    return result
}

async function replaceAttributes(
    html: string,
    regex: RegExp,
    options: ExportOptions,
    fixedAttr?: string,
): Promise<string> {
    let result = ''
    let lastIndex = 0
    let match: RegExpExecArray | null

    while ((match = regex.exec(html)) !== null) {
        const attr = fixedAttr ?? match[1]
        const url = fixedAttr ? match[1] : match[2]

        result += html.slice(lastIndex, match.index)

        if (shouldPackageResource(url)) {
            const inlined = await inlineImageSrc(url, options)
            result += ` ${attr}="${escapeAttr(inlined)}"`
        } else {
            result += match[0]
        }

        lastIndex = regex.lastIndex
    }

    return result + html.slice(lastIndex)
}

function extractBodyContent(html: string): string {
    const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)
    if (bodyMatch) return bodyMatch[1]

    // Strip xml/doctype/html/head if no body tag found
    return html
        .replace(/<\?xml[^>]*>/gi, '')
        .replace(/<!DOCTYPE[^>]*>/gi, '')
        .replace(/<\/?html\b[^>]*>/gi, '')
        .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
        .replace(/<body\b[^>]*>/gi, '')
        .replace(/<\/body>/gi, '')
}

// ---------------------------------------------------------------------------
// HTML document assembly
// ---------------------------------------------------------------------------

function buildHTMLDocument(input: {
    title: string
    author?: string
    lang: string
    sections: HTMLSection[]
}): string {
    const { title, author, lang, sections } = input
    const tocItems = sections.map(s =>
        `    <li><a href="#${escapeAttr(s.id)}">${escapeXML(s.title)}</a></li>`,
    ).join('\n')

    const sectionHtml = sections.map(s => `
  <section id="${escapeAttr(s.id)}" class="chapter">
    <h2 class="chapter-title">${escapeXML(s.title)}</h2>
    <div class="chapter-content">
${s.content}
    </div>
  </section>`).join('\n')

    return `<!DOCTYPE html>
<html lang="${escapeAttr(lang)}">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${escapeXML(title)}</title>
${author ? `  <meta name="author" content="${escapeAttr(author)}"/>\n` : ''}  <style>
    *, *::before, *::after { box-sizing: border-box; }
    :root {
      --text: #1a1a1a;
      --bg: #fafafa;
      --accent: #2563eb;
      --border: #e5e7eb;
      --muted: #6b7280;
      --max-width: 720px;
      --serif: Georgia, 'Times New Roman', serif;
      --sans: system-ui, -apple-system, sans-serif;
    }
    body {
      margin: 0;
      padding: 0;
      background: var(--bg);
      color: var(--text);
      font-family: var(--serif);
      font-size: 18px;
      line-height: 1.75;
    }
    .page-header {
      background: white;
      border-bottom: 1px solid var(--border);
      padding: 2rem 1rem;
      text-align: center;
    }
    .page-header h1 {
      margin: 0 0 0.5rem;
      font-size: 2rem;
      font-family: var(--sans);
    }
    .page-header .author {
      color: var(--muted);
      font-family: var(--sans);
      font-size: 1rem;
    }
    .toc-nav {
      max-width: var(--max-width);
      margin: 2rem auto;
      padding: 1.5rem;
      background: white;
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    .toc-nav h2 {
      margin: 0 0 1rem;
      font-size: 1.1rem;
      font-family: var(--sans);
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .toc-nav ol {
      margin: 0;
      padding: 0 0 0 1.25rem;
    }
    .toc-nav li { margin: 0.35rem 0; }
    .toc-nav a {
      color: var(--accent);
      text-decoration: none;
      font-family: var(--sans);
    }
    .toc-nav a:hover { text-decoration: underline; }
    main { padding: 0 1rem 4rem; }
    .chapter {
      max-width: var(--max-width);
      margin: 3rem auto 0;
    }
    .chapter-title {
      font-family: var(--sans);
      font-size: 1.5rem;
      border-bottom: 2px solid var(--border);
      padding-bottom: 0.5rem;
      margin-bottom: 1.5rem;
    }
    .chapter-content p { margin: 0 0 1em; }
    .chapter-content h1, .chapter-content h2, .chapter-content h3,
    .chapter-content h4, .chapter-content h5, .chapter-content h6 {
      font-family: var(--sans);
      line-height: 1.3;
      margin: 2em 0 0.5em;
    }
    .chapter-content img {
      max-width: 100%;
      height: auto;
      display: block;
      margin: 1.5em auto;
    }
    .chapter-content blockquote {
      border-left: 4px solid var(--border);
      margin: 1.5em 0;
      padding: 0.5em 1em;
      color: var(--muted);
    }
    .chapter-content pre {
      background: #f3f4f6;
      border-radius: 6px;
      padding: 1em;
      overflow-x: auto;
      font-size: 0.9em;
    }
    .image-section { text-align: center; margin: 2rem 0; }
    @media (max-width: 600px) {
      body { font-size: 16px; }
      .page-header h1 { font-size: 1.5rem; }
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --text: #e5e7eb;
        --bg: #111827;
        --border: #374151;
        --muted: #9ca3af;
      }
      .page-header, .toc-nav { background: #1f2937; }
      .chapter-content pre { background: #1f2937; }
    }
  </style>
</head>
<body>
  <header class="page-header">
    <h1>${escapeXML(title)}</h1>
${author ? `    <p class="author">${escapeXML(author)}</p>\n` : ''}  </header>

  <nav class="toc-nav" aria-label="Table of Contents">
    <h2>Contents</h2>
    <ol>
${tocItems}
    </ol>
  </nav>

  <main>
${sectionHtml}
  </main>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Base64 encoding helper
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
    if (typeof btoa === 'function') {
        let binary = ''
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
        return btoa(binary)
    }
    const bufferCtor = (globalThis as unknown as { Buffer?: { from(arr: Uint8Array): { toString(enc: string): string } } }).Buffer
    if (!bufferCtor) throw new Error('No base64 encoder available')
    return bufferCtor.from(bytes).toString('base64')
}
