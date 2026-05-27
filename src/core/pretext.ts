/**
 * EPUB/XHTML to Pretext adapter.
 *
 * rebook owns document parsing and style extraction. Line breaking and text
 * measurement are delegated to @chenglou/pretext.
 */

import type { LayoutCursor } from '@chenglou/pretext'
import {
    materializeRichInlineLineRange,
    prepareRichInline,
    walkRichInlineLineRanges,
    type PreparedRichInline,
    type RichInlineItem,
    type RichInlineLineRange,
} from '@chenglou/pretext/rich-inline'
import type {
    DocumentNode,
    ImageStyle,
    TextBlock,
    TextBlockType,
    TextImage,
    TextSegment,
    TextStyle,
    TextTable,
    TextTableCell,
    TextTableRow,
} from './types'
import { isTextNode } from './document'

export type { ImageStyle, TextBlock, TextBlockType, TextImage, TextSegment, TextStyle, TextTable, TextTableCell, TextTableRow } from './types'

export interface PreparedTextBlock {
    prepared?: PreparedRichInline
    itemSegmentIndexes: readonly number[]
    block: TextBlock
}

export interface PreparedText {
    segments: readonly TextSegment[]
    blocks: readonly PreparedTextBlock[]
    baseStyle: Required<Pick<TextStyle, 'fontFamily' | 'fontSize' | 'lineHeight'>>
    lineHeight: number
}

export interface PrepareOptions {
    baseStyle?: TextStyle
}

export interface ExtractDocumentBlocksOptions {
    coverImageSrcs?: readonly string[]
}

export interface LayoutOptions {
    inlineSize: number
    lineHeight?: number
    blockStart?: number
    blockGap?: number
    maxBlockHeight?: number
}

export interface LinePosition {
    segmentIndex: number
    cursor: LayoutCursor
}

export interface LineSegmentRange {
    segmentIndex: number
    start: LayoutCursor
    end: LayoutCursor
    text: string
    style: TextStyle
    gapBefore: number
    occupiedWidth: number
}

export interface LineRange {
    index: number
    kind: 'text' | 'image' | 'table'
    block?: TextBlock
    image?: TextImage
    table?: TextTable
    start: LinePosition | null
    end: LinePosition | null
    text: string
    width: number
    top: number
    height: number
    segments: readonly LineSegmentRange[]
}

export interface VisibleLineWindow {
    startIndex: number
    endIndex: number
    offsetTop: number
    totalHeight: number
    lines: readonly LineRange[]
}

const BLOCK_TAGS = new Set([
    'address', 'article', 'aside', 'blockquote', 'body', 'br', 'dd', 'div',
    'dl', 'dt', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4',
    'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre',
    'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
])

const DEFAULT_STYLE = {
    fontFamily: 'Georgia, serif',
    fontSize: 16,
    lineHeight: 1.6,
} satisfies Required<Pick<TextStyle, 'fontFamily' | 'fontSize' | 'lineHeight'>>

export function extractDocumentSegments(
    nodes: readonly DocumentNode[],
    baseStyle: TextStyle = {},
    options: ExtractDocumentBlocksOptions = {},
): TextSegment[] {
    return extractDocumentBlocks(nodes, baseStyle, options).flatMap(block => block.segments)
}

