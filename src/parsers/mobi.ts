/**
 * MOBI / AZW / AZW3 parser.
 *
 * Ports foliate-js mobi.js to TypeScript with rebook architecture.
 * Supports both legacy Mobipocket (MOBI6, version < 8) and modern
 * Kindle Format 8 (KF8/AZW3, version >= 8).
 *
 * Architecture:
 *   PDB → low-level Palm Database record access
 *   MOBI → headers, decompression, metadata, resource loading
 *   MOBI6 → legacy format: pagebreak splitting, filepos anchors
 *   KF8 → modern format: skeleton/fragment tables, kindle: URIs
 *   MOBIParser → public Parser interface
 */

import type { Book, BookMetadata, Section, TOCItem, Landmark, Rendition, SectionDocument } from '../core/types'
import type { Parser, ParserInput, ParserOptions } from '../core/parser'
import type { DOMAdapter } from '../core/dom-adapter'
import type { URLFactory } from '../core/url-factory'
import { replaceSeries, unescapeHTML } from '../core/utils'
import { UnsupportedInputError, ParseError, CorruptedFileError, AdapterRequiredError } from '../core/errors'
import { normalizeContributors } from '../core/metadata'
import { parseHTML, createSectionDocument } from '../core/document'
import { extractDocumentBlocks, extractDocumentSegments } from '../core/pretext'

// ============================================================================
// Constants
// ============================================================================

const MIME_XHTML = 'application/xhtml+xml'
const MIME_HTML = 'text/html'
const MIME_XML = 'application/xml'
const MIME_CSS = 'text/css'
const MIME_SVG = 'image/svg+xml'



const MOBI_ENCODING: Record<number, string> = {
    1252: 'windows-1252',
    65001: 'utf-8',
}

