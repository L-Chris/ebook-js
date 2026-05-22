/**
 * Zip Loader unit tests
 *
 * Tests normal zip loading, isZipFile detection, and malformed zip
 * recovery via CD offset correction and local header scanning fallback.
 */

import { describe, it, expect } from 'vitest'
import { createZipLoader, isZipFile } from '../../src/loaders/zip-loader'
import {
    createValidZip,
    corruptCDOffset,
    shiftAllCDOffsets,
    createPrependedZip,
    destroyCD,
} from '../fixtures/zip-fixture'

// ============================================================================
// Test data
// ============================================================================

const TEST_FILES = [
    { name: 'hello.txt', content: 'Hello, World!' },
    { name: 'data/config.json', content: '{"key": "value"}' },
    { name: 'readme.md', content: '# Test\n\nThis is a test file.' },
]

// ============================================================================
// isZipFile
// ============================================================================

describe('isZipFile', () => {
    it('should return true for valid zip ArrayBuffer', async () => {
        const buffer = await createValidZip(TEST_FILES)
        expect(await isZipFile(buffer)).toBe(true)
    })

    it('should return true for valid zip Blob', async () => {
        const buffer = await createValidZip(TEST_FILES)
        const blob = new Blob([buffer])
        expect(await isZipFile(blob)).toBe(true)
    })

    it('should return false for non-zip ArrayBuffer', async () => {
        const buffer = new ArrayBuffer(16)
        const view = new Uint8Array(buffer)
        view.set([0x00, 0x01, 0x02, 0x03])
        expect(await isZipFile(buffer)).toBe(false)
    })

    it('should return false for empty ArrayBuffer', async () => {
        expect(await isZipFile(new ArrayBuffer(0))).toBe(false)
    })

    it('should return false for ArrayBuffer smaller than 4 bytes', async () => {
        expect(await isZipFile(new ArrayBuffer(2))).toBe(false)
    })
})

// ============================================================================
// createZipLoader — normal operation
// ============================================================================

