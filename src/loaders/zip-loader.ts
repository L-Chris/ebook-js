/**
 * Zip-based loader using @zip.js/zip.js.
 * Provides file-level access to zip archive contents.
 *
 * Handles malformed zip files through multiple fallback strategies:
 *
 * 1. **Prepended data correction** — detects uniformly-shifted offsets
 *    (common in self-extracting archives or files with prepended data)
 *    and patches Central Directory offsets before retrying zip.js.
 *
 * 2. **Per-entry local header fallback** — when individual entries have
 *    incorrect CD offsets, scans the file for actual Local File Header
 *    positions and extracts data directly using DecompressionStream.
 *
 * 3. **Full local-header-only fallback** — when the Central Directory is
 *    completely unreadable, builds the entry list and loader entirely
 *    from Local File Headers found by scanning the file.
 */

import type { Loader, LoaderEntry } from '../core/loader'

/** Internal zip entry shape */
interface ZipFileEntry {
    filename: string
    uncompressedSize: number
    compressedSize: number
    compressionMethod: number
    getData(writer: unknown): Promise<unknown>
}

/** Input types accepted by the zip loader */
export type ZipInput = File | Blob | ArrayBuffer

/** Duck-type check for Blob-like objects */
const isBlobLike = (obj: unknown): obj is Blob =>
    obj != null && typeof obj === 'object' && 'arrayBuffer' in obj && typeof (obj as Blob).slice === 'function'

// ============================================================================
// Zip format constants
// ============================================================================

const LOCAL_FILE_HEADER_SIG = 0x04034b50
const LOCAL_HEADER_SIZE = 30
const CENTRAL_DIR_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
const EOCD_MIN_SIZE = 22
const DATA_DESCRIPTOR_SIG = 0x08074b50

// ============================================================================
// Prepended data detection and correction
// ============================================================================

/**
 * Detect prepended data (self-extracting archive stub) by searching
 * for the first Local File Header signature from the start of the file.
 *
 * Returns the offset delta (0 if data starts at offset 0).
 *
 * @internal
 */
export async function findPrependedDataSize(blob: Blob): Promise<number> {
    // Read first 64KB to find the first PK\x03\x04
    const headerBuf = await blob.slice(0, Math.min(blob.size, 64 * 1024)).arrayBuffer()
    const bytes = new Uint8Array(headerBuf)

    for (let i = 0; i < bytes.length - 3; i++) {
        if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b &&
            bytes[i + 2] === 0x03 && bytes[i + 3] === 0x04) {
            if (i === 0) return 0

            // Validate it looks like a real local file header
            if (i + LOCAL_HEADER_SIZE > bytes.length) return 0
            const view = new DataView(headerBuf)
            const fileNameLength = view.getUint16(i + 26, true)
            if (fileNameLength === 0 || fileNameLength > 1024) return 0

            return i
        }
    }
    return 0
}

/**
 * Patch a zip ArrayBuffer to correct for prepended data.
 * Adjusts all Central Directory entry offsets and the EOCD CD offset
 * by subtracting the given delta.
 *
 * @internal
 */
export function correctPrependedData(buffer: ArrayBuffer, delta: number): ArrayBuffer {
    const result = buffer.slice(0)
    const bytes = new Uint8Array(result)
    const view = new DataView(result)

    // Find EOCD by searching backward
    let eocdOffset = -1
    const searchStart = Math.max(0, result.byteLength - EOCD_MIN_SIZE - 65535)
    for (let i = result.byteLength - EOCD_MIN_SIZE; i >= searchStart; i--) {
        if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b &&
            bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
            eocdOffset = i
            break
        }
    }
    if (eocdOffset < 0) return result // Can't fix without EOCD

    // Read CD info from EOCD
    const cdOffset = view.getUint32(eocdOffset + 16, true)
    const entryCount = view.getUint16(eocdOffset + 10, true)

    // Patch CD start offset
    const correctedCDOffset = Math.max(0, cdOffset - delta)
    view.setUint32(eocdOffset + 16, correctedCDOffset, true)

    // Patch each CD entry's local header offset
    let pos = correctedCDOffset
    for (let i = 0; i < entryCount; i++) {
        if (pos + 46 > result.byteLength) break
        const sig = view.getUint32(pos, true)
        if (sig !== CENTRAL_DIR_SIG) break

        const currentOffset = view.getUint32(pos + 42, true)
        const correctedOffset = Math.max(0, currentOffset - delta)
        view.setUint32(pos + 42, correctedOffset, true)

        const fileNameLength = view.getUint16(pos + 28, true)
        const extraFieldLength = view.getUint16(pos + 30, true)
        const commentLength = view.getUint16(pos + 32, true)
        pos += 46 + fileNameLength + extraFieldLength + commentLength
    }

    return result
}

