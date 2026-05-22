/**
 * Test fixture: FB2 (FictionBook 2) generator
 *
 * Creates minimal FB2 XML documents and FBZ (zipped) archives
 * for testing the FB2 parser.
 */

import { configure, ZipWriter, BlobWriter, TextReader } from '@zip.js/zip.js'

configure({ useWebWorkers: false })

export interface FB2Section {
    id?: string
    title?: string
    paragraphs?: string[]
}

export interface FB2Options {
    title?: string
    author?: { firstName?: string; lastName?: string; nickname?: string }
    language?: string
    genres?: string[]
    publisher?: string
    docId?: string
    sections?: FB2Section[]
    notesBody?: { title?: string; paragraphs?: string[] }
    coverImage?: boolean
    published?: string
}

/**
 * Minimal 1x1 red PNG as base64 (without data URI prefix).
 */
const MINIMAL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='

/**
 * Generate FB2 XML string.
 */
export function createTestFB2(options: FB2Options = {}): string {
    const title = options.title ?? 'Test Book'
    const firstName = options.author?.firstName ?? 'John'
    const lastName = options.author?.lastName ?? 'Doe'
    const nickname = options.author?.nickname
    const language = options.language ?? 'en'
    const genres = options.genres ?? ['fiction']
    const publisher = options.publisher
    const docId = options.docId ?? 'test-fb2-123'
    const sections = options.sections ?? [
        { title: 'Chapter 1', paragraphs: ['Hello, world!'] },
        { title: 'Chapter 2', paragraphs: ['Second chapter.'] },
    ]

    // Build author element
    let authorXML: string
    if (nickname) {
        authorXML = `<author><nickname>${nickname}</nickname></author>`
    } else {
        authorXML = `<author><first-name>${firstName}</first-name><last-name>${lastName}</last-name></author>`
    }

    // Build genre elements
    const genreXML = genres.map(g => `<genre>${g}</genre>`).join('\n        ')

    // Build coverpage if requested
    const coverXML = options.coverImage
        ? `<coverpage><image xlink:href="#cover-img"/></coverpage>`
        : ''

    // Build binary element for cover
    const binaryXML = options.coverImage
        ? `<binary id="cover-img" content-type="image/png">${MINIMAL_PNG_BASE64}</binary>`
        : ''

    // Build date
    const dateXML = options.published
        ? `<date value="${options.published}">${options.published}</date>`
        : ''

    // Build sections for first body
    const sectionsXML = sections.map((s, i) => {
        const id = s.id ? ` id="${s.id}"` : ''
        const titleXML = s.title
            ? `<title><p>${s.title}</p></title>`
            : ''
        const parasXML = (s.paragraphs ?? [`Section ${i + 1} text.`])
            .map(p => `<p>${p}</p>`)
            .join('\n            ')
        return `        <section${id}>
            ${titleXML}
            ${parasXML}
        </section>`
    }).join('\n')

    // Build notes body
    const notesXML = options.notesBody
        ? `<body name="notes">
        <section>
            <title><p>${options.notesBody.title ?? 'Notes'}</p></title>
            ${(options.notesBody.paragraphs ?? ['Note text.']).map(p => `<p>${p}</p>`).join('\n            ')}
        </section>
    </body>`
        : ''

    // Build publish-info
    const publishXML = publisher
        ? `<publish-info><publisher>${publisher}</publisher></publish-info>`
        : ''

    return `<?xml version="1.0" encoding="UTF-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"
             xmlns:xlink="http://www.w3.org/1999/xlink">
    <description>
        <title-info>
            ${genreXML}
            ${authorXML}
            <book-title>${title}</book-title>
            <lang>${language}</lang>
            ${coverXML}
            ${dateXML}
        </title-info>
        <document-info>
            <id>${docId}</id>
        </document-info>
        ${publishXML}
    </description>
    <body>
${sectionsXML}
    </body>
    ${notesXML}
    ${binaryXML}
</FictionBook>`
}

/**
 * Create a test FB2 document as ArrayBuffer (UTF-8 encoded XML).
 */
export function createTestFB2Buffer(options: FB2Options = {}): ArrayBuffer {
    const xml = createTestFB2(options)
    return new TextEncoder().encode(xml).buffer as ArrayBuffer
}

/**
 * Create a test FBZ (zipped FB2) archive as ArrayBuffer.
 */
export async function createTestFBZ(options: FB2Options = {}): Promise<ArrayBuffer> {
    const xml = createTestFB2(options)

    const blobWriter = new BlobWriter()
    const zipWriter = new ZipWriter(blobWriter)
    await zipWriter.add('book.fb2', new TextReader(xml))
    await zipWriter.close()
    const blob = await blobWriter.getData()
    return blob.arrayBuffer()
}
