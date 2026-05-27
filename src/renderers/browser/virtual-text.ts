/**
 * Virtual text renderer backed by the Pretext adapter.
 *
 * This renderer keeps the DOM small by rendering only visible line ranges.
 */

import type { BlockWindowEvent, Book, LinkEvent, LoadEvent, RelocateEvent, ResolvedNavigation, Section, TOCItem } from '../../core/types'
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
    type TextImage,
    type TextTable,
    type TextStyle,
} from '../../core/pretext'

interface RendererEventMap {
    load: LoadEvent
    relocate: RelocateEvent
    link: LinkEvent
    'block-window': BlockWindowEvent
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

interface TOCPosition {
    index: number
    sourceTop: number
    order: number
    item: TOCItem
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
    private tocPositions: TOCPosition[] = []
    private pendingTOCItem: TOCItem | null = null
    private suppressNextScrollRelocate = false
    private prefetchPageCount = 0

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
            if (this.suppressNextScrollRelocate) {
                this.suppressNextScrollRelocate = false
                return
            }
            this.emitRelocate('scroll')
            this.emitBlockWindow('scroll')
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
            this.emitBlockWindow('resize')
        }, RESIZE_DEBOUNCE_MS))
        this.resizeObserver.observe(this.container)
    }

    async open(book: Book): Promise<void> {
        this.book = book
        this.sections = book.sections
        this.progress = new SectionProgress(this.sections)
        this.tocPositions = []
        this.prefetchPageCount = getTranslationPrefetchPageCount(book)
    }

    async goTo(target: number | string): Promise<void> {
        if (typeof target === 'number') {
            this.pendingTOCItem = null
            await this.loadSection(target)
            return
        }

        const resolved = this.book?.resolveHref?.(target) ?? this.resolveHrefFallback(target)
        if (resolved) {
            this.pendingTOCItem = this.findTOCItem(target)
            await this.loadSection(resolved.index, resolved.anchor)
        } else {
            this.pendingTOCItem = null
        }
    }

    async next(): Promise<void> {
        if (this.layoutMode === 'paginated') {
            const nextPage = this.findReadablePage(this.pageIndex + 1, 1)
            if (nextPage != null) {
                this.pageIndex = nextPage
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
            const previousPage = this.findReadablePage(this.pageIndex - 1, -1)
            if (previousPage != null) {
                this.pageIndex = previousPage
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
            this.pageIndex = this.findReadablePage(this.pageIndex, 0) ?? this.pageIndex
            this.applyPageScroll('fraction')
            return
        }
        const maxScroll = Math.max(0, this.scroller.scrollHeight - this.scroller.clientHeight)
        this.suppressNextScrollRelocate = true
        this.scroller.scrollTop = maxScroll * sectionFraction
        this.renderVisibleLines()
        this.emitRelocate('fraction')
        this.emitBlockWindow('fraction')
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
        this.emitBlockWindow('layout')
    }

    setSpread(maxColumns: number): void {
        const fraction = this.getSectionFraction()
        this.maxColumnCount = Math.max(1, maxColumns)
        this.relayout()
        this.restoreSectionFraction(fraction)
        this.emitRelocate('spread')
        this.emitBlockWindow('spread')
    }

    getLocation(): RelocateEvent | null {
        return this.lastLocation
    }

    getSectionFractions(): number[] {
        return this.progress?.getFractions() ?? []
    }

    async refresh(): Promise<void> {
        if (this.currentIndex < 0) return
        const fraction = this.getSectionFraction()
        await this.loadSection(this.currentIndex, undefined, this.scrollTopForFraction(fraction))
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

        const anchorScrollTop = this.getAnchorScrollTop(anchor)
        const targetScrollTop = anchorScrollTop ?? restoreScrollTop
        if (this.layoutMode === 'paginated') {
            this.pageIndex = Math.max(0, Math.floor(targetScrollTop / Math.max(1, this.columnLayout.pageHeight)))
            this.pageIndex = Math.min(this.pageIndex, this.columnLayout.pageCount - 1)
            this.pageIndex = this.findReadablePage(this.pageIndex, 0) ?? this.pageIndex
            this.suppressNextScrollRelocate = true
            this.scroller.scrollTop = this.pageIndex * this.columnLayout.pageHeight
        } else {
            this.suppressNextScrollRelocate = true
            this.scroller.scrollTop = targetScrollTop
        }

        this.renderVisibleLines()
        this.emit('load', { doc: { lines: this.lines, segments }, index })
        this.emitBlockWindow('load')
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
        const maxColumnWidth = parseCSSPixels(this.styles.maxColumnWidth ?? this.styles.maxInlineSize, 720)
        const availableWidth = Math.max(1, this.scroller.clientWidth - margin * 2)
        const columns = this.getColumnCount(availableWidth, minColumnWidth, gap)
        const rawWidth = columns > 1
            ? (availableWidth - gap * (columns - 1)) / columns
            : availableWidth
        const inlineSize = Math.max(minColumnWidth, Math.min(maxColumnWidth, rawWidth))
        const pageHeight = Math.max(1, this.scroller.clientHeight)
        const pagePaddingBlock = this.getPagePaddingBlock(pageHeight, margin)
        const columnHeight = this.layoutMode === 'paginated'
            ? Math.max(this.getLineHeightPixels(), pageHeight - pagePaddingBlock * 2)
            : Number.POSITIVE_INFINITY
        this.lines = layoutText(this.prepared, {
            inlineSize,
            lineHeight: this.getLineHeightPixels(),
            blockGap: this.getLineHeightPixels() * 0.5,
            maxBlockHeight: this.layoutMode === 'paginated' ? columnHeight : undefined,
        })
        const contentHeight = this.lines[this.lines.length - 1]?.top + this.lines[this.lines.length - 1]?.height || 0
        const pageCount = this.layoutMode === 'paginated'
            ? getReadablePageCount(this.lines, columnHeight, columns)
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
        this.pageIndex = this.findReadablePage(Math.min(this.pageIndex, pageCount - 1), 0) ?? 0
        const contentWidth = inlineSize * columns + gap * (columns - 1)
        const contentLeft = Math.max(0, (this.scroller.clientWidth - contentWidth) / 2)
        this.spacer.style.height = `${totalHeight}px`
        this.content.style.marginInline = '0'
        this.content.style.maxWidth = ''
        this.content.style.left = `${contentLeft}px`
        this.content.style.right = 'auto'
        this.content.style.width = `${contentWidth}px`
        this.rebuildTOCPositions()
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
            if (line.kind === 'image' && line.image) {
                this.content.appendChild(this.createImageLine(line, position))
                continue
            }
            if (line.kind === 'table' && line.table) {
                this.content.appendChild(this.createTableLine(line, position))
                continue
            }
            if (line.kind === 'separator') {
                this.content.appendChild(this.createSeparatorLine(line, position))
                continue
            }
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
            const block = line.block ?? this.prepared?.blocks.find(item => item.itemSegmentIndexes.includes(line.start?.segmentIndex ?? -1))?.block
            if (block) {
                lineEl.dataset.blockId = block.id
                lineEl.dataset.blockType = block.type
            }

            for (const fragment of line.segments) {
                const span = document.createElement('span')
                if (fragment.gapBefore > 0) span.style.marginLeft = `${fragment.gapBefore}px`
                if (isInlineImageFragment(fragment)) {
                    const img = document.createElement('img')
                    img.src = fragment.source.attrs.src ?? ''
                    img.alt = fragment.source.attrs.alt ?? ''
                    img.style.cssText = `
                        display: inline-block;
                        width: ${parseCSSPixels(fragment.source.attrs['data-rebook-inline-image-width'], 11)}px;
                        height: ${parseCSSPixels(fragment.source.attrs['data-rebook-inline-image-height'], 11)}px;
                        max-width: 1em;
                        max-height: 1em;
                        vertical-align: super;
                        object-fit: contain;
                    `
                    span.appendChild(img)
                } else {
                    span.textContent = fragment.text
                    applyTextStyle(span, { ...this.getBaseTextStyle(), ...fragment.style })
                }
                lineEl.appendChild(span)
            }

            this.content.appendChild(lineEl)
        }
    }

    private createImageLine(line: LineRange, position: { top: number; left: number }): HTMLElement {
        const layout = this.columnLayout
        const image = line.image!
        const wrapper = document.createElement('figure')
        wrapper.style.cssText = `
            position: absolute;
            top: ${position.top}px;
            left: ${position.left}px;
            width: ${layout.columnWidth}px;
            height: ${line.height}px;
            margin: 0;
            display: flex;
            align-items: center;
            justify-content: ${getImageJustifyContent(image)};
            overflow: hidden;
        `
        if (line.block) {
            wrapper.dataset.blockId = line.block.id
            wrapper.dataset.blockType = line.block.type
        }
        if (image.isCover) wrapper.dataset.cover = 'true'

        const img = document.createElement('img')
        img.src = image.src
        img.alt = image.alt ?? ''
        if (image.title) img.title = image.title
        img.style.cssText = `
            display: block;
            width: auto;
            height: auto;
            max-width: ${Math.min(line.width, layout.columnWidth)}px;
            max-height: ${line.height}px;
            object-fit: ${image.style?.objectFit ?? 'contain'};
        `
        wrapper.appendChild(img)
        return wrapper
    }

    private createSeparatorLine(line: LineRange, position: { top: number; left: number }): HTMLElement {
        const layout = this.columnLayout
        const wrapper = document.createElement('div')
        wrapper.style.cssText = `
            position: absolute;
            top: ${position.top}px;
            left: ${position.left}px;
            width: ${layout.columnWidth}px;
            height: ${line.height}px;
            display: flex;
            align-items: center;
        `
        if (line.block) {
            wrapper.dataset.blockId = line.block.id
            wrapper.dataset.blockType = line.block.type
        }

        const rule = document.createElement('div')
        rule.style.cssText = `
            width: 100%;
            border-top: 1px solid currentColor;
            opacity: 0.35;
        `
        wrapper.appendChild(rule)
        return wrapper
    }

    private createTableLine(line: LineRange, position: { top: number; left: number }): HTMLElement {
        const layout = this.columnLayout
        const table = line.table!
        const wrapper = document.createElement('div')
        wrapper.style.cssText = `
            position: absolute;
            top: ${position.top}px;
            left: ${position.left}px;
            width: ${layout.columnWidth}px;
            height: ${line.height}px;
            overflow: hidden;
            font-family: ${this.styles.fontFamily ?? 'system-ui, -apple-system, Georgia, serif'};
            font-size: ${parseCSSPixels(this.styles.fontSize, 16)}px;
            line-height: ${this.getLineHeightPixels()}px;
            color: ${this.styles.color ?? 'inherit'};
        `
        wrapper.dataset.blockId = line.block?.id ?? `table-row-${table.rowIndex}`
        wrapper.dataset.blockType = 'table'
        wrapper.setAttribute('role', 'row')

        const row = document.createElement('div')
        row.style.cssText = `
            display: grid;
            grid-template-columns: ${getTableGridTemplate(table)};
            width: 100%;
            min-height: 100%;
            border-top: ${table.rowIndex === 0 ? '1px solid #8a8a8a' : '0'};
            border-left: 1px solid #8a8a8a;
            background: #fff;
        `

        for (const cell of table.rows[0]?.cells ?? []) {
            const cellEl = document.createElement(cell.header ? 'strong' : 'span')
            cellEl.textContent = cell.text
            cellEl.style.cssText = `
                display: block;
                min-width: 0;
                padding: 4px 6px;
                border-right: 1px solid #8a8a8a;
                border-bottom: 1px solid #8a8a8a;
                white-space: normal;
                overflow-wrap: anywhere;
                text-align: ${getTableTextAlign(cell.align)};
                ${cell.colspan ? `grid-column: span ${cell.colspan};` : ''}
            `
            row.appendChild(cellEl)
        }

        wrapper.appendChild(row)
        return wrapper
    }

    private emitRelocate(reason: string): void {
        if (this.currentIndex < 0) return
        const maxScroll = Math.max(0, this.scroller.scrollHeight - this.scroller.clientHeight)
        const fraction = this.layoutMode === 'paginated'
            ? this.columnLayout.pageCount > 1 ? this.pageIndex / (this.columnLayout.pageCount - 1) : 0
            : maxScroll > 0 ? this.scroller.scrollTop / maxScroll : 0
        const range = getVisibleLines(
            this.lines,
            this.getSourceScrollTop(),
            this.getSourceViewportHeight(),
            0,
        )
        const event: RelocateEvent = {
            range,
            index: this.currentIndex,
            fraction,
            totalFraction: this.progress?.getProgress(this.currentIndex, fraction).fraction,
            tocItem: this.pendingTOCItem ?? this.getCurrentTOCItem(),
            reason,
        }
        this.lastLocation = event
        this.emit('relocate', event)
        this.pendingTOCItem = null
    }

    private emitBlockWindow(reason: string): void {
        if (this.currentIndex < 0 || this.prefetchPageCount <= 0) return
        const blockIds = this.getPrefetchBlockIds()
        if (!blockIds.length) return
        this.emit('block-window', {
            index: this.currentIndex,
            blockIds,
            pageIndex: this.layoutMode === 'paginated' ? this.pageIndex : undefined,
            pageCount: this.prefetchPageCount,
            reason,
        })
    }

    private getPrefetchBlockIds(): string[] {
        const ids: string[] = []
        const seen = new Set<string>()
        const sourceStart = this.getSourceScrollTop()
        const sourceEnd = sourceStart + this.getSourceViewportHeight() + this.getSourceHeightForPages(this.prefetchPageCount)

        for (const line of this.lines) {
            if (line.top + line.height < sourceStart) continue
            if (line.top > sourceEnd) break
            const blockId = line.block?.id
            if (!blockId || seen.has(blockId)) continue
            seen.add(blockId)
            ids.push(blockId)
        }

        return ids
    }

    private getSourceHeightForPages(pageCount: number): number {
        const safePageCount = Math.max(1, pageCount)
        return this.layoutMode === 'paginated'
            ? this.columnLayout.columnHeight * this.columnLayout.columns * safePageCount
            : this.scroller.clientHeight * safePageCount
    }

    private resolveHrefFallback(href: string): ResolvedNavigation | null {
        const [path] = href.split('#')
        const index = this.sections.findIndex(section =>
            typeof section.id === 'string' && (section.id === path || section.id.endsWith(path)))
        return index < 0 ? null : { index }
    }

    private rebuildTOCPositions(): void {
        this.tocPositions = []
        if (!this.book?.toc) return

        for (const [order, item] of flattenTOC(this.book.toc).entries()) {
            const resolved = this.book.resolveHref?.(item.href)
            const index = resolved?.index ?? this.getTOCSectionIndex(item.href)
            if (index == null || index < 0) continue
            let sourceTop = 0
            if (index === this.currentIndex) {
                if (resolved?.anchor == null && !this.getTOCFragment(item.href)) {
                    sourceTop = 0
                } else {
                    const anchorTop = this.getAnchorSourceTop(resolved?.anchor)
                    if (anchorTop == null) continue
                    sourceTop = anchorTop
                }
            }
            this.tocPositions.push({ index, sourceTop, order, item })
        }
        this.tocPositions.sort(compareTOCPosition)
    }

    private getTOCSectionIndex(href: string): number | null {
        const result = this.book?.splitTOCHref?.(href)
        if (!result) return null
        const [id] = result
        const index = this.sections.findIndex(section => section.id === id)
        return index >= 0 ? index : null
    }

    private getTOCFragment(href: string): string | number | null {
        const result = this.book?.splitTOCHref?.(href)
        if (result) return result[1]
        return href.includes('#') ? href.split('#')[1] : null
    }

    private findTOCItem(href: string): TOCItem | null {
        if (!this.book?.toc) return null
        return flattenTOC(this.book.toc).find(item => item.href === href) ?? null
    }

    private getCurrentTOCItem(): TOCItem | null {
        if (!this.tocPositions.length || this.currentIndex < 0) return null
        const sourceStart = this.getSourceScrollTop()
        const sourceEnd = sourceStart + this.getSourceViewportHeight()
        if (this.layoutMode === 'paginated') {
            const visible = this.tocPositions.find(position =>
                position.index === this.currentIndex
                && position.sourceTop > sourceStart + 1
                && position.sourceTop < sourceEnd - 1)
            if (visible) return visible.item
        }

        const sourceTop = sourceStart + this.getLineHeightPixels() * 0.5
        let active: TOCPosition | null = null

        for (const position of this.tocPositions) {
            if (position.index > this.currentIndex) break
            if (position.index === this.currentIndex && position.sourceTop > sourceTop) break
            active = position
        }

        return active?.item ?? null
    }

    private getAnchorScrollTop(anchor?: ResolvedNavigation['anchor']): number | null {
        if (anchor == null) return null
        if (typeof anchor === 'number') return anchor

        const sourceTop = this.getAnchorSourceTop(anchor)
        return sourceTop == null ? null : this.getScrollTopForSourceTop(sourceTop)
    }

    private getAnchorSourceTop(anchor?: ResolvedNavigation['anchor']): number | null {
        if (anchor == null) return null
        if (typeof anchor === 'number') return anchor

        const value = this.resolveAnchorValue(anchor)
        if (typeof value === 'number') return value

        const anchorIds = getAnchorIds(value)
        if (!anchorIds.length) return null

        const line = this.lines.find(item => {
            const block = item.block
            if (!block) return false
            return anchorIds.some(id =>
                block.id === id
                || block.attrs?.id === id
                || block.attrs?.name === id)
        })

        return line?.top ?? this.getFileposSourceTop(anchorIds)
    }

    private getFileposSourceTop(anchorIds: readonly string[]): number | null {
        const id = anchorIds.find(value => /^filepos\d+$/.test(value))
        if (!id || this.currentIndex < 0) return null

        const filepos = Number(id.slice('filepos'.length))
        const sectionStart = this.sections
            .slice(0, this.currentIndex)
            .reduce((sum, section) => sum + Math.max(0, section.size ?? 0), 0)
        const sectionSize = Math.max(1, this.sections[this.currentIndex]?.size ?? 1)
        const fraction = Math.max(0, Math.min(1, (filepos - sectionStart) / sectionSize))
        return fraction * this.getContentHeight()
    }

    private getContentHeight(): number {
        const last = this.lines[this.lines.length - 1]
        return last ? last.top + last.height : 0
    }

    private resolveAnchorValue(anchor: ResolvedNavigation['anchor']): unknown {
        if (typeof anchor !== 'function') return anchor
        try {
            return anchor({
                getElementById: (id: string) => id,
                querySelector: (selector: string) => selector,
            })
        } catch {
            return null
        }
    }

    private getScrollTopForSourceTop(sourceTop: number): number {
        const safeSourceTop = Math.max(0, sourceTop)
        if (this.layoutMode === 'paginated') {
            const pageSourceHeight = Math.max(1, this.columnLayout.columnHeight * this.columnLayout.columns)
            const page = Math.floor(safeSourceTop / pageSourceHeight)
            return page * this.columnLayout.pageHeight
        }
        return safeSourceTop + this.columnLayout.pagePaddingBlock
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
            this.pageIndex = this.findReadablePage(this.pageIndex, 0) ?? this.pageIndex
            this.pageIndex = Math.min(Math.max(0, this.pageIndex), this.columnLayout.pageCount - 1)
            this.suppressNextScrollRelocate = true
            this.scroller.scrollTop = this.pageIndex * this.columnLayout.pageHeight
        }
        this.renderVisibleLines()
        this.emitRelocate(reason)
        this.emitBlockWindow(reason)
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
            this.pageIndex = this.findReadablePage(this.pageIndex, 0) ?? this.pageIndex
            this.suppressNextScrollRelocate = true
            this.scroller.scrollTop = this.pageIndex * this.columnLayout.pageHeight
        } else {
            this.suppressNextScrollRelocate = true
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

    private findReadablePage(pageIndex: number, direction: -1 | 0 | 1): number | null {
        if (this.layoutMode !== 'paginated') return 0
        const pageCount = this.columnLayout.pageCount
        if (pageCount <= 0) return null
        if (direction > 0 && pageIndex >= pageCount) return null
        if (direction < 0 && pageIndex < 0) return null
        const start = Math.min(Math.max(0, pageIndex), pageCount - 1)
        if (this.hasReadableLinesOnPage(start)) return start

        if (direction > 0) {
            for (let page = start + 1; page < pageCount; page++) {
                if (this.hasReadableLinesOnPage(page)) return page
            }
            return null
        }

        if (direction < 0) {
            for (let page = start - 1; page >= 0; page--) {
                if (this.hasReadableLinesOnPage(page)) return page
            }
            return null
        }

        for (let distance = 1; distance < pageCount; distance++) {
            const previous = start - distance
            const next = start + distance
            if (previous >= 0 && this.hasReadableLinesOnPage(previous)) return previous
            if (next < pageCount && this.hasReadableLinesOnPage(next)) return next
        }
        return null
    }

    private hasReadableLinesOnPage(pageIndex: number): boolean {
        const { columns, columnHeight } = this.columnLayout
        return this.lines.some(line => getLinePageIndex(line, columnHeight, columns) === pageIndex)
    }

    private emit<K extends keyof RendererEventMap>(event: K, data: RendererEventMap[K]): void {
        this.listeners.get(event)?.forEach(fn => fn(data))
    }
}