// ============================================================================
// EOCD comment extraction
// ============================================================================

/**
 * Read the zip archive comment from the EOCD record.
 *
 * @internal
 */
export async function readZipComment(blob: Blob): Promise<string | null> {
    // EOCD is at least 22 bytes, at most 22 + 65535 (max comment)
    const readSize = Math.min(blob.size, 22 + 65535)
    const start = blob.size - readSize
    const buf = await blob.slice(start).arrayBuffer()
    const bytes = new Uint8Array(buf)
    const view = new DataView(buf)

    // Search backward for EOCD signature
    for (let i = buf.byteLength - 22; i >= 0; i--) {
        if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b &&
            bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
            const commentLength = view.getUint16(i + 20, true)
            if (commentLength === 0) return null
            const commentBytes = buf.slice(i + 22, i + 22 + commentLength)
            return new TextDecoder().decode(commentBytes)
        }
    }
    return null
}

// ============================================================================
// Fallback: manual extraction from local file headers
// ============================================================================

/**
 * Scan the entire file for local file headers (PK\x03\x04) and build
 * a filename -> byte-offset map. This is the ground truth for where
 * each entry's data actually lives in the file.
 *
 * @internal
 */
export async function buildLocalHeaderMap(blob: Blob): Promise<Map<string, number>> {
    const map = new Map<string, number>()
    const CHUNK = 256 * 1024
    const size = blob.size
    const positions: number[] = []

    // Pass 1: find all PK\x03\x04 signatures in chunks
    for (let start = 0; start < size; start += CHUNK - 3) {
        const end = Math.min(start + CHUNK, size)
        const buf = await blob.slice(start, end).arrayBuffer()
        const bytes = new Uint8Array(buf)
        for (let i = 0; i < bytes.length - 3; i++) {
            if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b &&
                bytes[i + 2] === 0x03 && bytes[i + 3] === 0x04) {
                positions.push(start + i)
            }
        }
    }

    // Pass 2: validate each signature and extract filename
    for (const pos of positions) {
        if (pos + LOCAL_HEADER_SIZE > size) continue
        const headerBuf = await blob.slice(pos, pos + LOCAL_HEADER_SIZE).arrayBuffer()
        const header = new DataView(headerBuf)
        if (header.getUint32(0, true) !== LOCAL_FILE_HEADER_SIG) continue
        const fileNameLength = header.getUint16(26, true)
        if (fileNameLength === 0 || fileNameLength > 1024) continue
        if (pos + LOCAL_HEADER_SIZE + fileNameLength > size) continue
        const nameBuf = await blob.slice(pos + LOCAL_HEADER_SIZE, pos + LOCAL_HEADER_SIZE + fileNameLength).arrayBuffer()
        const filename = new TextDecoder().decode(nameBuf)
        // Skip false positives: null bytes or Unicode replacement chars from compressed data
        if (!filename.includes('\0') && !/[�]/.test(filename)) {
            map.set(filename, pos)
        }
    }

    return map
}

/**
 * Find the next local file header offset after the given position.
 * Used to determine compressed data boundaries when data descriptors are present.
 */
function findNextLFHOffset(localHeaderMap: Map<string, number>, afterOffset: number): number {
    let next = -1
    for (const offset of localHeaderMap.values()) {
        if (offset > afterOffset && (next === -1 || offset < next)) {
            next = offset
        }
    }
    return next
}

/**
 * Extract entry data directly from the blob, bypassing zip.js.
 * Reads the local file header and decompresses the data.
 *
 * Handles data descriptors (bit 3 of general purpose flag): when the
 * local header has compressedSize = 0, uses the next local file header
 * position to determine data boundaries, then locates the data descriptor
 * to find the exact compressed data size.
 *
 * @internal
 */
