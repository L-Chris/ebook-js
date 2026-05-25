import { describe, it, expect, vi } from 'vitest'
import { withTranslation } from '../../src/plugins/translation'
import type { Book, Section, TextBlock } from '../../src/core/types'

type TestTranslationBook = Book & {
    requestBlockTranslations?: (sectionIndex: number, blockIds: readonly string[]) => void
    refreshTranslatedTOC?: () => void
}

const { generateTextMock, outputObjectMock, createTranslationResponse } = vi.hoisted(() => ({
    createTranslationResponse: async (options: any) => {
        const payload = JSON.parse(options.prompt)
        const translatedPayload = Object.fromEntries(
            Object.entries(payload).map(([key, text]) => [key, `[Translated] ${text}`])
        )
        return {
            output: translatedPayload
        }
    },
    generateTextMock: vi.fn(),
    outputObjectMock: vi.fn((options: any) => options)
}))

vi.mock('ai', () => ({
    generateText: generateTextMock,
    Output: {
        object: outputObjectMock
    },
    jsonSchema: (schema: any) => schema
}))

const mockModel = {}

const waitForUpdate = () => {
    let resolve!: (value: { sectionIndex: number; blocks: TextBlock[] }) => void
    const promise = new Promise<{ sectionIndex: number; blocks: TextBlock[] }>(res => {
        resolve = res
    })
    return { promise, resolve }
}

