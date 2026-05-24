/**
 * Exporter interface and registry.
 *
 * Exporters take a normalized Book and produce a downloadable file format.
 * This mirrors the parser registry in the opposite direction: parsers convert
 * file formats into Book, exporters convert Book into file formats.
 */

import type { Book } from './types'
import type { Parser, ParserInput, ParserOptions } from './parser'
import { registry as parserRegistry } from './parser'
import { UnsupportedFormatError } from './errors'

export type ExportSectionUnit = 'section'
export type ExportSelectionType = 'first-sections'
export type ExportFormat = string

export interface ExportSelection {
    readonly type: ExportSelectionType
    readonly count: number
    readonly unit?: ExportSectionUnit
    readonly includeNonLinear?: boolean
}

export interface ExportOptions {
    /** Output format name. Defaults to EPUB for portable exports. */
    format?: ExportFormat
    /** Parser used when the source is a File, Blob, URL string, or ArrayBuffer. Defaults to the parser registry. */
    parser?: Parser
    /** Parser options used when parsing a raw source. */
    parserOptions?: ParserOptions
    /** Specific exporter instance to use instead of exporterRegistry lookup. */
    exporter?: Exporter
    /** Override the exported title. */
    title?: string
    /** Override the exported identifier. */
    identifier?: string
}

export interface ExportFirstSectionsOptions extends ExportOptions {
    /**
     * Unit used for extraction.
     * Currently only "section" is portable across parsers. For CBZ this is one
     * image page; for reflowable formats this is one spine/reading section, not
     * a renderer-layout visual page.
     */
    unit?: ExportSectionUnit
    /** Include non-linear sections such as notes. Defaults to false. */
    includeNonLinear?: boolean
}

export interface Exporter {
    readonly format: ExportFormat
    readonly mediaType: string
    readonly extension: string
    canExport?(book: Book, selection: ExportSelection, options?: ExportOptions): Promise<boolean> | boolean
    exportBook(book: Book, selection: ExportSelection, options?: ExportOptions): Promise<Blob>
}

export type ExporterFactory = () => Exporter

export class ExporterRegistry {
    private exporters: Map<string, ExporterFactory> = new Map()

    register(format: string, factory: ExporterFactory): void {
        this.exporters.set(format, factory)
    }

    unregister(format: string): void {
        this.exporters.delete(format)
    }

    get(format: string): Exporter | undefined {
        return this.exporters.get(format)?.()
    }

    list(): string[] {
        return Array.from(this.exporters.keys())
    }

    async exportBook(book: Book, selection: ExportSelection, options: ExportOptions = {}): Promise<Blob> {
        const exporter = options.exporter ?? this.get(options.format ?? 'epub')
        if (!exporter) throw new UnsupportedFormatError(`Unsupported export format: ${options.format ?? 'epub'}`)

        if (exporter.canExport && !(await exporter.canExport(book, selection, options))) {
            throw new UnsupportedFormatError(`Exporter "${exporter.format}" cannot export the requested selection`)
        }

        return exporter.exportBook(book, selection, options)
    }

    async export(source: Book | ParserInput, selection: ExportSelection, options: ExportOptions = {}): Promise<Blob> {
        const book = isBook(source)
            ? source
            : options.parser
                ? await options.parser.parse(source, options.parserOptions)
                : await parserRegistry.open(source, options.parserOptions)
        return this.exportBook(book, selection, options)
    }
}

export const exporterRegistry = new ExporterRegistry()

export async function exportBook(
    book: Book,
    selection: ExportSelection,
    options: ExportOptions = {},
): Promise<Blob> {
    return exporterRegistry.exportBook(book, selection, options)
}

export async function exportBookAsBuffer(
    book: Book,
    selection: ExportSelection,
    options: ExportOptions = {},
): Promise<ArrayBuffer> {
    const blob = await exportBook(book, selection, options)
    return blob.arrayBuffer()
}

export async function exportFirstSections(
    source: Book | ParserInput,
    sectionCount: number,
    options: ExportFirstSectionsOptions = {},
): Promise<Blob> {
    return exporterRegistry.export(source, firstSectionsSelection(sectionCount, options), options)
}

export async function exportFirstSectionsAsBuffer(
    source: Book | ParserInput,
    sectionCount: number,
    options: ExportFirstSectionsOptions = {},
): Promise<ArrayBuffer> {
    const blob = await exportFirstSections(source, sectionCount, options)
    return blob.arrayBuffer()
}

export function firstSectionsSelection(sectionCount: number, options: ExportFirstSectionsOptions = {}): ExportSelection {
    return {
        type: 'first-sections',
        count: sectionCount,
        unit: options.unit,
        includeNonLinear: options.includeNonLinear,
    }
}

export function isBook(value: unknown): value is Book {
    return !!value && typeof value === 'object' && Array.isArray((value as Book).sections)
}