export async function extractDirectly(
    blob: Blob,
    localOffset: number,
    localHeaderMap?: Map<string, number>,
): Promise<ArrayBuffer> {
    // Read local file header
    const headerBuf = await blob.slice(localOffset, localOffset + LOCAL_HEADER_SIZE).arrayBuffer()
    const header = new DataView(headerBuf)

    if (header.getUint32(0, true) !== LOCAL_FILE_HEADER_SIG) {
        throw new Error('Local file header not found')
    }

    const compressionMethod = header.getUint16(8, true)
    let compressedSize = header.getUint32(18, true) // 4 bytes, not 2
    const fileNameLength = header.getUint16(26, true)
    const extraFieldLength = header.getUint16(28, true)
    const dataStart = localOffset + LOCAL_HEADER_SIZE + fileNameLength + extraFieldLength

    if (compressedSize === 0) {
        // Data descriptor case: compressed size is stored after the compressed data.
        // Use the next LFH position (from our scan) as an upper boundary.
        if (!localHeaderMap) {
            throw new Error('Cannot determine compressed size (data descriptor)')
        }

        const nextLFH = findNextLFHOffset(localHeaderMap, localOffset)
        const upperBound = nextLFH > 0 ? nextLFH : blob.size

        // Read the region between dataStart and upperBound to find the
        // data descriptor (PK\x07\x08) at the end
        const regionSize = upperBound - dataStart
        if (regionSize <= 0) throw new Error('No data between headers')

        const regionBuf = await blob.slice(dataStart, upperBound).arrayBuffer()
        const regionView = new DataView(regionBuf)

        // Search backward for the data descriptor signature
        let found = false
        for (let i = regionBuf.byteLength - 16; i >= 0; i--) {
            if (regionView.getUint32(i, true) === DATA_DESCRIPTOR_SIG) {
                const descCompSize = regionView.getUint32(i + 8, true)
                if (dataStart + descCompSize === localOffset + LOCAL_HEADER_SIZE + fileNameLength + extraFieldLength + descCompSize) {
                    compressedSize = descCompSize
                    found = true
                    break
                }
            }
        }

        // Try descriptor without signature (some zip writers omit PK\x07\x08)
        if (!found) {
            for (let i = regionBuf.byteLength - 12; i >= 0; i--) {
                // Descriptor without sig: CRC32(4) + compressedSize(4) + uncompressedSize(4)
                const descCompSize = regionView.getUint32(i + 4, true)
                if (dataStart + descCompSize + 12 === upperBound ||
                    dataStart + descCompSize + 16 === upperBound) {
                    compressedSize = descCompSize
                    found = true
                    break
                }
            }
        }

        if (!found) {
            // Last resort: assume compressed data extends to next header.
            // Works for stored (uncompressed) entries; may fail for deflated.
            compressedSize = regionSize
        }
    }

    const compressedData = blob.slice(dataStart, dataStart + compressedSize)

    // Method 0: stored (no compression)
    if (compressionMethod === 0) {
        return compressedData.arrayBuffer()
    }

    // Method 8: deflate
    if (compressionMethod === 8) {
        if (typeof DecompressionStream === 'undefined') {
            throw new Error('DecompressionStream API not available')
        }
        const stream = compressedData.stream()
            .pipeThrough(new DecompressionStream('deflate-raw'))
        return new Response(stream).arrayBuffer()
    }

    throw new Error(`Unsupported compression method: ${compressionMethod}`)
}

// ============================================================================
// Fallback loader from local headers only
// ============================================================================

/**
 * Build a Loader using only the local header map, without zip.js.
 * Used as last resort when the Central Directory is completely unreadable.
 */
function buildFallbackLoader(
    blob: Blob,
    localHeaderMap: Map<string, number>,
): Loader {
    const filenames = [...localHeaderMap.keys()]
    const entries: LoaderEntry[] = filenames.map(filename => ({
        filename,
        size: 0, // Unknown without CD
    }))

    const loadText = async (filename: string): Promise<string | null> => {
        const localOffset = localHeaderMap.get(filename)
        if (localOffset === undefined) return null
        try {
            const buffer = await extractDirectly(blob, localOffset, localHeaderMap)
            return new TextDecoder().decode(buffer)
        } catch {
            return null
        }
    }

    const loadBlob = async (filename: string, type?: string): Promise<Blob | null> => {
        const localOffset = localHeaderMap.get(filename)
        if (localOffset === undefined) return null
        try {
            const buffer = await extractDirectly(blob, localOffset, localHeaderMap)
            return new Blob([buffer], { type: type ?? '' })
        } catch {
            return null
        }
    }

    const getSize = (_filename: string): number => 0

    return { entries, loadText, loadBlob, getSize, getComment: () => readZipComment(blob) }
}