const EXTH_RECORD_TYPE: Record<number, [string, string, boolean?]> = {
    100: ['creator', 'string', true],
    101: ['publisher', 'string'],
    103: ['description', 'string'],
    104: ['isbn', 'string'],
    105: ['subject', 'string', true],
    106: ['date', 'string'],
    108: ['contributor', 'string', true],
    109: ['rights', 'string'],
    110: ['subjectCode', 'string', true],
    112: ['source', 'string', true],
    113: ['asin', 'string'],
    121: ['boundary', 'uint'],
    122: ['fixedLayout', 'string'],
    125: ['numResources', 'uint'],
    126: ['originalResolution', 'string'],
    127: ['zeroGutter', 'string'],
    128: ['zeroMargin', 'string'],
    129: ['coverURI', 'string'],
    132: ['regionMagnification', 'string'],
    201: ['coverOffset', 'uint'],
    202: ['thumbnailOffset', 'uint'],
    503: ['title', 'string'],
    524: ['language', 'string', true],
    527: ['pageProgressionDirection', 'string'],
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MOBI_LANG: Record<number, any[]> = {
    1: ['ar', 'ar-SA', 'ar-IQ', 'ar-EG', 'ar-LY', 'ar-DZ', 'ar-MA', 'ar-TN', 'ar-OM',
        'ar-YE', 'ar-SY', 'ar-JO', 'ar-LB', 'ar-KW', 'ar-AE', 'ar-BH', 'ar-QA'],
    2: ['bg'], 3: ['ca'], 4: ['zh', 'zh-TW', 'zh-CN', 'zh-HK', 'zh-SG'], 5: ['cs'],
    6: ['da'], 7: ['de', 'de-DE', 'de-CH', 'de-AT', 'de-LU', 'de-LI'], 8: ['el'],
    9: ['en', 'en-US', 'en-GB', 'en-AU', 'en-CA', 'en-NZ', 'en-IE', 'en-ZA',
        'en-JM', null, 'en-BZ', 'en-TT', 'en-ZW', 'en-PH'],
    10: ['es', 'es-ES', 'es-MX', null, 'es-GT', 'es-CR', 'es-PA', 'es-DO',
        'es-VE', 'es-CO', 'es-PE', 'es-AR', 'es-EC', 'es-CL', 'es-UY', 'es-PY',
        'es-BO', 'es-SV', 'es-HN', 'es-NI', 'es-PR'],
    11: ['fi'], 12: ['fr', 'fr-FR', 'fr-BE', 'fr-CA', 'fr-CH', 'fr-LU', 'fr-MC'],
    13: ['he'], 14: ['hu'], 15: ['is'], 16: ['it', 'it-IT', 'it-CH'],
    17: ['ja'], 18: ['ko'], 19: ['nl', 'nl-NL', 'nl-BE'], 20: ['no', 'nb', 'nn'],
    21: ['pl'], 22: ['pt', 'pt-BR', 'pt-PT'], 23: ['rm'], 24: ['ro'], 25: ['ru'],
    26: ['hr', null, 'sr'], 27: ['sk'], 28: ['sq'], 29: ['sv', 'sv-SE', 'sv-FI'],
    30: ['th'], 31: ['tr'], 32: ['ur'], 33: ['id'], 34: ['uk'], 35: ['be'],
    36: ['sl'], 37: ['et'], 38: ['lv'], 39: ['lt'], 41: ['fa'], 42: ['vi'],
    43: ['hy'], 44: ['az'], 45: ['eu'], 46: ['hsb'], 47: ['mk'], 48: ['st'],
    49: ['ts'], 50: ['tn'], 52: ['xh'], 53: ['zu'], 54: ['af'], 55: ['ka'],
    56: ['fo'], 57: ['hi'], 58: ['mt'], 59: ['se'], 62: ['ms'], 63: ['kk'],
    65: ['sw'], 67: ['uz', null, 'uz-UZ'], 68: ['tt'], 69: ['bn'], 70: ['pa'],
    71: ['gu'], 72: ['or'], 73: ['ta'], 74: ['te'], 75: ['kn'], 76: ['ml'],
    77: ['as'], 78: ['mr'], 79: ['sa'], 82: ['cy', 'cy-GB'], 83: ['gl', 'gl-ES'],
    87: ['kok'], 97: ['ne'], 98: ['fy'],
}

// ============================================================================
// Struct Definitions
// ============================================================================

type StructField = [offset: number, length: number, type: 'string' | 'uint']
type StructDef = Record<string, StructField>

const PDB_HEADER: StructDef = {
    name: [0, 32, 'string'],
    type: [60, 4, 'string'],
    creator: [64, 4, 'string'],
    numRecords: [76, 2, 'uint'],
}

const PALMDOC_HEADER: StructDef = {
    compression: [0, 2, 'uint'],
    numTextRecords: [8, 2, 'uint'],
    recordSize: [10, 2, 'uint'],
    encryption: [12, 2, 'uint'],
}

const MOBI_HEADER: StructDef = {
    magic: [16, 4, 'string'],
    length: [20, 4, 'uint'],
    type: [24, 4, 'uint'],
    encoding: [28, 4, 'uint'],
    uid: [32, 4, 'uint'],
    version: [36, 4, 'uint'],
    titleOffset: [84, 4, 'uint'],
    titleLength: [88, 4, 'uint'],
    localeRegion: [94, 1, 'uint'],
    localeLanguage: [95, 1, 'uint'],
    resourceStart: [108, 4, 'uint'],
    huffcdic: [112, 4, 'uint'],
    numHuffcdic: [116, 4, 'uint'],
    exthFlag: [128, 4, 'uint'],
    trailingFlags: [240, 4, 'uint'],
    indx: [244, 4, 'uint'],
}

const KF8_HEADER: StructDef = {
    resourceStart: [108, 4, 'uint'],
    fdst: [192, 4, 'uint'],
    numFdst: [196, 4, 'uint'],
    frag: [248, 4, 'uint'],
    skel: [252, 4, 'uint'],
    guide: [260, 4, 'uint'],
}

const EXTH_HEADER: StructDef = {
    magic: [0, 4, 'string'],
    length: [4, 4, 'uint'],
    count: [8, 4, 'uint'],
}

const INDX_HEADER: StructDef = {
    magic: [0, 4, 'string'],
    length: [4, 4, 'uint'],
    type: [8, 4, 'uint'],
    idxt: [20, 4, 'uint'],
    numRecords: [24, 4, 'uint'],
    encoding: [28, 4, 'uint'],
    language: [32, 4, 'uint'],
    total: [36, 4, 'uint'],
    ordt: [40, 4, 'uint'],
    ligt: [44, 4, 'uint'],
    numLigt: [48, 4, 'uint'],
    numCncx: [52, 4, 'uint'],
}

const TAGX_HEADER: StructDef = {
    magic: [0, 4, 'string'],
    length: [4, 4, 'uint'],
    numControlBytes: [8, 4, 'uint'],
}

const HUFF_HEADER: StructDef = {
    magic: [0, 4, 'string'],
    offset1: [8, 4, 'uint'],
    offset2: [12, 4, 'uint'],
}

const CDIC_HEADER: StructDef = {
    magic: [0, 4, 'string'],
    length: [4, 4, 'uint'],
    numEntries: [8, 4, 'uint'],
    codeLength: [12, 4, 'uint'],
}

const FDST_HEADER: StructDef = {
    magic: [0, 4, 'string'],
    numEntries: [8, 4, 'uint'],
}

const FONT_HEADER: StructDef = {
    flags: [8, 4, 'uint'],
    dataStart: [12, 4, 'uint'],
    keyLength: [16, 4, 'uint'],
    keyStart: [20, 4, 'uint'],
}

// ============================================================================
// Binary Parsing Helpers
// ============================================================================

const textDecoder = new TextDecoder()
const getString = (buffer: ArrayBuffer): string => textDecoder.decode(buffer)

const getUint = (buffer: ArrayBuffer): number | undefined => {
    if (!buffer || buffer.byteLength === 0) return undefined
    const l = buffer.byteLength
    const view = new DataView(buffer)
    if (l === 4) return view.getUint32(0)
    if (l === 2) return view.getUint16(0)
    return view.getUint8(0)
}

const getStruct = (def: StructDef, buffer: ArrayBuffer): Record<string, string | number | undefined> => {
    return Object.fromEntries(
        Object.entries(def).map(([key, [start, len, type]]) => [
            key,
            (type === 'string' ? getString : getUint)(buffer.slice(start, start + len)),
        ])
    )
}

const getDecoder = (encoding: number | string | undefined): TextDecoder => {
    const enc = typeof encoding === 'number' ? MOBI_ENCODING[encoding] : undefined
    return new TextDecoder(enc)
}

/**
 * Variable-length quantity: reads 7-bit VLQ from start of byte array.
 */
const getVarLen = (byteArray: Uint8Array, i = 0): { value: number; length: number } => {
    let value = 0, length = 0
    for (const byte of byteArray.subarray(i, i + 4)) {
        value = (value << 7) | (byte & 0b111_1111) >>> 0
        length++
        if (byte & 0b1000_0000) break
    }
    return { value, length }
}

/**
 * Variable-length quantity read from the end of data.
 */
const getVarLenFromEnd = (byteArray: Uint8Array): number => {
    let value = 0
    for (const byte of byteArray.subarray(-4)) {
        if (byte & 0b1000_0000) value = 0
        value = (value << 7) | (byte & 0b111_1111)
    }
    return value
}

const countBitsSet = (x: number): number => {
    let count = 0
    for (; x > 0; x = x >> 1) if ((x & 1) === 1) count++
    return count
}

const countUnsetEnd = (x: number): number => {
    let count = 0
    while ((x & 1) === 0) { x = x >> 1; count++ }
    return count
}

const concatTypedArray = (a: Uint8Array, b: Uint8Array): Uint8Array => {
    const result = new Uint8Array(a.length + b.length)
    result.set(a)
    result.set(b, a.length)
    return result
}

const concatTypedArray3 = (a: Uint8Array, b: Uint8Array, c: Uint8Array): Uint8Array => {
    const result = new Uint8Array(a.length + b.length + c.length)
    result.set(a)
    result.set(b, a.length)
    result.set(c, a.length + b.length)
    return result
}

/**
 * Convert raw bytes to string preserving each byte as a character.
 * Critical for MOBI6 where filepos values are byte offsets.
 */
const rawBytesToString = (uint8Array: Uint8Array): string => {
    const chunkSize = 0x8000
    let result = ''
    for (let i = 0; i < uint8Array.length; i += chunkSize) {
        result += String.fromCharCode.apply(null, Array.from(uint8Array.subarray(i, i + chunkSize)))
    }
    return result
}

// ============================================================================
// Decompression
// ============================================================================

/**
 * PalmDOC LZ77 variant decompression.
 */
const decompressPalmDOC = (array: Uint8Array): Uint8Array => {
    const output: number[] = []
    for (let i = 0; i < array.length; i++) {
        const byte = array[i]
        if (byte === 0) output.push(0)
        else if (byte <= 8)
            for (const x of array.subarray(i + 1, (i += byte) + 1))
                output.push(x)
        else if (byte <= 0b0111_1111) output.push(byte)
        else if (byte <= 0b1011_1111) {
            const bytes = (byte << 8) | array[i++ + 1]
            const distance = (bytes & 0b0011_1111_1111_1111) >>> 3
            const length = (bytes & 0b111) + 3
            for (let j = 0; j < length; j++)
                output.push(output[output.length - distance])
        }
        else output.push(32, byte ^ 0b1000_0000)
    }
    return Uint8Array.from(output)
}

/**
 * Read 32 bits from a byte array at a given bit position.
 */
const read32Bits = (byteArray: Uint8Array, from: number): bigint => {
    const startByte = from >> 3
    const end = from + 32
    const endByte = end >> 3
    let bits = 0n
    for (let i = startByte; i <= endByte; i++)
        bits = bits << 8n | BigInt(byteArray[i] ?? 0)
    return (bits >> (8n - BigInt(end & 7))) & 0xffffffffn
}

/**
 * HUFF/CDIC decompression setup.
 */
const huffcdic = async (
    mobi: { huffcdic: number | string | undefined; numHuffcdic: number | string | undefined },
    loadRecord: (index: number) => Promise<ArrayBuffer>,
): Promise<(byteArray: Uint8Array) => Uint8Array> => {
    const huffRecord = await loadRecord(mobi.huffcdic as number)
    const { magic, offset1, offset2 } = getStruct(HUFF_HEADER, huffRecord)
    if (magic !== 'HUFF') throw new CorruptedFileError('Invalid HUFF record', 'mobi')

    const off1 = offset1 as number
    const off2 = offset2 as number

    // table1 is indexed by byte value
    const table1 = Array.from({ length: 256 }, (_, i) => off1 + i * 4)
        .map(offset => getUint(huffRecord.slice(offset, offset + 4))!)
        .map(x => [x & 0b1000_0000, x & 0b1_1111, x >>> 8] as [number, number, number])

    // table2 is indexed by code length
    const table2: ([number, number] | null)[] = ([null] as ([number, number] | null)[]).concat(
        Array.from({ length: 32 }, (_, i) => off2 + i * 8)
            .map(offset => [
                getUint(huffRecord.slice(offset, offset + 4))!,
                getUint(huffRecord.slice(offset + 4, offset + 8))!,
            ] as [number, number])
    )

    const dictionary: [Uint8Array, boolean][] = []
    const numHuffcdic = mobi.numHuffcdic as number
    for (let i = 1; i < numHuffcdic; i++) {
        const record = await loadRecord((mobi.huffcdic as number) + i)
        const cdic = getStruct(CDIC_HEADER, record)
        if (cdic.magic !== 'CDIC') throw new CorruptedFileError('Invalid CDIC record', 'mobi')
        const n = Math.min(1 << (cdic.codeLength as number), (cdic.numEntries as number) - dictionary.length)
        const buffer = record.slice(cdic.length as number)
        for (let j = 0; j < n; j++) {
            const offset = getUint(buffer.slice(j * 2, j * 2 + 2))!
            const x = getUint(buffer.slice(offset, offset + 2))!
            const length = x & 0x7fff
            const decompressed = x & 0x8000
            const value = new Uint8Array(buffer.slice(offset + 2, offset + 2 + length))
            dictionary.push([value, !!decompressed])
        }
    }

    const decompress = (byteArray: Uint8Array): Uint8Array => {
        let output: Uint8Array = new Uint8Array()
        const bitLength = byteArray.byteLength * 8
        for (let i = 0; i < bitLength;) {
            const bits = Number(read32Bits(byteArray, i))
            let [found, codeLength, value] = table1[bits >>> 24]
            if (!found) {
                while (bits >>> (32 - codeLength) < table2[codeLength]![0])
                    codeLength += 1
                value = table2[codeLength]![1]
            }
            if ((i += codeLength) > bitLength) break

            const code = value - (bits >>> (32 - codeLength))
            let [result, isDecompressed] = dictionary[code]
            if (!isDecompressed) {
                result = decompress(result)
                dictionary[code] = [result, true]
            }
            output = concatTypedArray(output, result as Uint8Array)
        }
        return output
    }
    return decompress
}

// ============================================================================
// Index Parsing (INDX/TAGX/CNCX)
// ============================================================================

interface IndexEntry {
    name: string
    tagMap: Record<number, number[]>
}

interface IndexData {
    table: IndexEntry[]
    cncx: Record<number, string>
}

const getIndexData = async (
    indxIndex: number,
    loadRecord: (index: number) => Promise<ArrayBuffer>,
): Promise<IndexData> => {
    const indxRecord = await loadRecord(indxIndex)
    const indx = getStruct(INDX_HEADER, indxRecord)
    if (indx.magic !== 'INDX') throw new CorruptedFileError('Invalid INDX record', 'mobi')
    const decoder = getDecoder(indx.encoding)

    const tagxBuffer = indxRecord.slice(indx.length as number)
    const tagx = getStruct(TAGX_HEADER, tagxBuffer)
    if (tagx.magic !== 'TAGX') throw new CorruptedFileError('Invalid TAGX section', 'mobi')
    const numTags = ((tagx.length as number) - 12) / 4
    const tagTable = Array.from({ length: numTags }, (_, i) =>
        new Uint8Array(tagxBuffer.slice(12 + i * 4, 12 + i * 4 + 4)))

    const cncx: Record<number, string> = {}
    let cncxRecordOffset = 0
    const numCncx = indx.numCncx as number
    for (let i = 0; i < numCncx; i++) {
        const record = await loadRecord(indxIndex + (indx.numRecords as number) + i + 1)
        const array = new Uint8Array(record)
        for (let pos = 0; pos < array.byteLength;) {
            const index = pos
            const { value, length } = getVarLen(array, pos)
            pos += length
            const result = record.slice(pos, pos + value)
            pos += value
            cncx[cncxRecordOffset + index] = decoder.decode(result)
        }
        cncxRecordOffset += 0x10000
    }

    const table: IndexEntry[] = []
    const numIndxRecords = indx.numRecords as number
    for (let i = 0; i < numIndxRecords; i++) {
        const record = await loadRecord(indxIndex + 1 + i)
        const array = new Uint8Array(record)
        const subIndx = getStruct(INDX_HEADER, record)
        if (subIndx.magic !== 'INDX') throw new CorruptedFileError('Invalid INDX record', 'mobi')
        const subNumRecords = subIndx.numRecords as number
        for (let j = 0; j < subNumRecords; j++) {
            const offsetOffset = (subIndx.idxt as number) + 4 + 2 * j
            const offset = getUint(record.slice(offsetOffset, offsetOffset + 2))!

            const length = getUint(record.slice(offset, offset + 1))!
            const name = getString(record.slice(offset + 1, offset + 1 + length))

            const tags: [number, number | null, number | null, number][] = []
            const startPos = offset + 1 + length
            let controlByteIndex = 0
            let pos = startPos + (tagx.numControlBytes as number)
            for (const [tag, numValues, mask, end] of tagTable) {
                if (end & 1) {
                    controlByteIndex++
                    continue
                }
                const off = startPos + controlByteIndex
                const value = getUint(record.slice(off, off + 1))! & mask
                if (value === mask) {
                    if (countBitsSet(mask) > 1) {
                        const vl = getVarLen(array, pos)
                        tags.push([tag, null, vl.value, numValues])
                        pos += vl.length
                    } else tags.push([tag, 1, null, numValues])
                } else tags.push([tag, value >> countUnsetEnd(mask), null, numValues])
            }

            const tagMap: Record<number, number[]> = {}
            for (const [tag, valueCount, valueBytes, numVals] of tags) {
                const values: number[] = []
                if (valueCount != null) {
                    for (let k = 0; k < valueCount * numVals; k++) {
                        const vl = getVarLen(array, pos)
                        values.push(vl.value)
                        pos += vl.length
                    }
                } else {
                    let count = 0
                    while (count < (valueBytes ?? 0)) {
                        const vl = getVarLen(array, pos)
                        values.push(vl.value)
                        pos += vl.length
                        count += vl.length
                    }
                }
                tagMap[tag] = values
            }
            table.push({ name, tagMap })
        }
    }
    return { table, cncx }
}

interface NCXItem {
    index: number
    label: string
    headingLevel: number
    pos: number[] | undefined
    children?: NCXItem[]
    [key: string]: unknown
}

const getNCX = async (
    indxIndex: number,
    loadRecord: (index: number) => Promise<ArrayBuffer>,
): Promise<NCXItem[]> => {
    const { table, cncx } = await getIndexData(indxIndex, loadRecord)
    const items: NCXItem[] = table.map(({ tagMap }, index) => ({
        index,
        offset: tagMap[1]?.[0],
        size: tagMap[2]?.[0],
        label: cncx[tagMap[3]?.[0] as number] ?? '',
        headingLevel: tagMap[4]?.[0] ?? 0,
        pos: tagMap[6],
        parent: tagMap[21]?.[0],
        firstChild: tagMap[22]?.[0],
        lastChild: tagMap[23]?.[0],
    }))
    const getChildren = (item: NCXItem): NCXItem => {
        if (item.firstChild == null) return item
        item.children = items.filter(x => x.parent === item.index).map(getChildren)
        return item
    }
    return items.filter(item => item.headingLevel === 0).map(getChildren)
}

// ============================================================================
// EXTH Metadata
// ============================================================================

interface EXTHData {
    [key: string]: string | number | string[] | undefined
}

const getEXTH = (buf: ArrayBuffer, encoding: number | string | undefined): EXTHData => {
    const { magic, count } = getStruct(EXTH_HEADER, buf)
    if (magic !== 'EXTH') throw new CorruptedFileError('Invalid EXTH header', 'mobi')
    const decoder = getDecoder(encoding)
    const results: EXTHData = {}
    let offset = 12
    for (let i = 0; i < (count as number); i++) {
        const type = getUint(buf.slice(offset, offset + 4))!
        const length = getUint(buf.slice(offset + 4, offset + 8))!
        if (type in EXTH_RECORD_TYPE) {
            const [name, typ, many] = EXTH_RECORD_TYPE[type]
            const data = buf.slice(offset + 8, offset + length)
            const value = typ === 'uint' ? getUint(data)! : decoder.decode(data)
            if (many) {
                const arr = results[name] as string[] | undefined
                if (arr) (arr as string[]).push(value as string)
                else results[name] = [value as string]
            } else results[name] = value
        }
        offset += length
    }
    return results
}

// ============================================================================
// Font Handling
// ============================================================================

const getFont = async (buf: ArrayBuffer, unzlib?: (data: Uint8Array) => Uint8Array): Promise<Uint8Array> => {
    const { flags, dataStart, keyLength, keyStart } = getStruct(FONT_HEADER, buf)
    const array = new Uint8Array(buf.slice(dataStart as number))
    const f = flags as number
    // deobfuscate font
    if (f & 0b10) {
        const bytes = (keyLength as number) === 16 ? 1024 : 1040
        const key = new Uint8Array(buf.slice(keyStart as number, (keyStart as number) + (keyLength as number)))
        const length = Math.min(bytes, array.length)
        for (let i = 0; i < length; i++) array[i] = array[i] ^ key[i % key.length]
    }
    // decompress font
    if (f & 1) {
        try {
            if (unzlib) return unzlib(array)
        } catch (e) {
            console.warn('Failed to decompress font', e)
        }
    }
    return array
}

// ============================================================================
// PDB — Palm Database Container
// ============================================================================

interface PDBRecord {
    start: number
    end?: number
}

class PDB {
    file!: Blob
    offsets: PDBRecord[] = []
    pdb: Record<string, string | number | undefined> = {}

    async open(file: Blob): Promise<void> {
        this.file = file
        const headerBuf = await file.slice(0, 78).arrayBuffer()
        this.pdb = getStruct(PDB_HEADER, headerBuf)
        const numRecords = this.pdb.numRecords as number
        const buffer = await file.slice(78, 78 + numRecords * 8).arrayBuffer()
        const rawOffsets = Array.from({ length: numRecords },
            (_, i) => getUint(buffer.slice(i * 8, i * 8 + 4))!)
        this.offsets = rawOffsets.map((x, i, a) => ({ start: x, end: a[i + 1] }))
    }

    loadRecord(index: number): Promise<ArrayBuffer> {
        const offsets = this.offsets[index]
        if (!offsets) throw new CorruptedFileError('Record index out of bounds', 'mobi')
        return this.file.slice(offsets.start, offsets.end).arrayBuffer()
    }

    async loadMagic(index: number): Promise<string> {
        const start = this.offsets[index].start
        return getString(await this.file.slice(start, start + 4).arrayBuffer())
    }
}

// ============================================================================
// MOBI — Headers, Compression, Metadata
// ============================================================================

interface MOBIHeaders {
    palmdoc: Record<string, string | number | undefined>
    mobi: Record<string, string | number | undefined>
    exth: EXTHData | null
    kf8: Record<string, string | number | undefined> | null
}

class MOBI {
    #start = 0
    #resourceStart = 0
    #decoder!: TextDecoder
    #encoder = new TextEncoder()
    #decompress!: (data: Uint8Array) => Uint8Array
    #removeTrailingEntries!: (array: Uint8Array) => Uint8Array
    #pdb = new PDB()
    headers!: MOBIHeaders
    unzlib?: (data: Uint8Array) => Uint8Array

    constructor(opts?: { unzlib?: (data: Uint8Array) => Uint8Array }) {
        this.unzlib = opts?.unzlib
    }

    get pdbInfo() { return this.#pdb.pdb }

    async open(file: Blob, opts?: { domAdapter?: DOMAdapter; urlFactory?: URLFactory }): Promise<Book> {
        await this.#pdb.open(file)
        this.headers = this.#getHeaders(await this.#pdb.loadRecord(0))
        this.#resourceStart = this.headers.mobi.resourceStart as number
        let isKF8 = (this.headers.mobi.version as number) >= 8
        if (!isKF8) {
            const boundary = this.headers.exth?.boundary as number | undefined
            if (boundary != null && boundary < 0xffffffff) {
                try {
                    this.headers = this.#getHeaders(await this.#pdb.loadRecord(boundary))
                    this.#start = boundary
                    isKF8 = true
                } catch (e) {
                    console.warn('Failed to open KF8; falling back to MOBI', e)
                }
            }
        }
        await this.#setup()
        return isKF8 ? new KF8(this, opts).init() : new MOBI6(this, opts).init()
    }

    #getHeaders(buf: ArrayBuffer): MOBIHeaders {
        const palmdoc = getStruct(PALMDOC_HEADER, buf)
        const mobi = getStruct(MOBI_HEADER, buf)
        if (mobi.magic !== 'MOBI') throw new CorruptedFileError('Missing MOBI header', 'mobi')

        const titleOffset = mobi.titleOffset as number
        const titleLength = mobi.titleLength as number
        mobi.title = buf.slice(titleOffset, titleOffset + titleLength) as unknown as string
        const lang = MOBI_LANG[mobi.localeLanguage as number]
        mobi.language = lang?.[(mobi.localeRegion as number) >> 2] ?? lang?.[0]

        const exth = (mobi.exthFlag as number) & 0b100_0000
            ? getEXTH(buf.slice((mobi.length as number) + 16), mobi.encoding) : null
        const kf8 = (mobi.version as number) >= 8 ? getStruct(KF8_HEADER, buf) : null
        return { palmdoc, mobi, exth, kf8 }
    }

    async #setup(): Promise<void> {
        const { palmdoc, mobi } = this.headers
        this.#decoder = getDecoder(mobi.encoding)

        const compression = palmdoc.compression as number
        if (compression === 1) {
            this.#decompress = f => f
        } else if (compression === 2) {
            this.#decompress = decompressPalmDOC
        } else if (compression === 17480) {
            this.#decompress = await huffcdic(
                mobi as { huffcdic: number | string | undefined; numHuffcdic: number | string | undefined },
                this.loadRecord.bind(this),
            )
        } else {
            throw new ParseError(`Unknown compression type: ${compression}`, 'mobi')
        }

        const trailingFlags = mobi.trailingFlags as number
        const multibyte = trailingFlags & 1
        const numTrailingEntries = countBitsSet(trailingFlags >>> 1)
        this.#removeTrailingEntries = (array: Uint8Array): Uint8Array => {
            for (let i = 0; i < numTrailingEntries; i++) {
                const length = getVarLenFromEnd(array)
                array = array.subarray(0, -length)
            }
            if (multibyte) {
                const length = (array[array.length - 1] & 0b11) + 1
                array = array.subarray(0, -length)
            }
            return array
        }
    }

    decode(...args: Parameters<TextDecoder['decode']>): string {
        return this.#decoder.decode(...args)
    }

    encode(str: string): Uint8Array {
        return this.#encoder.encode(str)
    }

    loadRecord(index: number): Promise<ArrayBuffer> {
        return this.#pdb.loadRecord(this.#start + index)
    }

    loadMagic(index: number): Promise<string> {
        return this.#pdb.loadMagic(this.#start + index)
    }

    loadText(index: number): Promise<Uint8Array> {
        return this.loadRecord(index + 1)
            .then(buf => new Uint8Array(buf))
            .then(this.#removeTrailingEntries)
            .then(this.#decompress)
    }

    async loadResource(index: number): Promise<ArrayBuffer> {
        const buf = await this.#pdb.loadRecord(this.#resourceStart + index)
        const magic = getString(buf.slice(0, 4))
        if (magic === 'FONT') {
            const font = await getFont(buf, this.unzlib)
            return font.buffer.slice(font.byteOffset, font.byteOffset + font.byteLength) as ArrayBuffer
        }
        if (magic === 'VIDE' || magic === 'AUDI') return buf.slice(12)
        return buf
    }

    async getNCX(): Promise<NCXItem[] | undefined> {
        const index = this.headers.mobi.indx as number
        if (index < 0xffffffff) return getNCX(index, this.loadRecord.bind(this))
        return undefined
    }

    getMetadata(): BookMetadata {
        const { mobi, exth } = this.headers
        const title = unescapeHTML((exth?.title as string) || this.decode(mobi.title as unknown as ArrayBuffer))
        // Build metadata (mutable during construction, readonly in final type)
        const metadata: { -readonly [K in keyof BookMetadata]?: BookMetadata[K] } = {
            identifier: (mobi.uid as number)?.toString(),
            title,
        }
        if (exth?.creator) {
            const authors = (exth.creator as string[]).map(unescapeHTML)
            metadata.author = normalizeContributors(authors)
        }
        if (exth?.publisher) metadata.publisher = unescapeHTML(exth.publisher as string)
        if (exth?.language) {
            const langs = exth.language as string[]
            metadata.language = Array.isArray(langs) ? langs[0] : langs as unknown as string
        } else if (mobi.language) {
            metadata.language = mobi.language as string
        }
        if (exth?.date) metadata.published = exth.date as string
        if (exth?.description) metadata.description = unescapeHTML(exth.description as string)
        if (exth?.subject) metadata.subject = (exth.subject as string[]).map(unescapeHTML)
        if (exth?.rights) metadata.rights = unescapeHTML(exth.rights as string)
        if (exth?.contributor) metadata.contributor = normalizeContributors((exth.contributor as string[]).map(unescapeHTML))
        return metadata
    }

    async getCover(): Promise<Blob | null> {
        const { exth } = this.headers
        const coverOffset = exth?.coverOffset as number | undefined
        const thumbOffset = exth?.thumbnailOffset as number | undefined
        const offset = coverOffset != null && coverOffset < 0xffffffff ? coverOffset
            : thumbOffset != null && thumbOffset < 0xffffffff ? thumbOffset : null
        if (offset != null) {
            const buf = await this.loadResource(offset)
            return new Blob([buf])
        }
        return null
    }

    get numTextRecords(): number {
        return this.headers.palmdoc.numTextRecords as number
    }

    get numRecords(): number {
        return this.#pdb.pdb.numRecords as number
    }
}

// ============================================================================
// MOBI6 — Legacy Mobipocket
// ============================================================================

const mbpPagebreakRegex = /<\s*(?:mbp:)?pagebreak[^>]*>/gi
const fileposRegex = /<[^<>]+filepos=['"]{0,1}(\d+)[^<>]*>/gi
const selfClosingRegex = /<(a|div|span|p)\s*\/>/gi
const htmlVoidTagRegex = /<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b([^<>]*?)>/gi

function sanitizeMOBI6HTML(str: string): string {
    return str
        .replace(/\s(filepos|recindex)=["']?(\d+)["']?/gi, ' $1="$2"')
        .replace(selfClosingRegex, '<$1></$1>')
        .replace(htmlVoidTagRegex, (match, tag: string, attrs: string) =>
            /\/\s*>$/.test(match) ? match : `<${tag}${attrs}/>`)
        .replace(/<\/(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)>/gi, '')
}

function wrapMOBI6Fragment(str: string): string {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body>${str}</body></html>`
}

interface MOBI6Section {
    book: MOBI6
    raw: Uint8Array
    start: number
    end: number
}

class MOBI6 {
    #mobi: MOBI
    #domAdapter?: DOMAdapter
    #urlFactory?: URLFactory
    #resourceCache = new Map<number, string>()
    #textCache = new Map<MOBI6Section, string>()
    #cache = new Map<MOBI6Section, string>()
    #sections: MOBI6Section[] = []
    #fileposList: { filepos: string; number: number }[] = []
    #urls: string[] = []

    sections: Section[] = []
    toc?: TOCItem[]
    landmarks?: Landmark[]
    metadata?: BookMetadata

    constructor(mobi: MOBI, opts?: { domAdapter?: DOMAdapter; urlFactory?: URLFactory }) {
        this.#mobi = mobi
        this.#domAdapter = opts?.domAdapter
        this.#urlFactory = opts?.urlFactory
    }

    async init(): Promise<Book> {
        // Load all text records
        const recordBuffers: Uint8Array[] = []
        for (let i = 0; i < this.#mobi.numTextRecords; i++) {
            recordBuffers.push(await this.#mobi.loadText(i))
        }
        const totalLength = recordBuffers.reduce((sum, buf) => sum + buf.byteLength, 0)
        const array = new Uint8Array(totalLength)
        recordBuffers.reduce((offset, buf) => {
            array.set(buf, offset)
            return offset + buf.byteLength
        }, 0)

        // Convert to string for regex matching (preserves byte offsets for filepos)
        const str = rawBytesToString(array)

        // Split at <mbp:pagebreak> tags
        const breakIndices = [0, ...Array.from(str.matchAll(mbpPagebreakRegex), m => m.index)]
        this.#sections = breakIndices.map((start, i) => {
            const end = breakIndices[i + 1] ?? array.length
            return { book: this, raw: array.subarray(start, end), start: 0, end: 0 }
        })
        // Compute filepos start/end for each section
        this.#sections.forEach((section, i, arr) => {
            section.start = arr[i - 1]?.end ?? 0
            section.end = section.start + section.raw.byteLength
        })

        // Build sections array
        this.sections = this.#sections.map((section, index) => ({
            id: index,
            load: () => this.loadSection(section),
            createDocument: () => this.createDocument(section),
            format: 'html' as const,
            getDocument: async (): Promise<SectionDocument | null> => {
                const html = await this.createDocument(section)
                if (!this.#domAdapter) return null
                const nodes = parseHTML(html, this.#domAdapter)
                return createSectionDocument(nodes, this.#domAdapter)
            },
            getSegments: async () => {
                const html = await this.createDocument(section)
                if (!this.#domAdapter) return []
                const nodes = parseHTML(html, this.#domAdapter)
                return extractDocumentSegments(nodes)
            },
            getBlocks: async () => {
                const html = await this.loadSection(section)
                if (!this.#domAdapter) return []
                const nodes = parseHTML(html, this.#domAdapter)
                return extractDocumentBlocks(nodes, {}, {
                    coverImageSrcs: [],
                })
            },
            size: section.end - section.start,
        }))

        // Build TOC from guide
        try {
            this.landmarks = await this.getGuide()
            const tocHref = this.landmarks
                .find(({ type }) => type?.includes('toc'))?.href
            if (tocHref) {
                const { index } = this.resolveHref(tocHref)!
                const docStr = await this.sections[index].createDocument!() as string
                // Parse the document to extract TOC links
                if (this.#domAdapter) {
                    const doc = this.#domAdapter.parseHTML(wrapMOBI6Fragment(docStr), MIME_HTML)
                    const links = doc.querySelectorAll('a[filepos]')
                    this.toc = []
                    for (const a of links) {
                        const filepos = a.getAttribute('filepos')
                        if (filepos) {
                            this.toc.push({
                                label: (a.textContent || '').trim(),
                                href: `filepos:${filepos}`,
                            })
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('Failed to build MOBI6 TOC', e)
        }

        // Collect all filepos references for anchor insertion
        this.#fileposList = [...new Set(
            Array.from(str.matchAll(fileposRegex), m => m[1]))]
            .map(filepos => ({ filepos, number: Number(filepos) }))
            .sort((a, b) => a.number - b.number)

        this.metadata = this.#mobi.getMetadata()
        return this.toBook()
    }

    async getGuide(): Promise<Landmark[]> {
        const docStr = await this.createDocument(this.#sections[0])
        if (!this.#domAdapter) return []
        const doc = this.#domAdapter.parseHTML(wrapMOBI6Fragment(docStr), MIME_HTML)
        const refs = doc.getElementsByTagName('reference')
        return refs.map(ref => ({
            label: ref.getAttribute('title') || '',
            type: (ref.getAttribute('type') || '').split(/\s/),
            href: `filepos:${ref.getAttribute('filepos') || '0'}`,
        }))
    }

    async loadResource(index: number): Promise<string> {
        if (this.#resourceCache.has(index)) return this.#resourceCache.get(index)!
        const raw = await this.#mobi.loadResource(index)
        const url = this.#createURL(raw, '')
        this.#resourceCache.set(index, url)
        return url
    }

    async loadRecindex(recindex: string): Promise<string> {
        return this.loadResource(Number(recindex) - 1)
    }

    async replaceResources(htmlStr: string): Promise<string> {
        // Replace img recindex
        htmlStr = htmlStr.replace(/<img[^>]+recindex=["'](\d+)["'][^>]*>/gi, (match, recindex) => {
            // We'll do async replacement after
            return match
        })
        // For simplicity, use regex-based async replacement
        const imgRegex = /recindex=["']?(\d+)["']?/gi
        const matches: { full: string; recindex: string }[] = []
        let m: RegExpExecArray | null
        while ((m = imgRegex.exec(htmlStr)) !== null) {
            matches.push({ full: m[0], recindex: m[1] })
        }
        for (const { full, recindex } of matches) {
            try {
                const url = await this.loadRecindex(recindex)
                htmlStr = htmlStr.replace(full, `src="${url}"`)
            } catch {
                // skip
            }
        }

        // Replace filepos links
        htmlStr = htmlStr.replace(/\sfilepos=["']?(\d+)["']?/gi, (_, filepos) =>
            ` href="filepos:${filepos}"`)

        return htmlStr
    }

    async loadSectionText(section: MOBI6Section): Promise<string> {
        if (this.#textCache.has(section)) return this.#textCache.get(section)!
        const { raw } = section

        // Insert anchor elements for filepos references
        const sectionFilepos = this.#fileposList
            .filter(({ number }) => number >= section.start && number < section.end)
            .map(obj => ({ ...obj, offset: obj.number - section.start }))

        let arr = raw
        if (sectionFilepos.length) {
            arr = raw.subarray(0, sectionFilepos[0].offset)
            sectionFilepos.forEach(({ filepos, offset }, i) => {
                const next = sectionFilepos[i + 1]
                const a = this.#mobi.encode(`<a id="filepos${filepos}"></a>`)
                arr = concatTypedArray3(arr, a, raw.subarray(offset, next?.offset))
            })
        }

        const str = this.#mobi.decode(arr)
            .replaceAll(mbpPagebreakRegex, '')
            .replace(/<\/\s*(?:mbp:)?pagebreak\s*>/gi, '')
        this.#textCache.set(section, str)
        return str
    }

    async createDocument(section: MOBI6Section): Promise<string> {
        const str = await this.loadSectionText(section)
        return sanitizeMOBI6HTML(str)
    }

    async loadSection(section: MOBI6Section): Promise<string> {
        if (this.#cache.has(section)) return this.#cache.get(section)!
        let str = await this.createDocument(section)
        str = await this.replaceResources(str)

        // Wrap in minimal HTML document (styles should be applied by the renderer)
        // Return the HTML string directly; the renderer creates blob URLs if needed.
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${str}</body></html>`

        this.#cache.set(section, html)
        return html
    }

    resolveHref(href: string): { index: number; anchor: (doc: unknown) => unknown } | null {
        const match = href.match(/filepos:(.*)/)
        if (!match) return null
        const filepos = match[1]
        const number = Number(filepos)
        const index = this.#sections.findIndex(section => section.end > number)
        if (index < 0) return null
        const anchor = (doc: unknown) => {
            // The renderer provides a DOM; we return the element ID
            return `filepos${filepos}`
        }
        return { index, anchor }
    }

    splitTOCHref(href: string): [number, string] | null {
        const match = href.match(/filepos:(.*)/)
        if (!match) return null
        const filepos = match[1]
        const number = Number(filepos)
        const index = this.#sections.findIndex(section => section.end > number)
        return [index, `filepos${filepos}`]
    }

    isExternal(uri: string): boolean {
        return /^(?!blob|filepos)\w+:/i.test(uri)
    }

    destroy(): void {
        for (const url of this.#resourceCache.values()) this.#revokeURL(url)
        for (const url of this.#cache.values()) {
            // Section content is now a string, not a blob URL
            if (url.startsWith('blob:') || url.startsWith('test:')) this.#revokeURL(url)
        }
    }

    #createURL(data: string | ArrayBuffer, mimeType: string): string {
        if (this.#urlFactory) {
            return this.#urlFactory.createURL(data, mimeType)
        }
        const blob = typeof data === 'string'
            ? new Blob([data], { type: mimeType })
            : new Blob([data])
        const url = URL.createObjectURL(blob)
        this.#urls.push(url)
        return url
    }

    #revokeURL(url: string): void {
        if (this.#urlFactory) {
            this.#urlFactory.revokeURL(url)
        } else {
            URL.revokeObjectURL(url)
        }
    }

    toBook(): Book {
        const self = this
        return {
            sections: this.sections,
            toc: this.toc,
            landmarks: this.landmarks,
            metadata: this.metadata,
            getCover: () => this.#mobi.getCover(),
            resolveHref: (href: string) => self.resolveHref(href),
            isExternal: (uri: string) => self.isExternal(uri),
            splitTOCHref: (href: string) => {
                const result = self.splitTOCHref(href)
                return result ?? [0, null]
            },
            destroy: () => self.destroy(),
        }
    }
}

// ============================================================================
// KF8 — Kindle Format 8
// ============================================================================

const kindleResourceRegex = /kindle:(flow|embed):(\w+)(?:\?mime=(\w+\/[-+.\w]+))?/
const kindlePosRegex = /kindle:pos:fid:(\w+):off:(\w+)/

const parseResourceURI = (str: string): { resourceType: string; id: number; type: string } => {
    const match = str.match(kindleResourceRegex)
    if (!match) return { resourceType: '', id: 0, type: '' }
    const [, resourceType, id, type] = match
    return { resourceType, id: parseInt(id, 32), type }
}

const parsePosURI = (str: string): { fid: number; off: number } | null => {
    const match = str.match(kindlePosRegex)
    if (!match) return null
    const [, fid, off] = match
    return { fid: parseInt(fid, 32), off: parseInt(off, 32) }
}

const makePosURI = (fid = 0, off = 0): string =>
    `kindle:pos:fid:${fid.toString(32).toUpperCase().padStart(4, '0')
    }:off:${off.toString(32).toUpperCase().padStart(10, '0')}`

const getFragmentSelector = (str: string): string | undefined => {
    const match = str.match(/\s(id|name|aid)\s*=\s*['"]([^'"]*)['"]/i)
    if (!match) return undefined
    const [, attr, value] = match
    return `[${attr}="${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"]`
}

const getPageSpread = (properties: string[]): 'left' | 'right' | 'center' | undefined => {
    for (const p of properties) {
        if (p === 'page-spread-left' || p === 'rendition:page-spread-left') return 'left'
        if (p === 'page-spread-right' || p === 'rendition:page-spread-right') return 'right'
        if (p === 'rendition:page-spread-center') return 'center'
    }
    return undefined
}

interface KF8Skel {
    index: number
    name: string
    numFrag: number
    offset: number
    length: number
}

interface KF8Frag {
    insertOffset: number
    selector: string
    index: number
    offset: number
    length: number
}

interface KF8Section {
    skel: KF8Skel
    frags: KF8Frag[]
    fragEnd: number
    length: number
    totalLength: number
}

class KF8 {
    #mobi: MOBI
    #domAdapter?: DOMAdapter
    #urlFactory?: URLFactory
    #cache = new Map<KF8Section | string, string>()
    #fragmentOffsets = new Map<number, number[]>()
    #fragmentSelectors = new Map<number, Map<number, string>>()
    #tables: {
        fdstTable?: [number, number][]
        skelTable?: KF8Skel[]
        fragTable?: KF8Frag[]
    } = {}
    #sections: KF8Section[] = []
    #fullRawLength = 0
    #rawHead: Uint8Array = new Uint8Array()
    #rawTail: Uint8Array = new Uint8Array()
    #lastLoadedHead = -1
    #lastLoadedTail = -1
    #type = MIME_XHTML
    #urls: string[] = []

    sections: Section[] = []
    toc?: TOCItem[]
    landmarks?: Landmark[]
    metadata?: BookMetadata
    dir?: string
    rendition?: Rendition

    constructor(mobi: MOBI, opts?: { domAdapter?: DOMAdapter; urlFactory?: URLFactory }) {
        this.#mobi = mobi
        this.#domAdapter = opts?.domAdapter
        this.#urlFactory = opts?.urlFactory
    }

    async init(): Promise<Book> {
        const loadRecord = this.#mobi.loadRecord.bind(this.#mobi)
        const { kf8 } = this.#mobi.headers

        // Parse FDST (flow section definition table)
        try {
            const fdstBuffer = await loadRecord(kf8!.fdst as number)
            const fdst = getStruct(FDST_HEADER, fdstBuffer)
            if (fdst.magic !== 'FDST') throw new CorruptedFileError('Missing FDST record', 'mobi')
            const fdstTable = Array.from({ length: fdst.numEntries as number },
                (_, i) => 12 + i * 8)
                .map(offset => [
                    getUint(fdstBuffer.slice(offset, offset + 4))!,
                    getUint(fdstBuffer.slice(offset + 4, offset + 8))!,
                ] as [number, number])
            this.#tables.fdstTable = fdstTable
            this.#fullRawLength = fdstTable[fdstTable.length - 1][1]
        } catch { /* FDST may not exist */ }

        // Parse SKEL table
        const skelData = await getIndexData(kf8!.skel as number, loadRecord)
        const skelTable: KF8Skel[] = skelData.table.map(({ name, tagMap }, index) => ({
            index, name,
            numFrag: tagMap[1][0],
            offset: tagMap[6][0],
            length: tagMap[6][1],
        }))

        // Parse FRAG table
        const fragData = await getIndexData(kf8!.frag as number, loadRecord)
        const fragTable: KF8Frag[] = fragData.table.map(({ name, tagMap }) => ({
            insertOffset: parseInt(name),
            selector: fragData.cncx[tagMap[2]?.[0]],
            index: tagMap[4][0],
            offset: tagMap[6][0],
            length: tagMap[6][1],
        }))

        this.#tables.skelTable = skelTable
        this.#tables.fragTable = fragTable

        // Build sections from skel + frag
        this.#sections = skelTable.reduce<KF8Section[]>((arr, skel) => {
            const last = arr[arr.length - 1]
            const fragStart = last?.fragEnd ?? 0
            const fragEnd = fragStart + skel.numFrag
            const frags = fragTable.slice(fragStart, fragEnd)
            const length = skel.length + frags.reduce((a, f) => a + f.length, 0)
            const totalLength = (last?.totalLength ?? 0) + length
            return arr.concat({ skel, frags, fragEnd, length, totalLength })
        }, [])

        // Parse RESC for page spreads
        const pageSpreads = new Map<number, string>()
        try {
            const resources = await this.getResourcesByMagic(['RESC', 'PAGE'])
            if (resources.RESC != null) {
                const buf = await this.#mobi.loadRecord(resources.RESC)
                const str = this.#mobi.decode(buf.slice(16)).replace(/\0/g, '')
                const index = str.search(/\?>/)
                const xmlStr = `<package>${str.slice(index)}</package>`
                if (this.#domAdapter) {
                    const opf = this.#domAdapter.parseXML(xmlStr)
                    const itemrefs = opf.querySelectorAll('itemref')
                    for (const $itemref of itemrefs) {
                        const i = parseInt($itemref.getAttribute('skelid') || '0')
                        const props = ($itemref.getAttribute('properties') || '').split(' ')
                        const spread = getPageSpread(props)
                        if (spread) pageSpreads.set(i, spread)
                    }
                }
            }
        } catch { /* RESC is optional */ }

        // Build sections
        this.sections = this.#sections.map((section, index) =>
            section.frags.length ? ({
                id: index,
                load: () => this.loadSection(section),
                createDocument: () => this.createDocument(section),
                format: 'xhtml' as const,
                getDocument: async (): Promise<SectionDocument | null> => {
                    const html = await this.createDocument(section)
                    if (!this.#domAdapter) return null
                    const nodes = parseHTML(html, this.#domAdapter)
                    return createSectionDocument(nodes, this.#domAdapter)
                },
                getSegments: async () => {
                    const html = await this.createDocument(section)
                    if (!this.#domAdapter) return []
                    const nodes = parseHTML(html, this.#domAdapter)
                    return extractDocumentSegments(nodes)
                },
                getBlocks: async () => {
                    const html = await this.loadSection(section)
                    if (!this.#domAdapter) return []
                    const nodes = parseHTML(html, this.#domAdapter)
                    return extractDocumentBlocks(nodes, {}, {
                        coverImageSrcs: [],
                    })
                },
                size: section.length,
            }) : ({ id: `nonlinear-${index}`, size: 0, linear: 'no', load: () => '' }))

        // Build TOC from NCX
        try {
            const ncx = await this.#mobi.getNCX()
            const map = ({ label, pos, children }: NCXItem): TOCItem => {
                const [fid, off] = pos || [0, 0]
                const href = makePosURI(fid, off)
                const arr = this.#fragmentOffsets.get(fid)
                if (arr) arr.push(off)
                else this.#fragmentOffsets.set(fid, [off])
                return { label: unescapeHTML(label), href, subitems: children?.map(map) }
            }
            this.toc = ncx?.map(map)
            this.landmarks = await this.getGuide()
        } catch (e) {
            console.warn('Failed to build KF8 TOC', e)
        }

        // Set metadata and rendition
        const { exth } = this.#mobi.headers
        this.dir = exth?.pageProgressionDirection as string | undefined
        this.rendition = {
            layout: exth?.fixedLayout === 'true' ? 'pre-paginated' : 'reflowable',
        }

        this.metadata = this.#mobi.getMetadata()
        return this.toBook()
    }

    async getResourcesByMagic(keys: string[]): Promise<Record<string, number>> {
        const results: Record<string, number> = {}
        const start = this.#mobi.headers.kf8!.resourceStart as number
        const end = this.#mobi.numRecords
        for (let i = start; i < end; i++) {
            try {
                const magic = await this.#mobi.loadMagic(i)
                const match = keys.find(key => key === magic)
                if (match) results[match] = i
            } catch { /* skip */ }
        }
        return results
    }

    async getGuide(): Promise<Landmark[] | undefined> {
        const index = this.#mobi.headers.kf8!.guide as number
        if (index < 0xffffffff) {
            const loadRecord = this.#mobi.loadRecord.bind(this.#mobi)
            const { table, cncx } = await getIndexData(index, loadRecord)
            return table.map(({ name, tagMap }) => ({
                label: cncx[tagMap[1]?.[0]] ?? '',
                type: name?.split(/\s/) ?? [],
                href: makePosURI(tagMap[6]?.[0] ?? tagMap[3]?.[0]),
            }))
        }
        return undefined
    }

    async loadResource(str: string): Promise<string> {
        if (this.#cache.has(str)) return this.#cache.get(str)!
        const { resourceType, id, type } = parseResourceURI(str)
        const raw = resourceType === 'flow' ? await this.loadFlow(id)
            : await this.#mobi.loadResource(id - 1)

        let data: string | ArrayBuffer
        if ([MIME_XHTML, MIME_HTML, MIME_CSS, MIME_SVG].includes(type)) {
            const buf = raw instanceof Uint8Array ? raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) : raw
            data = await this.replaceResources(this.#mobi.decode(buf as ArrayBuffer))
        } else {
            data = raw instanceof Uint8Array
                ? new Uint8Array(raw).buffer as ArrayBuffer
                : raw as ArrayBuffer
        }

        const url = this.#createURL(data, type)
        this.#cache.set(str, url)
        return url
    }

    replaceResources(str: string): Promise<string> {
        const regex = new RegExp(kindleResourceRegex, 'g')
        return replaceSeries(str, regex, this.loadResource.bind(this))
    }

    async loadRaw(start: number, end: number): Promise<Uint8Array> {
        const distanceHead = end - this.#rawHead.length
        const distanceEnd = this.#fullRawLength == null ? Infinity
            : (this.#fullRawLength - this.#rawTail.length) - start
        if (distanceHead < 0 || distanceHead < distanceEnd) {
            while (this.#rawHead.length < end) {
                const index = ++this.#lastLoadedHead
                const data = await this.#mobi.loadText(index)
                this.#rawHead = concatTypedArray(this.#rawHead, new Uint8Array(data))
            }
            return this.#rawHead.slice(start, end)
        }
        while (this.#fullRawLength - this.#rawTail.length > start) {
            const index = this.#mobi.numTextRecords - 1 - (++this.#lastLoadedTail)
            const data = await this.#mobi.loadText(index)
            this.#rawTail = concatTypedArray(new Uint8Array(data), this.#rawTail)
        }
        const rawTailStart = this.#fullRawLength - this.#rawTail.length
        return this.#rawTail.slice(start - rawTailStart, end - rawTailStart)
    }

    loadFlow(index: number): Promise<Uint8Array> | Uint8Array {
        if (index < 0xffffffff && this.#tables.fdstTable) {
            return this.loadRaw(...this.#tables.fdstTable[index])
        }
        return new Uint8Array()
    }

    async loadText(section: KF8Section): Promise<string> {
        const { skel, frags, length } = section
        const raw = await this.loadRaw(skel.offset, skel.offset + length)
        let skeleton: Uint8Array = new Uint8Array(raw.slice(0, skel.length))
        for (const frag of frags) {
            const insertOffset = frag.insertOffset - skel.offset
            const offset = skel.length + frag.offset
            const fragRaw = new Uint8Array(raw.slice(offset, offset + frag.length))
            skeleton = concatTypedArray3(
                new Uint8Array(skeleton.slice(0, insertOffset)), fragRaw,
                new Uint8Array(skeleton.slice(insertOffset)))

            const offsets = this.#fragmentOffsets.get(frag.index)
            if (offsets) {
                for (const off of offsets) {
                    const str = this.#mobi.decode(fragRaw.slice(off))
                    const selector = getFragmentSelector(str)
                    if (selector) this.#setFragmentSelector(frag.index, off, selector)
                }
            }
        }
        return this.#mobi.decode(skeleton)
    }

    async createDocument(section: KF8Section): Promise<string> {
        return this.loadText(section)
    }

    async loadSection(section: KF8Section): Promise<string> {
        if (this.#cache.has(section)) return this.#cache.get(section)!
        const str = await this.loadText(section)
        const replaced = await this.replaceResources(str)

        // Try XHTML first, fall back to HTML
        let docStr = replaced
        if (this.#domAdapter) {
            let doc = this.#domAdapter.parseHTML(replaced, this.#type)
            const parseError = doc.querySelector('parsererror')
            if (parseError || !doc.documentElement?.namespaceURI) {
                this.#type = MIME_HTML
                doc = this.#domAdapter.parseHTML(replaced, this.#type)
            }
            docStr = this.#domAdapter.serialize(doc)
        }

        // Return the HTML string directly; the renderer creates blob URLs if needed.
        this.#cache.set(section, docStr)
        return docStr
    }

    getIndexByFID(fid: number): number {
        return this.#sections.findIndex(section =>
            section.frags.some(frag => frag.index === fid))
    }

    #setFragmentSelector(id: number, offset: number, selector: string): void {
        const map = this.#fragmentSelectors.get(id)
        if (map) map.set(offset, selector)
        else {
            const newMap = new Map<number, string>()
            this.#fragmentSelectors.set(id, newMap)
            newMap.set(offset, selector)
        }
    }

    resolveHref(href: string): { index: number; anchor: (doc: unknown) => unknown } | null {
        const pos = parsePosURI(href)
        if (!pos) return null
        const index = this.getIndexByFID(pos.fid)
        if (index < 0) return null
        const anchor = () => this.#fragmentSelectors.get(pos.fid)?.get(pos.off) ?? null
        return { index, anchor }
    }

    splitTOCHref(href: string): [number, string] | null {
        const pos = parsePosURI(href)
        if (!pos) return null
        const index = this.getIndexByFID(pos.fid)
        return [index, `${pos.fid}:${pos.off}`]
    }

    isExternal(uri: string): boolean {
        return /^(?!blob|kindle)\w+:/i.test(uri)
    }

    destroy(): void {
        for (const url of this.#cache.values()) {
            if (typeof url === 'string' && (url.startsWith('blob:') || url.startsWith('test:'))) {
                this.#revokeURL(url)
            }
        }
    }

    #createURL(data: string | ArrayBuffer, mimeType: string): string {
        if (this.#urlFactory) {
            return this.#urlFactory.createURL(data, mimeType)
        }
        const blob = typeof data === 'string'
            ? new Blob([data], { type: mimeType })
            : new Blob([data])
        const url = URL.createObjectURL(blob)
        this.#urls.push(url)
        return url
    }

    #revokeURL(url: string): void {
        if (this.#urlFactory) {
            this.#urlFactory.revokeURL(url)
        } else {
            URL.revokeObjectURL(url)
        }
    }

    toBook(): Book {
        const self = this
        return {
            sections: this.sections,
            toc: this.toc,
            landmarks: this.landmarks,
            metadata: this.metadata,
            dir: this.dir as 'ltr' | 'rtl' | undefined,
            rendition: this.rendition,
            getCover: () => this.#mobi.getCover(),
            resolveHref: (href: string) => self.resolveHref(href),
            isExternal: (uri: string) => self.isExternal(uri),
            splitTOCHref: (href: string) => {
                const result = self.splitTOCHref(href)
                return result ?? [0, null]
            },
            destroy: () => self.destroy(),
        }
    }
}

// ============================================================================
// MOBIParser — Public API
// ============================================================================

/**
 * Check if a file is a MOBI/AZW file by reading bytes 60-68 for 'BOOKMOBI'.
 */
export const isMOBI = async (file: Blob | ArrayBuffer): Promise<boolean> => {
    try {
        const blob = file instanceof ArrayBuffer ? new Blob([file]) : file
        const magic = getString(await blob.slice(60, 68).arrayBuffer())
        return magic === 'BOOKMOBI'
    } catch {
        return false
    }
}

export class MOBIParser implements Parser {
    readonly priority = 5

    async canParse(input: ParserInput): Promise<boolean> {
        // Check file extension
        if (typeof input === 'string') {
            const lower = input.toLowerCase()
            return lower.endsWith('.mobi') || lower.endsWith('.azw') || lower.endsWith('.azw3')
        }
        if (input instanceof File) {
            const lower = input.name.toLowerCase()
            return lower.endsWith('.mobi') || lower.endsWith('.azw') || lower.endsWith('.azw3')
        }

        // Check BOOKMOBI magic bytes
        if (input instanceof ArrayBuffer) {
            return isMOBI(input)
        }
        // Blob
        return isMOBI(input as Blob)
    }

    async parse(input: ParserInput, options?: ParserOptions): Promise<Book> {
        // Require adapters
        if (!options?.domAdapter || !options?.urlFactory) {
            throw new AdapterRequiredError('domAdapter and urlFactory')
        }

        // Convert input to Blob
        let blob: Blob
        if (typeof input === 'string') {
            throw new UnsupportedInputError('MOBI parser cannot parse URL strings; provide a File, Blob, or ArrayBuffer')
        }
        if (input instanceof File || input instanceof Blob) {
            blob = input
        } else {
            blob = new Blob([input])
        }

        // Set up unzlib using fflate if available
        let unzlib: ((data: Uint8Array) => Uint8Array) | undefined
        try {
            const fflate = await import('fflate')
            unzlib = (data: Uint8Array) => fflate.unzlibSync(data)
        } catch {
            // fflate not available; font decompression will be skipped
        }

        const mobi = new MOBI({ unzlib })
        const book = await mobi.open(blob, {
            domAdapter: options.domAdapter,
            urlFactory: options.urlFactory,
        })

        return book
    }
}

export const mobi = () => new MOBIParser()