export function extractDocumentBlocks(
    nodes: readonly DocumentNode[],
    baseStyle: TextStyle = {},
    options: ExtractDocumentBlocksOptions = {},
): TextBlock[] {
    const blocks: TextBlock[] = []
    let nextId = 0
    const coverImageSrcs = new Set((options.coverImageSrcs ?? []).map(normalizeResourceRef))

    const pushBlock = (
        type: TextBlockType,
        node: DocumentNode,
        segments: TextSegment[],
        depth?: number,
    ) => {
        const normalized = normalizeSegments(segments)
        if (!normalized.some(segment => segment.text.trim())) return
        const preset = getBlockPreset(type, baseStyle, depth)
        blocks.push({
            id: node.attrs?.id ?? `${type}-${nextId++}`,
            type,
            depth,
            attrs: node.attrs,
            style: preset.style,
            blockGapBefore: preset.blockGapBefore,
            blockGapAfter: preset.blockGapAfter,
            segments: normalized.map(segment => ({
                ...segment,
                style: { ...preset.style, ...segment.style },
                source: {
                    ...segment.source,
                    nodeType: segment.source?.nodeType ?? type,
                    attrs: segment.source?.attrs ?? node.attrs,
                },
            })),
        })
    }

    const pushImageBlock = (node: DocumentNode) => {
        const image = getImageData(node, coverImageSrcs)
        if (!image) return
        if (isFootnoteMarkerImage(image)) return
        const fontSize = baseStyle.fontSize ?? DEFAULT_STYLE.fontSize
        blocks.push({
            id: node.attrs?.id ?? `image-${nextId++}`,
            type: 'image',
            attrs: node.attrs,
            style: parseInlineStyle(node.attrs?.style),
            blockGapBefore: image.isCover ? 0 : fontSize * 0.75,
            blockGapAfter: fontSize * 0.75,
            image,
            segments: [],
        })
    }

    const pushTableBlocks = (node: DocumentNode) => {
        const table = getTableData(node)
        if (!table || table.rows.length === 0) return
        const fontSize = baseStyle.fontSize ?? DEFAULT_STYLE.fontSize
        const lineHeight = baseStyle.lineHeight ?? DEFAULT_STYLE.lineHeight
        const tableId = node.attrs?.id ?? `table-${nextId++}`

        table.rows.forEach((row, rowIndex) => {
            blocks.push({
                id: rowIndex === 0 ? tableId : `${tableId}-row-${rowIndex + 1}`,
                type: 'table',
                attrs: {
                    ...node.attrs,
                    'data-rebook-table-row': String(rowIndex),
                },
                style: { fontSize, lineHeight },
                blockGapBefore: rowIndex === 0 ? fontSize * 0.75 : 0,
                blockGapAfter: rowIndex === table.rows.length - 1 ? fontSize * 0.75 : 0,
                table: {
                    ...table,
                    rowIndex,
                    rows: [row],
                },
                segments: [],
            })
        })
    }

    const walkBlock = (node: DocumentNode, inherited: TextStyle) => {
        if (isTextNode(node)) {
            if (node.text.trim()) {
                pushBlock('paragraph', node, [{ text: node.text, style: inherited, source: { nodeType: 'text' } }])
            }
            return
        }

        const type = node.type.toLowerCase()
        if (type === 'script' || type === 'style' || type === 'head') return

        if (isImageNode(type, node)) {
            pushImageBlock(node)
            return
        }

        if (type === 'table') {
            pushTableBlocks(node)
            return
        }

        if (/^h[1-6]$/.test(type)) {
            const depth = Number(type[1])
            pushBlock(depth === 1 ? 'chapter' : 'heading', node, collectInlineSegments(node, inherited), depth)
            return
        }

        if (type === 'p') {
            pushBlock('paragraph', node, collectInlineSegments(node, inherited))
            for (const image of collectImageNodes(node)) pushImageBlock(image)
            return
        }

        if (type === 'li') {
            pushBlock('listItem', node, [
                { text: '• ', style: inherited, source: { nodeType: 'marker' } },
                ...collectInlineSegments(node, inherited),
            ])
            return
        }

        if (type === 'blockquote') {
            pushBlock('blockquote', node, collectInlineSegments(node, inherited))
            for (const image of collectImageNodes(node)) pushImageBlock(image)
            return
        }

        if (type === 'pre') {
            pushBlock('pre', node, collectInlineSegments(node, inherited))
            return
        }

        for (const child of node.children ?? []) walkBlock(child, inherited)
    }

    for (const node of nodes) walkBlock(node, { ...baseStyle })

    return blocks
}

export function prepare(
    segments: readonly TextSegment[],
    options: PrepareOptions = {},
): PreparedText {
    return prepareBlocks(segmentsToBlocks(segments), options)
}

export function prepareBlocks(
    textBlocks: readonly TextBlock[],
    options: PrepareOptions = {},
): PreparedText {
    const baseStyle = { ...DEFAULT_STYLE, ...options.baseStyle }
    const lineHeight = baseStyle.fontSize * baseStyle.lineHeight
    const segments = textBlocks.flatMap(block => block.segments)
    let nextSegmentIndex = 0
    const blocks = textBlocks
        .filter(block => block.type === 'image' || block.type === 'table' || block.segments.some(segment => segment.text.trim()))
        .map(block => {
        const itemSegmentIndexes = block.segments.map(() => nextSegmentIndex++)
        if (block.type === 'image' || block.type === 'table') {
            return {
                itemSegmentIndexes,
                block,
            } satisfies PreparedTextBlock
        }
        const items: RichInlineItem[] = block.segments.map(segment => ({
            text: segment.text,
            font: toCanvasFont({ ...baseStyle, ...segment.style }),
            letterSpacing: segment.style?.letterSpacing,
            break: segment.break,
            extraWidth: segment.extraWidth,
        }))

        return {
            prepared: prepareRichInline(items),
            itemSegmentIndexes,
            block,
        } satisfies PreparedTextBlock
    })

    return { segments, blocks, baseStyle, lineHeight }
}

