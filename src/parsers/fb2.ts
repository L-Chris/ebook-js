/**
 * FB2 (FictionBook 2) parser.
 *
 * Parses FB2 XML documents and converts them to XHTML for rendering.
 * Also supports .fb2.zip / .fbz (zipped FB2 archives).
 *
 * The FB2Converter translates FB2 element types to XHTML equivalents
 * using recursive element mapping tables.
 */

import type { Book, BookMetadata, Section, TOCItem, Contributor } from '../core/types'
import type { Parser, ParserInput, ParserOptions } from '../core/parser'
import type { DOMAdapter, XMLDocument, XMLElement } from '../core/dom-adapter'
import type { URLFactory } from '../core/url-factory'
import { createZipLoader, isZipFile } from '../loaders/zip-loader'

// ============================================================================
// Constants
// ============================================================================

const XLINK_NS = 'http://www.w3.org/1999/xlink'
const XHTML_NS = 'http://www.w3.org/1999/xhtml'
const MIME_XHTML = 'application/xhtml+xml'

// ============================================================================
// Utility functions
// ============================================================================

const normalizeWhitespace = (str: string | null): string => {
    if (!str) return ''
    return str.replace(/[\t\n\f\r ]+/g, ' ').trim()
}

const getElementText = (el: XMLElement | null): string => {
    if (!el) return ''
    return normalizeWhitespace(el.textContent)
}

/**
 * Find first descendant element by tag name.
 */
const findByTag = (el: XMLElement, tagName: string): XMLElement | null => {
    const matches = el.getElementsByTagName(tagName)
    return matches[0] ?? null
}

/**
 * Find all descendant elements by tag name.
 */
const findAllByTag = (el: XMLElement, tagName: string): XMLElement[] => {
    return el.getElementsByTagName(tagName)
}

// ============================================================================
// Default FB2 stylesheet
// ============================================================================

const FB2_STYLE = `
body > img, section > img {
    display: block;
    margin: auto;
}
.title h1 {
    text-align: center;
}
body > section > .title, body.notesBodyType > .title {
    margin: 3em 0;
}
body.notesBodyType > section .title h1 {
    text-align: start;
}
body.notesBodyType > section .title {
    margin: 1em 0;
}
p {
    text-indent: 1em;
    margin: 0;
}
:not(p) + p, p:first-child {
    text-indent: 0;
}
.stanza {
    text-indent: 0;
    margin: 1em 0;
}
.text-author, .date {
    text-align: end;
}
.text-author:before {
    content: "\\2014";
}
table {
    border-collapse: collapse;
}
td, th {
    padding: .25em;
}
a[epub|type~="noteref"] {
    font-size: .75em;
    vertical-align: super;
}
body:not(.notesBodyType) > .title, body:not(.notesBodyType) > .epigraph {
    margin: 3em 0;
}
`

// ============================================================================
// FB2 to XHTML Converter
// ============================================================================

/**
 * Element mapping definitions for FB2 → XHTML conversion.
 * Format: { fb2Tag: [xhtmlTag, childDef, attrs?] }
 * childDef can be:
 *   - 'self': use the same mapping for children
 *   - an object: a different mapping table for children
 *   - undefined: no children processed
 */
type ElementDef = [string, (ElementMap | 'self')?, string[]?]
type ElementMap = Record<string, ElementDef | string>

const STYLE: ElementMap = {
    'strong': ['strong', 'self'],
    'emphasis': ['em', 'self'],
    'style': ['span', 'self'],
    'a': 'anchor',
    'strikethrough': ['s', 'self'],
    'sub': ['sub', 'self'],
    'sup': ['sup', 'self'],
    'code': ['code', 'self'],
    'image': 'image',
}

const TABLE: ElementMap = {
    'tr': ['tr', {
        'th': ['th', STYLE, ['colspan', 'rowspan', 'align', 'valign']],
        'td': ['td', STYLE, ['colspan', 'rowspan', 'align', 'valign']],
    }, ['align']],
}

const POEM: ElementMap = {
    'epigraph': ['blockquote'],
    'subtitle': ['h2', STYLE],
    'text-author': ['p', STYLE],
    'date': ['p', STYLE],
    'stanza': ['div', 'self'],
    'v': ['div', STYLE],
}

