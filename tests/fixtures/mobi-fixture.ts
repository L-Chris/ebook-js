/**
 * Test fixture: MOBI/AZW binary file generator
 *
 * Creates minimal MOBI6 files for testing the MOBI parser.
 * Supports PalmDOC compression and EXTH metadata.
 */

// ============================================================================
// Binary writing helpers
// ============================================================================

function writeString(view: DataView, offset: number, str: string): void {
    for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i))
    }
}

function writeUint32(view: DataView, offset: number, value: number): void {
    view.setUint32(offset, value)
}

function writeUint16(view: DataView, offset: number, value: number): void {
    view.setUint16(offset, value)
}

function concat(...buffers: ArrayBuffer[]): ArrayBuffer {
    const total = buffers.reduce((sum, b) => sum + b.byteLength, 0)
    const result = new Uint8Array(total)
    let offset = 0
    for (const buf of buffers) {
        result.set(new Uint8Array(buf), offset)
        offset += buf.byteLength
    }
    return result.buffer as ArrayBuffer
}

function stringToBuffer(str: string): ArrayBuffer {
    return new TextEncoder().encode(str).buffer as ArrayBuffer
}

function padTo(buffer: ArrayBuffer, size: number): ArrayBuffer {
    if (buffer.byteLength >= size) return buffer
    const padded = new Uint8Array(size)
    padded.set(new Uint8Array(buffer))
    return padded.buffer as ArrayBuffer
}

// ============================================================================
// PalmDOC compression (LZ77 variant)
// ============================================================================

/**
 * Simple PalmDOC compression. For test fixtures, we use a basic approach:
 * - literal bytes (0x09-0x7f) pass through
 * - space + char (0x80-0xbf): encodes space + (byte ^ 0x80)
 * - We don't use LZ77 back-references for simplicity
 */
function compressPalmDOC(data: Uint8Array): Uint8Array {
    const output: number[] = []
    for (let i = 0; i < data.length; i++) {
        const byte = data[i]
        if (byte === 0) {
            output.push(0)
        } else if (byte >= 0x09 && byte <= 0x7f) {
            output.push(byte)
        } else {
            // Literal copy (bytes 0x01-0x08 are copy-next-N)
            // Use the "copy 1 literal" approach: we push as-is for bytes in safe range
            // For unsafe bytes, use the space-XOR encoding if applicable
            if (i > 0 && data[i - 1] === 0x20 && byte >= 0x40 && byte <= 0x7f) {
                // Already handled by previous iteration in real compressor
                // For simplicity, just emit the byte
                output.push(byte)
            } else {
                output.push(byte)
            }
        }
    }
    return Uint8Array.from(output)
}

// ============================================================================
// EXTH metadata builder
// ============================================================================

interface EXTHEntry {
    type: number
    data: string | number
}

function buildEXTH(entries: EXTHEntry[], encoding: number = 65001): ArrayBuffer {
    const encoder = new TextEncoder()

    // Calculate total size
    let dataSize = 0
    for (const entry of entries) {
        const entrySize = typeof entry.data === 'number' ? 4 : encoder.encode(entry.data).byteLength
        dataSize += 8 + entrySize // 4 bytes type + 4 bytes length + data
    }

    const headerSize = 12 // magic(4) + length(4) + count(4)
    const totalSize = headerSize + dataSize
    // Pad to 4-byte boundary
    const paddedSize = Math.ceil(totalSize / 4) * 4

    const buffer = new ArrayBuffer(paddedSize)
    const view = new DataView(buffer)

    writeString(view, 0, 'EXTH')
    writeUint32(view, 4, paddedSize)
    writeUint32(view, 8, entries.length)

    let offset = 12
    for (const entry of entries) {
        writeUint32(view, offset, entry.type)
        if (typeof entry.data === 'number') {
            writeUint32(view, offset + 4, 12) // 8 header + 4 data
            writeUint32(view, offset + 8, entry.data)
            offset += 12
        } else {
            const bytes = encoder.encode(entry.data)
            writeUint32(view, offset + 4, 8 + bytes.byteLength)
            new Uint8Array(buffer, offset + 8, bytes.byteLength).set(bytes)
            offset += 8 + bytes.byteLength
        }
    }

    return buffer
}

