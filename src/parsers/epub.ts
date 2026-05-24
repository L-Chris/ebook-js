/**
 * EPUB Parser
 *
 * Parses EPUB 2.x and 3.x files into a Book object.
 * Based on foliate-js epub.js, restructured for TypeScript and our interfaces.
 * Environment-agnostic: uses injected adapters for DOM parsing and URL creation.
 */

import type {
    Book, Section, TOCItem, Landmark, BookMetadata,
    Rendition, ResolvedNavigation, LanguageMap, Contributor,
    SectionDocument,
} from '../core/types'
import type { Parser, ParserInput, ParserOptions } from '../core/parser'
import type { DOMAdapter, XMLDocument, XMLElement } from '../core/dom-adapter'
import type { URLFactory } from '../core/url-factory'
import type { Loader } from '../core/loader'
import { createZipLoader, isZipFile } from '../loaders/zip-loader'
import { normalizeWhitespace, getElementText, cssEscape, replaceSeries } from '../core/utils'
import { UnsupportedInputError, AdapterRequiredError, ParseError, CorruptedFileError } from '../core/errors'
import { normalizeLanguage, normalizeTitle, normalizePublisher } from '../core/metadata'
import { parseHTML, createSectionDocument } from '../core/document'
import { extractDocumentBlocks, extractDocumentSegments } from '../core/pretext'

// ============================================================================
// Constants
// ============================================================================

const NS = {
    CONTAINER: 'urn:oasis:names:tc:opendocument:xmlns:container',
    XHTML: 'http://www.w3.org/1999/xhtml',
    OPF: 'http://www.idpf.org/2007/opf',
    EPUB: 'http://www.idpf.org/2007/ops',
    DC: 'http://purl.org/dc/elements/1.1/',
    NCX: 'http://www.daisy.org/z3986/2005/ncx/',
    XLINK: 'http://www.w3.org/1999/xlink',
} as const

const MIME = {
    XML: 'application/xml',
    NCX: 'application/x-dtbncx+xml',
    XHTML: 'application/xhtml+xml',
    HTML: 'text/html',
    CSS: 'text/css',
    SVG: 'image/svg+xml',
} as const

const RELATORS: Record<string, string> = {
    art: 'artist',
    aut: 'author',
    clr: 'colorist',
    edt: 'editor',
    ill: 'illustrator',
    nrt: 'narrator',
    trl: 'translator',
    pbl: 'publisher',
}

// ============================================================================
// Utility Functions
// ============================================================================

/** Convert hyphenated/colon-separated names to camelCase */
const camel = (x: string): string =>
    x.toLowerCase().replace(/[-:](.)/g, (_, g: string) => g.toUpperCase())

/** Create child element getters that handle namespace */
const childGetter = (doc: XMLDocument, ns: string) => {
    const useNS = doc.lookupNamespaceURI(null) === ns || doc.lookupPrefix(ns)
    const match = (_el: XMLElement | XMLDocument, name: string) => (e: XMLElement) =>
        useNS
            ? e.namespaceURI === ns && e.localName === name
            : e.localName === name
    const getChildren = (el: XMLElement | XMLDocument): XMLElement[] =>
        'documentElement' in el ? Array.from(el.documentElement.children) : Array.from(el.children)
    return {
        $: (el: XMLElement | XMLDocument, name: string) =>
            getChildren(el).find(match(el, name)) ?? null,
        $$: (el: XMLElement | XMLDocument, name: string) =>
            getChildren(el).filter(match(el, name)),
        $$$: useNS
            ? (el: XMLElement | XMLDocument, name: string) =>
                Array.from(('documentElement' in el ? el : el.ownerDocument!).getElementsByTagNameNS(ns, name))
            : (el: XMLElement | XMLDocument, name: string) =>
                Array.from(('documentElement' in el ? el : el.ownerDocument!).getElementsByTagName(name)),
    }
}

/** Resolve a URL relative to a base path */
const resolveURL = (url: string, relativeTo: string): string => {
    try {
        url = url.replace(/%2c/gi, ',').replace(/%3a/gi, ':')
        if (relativeTo.includes(':') && !relativeTo.startsWith('OEBPS')) {
            return new URL(url, relativeTo).href
        }
        const root = 'https://invalid.invalid/'
        const obj = new URL(url, root + relativeTo)
        obj.search = ''
        return decodeURI(obj.href.replace(root, ''))
    } catch {
        return url
    }
}

