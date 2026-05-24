/**
 * CBZ (Comic Book Zip) exporter.
 *
 * Exports a selection of sections as a CBZ archive. Image sections are packed
 * directly as image files. Text sections (HTML/XHTML) are converted to plain-text
 * files and included as well. A ComicInfo.xml metadata file is also generated.
 */

import type { Book } from '../core/types'
import type { Exporter, ExportOptions, ExportSelection } from '../core/exporter'
import { selectSections } from './section-selection'
import {
    parseDataURI,
    extensionFromMime,
    extensionFromPath,
    loadReferencedResource,
    sectionTitleFromId,
    extractDocumentTitle,
    normalizeTitleText,
    stringifyLanguageMap,
    stringifyContributor,
    htmlToText,
    escapeXML,
} from './utils'

export type { ExportOptions, ExportSelection } from '../core/exporter'

const MIME_CBZ = 'application/vnd.comicbook+zip'

export class CBZExporter implements Exporter {
    readonly format = 'cbz'
    readonly mediaType = MIME_CBZ
    readonly extension = '.cbz'

    canExport(_book: Book, selection: ExportSelection): boolean {
        return selection.type === 'first-sections' && (!selection.unit || selection.unit === 'section')
    }

    async exportBook(book: Book, selection: ExportSelection, options: ExportOptions = {}): Promise<Blob> {
        return createCBZ(book, selection, options)
    }
}

export const cbzExporter = () => new CBZExporter()

// ---------------------------------------------------------------------------
// CBZ creation
// ---------------------------------------------------------------------------

interface CBZEntry {
    filename: string
    data: Uint8Array
}

async function createCBZ(
    book: Book,
    selection: ExportSelection,
    options: ExportOptions,
): Promise<Blob> {
    const selected = selectSections(book, selection)
    const entries: CBZEntry[] = []
    const encoder = new TextEncoder()

    for (let i = 0; i < selected.length; i++) {
        const entry = selected[i]
        const section = entry.section
        const pageNum = String(i + 1).padStart(4, '0')

        if (section.format === 'image') {
            // Image section: extract and store image bytes directly
            const src = String(await section.load())
            const data = parseDataURI(src)
            if (data) {
                const ext = extensionFromMime(data.mimeType)
                entries.push({
                    filename: `page${pageNum}${ext}`,
                    data: data.bytes,
                })
                continue
            }
            // fallback: try loading as referenced resource
            const loaded = await loadReferencedResource(src, options)
            if (loaded) {
                const ext = extensionFromMime(loaded.mimeType, src)
                entries.push({
                    filename: `page${pageNum}${ext}`,
                    data: loaded.bytes,
                })
                continue
            }
            // Could not resolve — skip this page
            continue
        }

        // Text section: load HTML and extract embedded images or plain text
        const html = String(await section.load())
        const title = entry.title ?? extractDocumentTitle(html) ?? sectionTitleFromId(section) ?? `Section ${i + 1}`

        // Extract inline images from the HTML first
        const imageEntries = await extractInlineImages(html, pageNum, options)
        if (imageEntries.length > 0) {
            for (const imgEntry of imageEntries) {
                entries.push(imgEntry)
            }
            continue
        }

        // No images: store as a plain-text file so the page is not completely lost
        const text = `${title}\n${'='.repeat(Math.min(title.length, 60))}\n\n${htmlToText(html)}`
        entries.push({
            filename: `page${pageNum}.txt`,
            data: encoder.encode(text),
        })
    }

    // Build ComicInfo.xml
    const comicInfo = buildComicInfoXML(book, selected.length)
    entries.push({
        filename: 'ComicInfo.xml',
        data: encoder.encode(comicInfo),
    })

    return buildZip(entries)
}

// ---------------------------------------------------------------------------
// Inline image extraction
// ---------------------------------------------------------------------------

async function extractInlineImages(
    html: string,
    pagePrefix: string,
    options: ExportOptions,
): Promise<CBZEntry[]> {
    const results: CBZEntry[] = []
    // Match src attributes that point to packaged resources (blob:, data:, test:)
    const srcRegex = /\s(?:src|poster)=["']([^"']+)["']/gi
    let match: RegExpExecArray | null
    let imgIndex = 0

    while ((match = srcRegex.exec(html)) !== null) {
        const url = match[1]
        const loaded = await loadReferencedResource(url, options)
        if (!loaded) continue
        if (!loaded.mimeType.startsWith('image/')) continue

        const ext = extensionFromMime(loaded.mimeType, url)
        imgIndex++
        results.push({
            filename: `page${pagePrefix}-img${String(imgIndex).padStart(2, '0')}${ext}`,
            data: loaded.bytes,
        })
    }

    return results
}

// ---------------------------------------------------------------------------
// ComicInfo.xml generation (ComicRack / Kavita / Komga compatible)
// ---------------------------------------------------------------------------

function buildComicInfoXML(book: Book, pageCount: number): string {
    const meta = book.metadata
    const title = normalizeTitleText(stringifyLanguageMap(meta?.title)) || 'Unknown'
    const author = stringifyContributor(meta?.author) ?? ''
    const publisher = typeof meta?.publisher === 'string'
        ? meta.publisher
        : stringifyLanguageMap(meta?.publisher as Parameters<typeof stringifyLanguageMap>[0]) ?? ''
    const lang = Array.isArray(meta?.language) ? (meta?.language[0] ?? '') : (meta?.language ?? '')
    const summary = meta?.description ?? ''
    const published = meta?.published ?? ''

    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n`
    xml += `  <Title>${escapeXML(title)}</Title>\n`
    if (author) xml += `  <Writer>${escapeXML(author)}</Writer>\n`
    if (publisher) xml += `  <Publisher>${escapeXML(publisher)}</Publisher>\n`
    if (published) {
        const year = published.slice(0, 4)
        if (year) xml += `  <Year>${escapeXML(year)}</Year>\n`
    }
    if (lang) xml += `  <LanguageISO>${escapeXML(lang)}</LanguageISO>\n`
    if (summary) xml += `  <Summary>${escapeXML(summary)}</Summary>\n`
    xml += `  <PageCount>${pageCount}</PageCount>\n`
    xml += `</ComicInfo>`
    return xml
}

// ---------------------------------------------------------------------------
// ZIP builder (reuses @zip.js/zip.js, same as EPUBExporter)
// ---------------------------------------------------------------------------

async function buildZip(entries: CBZEntry[]): Promise<Blob> {
    const { configure, ZipWriter, BlobWriter, Uint8ArrayReader } = await import('@zip.js/zip.js')
    configure({ useWebWorkers: false })

    const writer = new BlobWriter(MIME_CBZ)
    const zip = new ZipWriter(writer)

    for (const entry of entries) {
        await zip.add(entry.filename, new Uint8ArrayReader(entry.data))
    }

    await zip.close()
    return writer.getData()
}