export function layout(prepared: PreparedText, options: LayoutOptions): LineRange[] {
    const lines: LineRange[] = []
    const inlineSize = Math.max(1, options.inlineSize)
    const lineHeight = options.lineHeight ?? prepared.lineHeight
    const blockGap = options.blockGap ?? 0
    let top = options.blockStart ?? 0

    for (const block of prepared.blocks) {
        const blockStartCount = lines.length
        if (blockStartCount > 0) top += block.block.blockGapBefore ?? 0
        if (block.block.type === 'image' && block.block.image) {
            const metrics = getImageBlockMetrics(block.block.image, inlineSize, lineHeight, options.maxBlockHeight)
            top = avoidAtomicBlockPageBreak(top, metrics.height, options.maxBlockHeight, lineHeight)
            lines.push({
                index: lines.length,
                kind: 'image',
                block: block.block,
                image: block.block.image,
                start: null,
                end: null,
                text: block.block.image.alt ?? block.block.image.title ?? '',
                width: metrics.width,
                top,
                height: metrics.height,
                segments: [],
            })
            top += metrics.height
            top += block.block.blockGapAfter ?? blockGap
            continue
        }
        if (block.block.type === 'table' && block.block.table) {
            const metrics = getTableBlockMetrics(
                block.block.table,
                inlineSize,
                lineHeight,
                prepared.baseStyle.fontSize,
                options.maxBlockHeight,
            )
            top = avoidAtomicBlockPageBreak(top, metrics.height, options.maxBlockHeight, lineHeight)
            lines.push({
                index: lines.length,
                kind: 'table',
                block: block.block,
                table: block.block.table,
                start: null,
                end: null,
                text: block.block.table.rows[0]?.cells.map(cell => cell.text).join(' ') ?? '',
                width: metrics.width,
                top,
                height: metrics.height,
                segments: [],
            })
            top += metrics.height
            top += block.block.blockGapAfter ?? blockGap
            continue
        }
        const richInline = block.prepared
        if (!richInline) continue
        walkRichInlineLineRanges(richInline, inlineSize, (range) => {
            const materialized = materializeRichInlineLineRange(richInline, range)
            const fragments = materialized.fragments.map((fragment, index): LineSegmentRange => {
                const rangeFragment = range.fragments[index]!
                const segmentIndex = block.itemSegmentIndexes[fragment.itemIndex]!
                return {
                    segmentIndex,
                    start: rangeFragment.start,
                    end: rangeFragment.end,
                    text: fragment.text,
                    style: prepared.segments[segmentIndex]?.style ?? {},
                    gapBefore: fragment.gapBefore,
                    occupiedWidth: fragment.occupiedWidth,
                }
            })
            const first = fragments[0]
            const last = fragments[fragments.length - 1]
            lines.push({
                index: lines.length,
                kind: 'text',
                block: block.block,
                start: first ? { segmentIndex: first.segmentIndex, cursor: first.start } : null,
                end: last ? { segmentIndex: last.segmentIndex, cursor: last.end } : null,
                text: joinFragments(fragments),
                width: materialized.width,
                top,
                height: lineHeight,
                segments: fragments,
            })
            top += lineHeight
        })

        if (lines.length > blockStartCount) top += block.block.blockGapAfter ?? blockGap
    }

    if (lines.length === 0) {
        lines.push({
            index: 0,
            kind: 'text',
            start: null,
            end: null,
            text: '',
            width: 0,
            top,
            height: lineHeight,
            segments: [],
        })
    }

    return lines
}