// ============================================================================
// Zip Loader
// ============================================================================

/**
 * Create a Loader from a File/Blob/ArrayBuffer that is a zip archive.
 *
 * Uses @zip.js/zip.js for reading, with multiple fallback strategies for
 * malformed zip files:
 *
 * 1. Prepended data correction (uniformly shifted CD offsets)
 * 2. Per-entry local header extraction (individually corrupted CD offsets)
 * 3. Full local-header-only loader (completely destroyed Central Directory)
 */
export async function createZipLoader(input: ZipInput): Promise<Loader> {
    const { configure, ZipReader, BlobReader, Uint8ArrayReader, TextWriter, BlobWriter } =
        await import('@zip.js/zip.js')

    configure({ useWebWorkers: false })

    // Create the Blob for fallback extraction
    const blob: Blob = isBlobLike(input)
        ? input
        : new Blob([input])

    // Build local header map upfront — needed for all fallback paths
    const localHeaderMap = await buildLocalHeaderMap(blob)

    // --- Try zip.js with original input ---
    let reader: InstanceType<typeof ZipReader>
    let entries: ZipFileEntry[]

    try {
        reader = isBlobLike(input)
            ? new ZipReader(new BlobReader(input))
            : new ZipReader(new Uint8ArrayReader(new Uint8Array(input)))
        entries = await reader.getEntries() as unknown as ZipFileEntry[]
    } catch {
        // --- Try prepended data correction ---
        const delta = await findPrependedDataSize(blob)
        if (delta > 0) {
            try {
                const originalBuf = await blob.arrayBuffer()
                const corrected = correctPrependedData(originalBuf, delta)
                const correctedBlob = new Blob([corrected])
                reader = new ZipReader(new BlobReader(correctedBlob))
                entries = await reader.getEntries() as unknown as ZipFileEntry[]
            } catch {
                // --- Last resort: local-header-only fallback ---
                return buildFallbackLoader(blob, localHeaderMap)
            }
        } else {
            // --- Last resort: local-header-only fallback ---
            return buildFallbackLoader(blob, localHeaderMap)
        }
    }

    const map = new Map(entries.map(entry => [entry.filename, entry]))

    const loadText = async (filename: string): Promise<string | null> => {
        const entry = map.get(filename)
        if (!entry) return null
        try {
            return await entry.getData(new TextWriter()) as string
        } catch {
            const localOffset = localHeaderMap.get(filename)
            if (localOffset === undefined) return null
            try {
                const buffer = await extractDirectly(blob, localOffset, localHeaderMap)
                return new TextDecoder().decode(buffer)
            } catch {
                return null
            }
        }
    }

    const loadBlob = async (filename: string, type?: string): Promise<Blob | null> => {
        const entry = map.get(filename)
        if (!entry) return null
        try {
            return await entry.getData(new BlobWriter(type)) as Blob
        } catch {
            const localOffset = localHeaderMap.get(filename)
            if (localOffset === undefined) return null
            try {
                const buffer = await extractDirectly(blob, localOffset, localHeaderMap)
                return new Blob([buffer], { type: type ?? '' })
            } catch {
                return null
            }
        }
    }

    const getSize = (filename: string): number => {
        return map.get(filename)?.uncompressedSize ?? 0
    }

    return {
        entries: entries.map(entry => ({
            filename: entry.filename,
            size: entry.uncompressedSize,
        })),
        loadText,
        loadBlob,
        getSize,
        getComment: () => readZipComment(blob),
    }
}

/**
 * Check if a File/Blob is a zip archive by reading its magic bytes.
 */
export async function isZipFile(input: ZipInput): Promise<boolean> {
    let buffer: ArrayBuffer
    if (isBlobLike(input)) {
        if (input.size < 4) return false
        buffer = await input.slice(0, 4).arrayBuffer()
    } else {
        if (input.byteLength < 4) return false
        buffer = input.slice(0, 4)
    }
    const arr = new Uint8Array(buffer)
    return arr[0] === 0x50 && arr[1] === 0x4b && arr[2] === 0x03 && arr[3] === 0x04
}
