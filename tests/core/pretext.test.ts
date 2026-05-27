import { beforeAll, describe, expect, it, vi } from 'vitest'
import { elementNode, textNode } from '../../src/core/document'
import {
    extractDocumentBlocks,
    extractDocumentSegments,
    getVisibleLines,
    layout,
    prepareBlocks,
    prepare,
} from '../../src/core/pretext'

beforeAll(() => {
    vi.stubGlobal('OffscreenCanvas', class {
        getContext() {
            return {
                font: '16px serif',
                measureText(text: string) {
                    const fontSize = Number(this.font.match(/([\d.]+)px/)?.[1] ?? 16)
                    const width = Array.from(text).reduce((sum, char) => {
                        if (char === ' ') return sum + fontSize * 0.32
                        if (/[\u4e00-\u9fff]/.test(char)) return sum + fontSize
                        return sum + fontSize * 0.54
                    }, 0)
                    return { width }
                },
            }
        }
    })
})

describe('Pretext pipeline', () => {
    it('extracts styled text segments from document nodes', () => {
        const segments = extractDocumentSegments([
            elementNode('p', {}, [
                textNode('Hello '),
                elementNode('strong', {}, [textNode('bold')]),
                textNode(' and '),
                elementNode('em', { style: 'color: #900' }, [textNode('italic')]),
            ]),
        ])

        expect(segments.map(segment => segment.text).join('')).toBe('Hello bold and italic')
        expect(segments.find(segment => segment.text === 'bold')?.style?.fontWeight).toBe('700')
        expect(segments.find(segment => segment.text === 'italic')?.style?.fontStyle).toBe('italic')
        expect(segments.find(segment => segment.text === 'italic')?.style?.color).toBe('#900')
    })

    it('extracts AST structural blocks with preset reading styles', () => {
        const blocks = extractDocumentBlocks([
            elementNode('section', {}, [
                elementNode('h1', { id: 'chapter-1' }, [textNode('第一章')]),
                elementNode('p', {}, [textNode('中文段落 '), elementNode('strong', {}, [textNode('bold')])]),
                elementNode('blockquote', {}, [elementNode('p', {}, [textNode('quoted')])]),
            ]),
        ], { fontSize: 18, lineHeight: 1.8 })

        expect(blocks.map(block => block.type)).toEqual(['chapter', 'paragraph', 'blockquote'])
        expect(blocks[0].id).toBe('chapter-1')
        expect(blocks[0].style?.fontWeight).toBe('700')
        expect(blocks[1].segments.map(segment => segment.text).join('')).toBe('中文段落 bold')
        expect(blocks[1].segments.some(segment => segment.style?.fontWeight === '700')).toBe(true)

        const prepared = prepareBlocks(blocks, { baseStyle: { fontSize: 18, lineHeight: 1.8 } })
        expect(prepared.blocks[0].block.type).toBe('chapter')
    })

    it('extracts definition lists as nested list item blocks', () => {
        const blocks = extractDocumentBlocks([
            elementNode('dl', { class: 'toc' }, [
                elementNode('dt', {}, [
                    elementNode('span', { class: 'part' }, [textNode('I. '), elementNode('a', { href: 'pt01.html' }, [textNode('Part One')])]),
                ]),
                elementNode('dd', {}, [
                    elementNode('dl', {}, [
                        elementNode('dt', {}, [
                            elementNode('span', { class: 'chapter' }, [textNode('1. '), elementNode('a', { href: 'ch01.html' }, [textNode('Chapter One')])]),
                        ]),
                        elementNode('dt', {}, [
                            elementNode('span', { class: 'chapter' }, [textNode('2. '), elementNode('a', { href: 'ch02.html' }, [textNode('Chapter Two')])]),
                        ]),
                    ]),
                ]),
            ]),
        ])

        expect(blocks.map(block => block.type)).toEqual(['listItem', 'listItem', 'listItem'])
        expect(blocks.map(block => block.depth)).toEqual([0, 1, 1])
        expect(blocks.map(block => block.segments.map(segment => segment.text).join(''))).toEqual([
            '• I. Part One',
            ' • 1. Chapter One',
            ' • 2. Chapter Two',
        ])
    })

    it('preserves explicit break and separator blocks', () => {
        const blocks = extractDocumentBlocks([
            elementNode('p', {}, [elementNode('br')]),
            elementNode('hr', { id: 'rule' }),
        ], { fontSize: 10, lineHeight: 2 })

        expect(blocks.map(block => block.type)).toEqual(['break', 'separator'])
        expect(blocks[1].id).toBe('rule')

        const lines = layout(prepareBlocks(blocks, { baseStyle: { fontSize: 10, lineHeight: 2 } }), {
            inlineSize: 100,
        })
        expect(lines.map(line => line.kind)).toEqual(['text', 'separator'])
        expect(lines[0].height).toBe(20)
        expect(lines[1].width).toBe(100)
    })

    it('applies superscript and subscript inline styles', () => {
        const blocks = extractDocumentBlocks([
            elementNode('p', {}, [
                textNode('H'),
                elementNode('sub', {}, [textNode('2')]),
                textNode('O'),
                elementNode('sup', {}, [textNode('1')]),
            ]),
        ], { fontSize: 20, lineHeight: 1.5 })

        const sub = blocks[0].segments.find(segment => segment.text === '2')
        const sup = blocks[0].segments.find(segment => segment.text === '1')
        expect(sub?.style?.fontSize).toBe(15)
        expect(sub?.style?.verticalAlign).toBe('sub')
        expect(sup?.style?.fontSize).toBe(15)
        expect(sup?.style?.verticalAlign).toBe('super')
    })

    it('extracts image blocks with sizing and cover metadata', () => {
        const blocks = extractDocumentBlocks([
            elementNode('p', {}, [
                elementNode('img', {
                    src: 'blob:test-cover',
                    'data-rebook-original-src': 'images/cover.jpg',
                    alt: 'Cover',
                    width: '600',
                    height: '900',
                    style: 'max-width: 320px; max-height: 420px; object-fit: contain; text-align: center',
                }),
            ]),
        ], {}, { coverImageSrcs: ['images/cover.jpg'] })

        expect(blocks.map(block => block.type)).toEqual(['image'])
        expect(blocks[0].image?.src).toBe('blob:test-cover')
        expect(blocks[0].image?.originalSrc).toBe('images/cover.jpg')
        expect(blocks[0].image?.isCover).toBe(true)
        expect(blocks[0].image?.style?.maxWidth).toBe(320)
        expect(blocks[0].image?.style?.maxHeight).toBe(420)

        const prepared = prepareBlocks(blocks, { baseStyle: { fontSize: 16, lineHeight: 1.5 } })
        const lines = layout(prepared, { inlineSize: 280, maxBlockHeight: 300 })
        expect(lines[0].kind).toBe('image')
        expect(lines[0].image?.isCover).toBe(true)
        expect(lines[0].height).toBeLessThanOrEqual(300)
    })

    it('extracts images nested inside layout tables', () => {
        const blocks = extractDocumentBlocks([
            elementNode('table', { class: 'borderless' }, [
                elementNode('tr', {}, [
                    elementNode('td', {}, [
                        elementNode('div', { class: 'mediaobject' }, [
                            elementNode('img', {
                                src: 'blob:publisher-logo',
                                'data-rebook-original-src': 'graphics/logo.png',
                                alt: 'Publisher logo',
                                width: '200',
                                height: '80',
                            }),
                        ]),
                    ]),
                ]),
            ]),
        ])

        expect(blocks.map(block => block.type)).toEqual(['image'])
        expect(blocks[0].image?.src).toBe('blob:publisher-logo')
        expect(blocks[0].image?.originalSrc).toBe('graphics/logo.png')
        expect(blocks[0].image?.alt).toBe('Publisher logo')
    })

    it('extracts table rows as paginatable table blocks', () => {
        const blocks = extractDocumentBlocks([
            elementNode('table', {}, [
                elementNode('colgroup', {}, [
                    elementNode('col', { width: '25%' }),
                    elementNode('col', { width: '75%' }),
                ]),
                elementNode('tr', {}, [
                    elementNode('td', { class: 'center' }, [elementNode('b', {}, [textNode('Year')])]),
                    elementNode('td', {}, [textNode('Article count')]),
                ]),
                elementNode('tr', {}, [
                    elementNode('td', { class: 'center' }, [textNode('2000')]),
                    elementNode('td', {}, [textNode('92')]),
                ]),
            ]),
        ], { fontSize: 16, lineHeight: 1.5 })

        expect(blocks.map(block => block.type)).toEqual(['table', 'table'])
        expect(blocks[0].table?.columnCount).toBe(2)
        expect(blocks[0].table?.columnWeights).toEqual([25, 75])
        expect(blocks[0].table?.rows[0]?.cells.map(cell => cell.text)).toEqual(['Year', 'Article count'])
        expect(blocks[0].table?.rows[0]?.cells[0]?.header).toBe(true)
        expect(blocks[0].table?.rows[0]?.cells[0]?.align).toBe('center')

        const prepared = prepareBlocks(blocks, { baseStyle: { fontSize: 16, lineHeight: 1.5 } })
        const lines = layout(prepared, { inlineSize: 320, maxBlockHeight: 240 })
        expect(lines.map(line => line.kind)).toEqual(['table', 'table'])
        expect(lines[0].table?.rows[0]?.cells[1]?.text).toBe('Article count')
    })

    it('moves atomic image and table blocks to the next page column when they would overflow', () => {
        const blocks = extractDocumentBlocks([
            elementNode('p', {}, [
                elementNode('img', {
                    src: 'blob:figure',
                    width: '80',
                    height: '60',
                }),
            ]),
            elementNode('table', {}, [
                elementNode('tr', {}, [
                    elementNode('td', {}, [textNode('A long table cell that needs room')]),
                    elementNode('td', {}, [textNode('Value')]),
                ]),
            ]),
        ], { fontSize: 10, lineHeight: 1 })

        const prepared = prepareBlocks(blocks, { baseStyle: { fontSize: 10, lineHeight: 1 } })
        const imageLines = layout(prepared, { inlineSize: 120, blockStart: 55, maxBlockHeight: 100 })
        expect(imageLines[0].kind).toBe('image')
        expect(imageLines[0].top).toBe(100)

        const tableLines = layout(prepareBlocks([blocks[1]], { baseStyle: { fontSize: 10, lineHeight: 1 } }), {
            inlineSize: 120,
            blockStart: 82,
            maxBlockHeight: 100,
        })
        expect(tableLines[0].kind).toBe('table')
        expect(tableLines[0].top).toBe(100)
    })

    it('delegates preparation and line layout to Pretext while preserving segment ranges', () => {
        const segments = [
            { text: 'one two three four' },
        ]
        const prepared = prepare(segments, { baseStyle: { fontSize: 10, lineHeight: 2 } })

        const narrow = layout(prepared, { inlineSize: 45 })
        const wide = layout(prepared, { inlineSize: 200 })

        expect(narrow.map(line => line.text)).toEqual(['one two', 'three', 'four'])
        expect(wide).toHaveLength(1)
        expect(wide[0].start?.segmentIndex).toBe(0)
        expect(wide[0].end?.segmentIndex).toBe(0)
        expect(wide[0].segments[0].text).toBe('one two three four')
    })

    it('preserves preformatted newlines and indentation during layout', () => {
        const blocks = extractDocumentBlocks([
            elementNode('pre', { class: 'programlisting' }, [
                textNode('\n<ol>\n    <li>Dogs</li>\n    <li>Cats</li>\n</ol>\n'),
            ]),
        ], { fontSize: 10, lineHeight: 2 })

        expect(blocks[0].segments.map(segment => segment.text).join('')).toBe('<ol>\n    <li>Dogs</li>\n    <li>Cats</li>\n</ol>')

        const prepared = prepareBlocks(blocks, { baseStyle: { fontSize: 10, lineHeight: 2 } })
        const lines = layout(prepared, { inlineSize: 300 })
        const indent = '\u00a0\u00a0\u00a0\u00a0'
        expect(lines.map(line => line.text)).toEqual([
            '<ol>',
            `${indent}<li>Dogs</li>`,
            `${indent}<li>Cats</li>`,
            '</ol>',
        ])
    })

    it('returns a virtualized visible line window', () => {
        const prepared = prepare([{ text: 'a b c d e f g h i j' }], { baseStyle: { fontSize: 10, lineHeight: 1 } })
        const lines = layout(prepared, { inlineSize: 12 })
        const visible = getVisibleLines(lines, 20, 20, 1)

        expect(visible.totalHeight).toBe(lines.length * 10)
        expect(visible.startIndex).toBe(1)
        expect(visible.lines[0]).toBe(lines[1])
    })
})