export function getVisibleLines(
    lines: readonly LineRange[],
    scrollTop: number,
    viewportHeight: number,
    overscan = 2,
): VisibleLineWindow {
    if (lines.length === 0) {
        return { startIndex: 0, endIndex: 0, offsetTop: 0, totalHeight: 0, lines: [] }
    }

    const totalHeight = lines[lines.length - 1].top + lines[lines.length - 1].height
    const startIndex = findFirstVisibleLine(lines, scrollTop, overscan)
    const endIndex = findLastVisibleLine(lines, scrollTop + viewportHeight, overscan)

    return {
        startIndex,
        endIndex,
        offsetTop: lines[startIndex]?.top ?? 0,
        totalHeight,
        lines: lines.slice(startIndex, endIndex),
    }
}

export type PretextRichInlineLineRange = RichInlineLineRange

function collectInlineSegments(node: DocumentNode, inherited: TextStyle): TextSegment[] {
    const segments: TextSegment[] = []

    const walk = (current: DocumentNode, style: TextStyle) => {
        if (isTextNode(current)) {
            if (current.text) {
                segments.push({ text: current.text, style, source: { nodeType: 'text' } })
            }
            return
        }

        const type = current.type.toLowerCase()
        if (type === 'script' || type === 'style' || type === 'head') return
        if (type === 'br') {
            segments.push({ text: '\n', style, source: { nodeType: 'br', attrs: current.attrs } })
            return
        }

        if (BLOCK_TAGS.has(type) && current !== node) {
            for (const child of current.children ?? []) walk(child, applyNodeStyle(type, style, current.attrs))
            segments.push({ text: '\n', style, source: { nodeType: type, attrs: current.attrs } })
            return
        }

        const nextStyle = applyNodeStyle(type, style, current.attrs)
        for (const child of current.children ?? []) walk(child, nextStyle)
    }

    for (const child of node.children ?? []) walk(child, inherited)
    return segments
}

function collectImageNodes(node: DocumentNode): DocumentNode[] {
    const images: DocumentNode[] = []
    const walk = (current: DocumentNode) => {
        if (isTextNode(current)) return
        const type = current.type.toLowerCase()
        if (isImageNode(type, current)) {
            images.push(current)
            return
        }
        for (const child of current.children ?? []) walk(child)
    }
    for (const child of node.children ?? []) walk(child)
    return images
}

function getTableData(node: DocumentNode): TextTable | null {
    const rows = collectTableRows(node)
    if (rows.length === 0) return null
    const columnCount = Math.max(
        1,
        ...rows.map(row => row.cells.reduce((sum, cell) => sum + (cell.colspan ?? 1), 0)),
    )
    const columnWeights = getTableColumnWeights(node, rows, columnCount)
    return {
        columnCount,
        columnWeights,
        rowIndex: 0,
        rowCount: rows.length,
        rows,
    }
}

function collectTableRows(table: DocumentNode): TextTableRow[] {
    const rows: TextTableRow[] = []
    const walk = (node: DocumentNode) => {
        if (isTextNode(node)) return
        const type = node.type.toLowerCase()
        if (type === 'tr') {
            const cells = (node.children ?? [])
                .filter(child => !isTextNode(child) && isTableCellNode(child.type.toLowerCase()))
                .map(cell => getTableCellData(cell as DocumentNode))
                .filter((cell): cell is TextTableCell => Boolean(cell?.text))
            if (cells.length > 0) rows.push({ cells })
            return
        }
        for (const child of node.children ?? []) walk(child)
    }
    for (const child of table.children ?? []) walk(child)
    return rows
}

function getTableCellData(node: DocumentNode): TextTableCell | null {
    if (isTextNode(node)) return null
    const text = normalizeTableCellText(collectInlineSegments(node, {}).map(segment => segment.text).join(''))
    if (!text) return null
    const type = node.type.toLowerCase()
    return {
        text,
        header: type === 'th' || Boolean(node.children?.some(child => isElementOfType(child, 'b') || isElementOfType(child, 'strong'))),
        colspan: parsePositiveInteger(node.attrs?.colspan),
        rowspan: parsePositiveInteger(node.attrs?.rowspan),
        align: getTableCellAlign(node),
        attrs: node.attrs,
    }
}

function getTableColumnWeights(
    table: DocumentNode,
    rows: readonly TextTableRow[],
    columnCount: number,
): readonly number[] | undefined {
    const fromColgroup = getColgroupWeights(table, columnCount)
    if (fromColgroup) return fromColgroup

    const firstCompleteRow = rows.find(row => row.cells.length === columnCount && row.cells.every(cell => !cell.colspan || cell.colspan === 1))
    const weights = firstCompleteRow?.cells.map(cell => parsePercentWidth(cell.attrs?.style) ?? parsePercentWidth(cell.attrs?.width))
    return weights?.every((value): value is number => typeof value === 'number' && value > 0) ? weights : undefined
}