describe('Translation Plugin', () => {
    beforeEach(() => {
        generateTextMock.mockReset()
        generateTextMock.mockImplementation(createTranslationResponse)
        outputObjectMock.mockClear()
    })

    const mockBlocks: TextBlock[] = [
        {
            id: 'b1',
            type: 'paragraph',
            segments: [{ text: 'Hello world.' }]
        },
        {
            id: 'b2',
            type: 'image', // should not translate
            segments: [],
            image: { src: 'test.jpg' }
        },
        {
            id: 'b3',
            type: 'heading',
            segments: [{ text: 'Title' }]
        }
    ]

    const mockSection: Section = {
        id: 's1',
        size: 100,
        load: () => '',
        getBlocks: async () => [...mockBlocks]
    }

    const mockBook: Book = {
        sections: [mockSection]
    }

    it('translates text blocks in bilingual mode', async () => {
        const update = waitForUpdate()
        const plugin = withTranslation({
            model: mockModel as any,
            targetLanguage: 'zh-CN',
            mode: 'bilingual',
            onUpdate: update.resolve
        })

        const wrappedBook = await plugin(mockBook)
        const translationBook = wrappedBook as TestTranslationBook
        const wrappedSection = wrappedBook.sections[0]
        const initialBlocks = await wrappedSection.getBlocks!()

        expect(initialBlocks).toHaveLength(3)
        expect(initialBlocks[0].id).toBe('b1')
        expect(initialBlocks[0].segments[0].text).toBe('Hello world.')

        translationBook.requestBlockTranslations?.(0, ['b1', 'b3'])
        await update.promise
        const translatedBlocks = await wrappedSection.getBlocks!()

        expect(generateTextMock).toHaveBeenCalled()
        expect(generateTextMock.mock.calls[0][0].system).not.toContain('elements')
        expect(outputObjectMock).toHaveBeenCalled()
        expect(JSON.parse(generateTextMock.mock.calls[0][0].prompt)).toEqual({
            '0': 'Hello world.',
            '1': 'Title'
        })

        // b1 (orig), t0 (trans), b2 (image), b3 (orig), t2 (trans)
        expect(translatedBlocks).toHaveLength(5)
        
        expect(translatedBlocks[0].id).toBe('b1')
        expect(translatedBlocks[0].segments[0].text).toBe('Hello world.')
        
        expect(translatedBlocks[1].id).toBe('t0')
        expect(translatedBlocks[1].segments[0].text).toBe('[Translated] Hello world.')
        
        expect(translatedBlocks[2].id).toBe('b2') // Image untouched
        
        expect(translatedBlocks[3].id).toBe('b3')
        expect(translatedBlocks[3].segments[0].text).toBe('Title')
        
        expect(translatedBlocks[4].id).toBe('t2')
        expect(translatedBlocks[4].segments[0].text).toBe('[Translated] Title')
    })

    it('translates text blocks in replace mode', async () => {
        const update = waitForUpdate()
        const plugin = withTranslation({
            model: mockModel as any,
            targetLanguage: 'zh-CN',
            mode: 'replace',
            onUpdate: update.resolve
        })

        const wrappedBook = await plugin(mockBook)
        const translationBook = wrappedBook as TestTranslationBook
        const wrappedSection = wrappedBook.sections[0]
        const initialBlocks = await wrappedSection.getBlocks!()

        expect(initialBlocks).toHaveLength(3)
        expect(initialBlocks[0].segments[0].text).toBe('Hello world.')

        translationBook.requestBlockTranslations?.(0, ['b1', 'b3'])
        await update.promise
        const translatedBlocks = await wrappedSection.getBlocks!()

        // b1 (replaced), b2 (image), b3 (replaced)
        expect(translatedBlocks).toHaveLength(3)
        
        expect(translatedBlocks[0].id).toBe('b1')
        expect(translatedBlocks[0].segments[0].text).toBe('[Translated] Hello world.')
        
        expect(translatedBlocks[1].id).toBe('b2')
        
        expect(translatedBlocks[2].id).toBe('b3')
        expect(translatedBlocks[2].segments[0].text).toBe('[Translated] Title')
    })

    it('skips blocks that are too short', async () => {
        const shortBlockSection: Section = {
            id: 's2',
            size: 10,
            load: () => '',
            getBlocks: async () => [
                { id: 'b4', type: 'paragraph', segments: [{ text: 'A' }] }
            ]
        }
        
        const plugin = withTranslation({
            model: mockModel as any,
            mode: 'bilingual',
        })

        const wrappedBook = await plugin({ sections: [shortBlockSection] })
        const translationBook = wrappedBook as TestTranslationBook
        const initialBlocks = await wrappedBook.sections[0].getBlocks!()

        expect(initialBlocks).toHaveLength(1)
        expect(initialBlocks[0].id).toBe('b4')

        translationBook.requestBlockTranslations?.(0, ['b4'])
        await new Promise(resolve => setTimeout(resolve, 0))
        const translatedBlocks = await wrappedBook.sections[0].getBlocks!()

        expect(generateTextMock).not.toHaveBeenCalled()
        expect(translatedBlocks).toHaveLength(1)
        expect(translatedBlocks[0].id).toBe('b4')
    })

    it('skips blocks made only of numbers, whitespace, and punctuation', async () => {
        const nonTextBlocks: TextBlock[] = [
            { id: 'n1', type: 'paragraph', segments: [{ text: '12345' }] },
            { id: 'n2', type: 'paragraph', segments: [{ text: ' \t\n ' }] },
            { id: 'n3', type: 'paragraph', segments: [{ text: '.,?!，。！？' }] },
            { id: 'n4', type: 'paragraph', segments: [{ text: ' 123, 456.\t ' }] },
        ]
        const section: Section = {
            id: 's3',
            size: 20,
            load: () => '',
            getBlocks: async () => nonTextBlocks,
        }
        const plugin = withTranslation({
            model: mockModel as any,
            mode: 'bilingual',
        })

        const wrappedBook = await plugin({ sections: [section] })
        await wrappedBook.sections[0].getBlocks!()
        ;(wrappedBook as TestTranslationBook).requestBlockTranslations?.(0, nonTextBlocks.map(block => block.id))
        await new Promise(resolve => setTimeout(resolve, 0))

        expect(generateTextMock).not.toHaveBeenCalled()
        expect(await wrappedBook.sections[0].getBlocks!()).toEqual(nonTextBlocks)
    })

    it('retries once when structured translation output is invalid', async () => {
        const update = waitForUpdate()
        const formatError = Object.assign(new Error('No object generated: response did not match schema.'), {
            name: 'AI_NoObjectGeneratedError'
        })
        generateTextMock
            .mockRejectedValueOnce(formatError)
            .mockImplementationOnce(createTranslationResponse)

        const plugin = withTranslation({
            model: mockModel as any,
            mode: 'replace',
            onUpdate: update.resolve
        })

        const wrappedBook = await plugin(mockBook)
        await wrappedBook.sections[0].getBlocks!()
        ;(wrappedBook as TestTranslationBook).requestBlockTranslations?.(0, ['b1', 'b3'])
        await update.promise
        const translatedBlocks = await wrappedBook.sections[0].getBlocks!()

        expect(generateTextMock).toHaveBeenCalledTimes(2)
        expect(translatedBlocks[0].segments[0].text).toBe('[Translated] Hello world.')
    })

    it('retries once when translation output misses an input key', async () => {
        const update = waitForUpdate()
        generateTextMock
            .mockResolvedValueOnce({ output: { '0': '[Translated] Hello world.' } })
            .mockImplementationOnce(createTranslationResponse)

        const plugin = withTranslation({
            model: mockModel as any,
            mode: 'replace',
            onUpdate: update.resolve
        })

        const wrappedBook = await plugin(mockBook)
        await wrappedBook.sections[0].getBlocks!()
        ;(wrappedBook as TestTranslationBook).requestBlockTranslations?.(0, ['b1', 'b3'])
        await update.promise
        const translatedBlocks = await wrappedBook.sections[0].getBlocks!()

        expect(generateTextMock).toHaveBeenCalledTimes(2)
        expect(translatedBlocks[0].segments[0].text).toBe('[Translated] Hello world.')
        expect(translatedBlocks[2].segments[0].text).toBe('[Translated] Title')
    })

    it('updates rendered blocks after each translated batch', async () => {
        const updates: TextBlock[][] = []
        let resolveUpdates!: () => void
        const updatesPromise = new Promise<void>(resolve => {
            resolveUpdates = resolve
        })
        const plugin = withTranslation({
            model: mockModel as any,
            mode: 'bilingual',
            tokensPerBatch: 1,
            concurrency: 1,
            onUpdate: ({ blocks }) => {
                updates.push(blocks)
                if (updates.length === 2) resolveUpdates()
            }
        })

        const wrappedBook = await plugin(mockBook)
        await wrappedBook.sections[0].getBlocks!()
        ;(wrappedBook as TestTranslationBook).requestBlockTranslations?.(0, ['b1', 'b3'])
        await updatesPromise

        expect(generateTextMock).toHaveBeenCalledTimes(2)
        expect(updates[0]).toHaveLength(4)
        expect(updates[0][1].segments[0].text).toBe('[Translated] Hello world.')
        expect(updates[0][3].segments[0].text).toBe('Title')
        expect(updates[1]).toHaveLength(5)
        expect(updates[1][4].segments[0].text).toBe('[Translated] Title')
    })

    it('translates only block ids requested by the renderer window', async () => {
        const update = waitForUpdate()
        const plugin = withTranslation({
            model: mockModel as any,
            mode: 'bilingual',
            onUpdate: update.resolve
        })

        const wrappedBook = await plugin(mockBook)
        const wrappedSection = wrappedBook.sections[0]
        await wrappedSection.getBlocks!()

        ;(wrappedBook as TestTranslationBook).requestBlockTranslations?.(0, ['b1'])
        await update.promise
        const translatedBlocks = await wrappedSection.getBlocks!()

        expect(JSON.parse(generateTextMock.mock.calls[0][0].prompt)).toEqual({ '0': 'Hello world.' })
        expect(translatedBlocks).toHaveLength(4)
        expect(translatedBlocks[1].segments[0].text).toBe('[Translated] Hello world.')
        expect(translatedBlocks[3].segments[0].text).toBe('Title')
    })

    it('merges adjacent renderer window requests before translating', async () => {
        const update = waitForUpdate()
        const plugin = withTranslation({
            model: mockModel as any,
            mode: 'bilingual',
            onUpdate: update.resolve
        })

        const wrappedBook = await plugin(mockBook)
        const translationBook = wrappedBook as TestTranslationBook
        await wrappedBook.sections[0].getBlocks!()

        translationBook.requestBlockTranslations?.(0, ['b1'])
        translationBook.requestBlockTranslations?.(0, ['b3'])
        await update.promise

        expect(generateTextMock).toHaveBeenCalledTimes(1)
        expect(JSON.parse(generateTextMock.mock.calls[0][0].prompt)).toEqual({
            '0': 'Hello world.',
            '1': 'Title'
        })
    })

    it('switches display mode without requesting translations again', async () => {
        const update = waitForUpdate()
        let mode: 'bilingual' | 'replace' = 'bilingual'
        const plugin = withTranslation({
            model: mockModel as any,
            mode: () => mode,
            onUpdate: update.resolve
        })

        const wrappedBook = await plugin(mockBook)
        const wrappedSection = wrappedBook.sections[0]
        await wrappedSection.getBlocks!()
        ;(wrappedBook as TestTranslationBook).requestBlockTranslations?.(0, ['b1', 'b3'])
        await update.promise

        const bilingualBlocks = await wrappedSection.getBlocks!()
        expect(bilingualBlocks).toHaveLength(5)

        mode = 'replace'
        const replaceBlocks = await wrappedSection.getBlocks!()

        expect(generateTextMock).toHaveBeenCalledTimes(1)
        expect(replaceBlocks).toHaveLength(3)
        expect(replaceBlocks[0].segments[0].text).toBe('[Translated] Hello world.')

        mode = 'bilingual'
        const bilingualAgainBlocks = await wrappedSection.getBlocks!()

        expect(generateTextMock).toHaveBeenCalledTimes(1)
        expect(bilingualAgainBlocks).toHaveLength(5)
        expect(bilingualAgainBlocks[0].segments[0].text).toBe('Hello world.')
        expect(bilingualAgainBlocks[1].segments[0].text).toBe('[Translated] Hello world.')
    })

    it('translates table of contents labels when enabled', async () => {
        let resolveTOC!: (toc: Book['toc']) => void
        const tocPromise = new Promise<Book['toc']>(resolve => {
            resolveTOC = resolve
        })
        const plugin = withTranslation({
            model: mockModel as any,
            translateTOC: true,
            onTOCUpdate: resolveTOC
        })

        const wrappedBook = await plugin({
            sections: [mockSection],
            toc: [
                { label: 'Chapter One', href: 's1' },
                { label: 'Part Two', href: 's2', subitems: [{ label: 'Child', href: 's2#child' }] }
            ]
        })

        const translatedTOC = await tocPromise

        expect(translatedTOC?.[0].label).toBe('Chapter One / [Translated] Chapter One')
        expect(translatedTOC?.[1].subitems?.[0].label).toBe('Child / [Translated] Child')
        expect(wrappedBook.toc?.[0].label).toBe('Chapter One / [Translated] Chapter One')
    })

    it('toggles translated table of contents without requesting labels again', async () => {
        let translateTOC = true
        let mode: 'bilingual' | 'replace' = 'bilingual'
        let resolveTOC!: (toc: Book['toc']) => void
        const tocPromise = new Promise<Book['toc']>(resolve => {
            resolveTOC = resolve
        })
        const plugin = withTranslation({
            model: mockModel as any,
            translateTOC: () => translateTOC,
            mode: () => mode,
            onTOCUpdate: resolveTOC
        })

        const wrappedBook = await plugin({
            sections: [mockSection],
            toc: [{ label: 'Chapter One', href: 's1' }]
        })

        await tocPromise
        expect(wrappedBook.toc?.[0].label).toBe('Chapter One / [Translated] Chapter One')

        translateTOC = false
        wrappedBook.refreshTranslatedTOC?.()
        expect(wrappedBook.toc?.[0].label).toBe('Chapter One')

        translateTOC = true
        mode = 'replace'
        wrappedBook.refreshTranslatedTOC?.()
        expect(wrappedBook.toc?.[0].label).toBe('[Translated] Chapter One')
        expect(generateTextMock).toHaveBeenCalledTimes(1)
    })
})