const SECTION: ElementMap = {
    'title': ['header', {
        'p': ['h1', STYLE],
        'empty-line': ['br'],
    }],
    'epigraph': ['blockquote', 'self'],
    'image': 'image',
    'annotation': ['aside'],
    'section': ['section', 'self'],
    'p': ['p', STYLE],
    'poem': ['blockquote', POEM],
    'subtitle': ['h2', STYLE],
    'cite': ['blockquote', 'self'],
    'empty-line': ['br'],
    'table': ['table', TABLE],
    'text-author': ['p', STYLE],
}
POEM['epigraph'] = ['blockquote', SECTION]

const BODY: ElementMap = {
    'image': 'image',
    'title': ['section', {
        'p': ['h1', STYLE],
        'empty-line': ['br'],
    }],
    'epigraph': ['section', SECTION],
    'section': ['section', SECTION],
}

/**
 * Convert FB2 XML document to XHTML string.
 */
class FB2Converter {
    private bins: Map<string, XMLElement>
    private doc: XMLDocument

    constructor(private fb2: XMLDocument, private domAdapter: DOMAdapter) {
        this.doc = fb2
        // Build map of binary elements by ID
        this.bins = new Map()
        for (const bin of findAllByTag(fb2.documentElement, 'binary')) {
            const id = bin.getAttribute('id')
            if (id) this.bins.set(id, bin)
        }
    }

    /**
     * Get image src from FB2 <image> element.
     */
    private getImageSrc(el: XMLElement): string {
        const href = el.getAttributeNS(XLINK_NS, 'href')
        if (!href) return 'data:,'
        const [, id] = href.split('#')
        if (!id) return href
        const bin = this.bins.get(id)
        if (bin) {
            const contentType = bin.getAttribute('content-type') || 'image/png'
            const content = bin.textContent || ''
            return `data:${contentType};base64,${content}`
        }
        return href
    }

    /**
     * Convert an image element.
     */
    private convertImage(node: XMLElement): string {
        const alt = node.getAttribute('alt') || ''
        const title = node.getAttribute('title') || ''
        const src = this.getImageSrc(node)
        return `<img src="${this.escapeAttr(src)}" alt="${this.escapeAttr(alt)}" title="${this.escapeAttr(title)}">`
    }

    /**
     * Convert an anchor element.
     */
    private convertAnchor(node: XMLElement): string {
        const href = node.getAttributeNS(XLINK_NS, 'href') || ''
        const type = node.getAttribute('type')
        const inner = this.convertChildren(node, STYLE)
        const typeAttr = type === 'note' ? ' epub:type="noteref"' : ''
        return `<a href="${this.escapeAttr(href)}"${typeAttr}>${inner}</a>`
    }

    /**
     * Escape HTML attribute value.
     */
    private escapeAttr(str: string): string {
        return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }

    /**
     * Escape HTML text content.
     */
    private escapeText(str: string): string {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }

    /**
     * Convert child elements using the given mapping.
     */
    private convertChildren(node: XMLElement, def: ElementMap | 'self' | undefined): string {
        if (!def) return ''
        let result = ''
        for (const child of node.children) {
            const converted = def === 'self'
                ? this.convertElement(child, def as unknown as ElementMap)
                : this.convertElement(child, def)
            if (converted) result += converted
        }
        return result
    }

    /**
     * Convert a single element using the mapping table.
     */
    private convertElement(node: XMLElement, def: ElementMap): string {
        const nodeName = node.localName
        if (!nodeName) return ''

        // Text node handling (shouldn't happen with XMLElement, but just in case)
        const d = def[nodeName]
        if (!d) return ''

        // Special handlers
        if (typeof d === 'string') {
            if (d === 'image') return this.convertImage(node)
            if (d === 'anchor') return this.convertAnchor(node)
            return ''
        }

        const [name, opts, attrs] = d
        let result = `<${name}`

        // Copy ID
        const id = node.getAttribute('id')
        if (id) result += ` id="${this.escapeAttr(id)}"`

        // Add class from original element name
        result += ` class="${nodeName}"`

        // Copy specified attributes
        if (attrs) {
            for (const attr of attrs) {
                const value = node.getAttribute(attr)
                if (value) result += ` ${attr}="${this.escapeAttr(value)}"`
            }
        }

        result += '>'

        // Process children
        const childDef = opts === 'self' ? def : opts
        const childContent = this.convertChildren(node, childDef)
        result += childContent

        // If no element children were converted, use text content
        // (handles leaf elements whose content is text nodes)
        if (!childContent && node.children.length === 0) {
            result += this.escapeText(node.textContent || '')
        }

        result += `</${name}>`
        return result
    }