describe('createZipLoader', () => {
    describe('normal zip', () => {
        it('should list all entries', async () => {
            const buffer = await createValidZip(TEST_FILES)
            const loader = await createZipLoader(buffer)

            expect(loader.entries).toHaveLength(TEST_FILES.length)
            const names = loader.entries.map(e => e.filename)
            for (const file of TEST_FILES) {
                expect(names).toContain(file.name)
            }
        })

        it('should load text file content', async () => {
            const buffer = await createValidZip(TEST_FILES)
            const loader = await createZipLoader(buffer)

            const text = await loader.loadText('hello.txt')
            expect(text).toBe('Hello, World!')
        })

        it('should load text from nested path', async () => {
            const buffer = await createValidZip(TEST_FILES)
            const loader = await createZipLoader(buffer)

            const text = await loader.loadText('data/config.json')
            expect(text).toBe('{"key": "value"}')
        })

        it('should load file as Blob', async () => {
            const buffer = await createValidZip(TEST_FILES)
            const loader = await createZipLoader(buffer)

            const blob = await loader.loadBlob('hello.txt', 'text/plain')
            expect(blob).toBeInstanceOf(Blob)
            const text = await blob!.text()
            expect(text).toBe('Hello, World!')
        })

        it('should return null for non-existent file (loadText)', async () => {
            const buffer = await createValidZip(TEST_FILES)
            const loader = await createZipLoader(buffer)

            const text = await loader.loadText('nonexistent.txt')
            expect(text).toBeNull()
        })

        it('should return null for non-existent file (loadBlob)', async () => {
            const buffer = await createValidZip(TEST_FILES)
            const loader = await createZipLoader(buffer)

            const blob = await loader.loadBlob('nonexistent.txt')
            expect(blob).toBeNull()
        })

        it('should return non-zero size for existing file', async () => {
            const buffer = await createValidZip(TEST_FILES)
            const loader = await createZipLoader(buffer)

            expect(loader.getSize('hello.txt')).toBeGreaterThan(0)
        })

        it('should return 0 for non-existent file size', async () => {
            const buffer = await createValidZip(TEST_FILES)
            const loader = await createZipLoader(buffer)

            expect(loader.getSize('nonexistent.txt')).toBe(0)
        })
    })

    // ========================================================================
    // Malformed zip — CD offset corruption (per-entry fallback)
    // ========================================================================

    describe('malformed zip — CD offset corruption', () => {
        it('should recover entry with corrupted CD offset', async () => {
            const validBuffer = await createValidZip(TEST_FILES)
            const corrupted = corruptCDOffset(validBuffer, 'hello.txt')
            const loader = await createZipLoader(corrupted)

            // Entry should still be listed (from CD)
            const names = loader.entries.map(e => e.filename)
            expect(names).toContain('hello.txt')
        })

        it('should load text from entry with corrupted CD offset', async () => {
            const validBuffer = await createValidZip(TEST_FILES)
            const corrupted = corruptCDOffset(validBuffer, 'hello.txt')
            const loader = await createZipLoader(corrupted)

            // Should fall back to local header extraction
            const text = await loader.loadText('hello.txt')
            expect(text).toBe('Hello, World!')
        })

        it('should load Blob from entry with corrupted CD offset', async () => {
            const validBuffer = await createValidZip(TEST_FILES)
            const corrupted = corruptCDOffset(validBuffer, 'data/config.json')
            const loader = await createZipLoader(corrupted)

            const blob = await loader.loadBlob('data/config.json', 'application/json')
            expect(blob).toBeInstanceOf(Blob)
            const text = await blob!.text()
            expect(text).toBe('{"key": "value"}')
        })

        it('should not affect other entries', async () => {
            const validBuffer = await createValidZip(TEST_FILES)
            const corrupted = corruptCDOffset(validBuffer, 'hello.txt')
            const loader = await createZipLoader(corrupted)

            // Other entries should still load normally via zip.js
            const text = await loader.loadText('readme.md')
            expect(text).toBe('# Test\n\nThis is a test file.')
        })

        it('should handle multiple corrupted entries', async () => {
            let buffer = await createValidZip(TEST_FILES)
            buffer = corruptCDOffset(buffer, 'hello.txt')
            buffer = corruptCDOffset(buffer, 'readme.md')
            const loader = await createZipLoader(buffer)

            const text1 = await loader.loadText('hello.txt')
            expect(text1).toBe('Hello, World!')

            const text2 = await loader.loadText('readme.md')
            expect(text2).toBe('# Test\n\nThis is a test file.')
        })
    })

    // ========================================================================
    // Malformed zip — shifted CD offsets
    // ========================================================================

    describe('malformed zip — shifted CD offsets', () => {
        it('should recover entries when all CD offsets are shifted', async () => {
            const validBuffer = await createValidZip(TEST_FILES)
            const shifted = shiftAllCDOffsets(validBuffer, 5000)
            const loader = await createZipLoader(shifted)

            // Should recover all entries via fallback
            for (const file of TEST_FILES) {
                const text = await loader.loadText(file.name)
                expect(text).toBe(file.content)
            }
        })
    })

    // ========================================================================
    // Malformed zip — prepended data (SFX-like)
    // ========================================================================

    describe('malformed zip — prepended data', () => {
        it('should handle zip with prepended data', async () => {
            const validBuffer = await createValidZip(TEST_FILES)
            const prepended = createPrependedZip(validBuffer, 1024)
            const loader = await createZipLoader(prepended)

            // Should be able to load entries
            for (const file of TEST_FILES) {
                const text = await loader.loadText(file.name)
                expect(text).toBe(file.content)
            }
        })
    })

    // ========================================================================
    // Malformed zip — destroyed Central Directory
    // ========================================================================

    describe('malformed zip — destroyed CD', () => {
        it('should recover entries from local headers when CD is destroyed', async () => {
            const validBuffer = await createValidZip(TEST_FILES)
            const destroyed = destroyCD(validBuffer)
            const loader = await createZipLoader(destroyed)

            // Should still list entries (from local header scan)
            expect(loader.entries.length).toBeGreaterThanOrEqual(TEST_FILES.length)
        })

        it('should load text from entries when CD is destroyed', async () => {
            const validBuffer = await createValidZip(TEST_FILES)
            const destroyed = destroyCD(validBuffer)
            const loader = await createZipLoader(destroyed)

            for (const file of TEST_FILES) {
                const text = await loader.loadText(file.name)
                expect(text).toBe(file.content)
            }
        })
    })
})