// ============================================================================
// MOBI file builder
// ============================================================================

export interface MOBISection {
    html: string
}

export interface MOBIFixtureOptions {
    title?: string
    author?: string
    language?: string
    publisher?: string
    description?: string
    sections?: MOBISection[]
    compression?: 1 | 2  // 1 = none, 2 = PalmDOC
    version?: number       // 6 = MOBI6, 8+ = KF8
    coverOffset?: number
    includeGuide?: boolean
    tocEntries?: { label: string; filepos: number }[]
}

/**
 * Build a complete MOBI6 file as ArrayBuffer.
 */
export function createTestMOBI(options: MOBIFixtureOptions = {}): ArrayBuffer {
    const title = options.title ?? 'Test Book'
    const author = options.author ?? 'Test Author'
    const language = options.language ?? 'en'
    const compression = options.compression ?? 1
    const version = options.version ?? 6

    // Build HTML content from sections
    const sections = options.sections ?? [
        { html: '<html><body><h1>Chapter 1</h1><p>Hello, world!</p></body></html>' },
        { html: '<html><body><h1>Chapter 2</h1><p>Second chapter.</p></body></html>' },
    ]

    // Build the full HTML text, splitting at pagebreaks
    let fullHTML = ''
    for (let i = 0; i < sections.length; i++) {
        if (i > 0) fullHTML += '<mbp:pagebreak/>'
        fullHTML += sections[i].html
    }

    // Add guide section if requested
    if (options.includeGuide) {
        const guideRefs = options.tocEntries ?? [
            { label: 'Chapter 1', filepos: 0 },
        ]
        let guide = '<guide>'
        for (const ref of guideRefs) {
            guide += `<reference type="toc" title="${ref.label}" filepos="${String(ref.filepos).padStart(10, '0')}"/>`
        }
        guide += '</guide>'
        fullHTML += guide
    }

    const textBytes = new TextEncoder().encode(fullHTML)

    // Compress text
    const compressed = compression === 2 ? compressPalmDOC(textBytes) : textBytes

    // Split into text records (max 4096 bytes each for record size)
    const recordSize = 4096
    const textRecords: Uint8Array[] = []
    for (let i = 0; i < compressed.length; i += recordSize) {
        textRecords.push(compressed.subarray(i, Math.min(i + recordSize, compressed.length)))
    }
    if (textRecords.length === 0) textRecords.push(new Uint8Array(0))

    // Build EXTH header
    const exthEntries: EXTHEntry[] = [
        { type: 100, data: author },     // creator
        { type: 524, data: language },    // language
    ]
    if (options.publisher) {
        exthEntries.push({ type: 101, data: options.publisher })
    }
    if (options.description) {
        exthEntries.push({ type: 103, data: options.description })
    }
    if (options.coverOffset != null) {
        exthEntries.push({ type: 201, data: options.coverOffset })
    }
    const exthData = buildEXTH(exthEntries)

    // Build Record 0: PalmDOC(16) + MOBI(232) + padding + EXTH + title
    // The MOBI "length" field tells the parser where EXTH starts: EXTH = record0[length + 16]
    const titleBytes = new TextEncoder().encode(title)
    const mobiOnlySize = 0xE8 // 232 bytes (standard MOBI header size for v6)
    // mobiHeaderLength = value of MOBI "length" field; EXTH starts at offset (16 + mobiHeaderLength) in record 0
    // We place EXTH right after the MOBI header, so mobiHeaderLength = mobiOnlySize = 232
    const mobiHeaderLength = mobiOnlySize
    const exthOffset = 16 + mobiHeaderLength // = 248
    const titleOffset = exthOffset + exthData.byteLength
    const record0Size = titleOffset + titleBytes.byteLength
    const record0 = new ArrayBuffer(record0Size)
    const r0view = new DataView(record0)

    // PalmDOC header (bytes 0-15 of record 0)
    writeUint16(r0view, 0, compression)     // compression
    writeUint16(r0view, 2, 0)               // unused
    writeUint32(r0view, 4, textBytes.byteLength)  // text length (uncompressed)
    writeUint16(r0view, 8, textRecords.length)    // num text records
    writeUint16(r0view, 10, recordSize)     // record size
    writeUint16(r0view, 12, 0)              // encryption (none)
    writeUint16(r0view, 14, 0)              // padding

    // MOBI header (bytes 16+ of record 0, offsets match MOBI_HEADER struct)
    writeString(r0view, 16, 'MOBI')                         // magic [16]
    writeUint32(r0view, 20, mobiHeaderLength)               // header length [20]
    writeUint32(r0view, 24, 2)                              // type [24] (2 = Mobipocket book)
    writeUint32(r0view, 28, 65001)                          // encoding [28] (UTF-8)
    writeUint32(r0view, 32, 12345678)                       // unique ID [32]
    writeUint32(r0view, 36, version)                        // version [36] (6 = MOBI6)
    writeUint32(r0view, 84, titleOffset)                    // title offset [84]
    writeUint32(r0view, 88, titleBytes.byteLength)          // title length [88]
    // locale: byte 94 = region, byte 95 = language
    r0view.setUint8(94, 0)    // region [94]
    r0view.setUint8(95, 9)    // language [95] (9 = English)
    // resourceStart: record index where resources begin
    const resourceStartRecord = 1 + textRecords.length
    writeUint32(r0view, 108, resourceStartRecord)           // [108]
    // huffcdic: no HUFF/CDIC
    writeUint32(r0view, 112, 0xFFFFFFFF)                    // [112]
    writeUint32(r0view, 116, 0)                             // [116]
    // EXTH flag
    writeUint32(r0view, 128, 0b100_0000)                    // EXTH present [128]
    // trailing flags (none)
    writeUint32(r0view, 240, 0)                             // [240]
    // INDX: no INDX
    writeUint32(r0view, 244, 0xFFFFFFFF)                    // [244]

    // Write EXTH data at correct offset
    const r0bytes = new Uint8Array(record0)
    r0bytes.set(new Uint8Array(exthData), exthOffset)

    // Write title
    r0bytes.set(titleBytes, titleOffset)

    // Calculate total records: record 0 + text records + (optional resource records)
    const numRecords = 1 + textRecords.length

    // Build PDB header (78 bytes)
    const pdbHeader = new ArrayBuffer(78)
    const pdbView = new DataView(pdbHeader)
    writeString(pdbView, 0, title.slice(0, 31).padEnd(32, '\0'))
    writeUint16(pdbView, 32, 0)   // attributes
    writeUint16(pdbView, 34, 0)   // version
    // creation/modification/backup dates (12 bytes, zeros)
    // numRecords at offset 76 (2 bytes)
    writeUint16(pdbView, 76, numRecords)
    // type and creator at offsets 60 and 64
    writeString(pdbView, 60, 'BOOK')    // type
    writeString(pdbView, 64, 'MOBI')    // creator

    // Build record offset table (8 bytes per record)
    const offsetTable = new ArrayBuffer(numRecords * 8)
    const otView = new DataView(offsetTable)

    // Record 0 starts after PDB header + offset table
    const dataStart = 78 + numRecords * 8
    let currentOffset = dataStart

    // Record 0
    writeUint32(otView, 0, currentOffset)
    writeUint32(otView, 4, 0) // attributes + uniqueID (packed)
    currentOffset += record0.byteLength

    // Text records
    for (let i = 0; i < textRecords.length; i++) {
        const idx = (i + 1) * 8
        writeUint32(otView, idx, currentOffset)
        writeUint32(otView, idx + 4, 0)
        currentOffset += textRecords[i].byteLength
    }

    // Assemble the file
    const parts: ArrayBuffer[] = [pdbHeader, offsetTable, record0]
    for (const rec of textRecords) {
        parts.push(rec.buffer.slice(rec.byteOffset, rec.byteOffset + rec.byteLength) as ArrayBuffer)
    }

    return concat(...parts)
}

/**
 * Create a test MOBI file as a Blob.
 */
export function createTestMOBIBlob(options: MOBIFixtureOptions = {}): Blob {
    return new Blob([createTestMOBI(options)])
}