function getColgroupWeights(table: DocumentNode, columnCount: number): readonly number[] | undefined {
    const cols: number[] = []
    const walk = (node: DocumentNode) => {
        if (isTextNode(node)) return
        if (node.type.toLowerCase() === 'col') {
            const weight = parsePercentWidth(node.attrs?.style) ?? parsePercentWidth(node.attrs?.width)
            if (weight) cols.push(weight)
            return
        }
        for (const child of node.children ?? []) walk(child)
    }
    for (const child of table.children ?? []) walk(child)
    return cols.length === columnCount ? cols : undefined
}

function isTableCellNode(type: string): boolean {
    return type === 'td' || type === 'th'
}

function isElementOfType(node: DocumentNode, type: string): boolean {
    return !isTextNode(node) && node.type.toLowerCase() === type
}

function normalizeTableCellText(value: string): string {
    return value
        .replace(/\s+/g, ' ')
        .trim()
}

function parsePositiveInteger(value?: string): number | undefined {
    if (!value) return undefined
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) && parsed > 1 ? parsed : undefined
}

function getTableCellAlign(node: DocumentNode): TextTableCell['align'] | undefined {
    if (isTextNode(node)) return undefined
    const styleAlign = parseTextAlignFromStyle(node.attrs?.style)
    if (styleAlign) return styleAlign
    const align = node.attrs?.align?.toLowerCase()
    if (align) return parseTextAlign(align)
    const className = node.attrs?.class?.toLowerCase()
    if (className?.split(/\s+/).includes('center')) return 'center'
    if (className?.split(/\s+/).includes('right')) return 'end'
    return undefined
}

function isImageNode(type: string, node: DocumentNode): boolean {
    if (type === 'img') return Boolean(node.attrs?.src)
    if (type === 'image') return Boolean(node.attrs?.href ?? node.attrs?.src)
    return false
}

function getImageData(
    node: DocumentNode,
    coverImageSrcs: ReadonlySet<string>,
): TextImage | null {
    const attrs = node.attrs ?? {}
    const src = attrs.src ?? attrs.href
    if (!src) return null

    const imageStyle = parseImageStyle(attrs.style)
    const width = parseCSSDimension(attrs.width) ?? imageStyle.width
    const height = parseCSSDimension(attrs.height) ?? imageStyle.height
    const originalSrc = attrs['data-rebook-original-src']
        ?? attrs['data-rebook-original-href']
        ?? attrs['data-rebook-original-data']
        ?? src
    const role = [
        attrs['epub:type'],
        attrs.type,
        attrs.role,
        attrs.properties,
        attrs.class,
    ].filter(Boolean).join(' ')
    const roleLower = role.toLowerCase()
    const normalizedSrc = normalizeResourceRef(src)
    const normalizedOriginalSrc = normalizeResourceRef(originalSrc)
    const isCover = roleLower.split(/\s+/).includes('cover')
        || coverImageSrcs.has(normalizedSrc)
        || coverImageSrcs.has(normalizedOriginalSrc)

    return {
        src,
        originalSrc,
        alt: attrs.alt,
        title: attrs.title,
        width,
        height,
        aspectRatio: width && height ? width / height : undefined,
        isCover,
        role: role || undefined,
        style: imageStyle,
    }
}

function isFootnoteMarkerImage(image: TextImage): boolean {
    const role = image.role?.toLowerCase() ?? ''
    return role.split(/\s+/).some(token =>
        token === 'epub-footnote'
        || token === 'epub-footnote1'
        || token === 'noteref'
        || token === 'footnote-ref')
}

function getImageBlockMetrics(
    image: TextImage,
    inlineSize: number,
    lineHeight: number,
    maxBlockHeight?: number,
): { width: number; height: number } {
    const maxWidth = Math.min(inlineSize, image.style?.maxWidth ?? inlineSize)
    const preferredWidth = image.style?.width ?? image.width ?? maxWidth
    const width = Math.max(1, Math.min(maxWidth, preferredWidth))
    const naturalRatio = image.aspectRatio ?? (image.width && image.height ? image.width / image.height : undefined)
    const fallbackHeight = image.isCover ? width * 1.35 : Math.max(lineHeight * 6, width * 0.62)
    const preferredHeight = image.style?.height
        ?? (naturalRatio ? width / naturalRatio : undefined)
        ?? image.height
        ?? fallbackHeight
    const styleMaxHeight = image.style?.maxHeight ?? Number.POSITIVE_INFINITY
    const maxHeight = maxBlockHeight
        ? Math.max(lineHeight * 2, Math.min(maxBlockHeight, styleMaxHeight))
        : styleMaxHeight
    const height = Math.max(lineHeight * 2, Math.min(maxHeight, preferredHeight))
    return { width, height }
}

