import type { Book, Section, TOCItem } from '../core/types'
import type { ExportSelection } from '../core/exporter'

export interface SelectedSection {
    readonly section: Section
    readonly sourceIndex: number
    readonly title?: string
}

export function selectSections(book: Book, selection: ExportSelection): SelectedSection[] {
    if (selection.type !== 'first-pages') {
        throw new Error(`Unsupported export selection: ${selection.type}`)
    }
    if (!Number.isInteger(selection.count) || selection.count < 1) {
        throw new RangeError('pageCount must be a positive integer')
    }
    if (selection.unit && selection.unit !== 'section') {
        throw new Error(`Unsupported page unit: ${selection.unit}`)
    }

    const labels = buildSectionLabels(book)
    return book.sections
        .map((section, sourceIndex) => ({ section, sourceIndex, title: labels.get(sourceIndex) }))
        .filter(entry => selection.includeNonLinear || entry.section.linear !== 'no')
        .slice(0, selection.count)
}

function buildSectionLabels(book: Book): Map<number, string> {
    const labels = new Map<number, string>()
    const walk = (items: readonly TOCItem[] | undefined) => {
        for (const item of items ?? []) {
            const index = resolveTOCIndex(book, item.href)
            if (index >= 0 && !labels.has(index)) labels.set(index, item.label)
            walk(item.subitems)
        }
    }
    walk(book.toc)
    return labels
}

function resolveTOCIndex(book: Book, href: string): number {
    const resolved = book.resolveHref?.(href)
    if (resolved && resolved.index >= 0) return resolved.index

    const [id] = book.splitTOCHref?.(href) ?? href.split('#')
    const sectionId = String(id)
    return book.sections.findIndex(section => String(section.id) === sectionId || String(section.id) === decodeURI(sectionId))
}
