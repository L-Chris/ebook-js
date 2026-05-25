import { generateText, jsonSchema, Output, type LanguageModel } from 'ai'
import type { Book, RebookPlugin, TextBlock, TextSegment } from '../core/types'

const MAX_TRANSLATION_ATTEMPTS = 2
type TranslationMode = 'replace' | 'bilingual'
type ValueOrGetter<T> = T | (() => T)
type TranslationUpdate = { sectionIndex: number; blocks: TextBlock[] }

class TranslationFormatError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'TranslationFormatError'
    }
}

export interface TranslationOptions {
    /** The language model to use for translation (from @ai-sdk/...) */
    model: LanguageModel
    /** Target language (default: 'zh-CN') */
    targetLanguage?: string
    /**
     * Display mode:
     * - 'replace': Replace original text with translated text
     * - 'bilingual': Show original text followed by translated text
     * Default: 'bilingual'
     */
    mode?: ValueOrGetter<TranslationMode>
    /** Translate table of contents labels. Defaults to false. */
    translateTOC?: ValueOrGetter<boolean>
    /** Max concurrency for translation requests (default: 2) */
    concurrency?: number
    /**
     * Approximate maximum tokens (or characters) per translation batch.
     * The plugin will group as many blocks as possible until this limit is reached.
     * (default: 1000)
     */
    tokensPerBatch?: number
    /**
     * Called when a background translation has updated a section.
     * Readers can use this to refresh the current section without blocking
     * initial rendering on the translation request.
     */
    onUpdate?: (event: TranslationUpdate) => void
    /** Called when table of contents labels have been translated. */
    onTOCUpdate?: (toc: Book['toc']) => void
}

/**
 * A plugin that translates the text blocks of a book using Vercel AI SDK.
 */
export function withTranslation(options: TranslationOptions): RebookPlugin {
    const {
        model,
        targetLanguage = 'zh-CN',
        mode = 'bilingual',
        concurrency = 2,
        tokensPerBatch = 1000,
        onUpdate,
        translateTOC = false,
        onTOCUpdate
    } = options

    return (book: Book): Book => {
        const starters = new Map<number, () => void>()
        let translatedTOC: Book['toc'] | null = null
        let tocTranslationPromise: Promise<Book['toc'] | null> | null = null

        const getMode = () => getValue(mode)
        const shouldTranslateTOC = () => getValue(translateTOC)

        const getTOC = () => shouldTranslateTOC() && translatedTOC ? translatedTOC : book.toc

        const startTOCTranslation = () => {
            if (!book.toc || !shouldTranslateTOC() || tocTranslationPromise || translatedTOC) return
            tocTranslationPromise = translateTOCItems(book.toc, model, targetLanguage)
                .then(toc => {
                    translatedTOC = toc
                    onTOCUpdate?.(toc)
                    return toc
                })
                .catch(err => {
                    tocTranslationPromise = null
                    throw err
                })
            tocTranslationPromise.catch(console.error)
        }

        const wrappedSections = book.sections.map((section, index) => {
            const originalGetBlocks = section.getBlocks?.bind(section)

            if (!originalGetBlocks) {
                return section
            }

            let originalBlocksPromise: Promise<TextBlock[]> | null = null
            let translatedTextByIndex: Map<number, string> | null = null
            let translationPromise: Promise<Map<number, string>> | null = null

            const getOriginalBlocks = () => {
                if (!originalBlocksPromise) {
                    originalBlocksPromise = Promise.resolve(originalGetBlocks()).then(blocks => [...blocks])
                }
                return originalBlocksPromise
            }

            const startTranslation = () => {
                if (translationPromise || translatedTextByIndex) return
                translationPromise = getOriginalBlocks()
                    .then(blocks => translateBlockTexts(blocks, model, targetLanguage, concurrency, tokensPerBatch))
                    .then(translations => {
                        translatedTextByIndex = translations
                        return getOriginalBlocks().then(blocks => {
                            const renderedBlocks = renderTranslatedBlocks(blocks, translations, getMode())
                            onUpdate?.({ sectionIndex: index, blocks: renderedBlocks })
                            return translations
                        })
                    })
                    .catch(err => {
                        translationPromise = null
                        throw err
                    })
                translationPromise.catch(console.error)
            }

            starters.set(index, startTranslation)

            return {
                ...section,
                getBlocks: async () => {
                    const originalBlocks = await getOriginalBlocks()
                    const blocks = translatedTextByIndex
                        ? renderTranslatedBlocks(originalBlocks, translatedTextByIndex, getMode())
                        : originalBlocks
                    startTranslation()

                    // Aggressively prefetch the next section in the background
                    // after a short delay to allow current layout/render to prioritize
                    setTimeout(() => {
                        starters.get(index + 1)?.()
                    }, 500)

                    return blocks
                }
            }
        })

        startTOCTranslation()

        return {
            ...book,
            get toc() {
                return getTOC()
            },
            sections: wrappedSections
        }
    }
}

