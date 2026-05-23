/**
 * Virtual text renderer backed by the Pretext adapter.
 *
 * This renderer keeps the DOM small by rendering only visible line ranges.
 */

import type { Book, LinkEvent, LoadEvent, RelocateEvent, ResolvedNavigation, Section } from '../../core/types'
import type { LayoutMode, Renderer, RendererConfig, RendererStyles } from '../../core/renderer'
import { SectionProgress } from '../../utils/progress'
import {
    getVisibleLines,
    layout as layoutText,
    prepare,
    prepareBlocks,
    type LineRange,
    type PreparedText,
    type TextBlock,
    type TextStyle,
} from '../../core/pretext'

interface RendererEventMap {
    load: LoadEvent
    relocate: RelocateEvent
    link: LinkEvent
}

type Listener<T> = (event: T) => void

const RESIZE_DEBOUNCE_MS = 100
const DEFAULT_MARGIN = 32
const DEFAULT_GAP = 48

interface ColumnLayout {
    margin: number
    gap: number
    columnWidth: number
    columns: number
    pageHeight: number
    columnHeight: number
    pagePaddingBlock: number
    totalHeight: number
    pageCount: number
}

const debounce = <T extends (...args: unknown[]) => void>(fn: T, wait: number): T => {
    let timeout: ReturnType<typeof setTimeout>
    return ((...args: unknown[]) => {
        clearTimeout(timeout)
        timeout = setTimeout(() => fn(...args), wait)
    }) as T
}

export class VirtualTextRenderer implements Renderer {
    private container: HTMLElement
    private scroller: HTMLElement
    private spacer: HTMLElement
    private content: HTMLElement
    private book: Book | null = null
    private sections: readonly Section[] = []
    private currentIndex = -1
    private prepared: PreparedText | null = null
    private lines: LineRange[] = []
    private styles: RendererStyles
    private maxColumnCount: number
    private columnLayout: ColumnLayout = {
        margin: DEFAULT_MARGIN,
        gap: DEFAULT_GAP,
        columnWidth: 0,
        columns: 1,
        pageHeight: 0,
        columnHeight: 0,
        pagePaddingBlock: 0,
        totalHeight: 0,
        pageCount: 1,
    }
    private layoutMode: LayoutMode
    private pageIndex = 0
    private progress: SectionProgress | null = null
    private lastLocation: RelocateEvent | null = null
    private listeners = new Map<string, Set<Listener<unknown>>>()
    private resizeObserver: ResizeObserver
    private activeLoadId = 0

    constructor(config: RendererConfig) {
        this.container = config.container
        this.styles = config.styles ?? {}
        this.maxColumnCount = config.maxColumnCount ?? 2
        this.layoutMode = config.layout ?? 'paginated'

        this.scroller = document.createElement('div')
        this.scroller.style.cssText = `
            width: 100%;
            height: 100%;
            overflow: auto;
            position: relative;
            color: ${this.styles.color ?? 'inherit'};
            background: ${this.styles.background ?? 'transparent'};
        `
        this.applyOverflowMode()

        this.spacer = document.createElement('div')
        this.spacer.style.cssText = 'position: relative; width: 100%; min-height: 100%;'

        this.content = document.createElement('div')
        this.content.style.cssText = 'position: absolute; top: 0; left: 0; right: 0;'

        this.spacer.appendChild(this.content)
        this.scroller.appendChild(this.spacer)
        this.container.appendChild(this.scroller)

        this.scroller.addEventListener('scroll', () => {
            this.renderVisibleLines()
            this.emitRelocate('scroll')
        }, { passive: true })
        this.scroller.addEventListener('wheel', (event) => {
            if (this.layoutMode !== 'paginated') return
            event.preventDefault()
            if (Math.abs(event.deltaY) < 2) return
            void (event.deltaY > 0 ? this.next() : this.prev())
        }, { passive: false })

        this.resizeObserver = new ResizeObserver(debounce(() => {
            const fraction = this.getSectionFraction()
            this.relayout()
            this.restoreSectionFraction(fraction)
            this.emitRelocate('resize')
        }, RESIZE_DEBOUNCE_MS))
        this.resizeObserver.observe(this.container)
    }

    async open(book: Book): Promise<void> {
        this.book = book
        this.sections = book.sections
        this.progress = new SectionProgress(this.sections)
    }

    async goTo(target: number | string): Promise<void> {
        if (typeof target === 'number') {
            await this.loadSection(target)
            return
        }

        const resolved = this.book?.resolveHref?.(target) ?? this.resolveHrefFallback(target)
        if (resolved) await this.loadSection(resolved.index, resolved.anchor)
    }