/** Check if a URI is external */
const isExternal = (uri: string): boolean => /^(?!blob)\w+:/i.test(uri)

/** Get dirname of a path */
const pathDirname = (str: string): string =>
    str.slice(0, str.lastIndexOf('/') + 1)

/** Get relative path from one path to another */
const pathRelative = (from: string, to: string): string => {
    if (!from) return to
    const as = from.replace(/\/$/, '').split('/')
    const bs = to.replace(/\/$/, '').split('/')
    const i = (as.length > bs.length ? as : bs).findIndex((_, i) => as[i] !== bs[i])
    return i < 0 ? '' : Array(as.length - i).fill('..').concat(bs.slice(i)).join('/')
}

/** Duck-type check for Blob-like objects */
const isBlobLike = (obj: unknown): obj is { arrayBuffer(): Promise<ArrayBuffer> } =>
    obj != null && typeof obj === 'object' && 'arrayBuffer' in obj && typeof obj.arrayBuffer === 'function'

// ============================================================================
// Metadata Parsing
// ============================================================================

interface ParsedMeta {
    property: string
    scheme?: string
    lang?: string
    value: string
    props: Record<string, ParsedMeta[]> | null
    attrs: Record<string, string>
}

const getPrefixes = (doc: XMLDocument): Map<string, string> => {
    const PREFIX: Record<string, string> = {
        a11y: 'http://www.idpf.org/epub/vocab/package/a11y/#',
        dcterms: 'http://purl.org/dc/terms/',
        marc: 'http://id.loc.gov/vocabulary/',
        media: 'http://www.idpf.org/epub/vocab/overlays/#',
        onix: 'http://www.editeur.org/ONIX/book/codelists/current.html#',
        rendition: 'http://www.idpf.org/vocab/rendition/#',
        schema: 'http://schema.org/',
        xsd: 'http://www.w3.org/2001/XMLSchema#',
    }
    const map = new Map(Object.entries(PREFIX))
    const value = doc.documentElement.getAttributeNS(NS.EPUB, 'prefix')
        || doc.documentElement.getAttribute('prefix')
    if (value) {
        for (const [, prefix, url] of value.matchAll(/(.+): +(.+)[ \t\r\n]*/g)) {
            map.set(prefix, url)
        }
    }
    return map
}

const getPropertyURL = (value: string | null, prefixes: Map<string, string>): string | null => {
    if (!value) return null
    const [a, b] = value.split(':')
    const prefix = b ? a : null
    const reference = b ? b : a
    const baseURL = prefixes.get(prefix!)
    return baseURL ? baseURL + reference : null
}

/**
 * Parse OPF metadata into our BookMetadata format.
 */
