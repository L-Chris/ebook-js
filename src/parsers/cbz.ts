/**
 * CBZ (Comic Book Zip) parser.
 *
 * Parses zip archives containing images (typically .cbz files).
 * Each image becomes a section. Metadata is read from ComicInfo.xml
 * (Anansi standard) or ComicBookInfo (JSON in zip comment).
 */

import type { Book, BookMetadata, Section, TOCItem } from '../core/types'
import type { Parser, ParserInput, ParserOptions } from '../core/parser'
import type { Loader } from '../core/loader'
import type { DOMAdapter } from '../core/dom-adapter'
import { createZipLoader, isZipFile } from '../loaders/zip-loader'
import { UnsupportedInputError, ParseError, AdapterRequiredError } from '../core/errors'
import { normalizeContributors } from '../core/metadata'

// ============================================================================
// Image extensions
// ============================================================================

const IMAGE_EXTENSIONS = [
    '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.avif',
]

const isImageFile = (filename: string): boolean => {
    const lower = filename.toLowerCase()
    return IMAGE_EXTENSIONS.some(ext => lower.endsWith(ext))
}

// ============================================================================
// MIME type detection for images
// ============================================================================

const getMimeType = (filename: string): string => {
    const lower = filename.toLowerCase()
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
    if (lower.endsWith('.png')) return 'image/png'
    if (lower.endsWith('.gif')) return 'image/gif'
    if (lower.endsWith('.bmp')) return 'image/bmp'
    if (lower.endsWith('.webp')) return 'image/webp'
    if (lower.endsWith('.svg')) return 'image/svg+xml'
    if (lower.endsWith('.avif')) return 'image/avif'
    return 'application/octet-stream'
}

// ============================================================================
// ComicInfo.xml metadata
// ============================================================================

interface ComicInfoMeta {
    title?: string
    publisher?: string
    language?: string
    author?: string
    series?: string
    seriesPosition?: string
    seriesTotal?: string
}

/**
 * Read ComicInfo.xml from the archive (Anansi standard).
 */
async function readComicInfoXML(loader: Loader, domAdapter: DOMAdapter): Promise<ComicInfoMeta | null> {
    const entry = loader.entries.find(e => e.filename.toLowerCase() === 'comicinfo.xml')
    if (!entry) return null
    const text = await loader.loadText(entry.filename)
    if (!text) return null

    // Parse XML using DOMAdapter
    const doc = domAdapter.parseXML(text)
    const root = doc.documentElement

    const get = (tag: string): string | undefined => {
        const els = root.getElementsByTagName(tag)
        if (els.length > 0) {
            const text = els[0].textContent?.trim()
            return text || undefined
        }
        return undefined
    }

    return {
        title: get('Title'),
        publisher: get('Publisher'),
        language: get('LanguageISO'),
        author: get('Writer'),
        series: get('Series'),
        seriesPosition: get('Number'),
        seriesTotal: get('Count'),
    }
}

// ============================================================================
// ComicBookInfo metadata (JSON in zip comment)
// ============================================================================

interface ComicBookInfoCredits {
    person: string
    role: string
}

interface ComicBookInfoData {
    title?: string
    publisher?: string
    language?: string
    credits?: ComicBookInfoCredits[]
    series?: string
    issue?: number
    publicationYear?: number
    publicationMonth?: number
}

/**
 * Read ComicBookInfo from zip comment (legacy format).
 */
async function readComicBookInfo(loader: Loader): Promise<ComicInfoMeta | null> {
    if (!loader.getComment) return null
    const comment = await loader.getComment()
    if (!comment) return null

    try {
        const parsed = JSON.parse(comment)
        const info = parsed['ComicBookInfo/1.0'] as ComicBookInfoData | undefined
        if (!info) return null

        const year = info.publicationYear
        const month = info.publicationMonth
        const mm = month && month >= 1 && month <= 12 ? String(month).padStart(2, '0') : null

        return {
            title: info.title,
            publisher: info.publisher,
            language: info.language,
            author: info.credits
                ? info.credits.map(c => `${c.person} (${c.role})`).join(', ')
                : undefined,
            series: info.series,
            seriesPosition: info.issue != null ? String(info.issue) : undefined,
            seriesTotal: undefined,
        }
    } catch {
        return null
    }
}