async function translateBlockTexts(
    blocks: TextBlock[],
    model: LanguageModel,
    targetLanguage: string,
    concurrency: number,
    tokensPerBatch: number
): Promise<Map<number, string>> {
    const translations = new Map<number, string>()
    const translatableItems = getTranslatableItems(blocks)

    const batches: { block: TextBlock, index: number }[][] = []
    let currentBatch: { block: TextBlock, index: number }[] = []
    let currentBatchTokens = 0

    for (const item of translatableItems) {
        const fullText = item.block.segments.map(s => s.text).join('')
        const estimatedTokens = fullText.length

        if (currentBatch.length > 0 && currentBatchTokens + estimatedTokens > tokensPerBatch) {
            batches.push(currentBatch)
            currentBatch = []
            currentBatchTokens = 0
        }

        currentBatch.push(item)
        currentBatchTokens += estimatedTokens
    }

    if (currentBatch.length > 0) {
        batches.push(currentBatch)
    }

    const active = new Set<Promise<void>>()
    let currentBatchIndex = 0

    const processBatch = async (batch: { block: TextBlock, index: number }[]) => {
        const payload = batch.map(b => b.block.segments.map(s => s.text).join(''))

        try {
            const batchTranslations = await requestTranslations(model, targetLanguage, payload)

            for (let i = 0; i < batch.length; i++) {
                const { block, index } = batch[i]
                const translatedText = batchTranslations[i]
                if (translatedText) {
                    translations.set(index, translatedText)
                }
            }
        } catch (error) {
            console.error(`Batch translation failed:`, error)
        }
    }

    while (currentBatchIndex < batches.length) {
        if (active.size >= concurrency) {
            await Promise.race(active)
            continue
        }

        const batch = batches[currentBatchIndex++]
        const promise = processBatch(batch).then(() => {
            active.delete(promise)
        })
        active.add(promise)
    }

    await Promise.all(active)

    return translations
}

function getTranslatableItems(blocks: readonly TextBlock[]): { block: TextBlock, index: number }[] {
    const items: { block: TextBlock, index: number }[] = []
    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i]
        if (['paragraph', 'heading', 'listItem', 'blockquote'].includes(block.type) && block.segments.length > 0) {
            const fullText = block.segments.map(s => s.text).join('')
            if (fullText.trim().length >= 2) {
                items.push({ block, index: i })
            }
        }
    }
    return items
}

function renderTranslatedBlocks(
    blocks: readonly TextBlock[],
    translatedTextByIndex: Map<number, string>,
    mode: TranslationMode,
): TextBlock[] {
    const rendered: TextBlock[] = []

    for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index]
        const translatedText = translatedTextByIndex.get(index)
        if (!translatedText) {
            rendered.push(block)
            continue
        }

        const translatedSegments: TextSegment[] = [{ text: translatedText, style: block.segments[0]?.style }]
        if (mode === 'replace') {
            rendered.push({ ...block, segments: translatedSegments })
        } else {
            rendered.push(block, {
                ...block,
                id: `${block.id}-tr`,
                segments: translatedSegments
            })
        }
    }

    return rendered
}

async function translateTOCItems(
    toc: NonNullable<Book['toc']>,
    model: LanguageModel,
    targetLanguage: string,
): Promise<NonNullable<Book['toc']>> {
    const items = flattenTOC(toc)
    const labels = items.map(item => item.label)
    if (!labels.length) return toc

    const translations = await requestTranslations(model, targetLanguage, labels)
    let index = 0

    const mapItems = (items: NonNullable<Book['toc']>): NonNullable<Book['toc']> => items.map(item => ({
        ...item,
        label: translations[index++] || item.label,
        subitems: item.subitems ? mapItems(item.subitems) : item.subitems,
    }))

    return mapItems(toc)
}

function flattenTOC(items: NonNullable<Book['toc']>): NonNullable<Book['toc']> {
    return items.flatMap(item => item.subitems?.length ? [item, ...flattenTOC(item.subitems)] : [item])
}

async function requestTranslations(
    model: LanguageModel,
    targetLanguage: string,
    payload: string[],
): Promise<string[]> {
    let lastError: unknown

    for (let attempt = 1; attempt <= MAX_TRANSLATION_ATTEMPTS; attempt++) {
        try {
            const { output } = await generateText({
                model,
                output: Output.array({
                    element: jsonSchema<string>({ type: 'string' }),
                    description: 'Translations in the same order as the input strings.',
                }),
                system: `You are a professional translator. Translate the input strings into ${targetLanguage}. Maintain the original tone, style, count, and order.`,
                prompt: JSON.stringify(payload),
            })

            if (!Array.isArray(output)) {
                throw new TranslationFormatError('Translation output was not an array.')
            }
            if (output.length !== payload.length) {
                throw new TranslationFormatError(`Translation output length ${output.length} did not match input length ${payload.length}.`)
            }

            return output
        } catch (error) {
            lastError = error
            if (attempt < MAX_TRANSLATION_ATTEMPTS && isRetryableTranslationError(error)) {
                console.warn('Translation output format was invalid; retrying once.', error)
                continue
            }
            throw error
        }
    }

    throw lastError
}

function isRetryableTranslationError(error: unknown): boolean {
    if (error instanceof TranslationFormatError) return true
    if (!error || typeof error !== 'object') return false
    const name = 'name' in error ? String(error.name) : ''
    return name === 'AI_NoObjectGeneratedError' || name === 'NoObjectGeneratedError'
}

function getValue<T>(value: ValueOrGetter<T>): T {
    return typeof value === 'function' ? (value as () => T)() : value
}