function getTableBlockMetrics(
    table: TextTable,
    inlineSize: number,
    lineHeight: number,
    fontSize: number,
    maxBlockHeight?: number,
): { width: number; height: number } {
    const cellPadding = fontSize * 0.45
    const columnWidths = getResolvedColumnWidths(table, inlineSize)
    const row = table.rows[0]
    const contentHeight = row?.cells.reduce((max, cell, cellIndex) => {
        const colspan = Math.max(1, cell.colspan ?? 1)
        const columnWidth = columnWidths
            .slice(cellIndex, cellIndex + colspan)
            .reduce((sum, width) => sum + width, 0)
        const textWidth = Math.max(fontSize * 2, columnWidth - cellPadding * 2)
        const estimatedLineCount = Math.max(1, Math.ceil(estimateTextWidth(cell.text, fontSize) / textWidth))
        return Math.max(max, estimatedLineCount * lineHeight + cellPadding * 2)
    }, lineHeight + cellPadding * 2) ?? lineHeight + cellPadding * 2
    const maxHeight = maxBlockHeight
        ? Math.max(lineHeight * 1.5, maxBlockHeight)
        : Number.POSITIVE_INFINITY
    return {
        width: inlineSize,
        height: Math.min(maxHeight, Math.max(lineHeight * 1.5, contentHeight)),
    }
}

function getResolvedColumnWidths(table: TextTable, inlineSize: number): number[] {
    const weights = table.columnWeights?.length === table.columnCount
        ? table.columnWeights
        : Array.from({ length: table.columnCount }, () => 1)
    const total = weights.reduce((sum, width) => sum + Math.max(0, width), 0) || table.columnCount
    return weights.map(weight => inlineSize * (Math.max(0, weight) / total))
}

function estimateTextWidth(text: string, fontSize: number): number {
    return Array.from(text).reduce((sum, char) => {
        if (char === ' ') return sum + fontSize * 0.32
        if (/[\u4e00-\u9fff]/.test(char)) return sum + fontSize
        return sum + fontSize * 0.54
    }, 0)
}

function avoidAtomicBlockPageBreak(
    top: number,
    height: number,
    maxBlockHeight: number | undefined,
    lineHeight: number,
): number {
    if (!maxBlockHeight || height >= maxBlockHeight) return top
    const offset = top % maxBlockHeight
    if (offset === 0) return top
    return offset + height > maxBlockHeight
        ? top + Math.max(lineHeight, maxBlockHeight - offset)
        : top
}

function segmentsToBlocks(segments: readonly TextSegment[]): TextBlock[] {
    return splitBlocks(segments).map((block, index) => ({
        id: `paragraph-${index}`,
        type: 'paragraph',
        segments: block.map(item => item.segment),
    }))
}

function splitBlocks(segments: readonly TextSegment[]): Array<Array<{ segment: TextSegment; segmentIndex: number }>> {
    const blocks: Array<Array<{ segment: TextSegment; segmentIndex: number }>> = []
    let current: Array<{ segment: TextSegment; segmentIndex: number }> = []

    const flush = () => {
        if (current.length > 0) {
            blocks.push(current)
            current = []
        }
    }

    segments.forEach((segment, segmentIndex) => {
        const pieces = segment.text.split('\n')
        pieces.forEach((piece, pieceIndex) => {
            if (piece) current.push({ segment: { ...segment, text: piece }, segmentIndex })
            if (pieceIndex < pieces.length - 1) flush()
        })
    })

    flush()
    return blocks
}