    async next(): Promise<void> {
        if (this.layoutMode === 'paginated') {
            if (this.pageIndex < this.columnLayout.pageCount - 1) {
                this.pageIndex++
                this.applyPageScroll('page')
                return
            }
            if (this.currentIndex < this.sections.length - 1) {
                await this.loadSection(this.currentIndex + 1)
            }
            return
        }

        const maxScroll = this.scroller.scrollHeight - this.scroller.clientHeight
        if (this.scroller.scrollTop < maxScroll - 1) {
            this.scroller.scrollTop = Math.min(maxScroll, this.scroller.scrollTop + this.scroller.clientHeight)
            return
        }
        if (this.currentIndex < this.sections.length - 1) {
            await this.loadSection(this.currentIndex + 1)
        }
    }

    async prev(): Promise<void> {
        if (this.layoutMode === 'paginated') {
            if (this.pageIndex > 0) {
                this.pageIndex--
                this.applyPageScroll('page')
                return
            }
            if (this.currentIndex > 0) {
                await this.loadSection(this.currentIndex - 1)
                this.pageIndex = this.columnLayout.pageCount - 1
                this.applyPageScroll('page')
            }
            return
        }

        if (this.scroller.scrollTop > 1) {
            this.scroller.scrollTop = Math.max(0, this.scroller.scrollTop - this.scroller.clientHeight)
            return
        }
        if (this.currentIndex > 0) {
            await this.loadSection(this.currentIndex - 1)
            this.scroller.scrollTop = this.scroller.scrollHeight
        }
    }

    async goToFraction(fraction: number): Promise<void> {
        if (!this.progress) return
        const [index, sectionFraction] = this.progress.getSection(Math.max(0, Math.min(1, fraction)))
        await this.loadSection(index)
        if (this.layoutMode === 'paginated') {
            this.pageIndex = Math.min(
                this.columnLayout.pageCount - 1,
                Math.floor(sectionFraction * this.columnLayout.pageCount),
            )
            this.applyPageScroll('fraction')
            return
        }
        const maxScroll = Math.max(0, this.scroller.scrollHeight - this.scroller.clientHeight)
        this.scroller.scrollTop = maxScroll * sectionFraction
        this.renderVisibleLines()
        this.emitRelocate('fraction')
    }

    setStyles(styles: RendererStyles): void {
        const fraction = this.getSectionFraction()
        this.styles = { ...this.styles, ...styles }
        this.scroller.style.color = this.styles.color ?? 'inherit'
        this.scroller.style.background = this.styles.background ?? 'transparent'
        if (this.currentIndex >= 0) {
            void this.loadSection(this.currentIndex, undefined, this.scrollTopForFraction(fraction))
        }
    }

    setLayout(mode: LayoutMode): void {
        if (this.layoutMode === mode) return
        const fraction = this.getSectionFraction()
        this.layoutMode = mode
        this.applyOverflowMode()
        this.relayout()
        this.restoreSectionFraction(fraction)
        this.emitRelocate('layout')
    }

    setSpread(maxColumns: number): void {
        const fraction = this.getSectionFraction()
        this.maxColumnCount = Math.max(1, maxColumns)
        this.relayout()
        this.restoreSectionFraction(fraction)
        this.emitRelocate('spread')
    }

    getLocation(): RelocateEvent | null {
        return this.lastLocation
    }

    getSectionFractions(): number[] {
        return this.progress?.getFractions() ?? []
    }

    on<K extends keyof RendererEventMap>(event: K, listener: Listener<RendererEventMap[K]>): void
    on(event: string, listener: Listener<unknown>): void
    on(event: string, listener: Listener<unknown>): void {
        if (!this.listeners.has(event)) this.listeners.set(event, new Set())
        this.listeners.get(event)!.add(listener)
    }

    off<K extends keyof RendererEventMap>(event: K, listener: Listener<RendererEventMap[K]>): void
    off(event: string, listener: Listener<unknown>): void
    off(event: string, listener: Listener<unknown>): void {
        this.listeners.get(event)?.delete(listener)
    }

    destroy(): void {
        this.activeLoadId++
        this.resizeObserver.disconnect()
        this.scroller.remove()
        this.listeners.clear()
        this.book = null
    }

