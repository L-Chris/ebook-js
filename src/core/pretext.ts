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
import type { DocumentNode, TextBlock, TextBlockType, TextSegment, TextStyle } from './types'
import { isTextNode } from './document'

export type { TextBlock, TextBlockType, TextSegment, TextStyle } from './types'

export interface PreparedTextBlock {
    prepared: PreparedRichInline
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

export interface LayoutOptions {
    inlineSize: number
    lineHeight?: number
    blockStart?: number
    blockGap?: number
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
): TextSegment[] {
    return extractDocumentBlocks(nodes, baseStyle).flatMap(block => block.segments)
}

export function extractDocumentBlocks(
    nodes: readonly DocumentNode[],
    baseStyle: TextStyle = {},
): TextBlock[] {
    const blocks: TextBlock[] = []
    let nextId = 0

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

    const walkBlock = (node: DocumentNode, inherited: TextStyle) => {
        if (isTextNode(node)) {
            if (node.text.trim()) {
                pushBlock('paragraph', node, [{ text: node.text, style: inherited, source: { nodeType: 'text' } }])
            }
            return
        }

        const type = node.type.toLowerCase()
        if (type === 'script' || type === 'style' || type === 'head') return

        if (/^h[1-6]$/.test(type)) {
            const depth = Number(type[1])
            pushBlock(depth === 1 ? 'chapter' : 'heading', node, collectInlineSegments(node, inherited), depth)
            return
        }

        if (type === 'p') {
            pushBlock('paragraph', node, collectInlineSegments(node, inherited))
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
        .filter(block => block.segments.some(segment => segment.text.trim()))
        .map(block => {
        const itemSegmentIndexes = block.segments.map(() => nextSegmentIndex++)
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
        walkRichInlineLineRanges(block.prepared, inlineSize, (range) => {
            const materialized = materializeRichInlineLineRange(block.prepared, range)
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
    for (const declaration of style.split(';')) {
        const [rawName, rawValue] = declaration.split(':')
        if (!rawName || !rawValue) continue
        const name = rawName.trim().toLowerCase()
        const value = rawValue.trim()
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

function parseCSSPixels(value: string): number | undefined {
    const match = value.match(/^([\d.]+)(px|em|rem)?$/)
    if (!match) return undefined
    const amount = Number(match[1])
    if (!Number.isFinite(amount)) return undefined
    return match[2] === 'em' || match[2] === 'rem' ? amount * DEFAULT_STYLE.fontSize : amount
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