const parseMetadata = (opf: XMLDocument): {
    metadata: BookMetadata
    rendition: Rendition
} => {
    const { $ } = childGetter(opf, NS.OPF)
    const $metadata = $(opf.documentElement, 'metadata')
    if (!$metadata) return { metadata: {}, rendition: {} }

    const baseLang = $metadata.getAttribute('xml:lang')
        ?? opf.documentElement.getAttribute('xml:lang') ?? 'und'
    const prefixes = getPrefixes(opf)

    // Parse meta elements
    const parseMeta = (el: XMLElement): ParsedMeta => {
        const property = el.getAttribute('property')
        const scheme = el.getAttribute('scheme')
        const getProps = (el: XMLElement): Record<string, ParsedMeta[]> | null => {
            const refines = Array.from($metadata.children)
                .filter(child => child.getAttribute('refines') === '#' + el.getAttribute('id'))
            if (!refines.length) return null
            const grouped: Record<string, ParsedMeta[]> = {}
            for (const child of refines) {
                const parsed = parseMeta(child)
                const key = parsed.property
                if (!grouped[key]) grouped[key] = []
                grouped[key].push(parsed)
            }
            return grouped
        }
        return {
            property: getPropertyURL(property, prefixes) ?? property ?? '',
            scheme: getPropertyURL(scheme, prefixes) ?? scheme ?? undefined,
            lang: el.getAttribute('xml:lang') ?? undefined,
            value: getElementText(el),
            props: getProps(el),
            attrs: Object.fromEntries(
                Array.from(el.attributes)
                    .filter(attr => attr.namespaceURI === NS.OPF)
                    .map(attr => [attr.localName, attr.value])
            ),
        }
    }

    // Group elements
    const dcElements: Record<string, XMLElement[]> = {}
    const metaElements: ParsedMeta[] = []
    const legacyMeta: Record<string, string> = {}

    for (const el of Array.from($metadata.children)) {
        if (el.namespaceURI === NS.DC) {
            const name = el.localName
            if (!dcElements[name]) dcElements[name] = []
            dcElements[name].push(el)
        } else if (el.namespaceURI === NS.OPF && el.localName === 'meta') {
            if (el.hasAttribute('name')) {
                legacyMeta[el.getAttribute('name')!] = el.getAttribute('content') ?? ''
            } else {
                metaElements.push(parseMeta(el))
            }
        }
    }

    // Helper functions
    const dc = (name: string): ParsedMeta[] =>
        (dcElements[name] ?? []).map(el => ({
            property: el.localName,
            value: getElementText(el),
            lang: el.getAttribute('xml:lang') ?? undefined,
            attrs: Object.fromEntries(
                Array.from(el.attributes)
                    .filter(attr => attr.namespaceURI === NS.OPF)
                    .map(attr => [attr.localName, attr.value])
            ),
            props: null,
        }))

    const one = (arr: ParsedMeta[] | undefined): string | undefined => arr?.[0]?.value
    const prop = (x: ParsedMeta | undefined, p: string): string | undefined =>
        x?.props?.[p]?.[0]?.value

    const makeLanguageMap = (x: ParsedMeta | undefined): LanguageMap | undefined => {
        if (!x) return undefined
        const alts = x.props?.['alternate-script'] ?? []
        if (!alts.length && (!x.lang || x.lang === baseLang)) return x.value
        const map: Record<string, string> = { [x.lang ?? baseLang]: x.value }
        for (const y of alts) map[y.lang ?? baseLang] ??= y.value
        return map
    }

    const makeContributor = (x: ParsedMeta | undefined): Contributor | undefined => {
        if (!x) return undefined
        const name = makeLanguageMap(x)
        if (!name) return undefined
        return {
            name,
            sortAs: makeLanguageMap(x.props?.['file-as']?.[0]) ?? x.attrs['file-as'],
            role: x.props?.role
                ?.filter(r => r.scheme === 'http://id.loc.gov/vocabulary/relators')
                ?.map(r => r.value) ?? (x.attrs.role ? [x.attrs.role] : undefined),
        }
    }

    const dcTitle = dc('title')
    const mainTitle = dcTitle.find(x => prop(x, 'title-type') === 'main') ?? dcTitle[0]
    const dcCreator = dc('creator')
    const dcContributor = dc('contributor')

    // Build metadata (mutable during construction, readonly in final type)
    const metadata: { -readonly [K in keyof BookMetadata]?: BookMetadata[K] } = {
        identifier: getElementText(
            opf.getElementById(opf.documentElement.getAttribute('unique-identifier') ?? '')
            ?? opf.getElementsByTagNameNS(NS.DC, 'identifier')[0]
        ) || undefined,
        title: normalizeTitle(makeLanguageMap(mainTitle)),
        subtitle: normalizeTitle(one(dcTitle.filter(x => prop(x, 'title-type') === 'subtitle'))),
        language: normalizeLanguage(dc('language').map(x => x.value).filter(Boolean)),
        description: one(dc('description')),
        publisher: normalizePublisher(makeContributor(dc('publisher')[0])),
        published: dc('date').find(x => x.attrs.event === 'publication')?.value
            ?? one(dc('date')),
        modified: one(metaElements.filter(m => m.property === 'http://purl.org/dc/terms/modified'))
            ?? dc('date').find(x => x.attrs.event === 'modification')?.value,
        subject: dc('subject').map(x => x.value),
        rights: one(dc('rights')),
    }

    // Add creators as authors
    for (const creator of dcCreator) {
        const contrib = makeContributor(creator)
        if (!contrib) continue
        const roles = (contrib as { role?: string[] }).role ?? []
        const keys = new Set(roles.map(r => RELATORS[r] ?? 'author'))
        if (!keys.size) keys.add('author')
        for (const key of keys) {
            const existing = metadata[key]
            if (Array.isArray(existing)) existing.push(contrib)
            else metadata[key] = [contrib]
        }
    }

    // Add contributors
    for (const contributor of dcContributor) {
        const contrib = makeContributor(contributor)
        if (!contrib) continue
        const existing = metadata.contributor
        if (Array.isArray(existing)) existing.push(contrib)
        else metadata.contributor = [contrib]
    }

    // Clean up null/undefined values
    for (const [key, val] of Object.entries(metadata)) {
        if (val == null) delete metadata[key]
    }

    // Parse rendition properties
    const rendition: Rendition = {}
    const RENDITION_PREFIX = 'http://www.idpf.org/vocab/rendition/#'
    for (const meta of metaElements) {
        if (meta.property.startsWith(RENDITION_PREFIX)) {
            const name = camel(meta.property.replace(RENDITION_PREFIX, ''))
            ;(rendition as Record<string, string>)[name] = meta.value
        }
    }

    return { metadata, rendition }
}