    /**
     * Convert a body element to XHTML.
     */
    convertBody(body: XMLElement): string {
        return this.convertChildren(body, BODY)
    }
}

// ============================================================================
// FB2 Parser
// ============================================================================

export class FB2Parser implements Parser {
    async canParse(input: ParserInput): Promise<boolean> {
        // Check file extension
        if (typeof input === 'string') {
            const lower = input.toLowerCase()
            return lower.endsWith('.fb2') || lower.endsWith('.fbz') || lower.endsWith('.fb2.zip')
        }
        if (input instanceof File) {
            const lower = input.name.toLowerCase()
            if (lower.endsWith('.fb2') || lower.endsWith('.fbz') || lower.endsWith('.fb2.zip')) return true
        }

        // Check ArrayBuffer content for FictionBook root element
        if (input instanceof ArrayBuffer) {
            try {
                const text = new TextDecoder().decode(input.slice(0, 1024))
                if (text.includes('<FictionBook')) return true
            } catch {
                // not text — might be a zip, fall through
            }
        }

        // Check if it's a zip with .fb2 file inside
        if (await isZipFile(input)) {
            try {
                const loader = await createZipLoader(input)
                return loader.entries.some(e => e.filename.toLowerCase().endsWith('.fb2'))
            } catch {
                return false
            }
        }

        return false
    }