export const createVirtualTextRenderer = (config: RendererConfig): Renderer => {
    return new VirtualTextRenderer(config)
}

function flattenTOC(items: readonly TOCItem[]): TOCItem[] {
    return items.flatMap(item =>
        item.subitems?.length
            ? [item, ...flattenTOC(item.subitems)]
            : [item]
    )
}

function getTranslationPrefetchPageCount(book: Book): number {
    const value = (book as { translationPrefetchPageCount?: unknown }).translationPrefetchPageCount
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.floor(value))
        : 0
}

function compareTOCPosition(a: TOCPosition, b: TOCPosition): number {
    return a.index - b.index
        || a.sourceTop - b.sourceTop
        || a.order - b.order
}

function getAnchorIds(value: unknown): string[] {
    if (typeof value !== 'string') {
        const id = getElementLikeId(value)
        return id ? [id] : []
    }

    const trimmed = value.trim()
    if (!trimmed) return []

    const attrMatch = trimmed.match(/^\[(?:id|name)=["']([^"']+)["']\]$/)
    if (attrMatch) return [unescapeCSSIdentifier(attrMatch[1])]

    if (trimmed.startsWith('#')) return [unescapeCSSIdentifier(trimmed.slice(1))]
    if (/^[\w:-]+$/.test(trimmed)) return [trimmed]

    return []
}