// ============================================================================
// Navigation Parsing
// ============================================================================

const parseNav = (doc: XMLDocument, resolve: (url: string) => string): {
    toc: TOCItem[] | null
    pageList: TOCItem[] | null
    landmarks: Landmark[] | null
} => {
    const { $, $$, $$$ } = childGetter(doc, NS.XHTML)
    const resolveHref = (href: string | null): string | null =>
        href ? decodeURI(resolve(href)) : null

    const parseLI = ($li: XMLElement, getType: boolean): TOCItem & { type?: string[] } => {
        const $a = $($li, 'a') ?? $($li, 'span')
        const $ol = $($li, 'ol')
        const href = resolveHref($a?.getAttribute('href') ?? null)
        const label = getElementText($a) || $a?.getAttribute('title') || ''
        const result: TOCItem & { type?: string[] } = {
            label,
            href: href ?? '',
            subitems: parseOL($ol, false) ?? undefined,
        }
        if (getType) {
            result.type = $a?.getAttributeNS(NS.EPUB, 'type')?.split(/\s/)
        }
        return result
    }

    const parseOL = ($ol: XMLElement | null, getType: boolean): (TOCItem & { type?: string[] })[] | null =>
        $ol ? $$($ol, 'li').map(li => parseLI(li, getType)) : null

    const parseNavElement = ($nav: XMLElement, getType: boolean) =>
        parseOL($($nav, 'ol'), getType)

    const $$nav = $$$(doc, 'nav')
    let toc: TOCItem[] | null = null
    let pageList: TOCItem[] | null = null
    let landmarks: Landmark[] | null = null

    for (const $nav of $$nav) {
        const type = $nav.getAttributeNS(NS.EPUB, 'type')?.split(/\s/) ?? []
        if (type.includes('toc') && !toc) {
            toc = parseNavElement($nav, false) as TOCItem[] | null
        } else if (type.includes('page-list') && !pageList) {
            pageList = parseNavElement($nav, false) as TOCItem[] | null
        } else if (type.includes('landmarks') && !landmarks) {
            const items = parseNavElement($nav, true)
            landmarks = items?.map(item => ({
                label: item.label,
                href: item.href,
                type: (item as { type?: string[] }).type ?? [],
            })) ?? null
        }
    }

    return { toc, pageList, landmarks }
}

const parseNCX = (doc: XMLDocument, resolve: (url: string) => string): {
    toc: TOCItem[] | null
    pageList: TOCItem[] | null
} => {
    const { $, $$ } = childGetter(doc, NS.NCX)
    const resolveHref = (href: string | null): string | null =>
        href ? decodeURI(resolve(href)) : null

    const parseItem = (el: XMLElement): TOCItem => {
        const $label = $(el, 'navLabel')
        const $content = $(el, 'content')
        const label = getElementText($label)
        const href = resolveHref($content?.getAttribute('src') ?? null)
        if (el.localName === 'navPoint') {
            const els = $$(el, 'navPoint')
            return {
                label,
                href: href ?? '',
                subitems: els.length ? els.map(parseItem) : undefined,
            }
        }
        return { label, href: href ?? '' }
    }

    const parseList = (el: XMLElement, itemName: string): TOCItem[] =>
        $$(el, itemName).map(parseItem)

    const getSingle = (container: string, itemName: string): TOCItem[] | null => {
        const $container = $(doc.documentElement, container)
        return $container ? parseList($container, itemName) : null
    }

    return {
        toc: getSingle('navMap', 'navPoint'),
        pageList: getSingle('pageList', 'pageTarget'),
    }
}