    private async loadSection(
        index: number,
        anchor?: ResolvedNavigation['anchor'],
        restoreScrollTop = 0,
    ): Promise<void> {
        if (index < 0 || index >= this.sections.length) return
        const loadId = ++this.activeLoadId
        const section = this.sections[index]
        const blocks = await this.loadTextBlocks(section)
        if (loadId !== this.activeLoadId) return
        const segments = blocks.flatMap(block => block.segments)

        this.prepared = blocks.length > 0
            ? prepareBlocks(blocks, { baseStyle: this.getBaseTextStyle() })
            : prepare(segments, { baseStyle: this.getBaseTextStyle() })
        this.currentIndex = index
        this.pageIndex = this.layoutMode === 'paginated'
            ? Math.max(0, Math.floor(restoreScrollTop / Math.max(1, this.columnLayout.pageHeight)))
            : 0
        this.relayout()

        if (this.layoutMode === 'paginated') {
            this.pageIndex = typeof anchor === 'number'
                ? Math.max(0, Math.floor(anchor / Math.max(1, this.columnLayout.pageHeight)))
                : Math.min(this.pageIndex, this.columnLayout.pageCount - 1)
            this.scroller.scrollTop = this.pageIndex * this.columnLayout.pageHeight
        } else {
            this.scroller.scrollTop = typeof anchor === 'number'
                ? anchor
                : restoreScrollTop
        }

        this.renderVisibleLines()
        this.emit('load', { doc: { lines: this.lines, segments }, index })
        this.emitRelocate('snap')
    }

    private async loadTextBlocks(section: Section): Promise<TextBlock[]> {
        if (section.getBlocks) return section.getBlocks()
        if (section.getSegments) {
            return [{
                id: `${section.id}-body`,
                type: 'container',
                segments: await section.getSegments(),
            }]
        }
        const text = section.loadText ? await section.loadText() : await section.load()
        return [{
            id: `${section.id}-body`,
            type: 'paragraph',
            segments: [{ text }],
        }]
    }

    private relayout(): void {
        if (!this.prepared) return
        const margin = parseCSSPixels(this.styles.margin, DEFAULT_MARGIN)
        const gap = parseCSSPixels(this.styles.gap, DEFAULT_GAP)
        const minColumnWidth = parseCSSPixels(this.styles.minColumnWidth, 320)
        const maxColumnWidth = parseCSSPixels(this.styles.maxColumnWidth, 720)
        const availableWidth = Math.max(1, this.scroller.clientWidth - margin * 2)
        const columns = this.getColumnCount(availableWidth, minColumnWidth, gap)
        const rawWidth = columns > 1
            ? (availableWidth - gap * (columns - 1)) / columns
            : availableWidth
        const inlineSize = Math.max(minColumnWidth, Math.min(maxColumnWidth, rawWidth))
        this.lines = layoutText(this.prepared, {
            inlineSize,
            lineHeight: this.getLineHeightPixels(),
            blockGap: this.getLineHeightPixels() * 0.5,
        })
        const contentHeight = this.lines[this.lines.length - 1]?.top + this.lines[this.lines.length - 1]?.height || 0
        const pageHeight = Math.max(1, this.scroller.clientHeight)
        const pagePaddingBlock = this.getPagePaddingBlock(pageHeight, margin)
        const columnHeight = this.layoutMode === 'paginated'
            ? Math.max(this.getLineHeightPixels(), pageHeight - pagePaddingBlock * 2)
            : Number.POSITIVE_INFINITY
        const pageCount = this.layoutMode === 'paginated'
            ? Math.max(1, Math.ceil(contentHeight / (columnHeight * columns)))
            : 1
        const totalHeight = columns > 1
            ? pageCount * pageHeight
            : this.layoutMode === 'paginated'
                ? pageCount * pageHeight
                : contentHeight + pagePaddingBlock * 2

        this.columnLayout = {
            margin,
            gap,
            columnWidth: inlineSize,
            columns,
            pageHeight,
            columnHeight,
            pagePaddingBlock,
            totalHeight,
            pageCount,
        }
        this.pageIndex = Math.min(this.pageIndex, pageCount - 1)
        this.spacer.style.height = `${totalHeight}px`
        this.content.style.marginInline = '0'
        this.content.style.maxWidth = ''
        this.content.style.left = `${margin}px`
        this.content.style.right = 'auto'
        this.content.style.width = `${inlineSize * columns + gap * (columns - 1)}px`
        this.renderVisibleLines()
    }