function getElementLikeId(value: unknown): string | null {
    if (!value || typeof value !== 'object') return null
    const maybeElement = value as { id?: unknown; getAttribute?: (name: string) => string | null }
    if (typeof maybeElement.id === 'string' && maybeElement.id) return maybeElement.id
    return maybeElement.getAttribute?.('id') ?? maybeElement.getAttribute?.('name') ?? null
}

function unescapeCSSIdentifier(value: string): string {
    return value.replace(/\\(.)/g, '$1')
}

function applyTextStyle(element: HTMLElement, style: TextStyle): void {
    if (style.fontFamily) element.style.fontFamily = style.fontFamily
    if (style.fontSize) element.style.fontSize = `${style.fontSize}px`
    if (style.fontWeight) element.style.fontWeight = style.fontWeight
    if (style.fontStyle) element.style.fontStyle = style.fontStyle
    if (style.fontVariant) element.style.fontVariant = style.fontVariant
    if (style.color) element.style.color = style.color
    if (style.textDecoration) element.style.textDecoration = style.textDecoration
    if (style.verticalAlign) element.style.verticalAlign = style.verticalAlign
    if (style.letterSpacing) element.style.letterSpacing = `${style.letterSpacing}px`
}

function isInlineImageFragment(fragment: { source?: { nodeType?: string; attrs?: Readonly<Record<string, string>> } }): fragment is { source: { nodeType: 'img'; attrs: Readonly<Record<string, string>> } } {
    return fragment.source?.nodeType === 'img' && Boolean(fragment.source.attrs?.src)
}

