/**
 * Test fixture: malformed zip generator
 *
 * Creates valid and intentionally malformed zip archives for testing
 * the zip-loader's fallback mechanisms.
 */

import { configure, ZipWriter, BlobWriter, TextReader } from '@zip.js/zip.js'

configure({ useWebWorkers: false })

// ============================================================================
// Zip format constants
// ============================================================================

const LOCAL_FILE_HEADER_SIG = 0x04034b50
const CENTRAL_DIR_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50

// ============================================================================
// Valid zip creation
// ============================================================================

export interface ZipFile {
    name: string
    content: string
}

/**
 * Generate a valid zip archive as ArrayBuffer.
 */
export async function createValidZip(files: ZipFile[]): Promise<ArrayBuffer> {
    const blobWriter = new BlobWriter()
    const zipWriter = new ZipWriter(blobWriter)

    for (const file of files) {
        await zipWriter.add(file.name, new TextReader(file.content))
    }

    await zipWriter.close()
    const blob = await blobWriter.getData()
    return blob.arrayBuffer()
}

// ============================================================================
// Binary helpers for zip manipulation
// ============================================================================

/**
 * Find the End of Central Directory record by searching backward for PK\x05\x06.
 * Returns the absolute offset of the EOCD signature.
 */
function findEOCD(buffer: ArrayBuffer): number {
    const bytes = new Uint8Array(buffer)
    // EOCD is at least 22 bytes, at most 22 + 65535 (max comment length)
    const maxComment = 65535
    const minStart = Math.max(0, buffer.byteLength - 22 - maxComment)

    for (let i = buffer.byteLength - 22; i >= minStart; i--) {
        if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b &&
            bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
            return i
        }
    }
    throw new Error('EOCD record not found')
}

/**
 * Get Central Directory start offset and entry count from EOCD.
 */
function getCDInfo(buffer: ArrayBuffer, eocdOffset: number): { cdOffset: number; cdSize: number; entryCount: number } {
    const view = new DataView(buffer)
    const entryCount = view.getUint16(eocdOffset + 10, true)
    const cdSize = view.getUint32(eocdOffset + 12, true)
    const cdOffset = view.getUint32(eocdOffset + 16, true)
    return { cdOffset, cdSize, entryCount }
}

/**
 * Iterate Central Directory entries, returning an array of
 * { filename, cdEntryOffset } objects.
 */
function getCDEntries(buffer: ArrayBuffer, cdOffset: number, entryCount: number): Array<{ filename: string; offset: number }> {
    const view = new DataView(buffer)
    const bytes = new Uint8Array(buffer)
    const entries: Array<{ filename: string; offset: number }> = []
    let pos = cdOffset

    for (let i = 0; i < entryCount; i++) {
        const sig = view.getUint32(pos, true)
        if (sig !== CENTRAL_DIR_SIG) {
            throw new Error(`Expected CD entry signature at offset ${pos}, got 0x${sig.toString(16)}`)
        }

        const fileNameLength = view.getUint16(pos + 28, true)
        const extraFieldLength = view.getUint16(pos + 30, true)
        const commentLength = view.getUint16(pos + 32, true)

        const nameBytes = bytes.slice(pos + 46, pos + 46 + fileNameLength)
        const filename = new TextDecoder().decode(nameBytes)

        entries.push({ filename, offset: pos })
        pos += 46 + fileNameLength + extraFieldLength + commentLength
    }

    return entries
}

// ============================================================================
// Malformed zip generators
// ============================================================================

/**
 * Corrupt the Central Directory offset for a specific entry.
 * Sets the entry's "relative offset of local file header" to an invalid value,
 * causing zip.js to fail on that entry while the local header remains intact.
 */
export function corruptCDOffset(buffer: ArrayBuffer, filename: string): ArrayBuffer {
    const result = buffer.slice(0)
    const eocdOffset = findEOCD(result)
    const { cdOffset, entryCount } = getCDInfo(result, eocdOffset)
    const entries = getCDEntries(result, cdOffset, entryCount)

    const target = entries.find(e => e.filename === filename)
    if (!target) throw new Error(`Entry "${filename}" not found in CD`)

    const view = new DataView(result)
    // Write an invalid offset (0 will usually point to the first LFH, not this entry's)
    view.setUint32(target.offset + 42, 0xFFFFFFFF, true)

    return result
}

/**
 * Shift ALL Central Directory entry offsets by a fixed delta.
 * This simulates the case where data was prepended to the zip
 * (e.g., self-extracting archive stub) but CD offsets weren't updated.
 */
export function shiftAllCDOffsets(buffer: ArrayBuffer, delta: number): ArrayBuffer {
    const result = buffer.slice(0)
    const eocdOffset = findEOCD(result)
    const { cdOffset, entryCount } = getCDInfo(result, eocdOffset)
    const entries = getCDEntries(result, cdOffset, entryCount)
    const view = new DataView(result)

    for (const entry of entries) {
        const current = view.getUint32(entry.offset + 42, true)
        const shifted = Math.max(0, current + delta)
        view.setUint32(entry.offset + 42, shifted, true)
    }

    return result
}

/**
 * Prepend garbage bytes to a valid zip to simulate a self-extracting archive.
 * The local headers shift forward, but the CD still references the original offsets.
 */
export function createPrependedZip(buffer: ArrayBuffer, prependSize: number = 1024): ArrayBuffer {
    const garbage = new Uint8Array(prependSize)
    // Fill with non-PK bytes to avoid false positive LFH signatures
    garbage.fill(0x00)

    const combined = new Uint8Array(prependSize + buffer.byteLength)
    combined.set(garbage, 0)
    combined.set(new Uint8Array(buffer), prependSize)
    return combined.buffer
}

/**
 * Completely destroy the Central Directory by zeroing it out.
 * Only local file headers remain — tests the full fallback scan path.
 */
export function destroyCD(buffer: ArrayBuffer): ArrayBuffer {
    const result = buffer.slice(0)
    const eocdOffset = findEOCD(result)
    const { cdOffset, cdSize } = getCDInfo(result, eocdOffset)

    // Zero out the entire Central Directory
    const bytes = new Uint8Array(result)
    bytes.fill(0, cdOffset, cdOffset + cdSize)

    return result
}