// ============================================================================
// Resource Loading
// ============================================================================

interface ManifestItem {
    id: string
    href: string
    mediaType: string
    properties?: string[]
    mediaOverlay?: string
}

/**
 * Loader that handles resource URL replacement.
 * Converts relative paths in EPUB content to blob: URLs.
 */
class ResourceLoader {
    private cache = new Map<string, string>()
    private refCount = new Map<string, number>()
    private manifest: ManifestItem[]
    private entries: Map<string, { filename: string; size: number }>

    constructor(
        private loadText: (name: string) => Promise<string | null>,
        private loadBlob: (name: string) => Promise<Blob | null>,
        manifest: ManifestItem[],
        entries: { filename: string; size: number }[],
        private domAdapter: DOMAdapter,
        private urlFactory: URLFactory,
    ) {
        this.manifest = manifest
        this.entries = new Map(entries.map(e => [e.filename, e]))
    }

    private async createURL(href: string, data: string | ArrayBuffer, type: string): Promise<string> {
        if (!data) return ''
        const url = this.urlFactory.createURL(data, type)
        this.cache.set(href, url)
        this.refCount.set(href, 1)
        return url
    }

    async loadItem(item: ManifestItem): Promise<string> {
        if (this.cache.has(item.href)) {
            this.refCount.set(item.href, (this.refCount.get(item.href) ?? 0) + 1)
            return this.cache.get(item.href)!
        }
        return this.loadReplaced(item)
    }

    private async loadReplaced(item: ManifestItem): Promise<string> {
        const { href, mediaType } = item
        const str = await this.loadText(href)
        if (!str) return ''

        // Parse and replace in HTML/XHTML/SVG
        const htmlTypes: string[] = [MIME.XHTML, MIME.HTML, MIME.SVG]
        if (htmlTypes.includes(mediaType)) {
            let doc: XMLDocument
            try {
                doc = this.domAdapter.parseXML(str)
            } catch (error) {
                if (mediaType !== MIME.XHTML && mediaType !== MIME.HTML) throw error
                doc = this.domAdapter.parseHTML(str, MIME.HTML)
            }

            // Change to HTML if XHTML is invalid
            if (mediaType === MIME.XHTML && (
                doc.querySelector('parsererror') ||
                !doc.documentElement?.namespaceURI
            )) {
                doc = this.domAdapter.parseHTML(str, MIME.HTML)
            }

            // Replace href/src/data/poster attributes
            const replace = async (el: XMLElement, attr: string) => {
                const val = el.getAttribute(attr)
                if (val) {
                    if (attr === 'src' || attr === 'poster' || attr === 'data') {
                        el.setAttribute(`data-rebook-original-${attr}`, resolveURL(val, href))
                    }
                    el.setAttribute(attr, await this.loadHref(val, href))
                }
            }

            for (const el of doc.querySelectorAll('link[href]')) await replace(el, 'href')
            for (const el of doc.querySelectorAll('[href]')) {
                if (!isNavigationHrefElement(el)) await replace(el, 'href')
            }
            for (const el of doc.querySelectorAll('[src]')) await replace(el, 'src')
            for (const el of doc.querySelectorAll('[poster]')) await replace(el, 'poster')
            for (const el of doc.querySelectorAll('object[data]')) await replace(el, 'data')
            for (const el of doc.querySelectorAll('[*|href]:not([href])')) {
                const val = el.getAttributeNS(NS.XLINK, 'href')
                if (val) {
                    el.setAttribute('data-rebook-original-href', resolveURL(val, href))
                    el.setAttributeNS(NS.XLINK, 'href', await this.loadHref(val, href))
                }
            }

            // Replace srcset
            for (const el of doc.querySelectorAll('[srcset]')) {
                const srcset = el.getAttribute('srcset')
                if (srcset) {
                    const replaced = await replaceSeries(
                        srcset,
                        /(\s*)(.+?)\s*((?:\s[\d.]+[wx])+\s*(?:,|$)|,\s+|$)/g,
                        async (_, p1, p2, p3) => {
                            const newUrl = await this.loadHref(p2, href)
                            return `${p1}${newUrl}${p3}`
                        }
                    )
                    el.setAttribute('srcset', replaced)
                }
            }

            // Replace inline styles
            for (const el of doc.querySelectorAll('style')) {
                if (el.textContent) {
                    el.textContent = await this.replaceCSS(el.textContent, href)
                }
            }
            for (const el of doc.querySelectorAll('[style]')) {
                const style = el.getAttribute('style')
                if (style) el.setAttribute('style', await this.replaceCSS(style, href))
            }

            const result = this.domAdapter.serialize(doc)
            // Return the serialized HTML string directly.
            // The renderer is responsible for creating blob URLs for the document.
            // Embedded resources (CSS, images) already have blob URLs from loadHref.
            this.cache.set(href, result)
            this.refCount.set(href, 1)
            return result
        }

        // CSS
        if (mediaType === MIME.CSS) {
            const result = await this.replaceCSS(str, href)
            return this.createURL(href, result, mediaType)
        }

        // Other resources: load as ArrayBuffer
        const blob = await this.loadBlob(href)
        if (!blob) return ''
        const buffer = await blob.arrayBuffer()
        return this.createURL(href, buffer, mediaType)
    }

