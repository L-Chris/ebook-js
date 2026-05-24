/**
 * TXT (plain-text) exporter.
 *
 * Exports selected sections as a single UTF-8 plain-text file.
 * Each section is separated by a chapter header and a divider line.
 * Image sections emit a descriptive placeholder.
 */

import type { Book } from '../core/types'
import type { Exporter, ExportOptions, ExportSelection } from '../core/exporter'
import { selectSections } from './section-selection'
import {
    extractDocumentTitle,
    sectionTitleFromId,
    stringifyLanguageMap,
    stringifyContributor,
    buildExportTitle,
    htmlToText,
} from './utils'

export type { ExportOptions, ExportSelection } from '../core/exporter'

const MIME_TXT = 'text/plain'

export class TXTExporter implements Exporter {
    readonly format = 'txt'
    readonly mediaType = MIME_TXT
    readonly extension = '.txt'

    canExport(_book: Book, selection: ExportSelection): boolean {
        return selection.type === 'first-sections' && (!selection.unit || selection.unit === 'section')
    }

    async exportBook(book: Book, selection: ExportSelection, options: ExportOptions = {}): Promise<Blob> {
        return createTXT(book, selection, options)
    }
}

export const txtExporter = () => new TXTExporter()

// ---------------------------------------------------------------------------
// TXT creation
// ---------------------------------------------------------------------------

async function createTXT(
    book: Book,
    selection: ExportSelection,
    _options: ExportOptions,
): Promise<Blob> {
    const selected = selectSections(book, selection)
    const parts: string[] = []

    // Book header
    const bookTitle = buildExportTitle(book.metadata)
    const author = stringifyContributor(book.metadata?.author)
    const publisher = typeof book.metadata?.publisher === 'string'
        ? book.metadata.publisher
        : stringifyLanguageMap(book.metadata?.publisher as Parameters<typeof stringifyLanguageMap>[0])

    parts.push(buildHeader(bookTitle, author, publisher))

    for (let i = 0; i < selected.length; i++) {
        const entry = selected[i]
        const section = entry.section

        if (section.format === 'image') {
            // Image section: emit a descriptive placeholder
            const label = entry.title ?? sectionTitleFromId(section) ?? `Image ${i + 1}`
            parts.push(`\n\n${'─'.repeat(60)}\n`)
            parts.push(`[${label}]\n`)
            continue
        }

        // Text section: prefer loadText(), fall back to stripping HTML
        let text: string
        if (typeof section.loadText === 'function') {
            text = String(await section.loadText())
        } else {
            const html = String(await section.load())
            text = htmlToText(html)
        }

        const html = String(await section.load())
        const title = entry.title ?? extractDocumentTitle(html) ?? sectionTitleFromId(section) ?? `Section ${i + 1}`

        // Chapter divider + title
        parts.push(`\n\n${'═'.repeat(60)}\n`)
        parts.push(`${title}\n`)
        parts.push(`${'─'.repeat(Math.min(title.length, 60))}\n\n`)
        parts.push(text.trim())
    }

    parts.push('\n')

    const content = parts.join('')
    return new Blob([content], { type: `${MIME_TXT};charset=utf-8` })
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function buildHeader(title: string, author: string | undefined, publisher: string | undefined): string {
    const lines: string[] = []
    const divider = '═'.repeat(60)
    lines.push(divider)
    lines.push(title)
    if (author) lines.push(`By ${author}`)
    if (publisher) lines.push(`Publisher: ${publisher}`)
    lines.push(divider)
    return lines.join('\n')
}