    async parse(input: ParserInput, options?: ParserOptions): Promise<Book> {
        const domAdapter = options?.domAdapter
        const urlFactory = options?.urlFactory
        if (!domAdapter || !urlFactory) {
            throw new Error('FB2Parser requires domAdapter and urlFactory')
        }

        if (typeof input === 'string') {
            throw new Error('FB2 parser cannot parse URL strings; provide a File, Blob, or ArrayBuffer')
        }

        // Load FB2 XML content
        let xmlContent: string
        const urls: string[] = []

        if (await isZipFile(input)) {
            // Zipped FB2 — find and load the .fb2 file
            const loader = await createZipLoader(input)
            const fb2Entry = loader.entries.find(e => e.filename.toLowerCase().endsWith('.fb2'))
            if (!fb2Entry) throw new Error('No .fb2 file found in archive')
            const text = await loader.loadText(fb2Entry.filename)
            if (!text) throw new Error('Failed to load FB2 content')
            xmlContent = text
        } else if (input instanceof ArrayBuffer) {
            xmlContent = new TextDecoder().decode(input)
        } else if (typeof input === 'string') {
            // Assume it's already XML content or a path
            xmlContent = input
        } else {
            // Blob
            xmlContent = await (input as Blob).text()
        }

        // Parse XML
        const doc = domAdapter.parseXML(xmlContent)

        // Check for parse errors
        const parseError = doc.querySelector('parsererror')
        if (parseError) {
            throw new Error('Failed to parse FB2 XML')
        }

        // Create converter
        const converter = new FB2Converter(doc, domAdapter)

        // Helper to find elements in document
        const root = doc.documentElement
        const $ = (tag: string) => findByTag(root, tag)
        const $$ = (tag: string) => findAllByTag(root, tag)

        // Extract person info
        const getPerson = (el: XMLElement): Contributor => {
            const nick = getElementText(findByTag(el, 'nickname'))
            if (nick) return { name: nick }
            const first = getElementText(findByTag(el, 'first-name'))
            const middle = getElementText(findByTag(el, 'middle-name'))
            const last = getElementText(findByTag(el, 'last-name'))
            const name = [first, middle, last].filter(x => x).join(' ')
            const sortAs = last
                ? [last, [first, middle].filter(x => x).join(' ')].join(', ')
                : undefined
            return { name, sortAs }
        }

        const getDate = (el: XMLElement | null): string | undefined => {
            if (!el) return undefined
            return el.getAttribute('value') ?? getElementText(el) ?? undefined
        }

        // Build metadata
        const titleInfo = $('title-info')
        const docInfo = $('document-info')
        const publishInfo = $('publish-info')

        const metadata: BookMetadata = {}

        if (titleInfo) {
            const title = getElementText(findByTag(titleInfo, 'book-title'))
            if (title) metadata.title = title

            const lang = getElementText(findByTag(titleInfo, 'lang'))
            if (lang) metadata.language = lang

            const authors = findAllByTag(titleInfo, 'author').map(getPerson)
            if (authors.length > 0) metadata.author = authors

            const translators = findAllByTag(titleInfo, 'translator').map(getPerson)
            if (translators.length > 0) metadata.translator = translators

            const genres = findAllByTag(titleInfo, 'genre').map(getElementText)
            if (genres.length > 0) metadata.subject = genres

            const date = getDate(findByTag(titleInfo, 'date'))
            if (date) metadata.published = date

            const annotation = findByTag(titleInfo, 'annotation')
            if (annotation) {
                const descHtml = converter.convertBody(annotation)
                if (descHtml) metadata.description = descHtml
            }
        }

        if (docInfo) {
            const id = getElementText(findByTag(docInfo, 'id'))
            if (id) metadata.identifier = id

            const date = getDate(findByTag(docInfo, 'date'))
            if (date) metadata.modified = date
        }

        if (publishInfo) {
            const publisher = getElementText(findByTag(publishInfo, 'publisher'))
            if (publisher) metadata.publisher = publisher
        }

        // Cover image
        let getCover: (() => Promise<Blob | null>) | undefined
        if (titleInfo) {
            const coverpage = findByTag(titleInfo, 'coverpage')
            if (coverpage) {
                const image = findByTag(coverpage, 'image')
                if (image) {
                    const src = converter['getImageSrc'](image)
                    getCover = async () => {
                        try {
                            const response = await fetch(src)
                            return await response.blob()
                        } catch {
                            return null
                        }
                    }
                }
            }
        }

        // Process bodies into sections
        const bodies = findAllByTag(root, 'body')
        const sections: Section[] = []
        const toc: TOCItem[] = []
        const idMap = new Map<string, number>()
        let sectionIndex = 0

        for (let bodyIdx = 0; bodyIdx < bodies.length; bodyIdx++) {
            const body = bodies[bodyIdx]
            const isFirstBody = bodyIdx === 0
            const bodyType = body.getAttribute('name') || (isFirstBody ? undefined : 'notes')

            // Convert body to XHTML
            const bodyHtml = converter.convertBody(body)

            // Parse the converted HTML to get a document for section splitting
            const bodyDoc = domAdapter.parseHTML(
                `<html xmlns="http://www.w3.org/1999/xhtml"><body${bodyType ? ` class="${bodyType}BodyType"` : ''}>${bodyHtml}</body></html>`,
                'application/xhtml+xml'
            )

            const bodyEl = findByTag(bodyDoc.documentElement, 'body')
            if (!bodyEl) continue

            // Get direct children of body
            const children = bodyEl.children

            if (isFirstBody) {
                // First body: each top-level child is a separate section
                for (const child of children) {
                    const idx = sectionIndex++
                    const childHtml = child.textContent || ''

                    // Extract title for TOC
                    const titleEl = findByTag(child, 'title') ?? findByTag(child, 'h1')
                    const title = titleEl ? getElementText(titleEl) : `Section ${idx + 1}`

                    // Collect IDs in this section
                    const sectionIds: string[] = []
                    const id = child.getAttribute('id')
                    if (id) {
                        sectionIds.push(id)
                        idMap.set(id, idx)
                    }
                    for (const el of findAllByTag(child, '*')) {
                        const elId = el.getAttribute('id')
                        if (elId) {
                            sectionIds.push(elId)
                            idMap.set(elId, idx)
                        }
                    }

                    // Create section HTML
                    const sectionHtml = buildXHTMLDocument(child, bodyType)
                    const sectionBlob = new Blob([sectionHtml], { type: MIME_XHTML })
                    const sectionUrl = urlFactory.createURL(sectionHtml, MIME_XHTML)
                    urls.push(sectionUrl)

                    sections.push({
                        id: idx,
                        size: sectionBlob.size,
                        load: () => sectionUrl,
                        createDocument: () => sectionHtml,
                        linear: bodyType === 'notes' ? 'no' : undefined,
                    })

                    toc.push({
                        label: title,
                        href: String(idx),
                    })
                }
            } else {
                // Additional bodies: entire body is one section, non-linear
                const idx = sectionIndex++
                const titleEl = findByTag(body, 'title')
                const title = titleEl ? getElementText(titleEl) : `Notes ${bodyIdx}`

                const sectionHtml = buildXHTMLDocument(bodyEl, bodyType || 'notes')
                const sectionBlob = new Blob([sectionHtml], { type: MIME_XHTML })
                const sectionUrl = urlFactory.createURL(sectionHtml, MIME_XHTML)
                urls.push(sectionUrl)

                // Collect IDs
                for (const el of findAllByTag(bodyEl, '*')) {
                    const elId = el.getAttribute('id')
                    if (elId) idMap.set(elId, idx)
                }

                sections.push({
                    id: idx,
                    size: sectionBlob.size,
                    load: () => sectionUrl,
                    createDocument: () => sectionHtml,
                    linear: 'no',
                })

                toc.push({
                    label: title,
                    href: String(idx),
                })
            }
        }

        // Create stylesheet URL
        const styleUrl = urlFactory.createURL(FB2_STYLE, 'text/css')
        urls.push(styleUrl)

        // Build Book
        const book: Book = {
            sections,
            toc,
            metadata,
            getCover: getCover || (() => null),
            resolveHref: (href: string) => {
                const [a, b] = href.split('#')
                if (a && !b) {
                    // TOC link: section index
                    const index = Number(a)
                    if (!isNaN(index)) return { index }
                }
                if (b) {
                    // Internal link: ID within section
                    const index = idMap.get(b)
                    if (index !== undefined) {
                        return {
                            index,
                            anchor: (doc: unknown) => {
                                // Simple ID lookup
                                return null // Renderer handles this
                            }
                        }
                    }
                }
                return null
            },
            splitTOCHref: (href: string) => {
                const parts = href.split('#')
                return [parts[0] || '', parts[1] || null]
            },
            destroy: () => {
                for (const url of urls) {
                    urlFactory.revokeURL(url)
                }
            },
        }

        return book
    }
}