function getBlockPreset(
    type: TextBlockType,
    baseStyle: TextStyle,
    depth?: number,
): { style: TextStyle; blockGapBefore: number; blockGapAfter: number } {
    const fontSize = baseStyle.fontSize ?? DEFAULT_STYLE.fontSize
    const lineHeight = baseStyle.lineHeight ?? DEFAULT_STYLE.lineHeight

    if (type === 'chapter') {
        return {
            style: {
                fontSize: fontSize * 1.55,
                fontWeight: '700',
                lineHeight: 1.45,
            },
            blockGapBefore: fontSize * 1.2,
            blockGapAfter: fontSize * 1.2,
        }
    }

    if (type === 'heading') {
        const scale = Math.max(1.08, 1.42 - (depth ?? 2) * 0.08)
        return {
            style: {
                fontSize: fontSize * scale,
                fontWeight: '700',
                lineHeight: 1.45,
            },
            blockGapBefore: fontSize * 0.9,
            blockGapAfter: fontSize * 0.6,
        }
    }

    if (type === 'blockquote') {
        return {
            style: {
                fontSize,
                lineHeight,
                color: baseStyle.color,
            },
            blockGapBefore: fontSize * 0.5,
            blockGapAfter: fontSize * 0.5,
        }
    }

    if (type === 'pre') {
        return {
            style: {
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                fontSize: fontSize * 0.92,
                lineHeight: 1.55,
            },
            blockGapBefore: fontSize * 0.6,
            blockGapAfter: fontSize * 0.6,
        }
    }

    if (type === 'listItem') {
        return {
            style: { fontSize, lineHeight },
            blockGapBefore: 0,
            blockGapAfter: fontSize * 0.35,
        }
    }

    return {
        style: { fontSize, lineHeight },
        blockGapBefore: 0,
        blockGapAfter: fontSize * 0.75,
    }
}

function normalizeSegments(segments: TextSegment[]): TextSegment[] {
    const normalized: TextSegment[] = []
    for (const segment of segments) {
        const text = segment.text.replace(/[ \t\r\f]+/g, ' ')
        if (!text) continue
        const last = normalized[normalized.length - 1]
        if (last && sameStyle(last.style, segment.style) && sameSource(last.source, segment.source)) {
            normalized[normalized.length - 1] = { ...last, text: last.text + text }
        } else {
            normalized.push({ ...segment, text })
        }
    }
    while (normalized[0]?.text === '\n') normalized.shift()
    while (normalized[normalized.length - 1]?.text === '\n') normalized.pop()
    return normalized
}

function applyNodeStyle(
    type: string,
    inherited: TextStyle,
    attrs?: Readonly<Record<string, string>>,
): TextStyle {
    const style = { ...inherited, ...parseInlineStyle(attrs?.style) }
    if (type === 'strong' || type === 'b') style.fontWeight = '700'
    if (type === 'em' || type === 'i' || type === 'cite') style.fontStyle = 'italic'
    if (type === 'u') style.textDecoration = 'underline'
    if (type === 's' || type === 'strike' || type === 'del') style.textDecoration = 'line-through'
    if (/^h[1-6]$/.test(type)) {
        const level = Number(type[1])
        style.fontWeight = '700'
        style.fontSize = (inherited.fontSize ?? DEFAULT_STYLE.fontSize) * (1.5 - level * 0.08)
    }
    return style
}

function parseInlineStyle(style?: string): TextStyle {
    if (!style) return {}
    const result: TextStyle = {}
    for (const [name, value] of parseStyleDeclarations(style)) {
        if (name === 'font-family') result.fontFamily = value
        else if (name === 'font-size') result.fontSize = parseCSSPixels(value)
        else if (name === 'font-weight') result.fontWeight = value
        else if (name === 'font-style') result.fontStyle = value
        else if (name === 'font-variant') result.fontVariant = value
        else if (name === 'line-height') result.lineHeight = parseLineHeight(value)
        else if (name === 'letter-spacing') result.letterSpacing = parseCSSPixels(value)
        else if (name === 'color') result.color = value
        else if (name === 'text-decoration') result.textDecoration = value
    }
    return result
}

function parseImageStyle(style: string | undefined): ImageStyle {
    const result: ImageStyle = {}
    for (const [name, value] of parseStyleDeclarations(style)) {
        if (name === 'width') result.width = parseCSSDimension(value)
        else if (name === 'height') result.height = parseCSSDimension(value)
        else if (name === 'max-width') result.maxWidth = parseCSSDimension(value)
        else if (name === 'max-height') result.maxHeight = parseCSSDimension(value)
        else if (name === 'object-fit' && isObjectFit(value)) result.objectFit = value
        else if (name === 'text-align') result.align = parseTextAlign(value)
        else if (name === 'margin-left' && value === 'auto') result.align = 'center'
        else if (name === 'margin-right' && value === 'auto' && result.align === 'center') result.align = 'center'
    }
    return result
}