function getImageJustifyContent(image: TextImage): string {
    if (image.style?.align === 'start') return 'flex-start'
    if (image.style?.align === 'end') return 'flex-end'
    return 'center'
}

function getTableGridTemplate(table: TextTable): string {
    const weights = table.columnWeights?.length === table.columnCount
        ? table.columnWeights
        : Array.from({ length: table.columnCount }, () => 1)
    return weights.map(weight => `minmax(0, ${Math.max(0.1, weight)}fr)`).join(' ')
}

function getTableTextAlign(align: 'start' | 'center' | 'end' | undefined): string {
    if (align === 'center') return 'center'
    if (align === 'end') return 'right'
    return 'left'
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

function getReadablePageCount(lines: readonly LineRange[], columnHeight: number, columns: number): number {
    let lastReadablePage = 0
    for (const line of lines) {
        if (line.height <= 0) continue
        lastReadablePage = Math.max(lastReadablePage, getLinePageIndex(line, columnHeight, columns))
    }
    return Math.max(1, lastReadablePage + 1)
}

function getLinePageIndex(line: LineRange, columnHeight: number, columns: number): number {
    const safeColumnHeight = Math.max(1, columnHeight)
    const safeColumns = Math.max(1, columns)
    const sourceColumn = Math.floor(Math.max(0, line.top) / safeColumnHeight)
    return Math.floor(sourceColumn / safeColumns)
}

function getPagePaddingBlock(mode: LayoutMode, pageHeight: number, margin: number): number {
    const preferred = mode === 'paginated'
        ? Math.max(20, margin)
        : Math.max(12, margin * 0.5)
    return Math.min(preferred, Math.max(12, pageHeight * 0.14))
}