/**
 * Build a complete XHTML document string from a body element.
 */
function buildXHTMLDocument(el: XMLElement, bodyClass?: string): string {
    // We need to serialize the element. Since we don't have a serializer,
    // we'll use a simple approach: get the outer HTML via textContent
    // This is a limitation - in production you'd use domAdapter.serialize()
    // For now, we return a minimal wrapper that the renderer can use.

    // The element's innerHTML is available through children traversal
    // but for simplicity, we'll reconstruct from what we have
    const classAttr = bodyClass ? ` class="${bodyClass}BodyType"` : ''

    // Get all the content by walking children
    const content = serializeElement(el)

    return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><style type="text/css">${FB2_STYLE}</style></head>
<body${classAttr}>${content}</body>
</html>`
}

/**
 * Recursive element serializer (since we can't use XMLSerializer in all environments).
 * Walks the DOM tree and produces an HTML string representation.
 */
function serializeElement(el: XMLElement): string {
    let result = ''

    for (const child of el.children) {
        const tag = child.localName
        if (!tag) continue

        result += `<${tag}`

        // Copy attributes
        for (const attr of child.attributes) {
            result += ` ${attr.localName}="${escapeAttr(attr.value)}"`
        }

        result += '>'

        // Recursively serialize child elements
        if (child.children.length > 0) {
            result += serializeElement(child)
        } else {
            result += escapeText(child.textContent || '')
        }

        result += `</${tag}>`
    }

    return result
}

function escapeAttr(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeText(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export const fb2 = () => new FB2Parser()
