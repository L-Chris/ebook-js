import { generateText, jsonSchema, Output, type LanguageModel } from 'ai'
import type { Book, RebookPlugin, TextBlock, TextSegment } from '../core/types'

const MAX_TRANSLATION_ATTEMPTS = 2
type TranslationMode = 'replace' | 'bilingual'
type ValueOrGetter<T> = T | (() => T)
type TranslationUpdate = { sectionIndex: number; blocks: TextBlock[] }
type TranslationBook = Book & { refreshTranslatedTOC?: () => void }

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
        let translatedTOCLabels: string[] | null = null
        let tocTranslationPromise: Promise<string[] | null> | null = null

        const getMode = () => getValue(mode)
        const shouldTranslateTOC = () => getValue(translateTOC)

        const getTOC = () => renderTOCItems(book.toc, translatedTOCLabels, shouldTranslateTOC(), getMode())

        const startTOCTranslation = () => {
            if (!book.toc || !shouldTranslateTOC() || tocTranslationPromise || translatedTOCLabels) return
            tocTranslationPromise = translateTOCLabels(book.toc, model, targetLanguage)
                .then(labels => {
                    translatedTOCLabels = labels
                    onTOCUpdate?.(getTOC())
                    return labels
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
            let translatedTextByIndex = new Map<number, string>()
            let translationPromise: Promise<Map<number, string>> | null = null
            let translationComplete = false

            const getOriginalBlocks = () => {
                if (!originalBlocksPromise) {
                    originalBlocksPromise = Promise.resolve(originalGetBlocks()).then(blocks => blocks.map(cloneTextBlock))
                }
                return originalBlocksPromise
            }

            const startTranslation = () => {
                if (translationPromise || translationComplete) return
                translationPromise = getOriginalBlocks()
                    .then(blocks => translateBlockTexts(blocks, model, targetLanguage, concurrency, tokensPerBatch, (translations) => {
                        translatedTextByIndex = translations
                        const renderedBlocks = renderTranslatedBlocks(blocks, translations, getMode())
                        onUpdate?.({ sectionIndex: index, blocks: renderedBlocks })
                    }))
                    .then(translations => {
                        translatedTextByIndex = translations
                        translationComplete = true
                        return translations
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
                    const blocks = translatedTextByIndex.size > 0
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

        const translatedBook: TranslationBook = {
            ...book,
            get toc() {
                startTOCTranslation()
                return getTOC()
            },
            refreshTranslatedTOC() {
                startTOCTranslation()
                onTOCUpdate?.(getTOC())
            },
            sections: wrappedSections
        }

        return translatedBook
    }
}

async function translateBlockTexts(
    blocks: TextBlock[],
    model: LanguageModel,
    targetLanguage: string,
    concurrency: number,
    tokensPerBatch: number,
    onBatch?: (translations: Map<number, string>) => void
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
            onBatch?.(new Map(translations))
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
            rendered.push(cloneTextBlock(block))
            continue
        }

        const translatedSegments: TextSegment[] = [{ text: translatedText, style: block.segments[0]?.style }]
        if (mode === 'replace') {
            rendered.push({ ...cloneTextBlock(block), segments: translatedSegments })
        } else {
            rendered.push(cloneTextBlock(block), {
                ...block,
                id: `t${index.toString(36)}`,
                segments: translatedSegments
            })
        }
    }

    return rendered
}

function cloneTextBlock(block: TextBlock): TextBlock {
    return {
        ...block,
        segments: block.segments.map(segment => ({ ...segment, style: segment.style ? { ...segment.style } : segment.style }))
    }
}

async function translateTOCLabels(
    toc: NonNullable<Book['toc']>,
    model: LanguageModel,
    targetLanguage: string,
): Promise<string[]> {
    const items = flattenTOC(toc)
    const labels = items.map(item => item.label)
    if (!labels.length) return []

    return requestTranslations(model, targetLanguage, labels)
}

function renderTOCItems(
    toc: Book['toc'],
    translations: readonly string[] | null,
    enabled: boolean,
    mode: TranslationMode,
): Book['toc'] {
    if (!toc || !enabled || !translations) return toc
    let index = 0
    const mapItems = (items: NonNullable<Book['toc']>): NonNullable<Book['toc']> => items.map(item => ({
        ...item,
        label: renderTOCLabel(item.label, translations[index++] || item.label, mode),
        subitems: item.subitems ? mapItems(item.subitems) : item.subitems,
    }))

    return mapItems(toc)
}

function renderTOCLabel(original: string, translated: string, mode: TranslationMode): string {
    return mode === 'replace' ? translated : `${original} / ${translated}`
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
    const entries = payload.map((text, index) => ({ key: index.toString(36), text }))
    const input = Object.fromEntries(entries.map(({ key, text }) => [key, text]))
    const schema = {
        type: 'object',
        properties: Object.fromEntries(entries.map(({ key }) => [key, { type: 'string' }])),
        required: entries.map(({ key }) => key),
        additionalProperties: false,
    }

    for (let attempt = 1; attempt <= MAX_TRANSLATION_ATTEMPTS; attempt++) {
        try {
            const { output } = await generateText({
                model,
                output: Output.object({
                    schema: jsonSchema<Record<string, string>>(schema),
                    description: 'Translations keyed by the same short block ids as the input.',
                }),
                system: `You are a professional translator. Translate each value into ${targetLanguage}. Preserve the original tone and style. Keep the exact same keys.`,
                prompt: JSON.stringify(input),
            })

            if (!output || typeof output !== 'object' || Array.isArray(output)) {
                throw new TranslationFormatError('Translation output was not an object.')
            }

            const translations = entries.map(({ key }) => output[key])
            const missingKey = entries.find(({ key }, index) => typeof translations[index] !== 'string')
            if (missingKey) {
                throw new TranslationFormatError(`Translation output missed key "${missingKey.key}".`)
            }

            return translations
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