function parsePercentWidth(value?: string): number | undefined {
    if (!value) return undefined
    const styleWidth = parseStyleDeclarations(value).find(([name]) => name === 'width')?.[1]
    const width = styleWidth ?? value
    const match = width.match(/([\d.]+)%/)
    if (!match) return undefined
    const amount = Number(match[1])
    return Number.isFinite(amount) && amount > 0 ? amount : undefined
}

function parseTextAlignFromStyle(style?: string): ImageStyle['align'] | undefined {
    const textAlign = parseStyleDeclarations(style).find(([name]) => name === 'text-align')?.[1]
    return textAlign ? parseTextAlign(textAlign) : undefined
}

function parseStyleDeclarations(style?: string): Array<[string, string]> {
    if (!style) return []
    const declarations: Array<[string, string]> = []
    for (const declaration of style.split(';')) {
        const separator = declaration.indexOf(':')
        if (separator < 0) continue
        const name = declaration.slice(0, separator).trim().toLowerCase()
        const value = declaration.slice(separator + 1).trim()
        if (name && value) declarations.push([name, value])
    }
    return declarations
}

function parseCSSPixels(value: string): number | undefined {
    const match = value.match(/^([\d.]+)(px|em|rem)?$/)
    if (!match) return undefined
    const amount = Number(match[1])
    if (!Number.isFinite(amount)) return undefined
    return match[2] === 'em' || match[2] === 'rem' ? amount * DEFAULT_STYLE.fontSize : amount
}

function parseCSSDimension(value?: string): number | undefined {
    if (!value) return undefined
    const trimmed = value.trim()
    if (trimmed === 'auto' || trimmed.endsWith('%')) return undefined
    return parseCSSPixels(trimmed)
}

function isObjectFit(value: string): value is NonNullable<ImageStyle['objectFit']> {
    return value === 'contain'
        || value === 'cover'
        || value === 'fill'
        || value === 'none'
        || value === 'scale-down'
}

function parseTextAlign(value: string): ImageStyle['align'] | undefined {
    if (value === 'center') return 'center'
    if (value === 'right' || value === 'end') return 'end'
    if (value === 'left' || value === 'start') return 'start'
    return undefined
}

function parseLineHeight(value: string): number | undefined {
    if (value === 'normal') return undefined
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric
    const px = parseCSSPixels(value)
    return px ? px / DEFAULT_STYLE.fontSize : undefined
}

function toCanvasFont(style: TextStyle): string {
    const fontStyle = style.fontStyle ?? 'normal'
    const fontVariant = style.fontVariant ?? 'normal'
    const fontWeight = style.fontWeight ?? '400'
    const fontSize = style.fontSize ?? DEFAULT_STYLE.fontSize
    const fontFamily = style.fontFamily ?? DEFAULT_STYLE.fontFamily
    return `${fontStyle} ${fontVariant} ${fontWeight} ${fontSize}px ${fontFamily}`
}

function joinFragments(fragments: readonly LineSegmentRange[]): string {
    return fragments.map(fragment => `${fragment.gapBefore > 0 ? ' ' : ''}${fragment.text}`).join('').trimEnd()
}

function findFirstVisibleLine(lines: readonly LineRange[], y: number, overscan: number): number {
    let low = 0
    let high = lines.length - 1
    while (low < high) {
        const mid = Math.floor((low + high) / 2)
        if (lines[mid].top + lines[mid].height <= y) low = mid + 1
        else high = mid
    }
    return Math.max(0, low - overscan)
}

function findLastVisibleLine(lines: readonly LineRange[], y: number, overscan: number): number {
    let low = 0
    let high = lines.length
    while (low < high) {
        const mid = Math.floor((low + high) / 2)
        if (lines[mid]?.top <= y) low = mid + 1
        else high = mid
    }
    return Math.min(lines.length, low + overscan)
}

function sameStyle(a?: TextStyle, b?: TextStyle): boolean {
    return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {})
}

function sameSource(a?: TextSegment['source'], b?: TextSegment['source']): boolean {
    return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {})
}

function normalizeResourceRef(ref: string): string {
    return decodeURI(ref)
        .replace(/[?#].*$/, '')
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .toLowerCase()
}