    private async loadHref(url: string, base: string): Promise<string> {
        if (!url || url.startsWith('#') || isExternal(url)) return url
        const href = resolveURL(url, base)
        const item = this.manifest.find(m => m.href === href)
        if (!item) return url
        return this.loadItem(item)
    }

    private async replaceCSS(str: string, href: string): Promise<string> {
        const replacedUrls = await replaceSeries(
            str,
            /url\(\s*["']?([^'"\n]*?)\s*["']?\s*\)/gi,
            async (_, url) => {
                const newUrl = await this.loadHref(url, href)
                return `url("${newUrl}")`
            }
        )
        return replaceSeries(
            replacedUrls,
            /@import\s*["']([^"'\n]*?)["']/gi,
            async (_, url) => {
                const newUrl = await this.loadHref(url, href)
                return `@import "${newUrl}"`
            }
        )
    }

    unref(href: string): void {
        const count = (this.refCount.get(href) ?? 0) - 1
        if (count <= 0) {
            const url = this.cache.get(href)
            // Only revoke blob URLs (CSS, images). HTML content is a string.
            if (url && url.startsWith('blob:')) this.urlFactory.revokeURL(url)
            this.cache.delete(href)
            this.refCount.delete(href)
        } else {
            this.refCount.set(href, count)
        }
    }

    destroy(): void {
        for (const url of this.cache.values()) {
            if (url.startsWith('blob:')) this.urlFactory.revokeURL(url)
        }
        this.cache.clear()
        this.refCount.clear()
    }
}

function isNavigationHrefElement(el: XMLElement): boolean {
    const name = el.localName.toLowerCase()
    return name === 'a' || name === 'area' || name === 'link'
}

// ============================================================================
// EPUB Parser
// ============================================================================

export class EPUBParser implements Parser {
    readonly priority = 10

    async canParse(input: ParserInput): Promise<boolean> {
        if (typeof input === 'string') return input.endsWith('.epub')
        if (isBlobLike(input) || input instanceof ArrayBuffer) {
            if (!(await isZipFile(input))) return false
            // Check if it contains META-INF/container.xml
            try {
                const loader = await createZipLoader(input)
                return loader.entries.some(e => e.filename === 'META-INF/container.xml')
            } catch {
                return false
            }
        }
        return false
    }

    async parse(input: ParserInput, options?: ParserOptions): Promise<Book> {
        let loader: Loader

        if (isBlobLike(input)) {
            loader = await createZipLoader(input)
        } else if (input instanceof ArrayBuffer) {
            loader = await createZipLoader(input)
        } else if (typeof input === 'string') {
            // Fetch from URL (browser environment)
            const res = await fetch(input)
            const buffer = await res.arrayBuffer()
            loader = await createZipLoader(buffer)
        } else {
            throw new UnsupportedInputError('Unsupported input type for EPUB parser')
        }

        if (!options?.domAdapter || !options?.urlFactory) {
            throw new AdapterRequiredError('domAdapter and urlFactory')
        }

        const epub = new EPUBBook(loader, options.domAdapter, options.urlFactory)
        return epub.init()
    }
}

// ============================================================================
// EPUB Book
// ============================================================================

class EPUBBook implements Book {
    private loader: Loader
    private domAdapter: DOMAdapter
    private urlFactory: URLFactory
    private resourceLoader!: ResourceLoader
    private manifest: ManifestItem[] = []
    private manifestById = new Map<string, ManifestItem>()
    private spine: Array<{ idref: string; linear?: string; properties?: string[] }> = []
    private opfPath = ''