    private renderVisibleLines(): void {
        const layout = this.columnLayout
        const sourceScrollTop = this.getSourceScrollTop()
        const sourceViewportHeight = this.getSourceViewportHeight()
        const window = getVisibleLines(this.lines, sourceScrollTop, sourceViewportHeight, 4)
        this.content.textContent = ''

        for (const line of window.lines) {
            const position = this.getRenderedLinePosition(line)
            const lineEl = document.createElement('div')
            lineEl.style.cssText = `
                position: absolute;
                top: ${position.top}px;
                left: ${position.left}px;
                width: ${layout.columnWidth}px;
                height: ${line.height}px;
                line-height: ${line.height}px;
                white-space: pre;
            `
            const block = this.prepared?.blocks.find(item => item.itemSegmentIndexes.includes(line.start?.segmentIndex ?? -1))?.block
            if (block) {
                lineEl.dataset.blockId = block.id
                lineEl.dataset.blockType = block.type
            }

            for (const fragment of line.segments) {
                const span = document.createElement('span')
                span.textContent = fragment.text
                if (fragment.gapBefore > 0) span.style.marginLeft = `${fragment.gapBefore}px`
                applyTextStyle(span, { ...this.getBaseTextStyle(), ...fragment.style })
                lineEl.appendChild(span)
            }

            this.content.appendChild(lineEl)
        }
    }

    private emitRelocate(reason: string): void {
        if (this.currentIndex < 0) return
        const maxScroll = Math.max(0, this.scroller.scrollHeight - this.scroller.clientHeight)
        const fraction = this.layoutMode === 'paginated'
            ? this.columnLayout.pageCount > 1 ? this.pageIndex / (this.columnLayout.pageCount - 1) : 0
            : maxScroll > 0 ? this.scroller.scrollTop / maxScroll : 0
        const event: RelocateEvent = {
            range: getVisibleLines(
                this.lines,
                this.getSourceScrollTop(),
                this.getSourceViewportHeight(),
                0,
            ),
            index: this.currentIndex,
            fraction,
            totalFraction: this.progress?.getProgress(this.currentIndex, fraction).fraction,
            reason,
        }
        this.lastLocation = event
        this.emit('relocate', event)
    }

    private resolveHrefFallback(href: string): ResolvedNavigation | null {
        const [path] = href.split('#')
        const index = this.sections.findIndex(section =>
            typeof section.id === 'string' && (section.id === path || section.id.endsWith(path)))
        return index < 0 ? null : { index }
    }

    private getBaseTextStyle(): TextStyle {
        return {
            fontFamily: this.styles.fontFamily ?? 'system-ui, -apple-system, "Noto Serif CJK SC", "Noto Serif SC", Georgia, serif',
            fontSize: parseCSSPixels(this.styles.fontSize, 16),
            lineHeight: getLineHeightMultiplier(this.styles.lineHeight, parseCSSPixels(this.styles.fontSize, 16)),
            color: this.styles.color,
        }
    }

    private getColumnCount(availableWidth: number, minColumnWidth: number, gap: number): number {
        return getColumnCount(this.layoutMode, availableWidth, minColumnWidth, gap, this.maxColumnCount)
    }

    private getRenderedLinePosition(line: LineRange): { top: number; left: number } {
        const { columns, pageHeight, columnHeight, columnWidth, gap, pagePaddingBlock } = this.columnLayout
        if (this.layoutMode !== 'paginated') return { top: line.top + pagePaddingBlock, left: 0 }

        const sourceColumn = Math.floor(line.top / columnHeight)
        const row = Math.floor(sourceColumn / columns)
        const column = sourceColumn % columns
        return {
            top: row * pageHeight + pagePaddingBlock + (line.top % columnHeight),
            left: column * (columnWidth + gap),
        }
    }

    private getSourceScrollTop(): number {
        if (this.layoutMode !== 'paginated') {
            return Math.max(0, this.scroller.scrollTop - this.columnLayout.pagePaddingBlock)
        }
        return this.pageIndex * this.columnLayout.columnHeight * this.columnLayout.columns
    }

    private getSourceViewportHeight(): number {
        if (this.layoutMode !== 'paginated') {
            return this.scroller.clientHeight + this.columnLayout.pagePaddingBlock * 2
        }
        return this.columnLayout.columnHeight * this.columnLayout.columns
    }

    private applyPageScroll(reason: string): void {
        if (this.layoutMode === 'paginated') {
            this.pageIndex = Math.min(Math.max(0, this.pageIndex), this.columnLayout.pageCount - 1)
            this.scroller.scrollTop = this.pageIndex * this.columnLayout.pageHeight
        }
        this.renderVisibleLines()
        this.emitRelocate(reason)
    }