// ============================================================================
// CBZ Parser
// ============================================================================

export class CBZParser implements Parser {
    readonly priority = 0

    async canParse(input: ParserInput): Promise<boolean> {
        // Check file extension
        if (typeof input === 'string') {
            return input.toLowerCase().endsWith('.cbz')
        }
        if (input instanceof File) {
            return input.name.toLowerCase().endsWith('.cbz')
        }

        // Check if it's a zip with image files
        const isZip = await isZipFile(input)
        if (!isZip) return false

        // Open zip and check for image files
        try {
            const loader = await createZipLoader(input)
            return loader.entries.some(e => isImageFile(e.filename))
        } catch {
            return false
        }
    }

    async parse(input: ParserInput, options?: ParserOptions): Promise<Book> {
        if (typeof input === 'string') {
            throw new UnsupportedInputError('CBZ parser cannot parse URL strings; provide a File, Blob, or ArrayBuffer')
        }

        // Require adapters — domAdapter for ComicInfo.xml, urlFactory no longer needed
        if (!options?.domAdapter) {
            throw new AdapterRequiredError('domAdapter')
        }

        const domAdapter = options.domAdapter

        // Load zip archive
        const loader = await createZipLoader(input)

        // Filter and sort image files
        const imageFiles = loader.entries
            .map(e => e.filename)
            .filter(isImageFile)
            .sort()

        if (imageFiles.length === 0) {
            throw new ParseError('No image files found in archive', 'cbz')
        }

        // Read metadata (prefer ComicInfo.xml over ComicBookInfo)
        const [xmlMeta, cbiMeta] = await Promise.all([
            readComicInfoXML(loader, domAdapter),
            readComicBookInfo(loader),
        ])
        const merged = { ...(cbiMeta || {}), ...(xmlMeta || {}) }

        // Build metadata
        const metadata: BookMetadata = {}
        if (merged.title) metadata.title = merged.title
        if (merged.publisher) metadata.publisher = merged.publisher
        if (merged.language) metadata.language = merged.language
        if (merged.author) metadata.author = normalizeContributors(merged.author)
        if (merged.series) {
            metadata.belongsTo = {
                series: {
                    name: merged.series,
                    position: merged.seriesPosition,
                    total: merged.seriesTotal,
                }
            }
        }

        // Data URI cache for lazy loading
        const dataCache = new Map<string, string>()

        // Helper to convert Blob to data URI
        const blobToDataURI = async (blob: Blob, mimeType: string): Promise<string> => {
            const buffer = await blob.arrayBuffer()
            const bytes = new Uint8Array(buffer)
            let binary = ''
            for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
            return `data:${mimeType};base64,${btoa(binary)}`
        }

        // Build sections
        const sections: Section[] = imageFiles.map(filename => ({
            id: filename,
            size: loader.getSize(filename),
            format: 'image' as const,
            load: async () => {
                if (dataCache.has(filename)) {
                    return dataCache.get(filename)!
                }
                const blob = await loader.loadBlob(filename)
                if (!blob) throw new ParseError(`Failed to load ${filename}`, 'cbz')
                const dataURI = await blobToDataURI(blob, getMimeType(filename))
                dataCache.set(filename, dataURI)
                return dataURI
            },
            unload: () => {
                dataCache.delete(filename)
            },
        }))

        // Build TOC (flat list of images)
        const toc: TOCItem[] = imageFiles.map(filename => ({
            label: filename,
            href: filename,
        }))

        // Build Book
        const book: Book = {
            sections,
            toc,
            metadata,
            rendition: { layout: 'pre-paginated' },
            getCover: async () => {
                if (imageFiles.length === 0) return null
                return loader.loadBlob(imageFiles[0])
            },
            resolveHref: (href: string) => {
                const index = sections.findIndex(s => s.id === href)
                return index >= 0 ? { index } : null
            },
            destroy: () => {
                dataCache.clear()
            },
        }

        return book
    }
}

export const cbz = () => new CBZParser()