    sections: Section[] = []
    dir?: 'ltr' | 'rtl'
    toc?: TOCItem[]
    pageList?: TOCItem[]
    landmarks?: Landmark[]
    metadata?: BookMetadata
    rendition?: Rendition

    constructor(loader: Loader, domAdapter: DOMAdapter, urlFactory: URLFactory) {
        this.loader = loader
        this.domAdapter = domAdapter
        this.urlFactory = urlFactory
    }

    private async loadXML(uri: string): Promise<XMLDocument | null> {
        const str = await this.loader.loadText(uri)
        if (!str) return null
        const doc = this.domAdapter.parseXML(str)
        if (doc.querySelector('parsererror')) {
            throw new ParseError(`XML parsing error in ${uri}: ${doc.querySelector('parsererror')?.textContent}`, 'epub')
        }
        return doc
    }

    async init(): Promise<this> {
        // 1. Load container.xml to find OPF
        const $container = await this.loadXML('META-INF/container.xml')
        if (!$container) throw new CorruptedFileError('Failed to load container.xml', 'epub')

        const rootfiles = Array.from(
            $container.getElementsByTagNameNS(NS.CONTAINER, 'rootfile')
        ).map(el => ({
            fullPath: el.getAttribute('full-path'),
            mediaType: el.getAttribute('media-type'),
        }))

        const opfFile = rootfiles.find(f => f.mediaType === 'application/oebps-package+xml')
        if (!opfFile?.fullPath) throw new CorruptedFileError('No package document found', 'epub')
        this.opfPath = opfFile.fullPath

        // 2. Load OPF
        const opf = await this.loadXML(this.opfPath)
        if (!opf) throw new CorruptedFileError('Failed to load OPF', 'epub')

        // 3. Parse manifest and spine
        const { $, $$ } = childGetter(opf, NS.OPF)
        const $manifest = $(opf.documentElement, 'manifest')
        const $spine = $(opf.documentElement, 'spine')

        if ($manifest) {
            this.manifest = Array.from($manifest.children)
                .filter(el => el.localName === 'item')
                .map(el => ({
                    id: el.getAttribute('id') ?? '',
                    href: resolveURL(el.getAttribute('href') ?? '', this.opfPath),
                    mediaType: el.getAttribute('media-type') ?? '',
                    properties: el.getAttribute('properties')?.split(/\s/),
                    mediaOverlay: el.getAttribute('media-overlay') ?? undefined,
                }))
            this.manifestById = new Map(this.manifest.map(m => [m.id, m]))
        }

        if ($spine) {
            this.spine = Array.from($spine.children)
                .filter(el => el.localName === 'itemref')
                .map(el => ({
                    idref: el.getAttribute('idref') ?? '',
                    linear: el.getAttribute('linear') ?? undefined,
                    properties: el.getAttribute('properties')?.split(/\s/),
                }))
            this.dir = ($spine.getAttribute('page-progression-direction') as 'ltr' | 'rtl') ?? undefined
        }

        // 4. Create resource loader
        this.resourceLoader = new ResourceLoader(
            this.loader.loadText.bind(this.loader),
            this.loader.loadBlob.bind(this.loader),
            this.manifest,
            this.loader.entries,
            this.domAdapter,
            this.urlFactory,
        )

        // 5. Create sections
        this.sections = this.spine.map((spineItem, index): Section | null => {
            const item = this.manifestById.get(spineItem.idref)
            if (!item) return null
            return {
                id: item.href,
                load: () => this.resourceLoader.loadItem(item),
                unload: () => this.resourceLoader.unref(item.href),
                format: 'xhtml' as const,
                loadText: () => this.loader.loadText(item.href).then(t => t ?? ''),
                createDocument: () => this.loadDocument(item),
                getDocument: async (): Promise<SectionDocument | null> => {
                    const html = await this.loadDocument(item)
                    const nodes = parseHTML(html, this.domAdapter)
                    return createSectionDocument(nodes, this.domAdapter)
                },
                getSegments: async () => {
                    const html = await this.loadDocument(item)
                    const nodes = parseHTML(html, this.domAdapter)
                    return extractDocumentSegments(nodes)
                },
                getBlocks: async () => {
                    const html = await this.resourceLoader.loadItem(item)
                    const nodes = parseHTML(html, this.domAdapter)
                    return extractDocumentBlocks(nodes, {}, {
                        coverImageSrcs: this.getCoverImageSrcs(),
                    })
                },
                size: this.loader.getSize(item.href),
                linear: spineItem.linear,
                cfi: `/6/${(index + 1) * 2}`,
                resolveHref: (href: string) => resolveURL(href, item.href),
            }
        }).filter((s): s is Section => s !== null)

        // 6. Parse navigation
        const navItem = this.manifest.find(m => m.properties?.includes('nav'))
        const ncxItem = this.manifest.find(m => m.mediaType === MIME.NCX)

        if (navItem) {
            try {
                const navDoc = await this.loadXML(navItem.href)
                if (navDoc) {
                    const resolve = (url: string) => resolveURL(url, navItem.href)
                    const nav = parseNav(navDoc, resolve)
                    this.toc = nav.toc ?? undefined
                    this.pageList = nav.pageList ?? undefined
                    this.landmarks = nav.landmarks ?? undefined
                }
            } catch (e) {
                console.warn('Failed to parse navigation:', e)
            }
        }

        // Fallback to NCX if no TOC
        if (!this.toc && ncxItem) {
            try {
                const ncxDoc = await this.loadXML(ncxItem.href)
                if (ncxDoc) {
                    const resolve = (url: string) => resolveURL(url, ncxItem.href)
                    const ncx = parseNCX(ncxDoc, resolve)
                    this.toc = ncx.toc ?? undefined
                    this.pageList = ncx.pageList ?? undefined
                }
            } catch (e) {
                console.warn('Failed to parse NCX:', e)
            }
        }

        // 7. Parse metadata
        const { metadata, rendition } = parseMetadata(opf)
        this.metadata = metadata
        this.rendition = rendition

        return this
    }