    private applyOverflowMode(): void {
        this.scroller.style.overflow = this.layoutMode === 'paginated' ? 'hidden' : 'auto'
    }

    private getPagePaddingBlock(pageHeight: number, margin: number): number {
        return getPagePaddingBlock(this.layoutMode, pageHeight, margin)
    }

    private getSectionFraction(): number {
        if (this.currentIndex < 0) return 0
        if (this.layoutMode === 'paginated') {
            return this.columnLayout.pageCount > 1
                ? this.pageIndex / (this.columnLayout.pageCount - 1)
                : 0
        }
        const maxScroll = Math.max(0, this.scroller.scrollHeight - this.scroller.clientHeight)
        return maxScroll > 0 ? this.scroller.scrollTop / maxScroll : 0
    }

    private restoreSectionFraction(fraction: number): void {
        const safe = Math.max(0, Math.min(1, fraction))
        if (this.layoutMode === 'paginated') {
            this.pageIndex = Math.min(
                this.columnLayout.pageCount - 1,
                Math.round(safe * Math.max(0, this.columnLayout.pageCount - 1)),
            )
            this.scroller.scrollTop = this.pageIndex * this.columnLayout.pageHeight
        } else {
            this.scroller.scrollTop = this.scrollTopForFraction(safe)
        }
        this.renderVisibleLines()
    }

    private scrollTopForFraction(fraction: number): number {
        const safe = Math.max(0, Math.min(1, fraction))
        if (this.layoutMode === 'paginated') {
            const page = Math.round(safe * Math.max(0, this.columnLayout.pageCount - 1))
            return page * this.columnLayout.pageHeight
        }
        const maxScroll = Math.max(0, this.scroller.scrollHeight - this.scroller.clientHeight)
        return maxScroll * safe
    }

    private getLineHeightPixels(): number {
        const fontSize = parseCSSPixels(this.styles.fontSize, 16)
        const lineHeight = this.styles.lineHeight
        if (typeof lineHeight === 'string' && lineHeight.trim().endsWith('px')) {
            return parseCSSPixels(lineHeight, fontSize * 1.6)
        }
        return fontSize * getLineHeightMultiplier(lineHeight, fontSize)
    }

    private emit<K extends keyof RendererEventMap>(event: K, data: RendererEventMap[K]): void {
        this.listeners.get(event)?.forEach(fn => fn(data))
    }
}

export const createVirtualTextRenderer = (config: RendererConfig): Renderer => {
    return new VirtualTextRenderer(config)
}

function applyTextStyle(element: HTMLElement, style: TextStyle): void {
    if (style.fontFamily) element.style.fontFamily = style.fontFamily
    if (style.fontSize) element.style.fontSize = `${style.fontSize}px`
    if (style.fontWeight) element.style.fontWeight = style.fontWeight
    if (style.fontStyle) element.style.fontStyle = style.fontStyle
    if (style.fontVariant) element.style.fontVariant = style.fontVariant
    if (style.color) element.style.color = style.color
    if (style.textDecoration) element.style.textDecoration = style.textDecoration
    if (style.letterSpacing) element.style.letterSpacing = `${style.letterSpacing}px`
}

function parseCSSPixels(value: string | undefined, fallback: number): number {
    if (!value) return fallback
    const match = value.trim().match(/^([\d.]+)(px)?$/)
    if (!match) return fallback
    const parsed = Number(match[1])
    return Number.isFinite(parsed) ? parsed : fallback
}

function getLineHeightMultiplier(value: RendererStyles['lineHeight'], fontSize: number): number {
    if (typeof value === 'number') return value
    if (typeof value === 'string') {
        const trimmed = value.trim()
        if (trimmed.endsWith('px')) return parseCSSPixels(trimmed, fontSize * 1.6) / fontSize
        const parsed = Number(trimmed)
        if (Number.isFinite(parsed)) return parsed
    }
    return 1.6
}

function getColumnCount(
    mode: LayoutMode,
    availableWidth: number,
    minColumnWidth: number,
    gap: number,
    maxColumnCount: number,
): number {
    if (mode !== 'paginated' || maxColumnCount < 2) return 1
    return availableWidth >= minColumnWidth * 2 + gap ? 2 : 1
}

function getPagePaddingBlock(mode: LayoutMode, pageHeight: number, margin: number): number {
    const preferred = mode === 'paginated'
        ? Math.max(20, margin)
        : Math.max(12, margin * 0.5)
    return Math.min(preferred, Math.max(12, pageHeight * 0.14))
}
