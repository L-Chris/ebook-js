/**
 * Shared utilities for exporters.
 *
 * These helpers are extracted from the EPUB exporter so that
 * CBZ, TXT, HTML and future exporters can reuse them without duplication.
 */

import type { BookMetadata, Contributor, LanguageMap, Section } from '../core/types'
import type { ExportOptions } from '../core/exporter'
import type { URLFactory } from '../core/url-factory'

// ---------------------------------------------------------------------------
// Data URI / Binary helpers
// ---------------------------------------------------------------------------

export function parseDataURI(src: string): { mimeType: string; bytes: Uint8Array } | null {
    const match = /^data:([^;,]+)?((?:;[^,]+)*),(.*)$/s.exec(src)
    if (!match) return null
    const mimeType = match[1] || 'application/octet-stream'
    const flags = match[2] || ''
    const data = match[3] || ''
    const bytes = flags.includes(';base64')
        ? decodeBase64(data)
        : new TextEncoder().encode(decodeURIComponent(data))
    return { mimeType, bytes }
}

export function decodeBase64(base64: string): Uint8Array {
    if (typeof atob === 'function') {
        const binary = atob(base64)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        return bytes
    }
    const bufferCtor = (globalThis as unknown as { Buffer?: { from(value: string, encoding: string): Uint8Array } }).Buffer
    if (!bufferCtor) throw new Error('No base64 decoder available')
    return new Uint8Array(bufferCtor.from(base64, 'base64'))
}

export async function toBytes(data: string | ArrayBuffer | Blob): Promise<Uint8Array> {
    if (typeof data === 'string') return new TextEncoder().encode(data)
    if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer())
    return new Uint8Array(data)
}

// ---------------------------------------------------------------------------
// MIME / extension helpers
// ---------------------------------------------------------------------------

export function extensionFromMime(mimeType: string, path = ''): string {
    switch (mimeType) {
        case 'image/jpeg': return '.jpg'
        case 'image/png': return '.png'
        case 'image/gif': return '.gif'
        case 'image/webp': return '.webp'
        case 'image/svg+xml': return '.svg'
        case 'image/avif': return '.avif'
        default: return extensionFromPath(path) ?? '.bin'
    }
}

export function extensionFromPath(path: string): string | null {
    const clean = path.split(/[?#]/)[0]
    const match = /\.(jpe?g|png|gif|webp|svg|avif|bmp)$/i.exec(clean)
    return match ? `.${match[1].toLowerCase().replace('jpeg', 'jpg')}` : null
}

export function getMimeTypeFromPath(path: string): string {
    switch (extensionFromPath(path)) {
        case '.jpg': return 'image/jpeg'
        case '.png': return 'image/png'
        case '.gif': return 'image/gif'
        case '.webp': return 'image/webp'
        case '.svg': return 'image/svg+xml'
        case '.avif': return 'image/avif'
        case '.bmp': return 'image/bmp'
        default: return 'application/octet-stream'
    }
}

// ---------------------------------------------------------------------------
// Resource loading
// ---------------------------------------------------------------------------

export function shouldPackageResource(url: string): boolean {
    if (!url || url.startsWith('#')) return false
    if (/^(https?:|mailto:|tel:|filepos:)/i.test(url)) return false
    return /^(blob:|data:|test:)/i.test(url)
}

export async function loadReferencedResource(
    url: string,
    options: ExportOptions,
): Promise<{ mimeType: string; bytes: Uint8Array } | null> {
    const data = parseDataURI(url)
    if (data) return data

    const urlFactory = options.parserOptions?.urlFactory as URLFactory | undefined
    const stored = urlFactory?.getData?.(url)
    if (stored) {
        return {
            mimeType: stored.mimeType,
            bytes: await toBytes(stored.data),
        }
    }

    if (typeof fetch !== 'function') return null
    try {
        const response = await fetch(url)
        if (!response.ok) return null
        const blob = await response.blob()
        return {
            mimeType: blob.type || response.headers.get('content-type') || getMimeTypeFromPath(url),
            bytes: await toBytes(blob),
        }
    } catch {
        return null
    }
}

// ---------------------------------------------------------------------------
// Title extraction helpers
// ---------------------------------------------------------------------------

export function extractDocumentTitle(html: string): string | null {
    const match = /<(?:title|h[1-6])\b[^>]*>([\s\S]*?)<\/(?:title|h[1-6])>/i.exec(html)
    const text = normalizeTitleText(match?.[1])
    return text || null
}

export function sectionTitleFromId(section: Section): string | null {
    const id = String(section.id).split(/[\/\\]/).pop()?.replace(/\.[^.]+$/, '')
    const text = normalizeTitleText(id?.replace(/[-_]+/g, ' '))
    return text || null
}

export function normalizeTitleText(value: string | undefined): string {
    if (!value) return ''
    return value
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/\s+/g, ' ')
        .trim()
}

// ---------------------------------------------------------------------------
// Metadata helpers
// ---------------------------------------------------------------------------

export function stringifyLanguageMap(value: LanguageMap | undefined): string {
    if (!value) return ''
    if (typeof value === 'string') return value
    return value[Object.keys(value)[0]] ?? ''
}

export function normalizeLanguage(value: string | string[] | undefined): string {
    if (Array.isArray(value)) return value[0] ?? 'und'
    return value || 'und'
}

export function stringifyContributor(value: Contributor | readonly Contributor[] | undefined): string | undefined {
    if (!value) return undefined
    if (Array.isArray(value)) return (value as readonly Contributor[]).map(item => stringifyContributor(item)).filter(Boolean).join(', ')
    if (typeof value === 'string') return value
    return stringifyLanguageMap((value as Exclude<Contributor, string>).name)
}

export function buildExportTitle(metadata: BookMetadata | undefined): string {
    const title = stringifyLanguageMap(metadata?.title)
    return title ? `${title} - First Sections` : 'First Sections'
}

export function buildIdentifier(metadata: BookMetadata | undefined): string {
    return `${metadata?.identifier ?? 'rebook-export'}-first-sections-${Date.now()}`
}

// ---------------------------------------------------------------------------
// XML / HTML escape helpers
// ---------------------------------------------------------------------------

export function escapeXML(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
}

export function escapeAttr(value: string): string {
    return escapeXML(value).replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------------------
// Plain-text extraction from HTML
// ---------------------------------------------------------------------------

/**
 * Strip HTML tags and decode basic entities to produce plain text.
 * This is a lightweight regex-based approach suitable for section content.
 */
export function htmlToText(html: string): string {
    return html
        // Remove script / style blocks
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
        // Block elements → newlines
        .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre|section|article|header|footer|br)\b[^>]*>/gi, '\n')
        .replace(/<br\b[^>]*\/?>/gi, '\n')
        // Remove remaining tags
        .replace(/<[^>]*>/g, '')
        // Decode entities
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&[a-z]+;/gi, ' ')
        // Collapse excessive blank lines
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}