    private async loadDocument(item: ManifestItem): Promise<string> {
        const str = await this.loader.loadText(item.href) ?? ''
        // Return raw string; renderer will parse into DOM when needed
        return str
    }

    resolveHref(href: string): ResolvedNavigation | null {
        const [path, hash] = href.split('#')
        const item = this.manifest.find(m => m.href === decodeURI(path))
        if (!item) return null
        const index = this.sections.findIndex(s => s.id === item.href)
        if (index < 0) return null
        const anchor = hash
            ? (doc: unknown) => (doc as XMLDocument).getElementById(hash)
            : () => 0
        return { index, anchor }
    }

    isExternal(href: string): boolean {
        return isExternal(href)
    }

    splitTOCHref(href: string): [string, string | null] {
        const parts = href.split('#')
        return [parts[0], parts[1] ?? null]
    }

    getTOCFragment(doc: unknown, id: string | number): unknown {
        const xmlDoc = doc as XMLDocument
        return xmlDoc.getElementById(String(id))
            ?? xmlDoc.querySelector(`[name="${cssEscape(String(id))}"]`)
    }

    async getCover(): Promise<Blob | null> {
        const coverItem = this.getCoverImageItem()

        if (!coverItem) return null
        const blob = await this.loader.loadBlob(coverItem.href)
        return blob
    }

    private getCoverImageItem(): ManifestItem | undefined {
        return this.manifest.find(m => m.properties?.includes('cover-image'))
            ?? this.manifest.find(m => m.id === 'cover' && m.mediaType.startsWith('image'))
            ?? this.manifest.find(m => m.href.includes('cover') && m.mediaType.startsWith('image'))
            ?? this.manifest.find(m => m.mediaType.startsWith('image'))
    }

    private getCoverImageSrcs(): string[] {
        const coverItem = this.getCoverImageItem()
        return coverItem ? [coverItem.href] : []
    }

    destroy(): void {
        this.resourceLoader?.destroy()
    }
}

/**
 * Create an EPUB parser instance.
 */
export const epub = () => new EPUBParser()
