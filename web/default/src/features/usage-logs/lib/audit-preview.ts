/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/

type JsonRecord = Record<string, unknown>

export type AuditPreviewKind = 'markdown' | 'image'

export interface AuditPreviewImage {
  id: string
  url: string
  alt?: string
  source: 'url' | 'markdown' | 'data'
}

export interface AuditPreviewItem {
  id: string
  kind: AuditPreviewKind
  label: string
  content?: string
  images?: AuditPreviewImage[]
}

export interface StructuredPreview {
  type: 'json' | 'text' | 'empty'
  value?: unknown
  formatted: string
}

export interface TextPreviewOptions {
  preferMarkdown?: boolean
  includeImages?: boolean
}

const STRUCTURED_JSON_FIELD_KEYS = new Set([
  'arguments',
  'args',
  'input',
  'output',
  'response',
  'result',
  'content',
  'text',
])
const MAX_STRUCTURED_JSON_DEPTH = 4

const IMAGE_EXTENSIONS = [
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'svg',
  'bmp',
  'ico',
  'avif',
]

const MARKDOWN_PATTERNS = [
  /^#{1,6}\s+\S.+/m,
  /\*\*[^*\n][\s\S]*?\*\*/,
  /__[^_\n][\s\S]*?__/,
  /!\[[^\]]*]\([^)]+\)/,
  /\[[^\]]+]\([^)]+\)/,
  /```[\s\S]*?```/,
  /`[^`\n]+`/,
  /^\s*[-*+]\s+\S.+/m,
  /^\s*\d+\.\s+\S.+/m,
  /^\s*>\s+\S.+/m,
  /^\s*\|.+\|.+\|/m,
  /^---+$/m,
]

const MARKDOWN_IMAGE_PATTERN = /!\[([^\]]*)]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const DATA_IMAGE_PATTERN = /data:image\/[a-zA-Z0-9.+-]+;base64,[^\s)"']+/g
const HTTP_URL_PATTERN = /https?:\/\/[^\s<>"')]+/g

export function buildTextPreviewItems(
  value: unknown,
  options: TextPreviewOptions = {}
): AuditPreviewItem[] {
  const text = stringifyText(value).trim()
  if (!text) return []

  const items: AuditPreviewItem[] = []
  const images =
    options.includeImages === false ? [] : detectImagePreviews(text)
  if (images.length > 0) {
    items.push({
      id: 'image',
      kind: 'image',
      label: 'Image Preview',
      images,
    })
  }

  if (options.preferMarkdown || isLikelyMarkdown(text)) {
    items.push({
      id: 'markdown',
      kind: 'markdown',
      label: 'Markdown Preview',
      content: normalizeMarkdownPreviewContent(text),
    })
  }

  return items
}

export function normalizeMarkdownPreviewContent(value: string): string {
  MARKDOWN_IMAGE_PATTERN.lastIndex = 0
  return value.replace(MARKDOWN_IMAGE_PATTERN, (match, alt, rawUrl) => {
    const url = sanitizePreviewUrl(String(rawUrl))
    if (!url) return match
    return `![${String(alt)}](${url})`
  })
}

export function detectImagePreviews(value: unknown): AuditPreviewImage[] {
  const text = stringifyText(value)
  if (!text && value === undefined) return []

  const images: AuditPreviewImage[] = []
  const seen = new Set<string>()

  const addImage = (
    rawUrl: string | undefined,
    source: AuditPreviewImage['source'],
    alt?: string
  ) => {
    const url = sanitizePreviewUrl(rawUrl)
    if (!url || !isImageReference(url) || seen.has(url)) return
    seen.add(url)
    images.push({
      id: `${source}-${images.length + 1}`,
      url,
      alt,
      source: url.startsWith('data:image/') ? 'data' : source,
    })
  }

  for (const candidate of collectImageCandidates(value)) {
    addImage(candidate.url, candidate.source, candidate.alt)
  }

  if (typeof value === 'string') {
    const parsed = safeParseJson(value.trim())
    if (parsed !== undefined) {
      for (const candidate of collectImageCandidates(parsed)) {
        addImage(candidate.url, candidate.source, candidate.alt)
      }
    }
  }

  if (!text) return images

  for (const match of text.matchAll(MARKDOWN_IMAGE_PATTERN)) {
    addImage(match[2], 'markdown', match[1]?.trim() || undefined)
  }

  for (const match of text.matchAll(DATA_IMAGE_PATTERN)) {
    addImage(match[0], 'data')
  }

  for (const match of text.matchAll(HTTP_URL_PATTERN)) {
    addImage(match[0], 'url')
  }

  return images
}

function collectImageCandidates(
  value: unknown,
  depth = 6
): Array<{ url: string; source: AuditPreviewImage['source']; alt?: string }> {
  if (depth <= 0 || value === undefined || value === null) return []
  if (typeof value === 'string') {
    const imageUrl = imageDataUrlFromString(value) || value
    return isImageReference(imageUrl) ? [{ url: imageUrl, source: 'url' }] : []
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectImageCandidates(item, depth - 1))
  }
  if (!isRecord(value)) return []

  const candidates: Array<{
    url: string
    source: AuditPreviewImage['source']
    alt?: string
  }> = []
  const alt = firstString(value.alt, value.alt_text, value.title)

  for (const key of ['image_url', 'url', 'uri', 'src']) {
    const nested = value[key]
    if (typeof nested === 'string' && isImageReference(nested)) {
      candidates.push({ url: nested, source: 'url', alt })
    } else if (isRecord(nested)) {
      const url = firstString(nested.url, nested.uri, nested.src)
      if (url && isImageReference(url)) {
        candidates.push({
          url,
          source: 'url',
          alt: firstString(nested.alt, nested.alt_text, nested.title) || alt,
        })
      }
    }
  }

  const b64 = firstString(
    value.b64_json,
    value.partial_image_b64,
    value.image_b64,
    isImageGenerationRecord(value) ? value.result : undefined,
    isImageGenerationRecord(value) ? value.output : undefined
  )
  if (b64) {
    const imageUrl = imageDataUrlFromString(b64)
    if (imageUrl) {
      candidates.push({
        url: imageUrl,
        source: 'data',
        alt,
      })
    }
  }

  if (typeof value.b64_json === 'string' && value.b64_json.trim() && !b64) {
    candidates.push({
      url: `data:image/png;base64,${value.b64_json.trim()}`,
      source: 'data',
      alt,
    })
  }

  for (const [key, childValue] of Object.entries(value)) {
    if (
      [
        'b64_json',
        'partial_image_b64',
        'image_b64',
        'image_url',
        'url',
        'uri',
        'src',
      ].includes(key)
    )
      continue
    candidates.push(...collectImageCandidates(childValue, depth - 1))
  }

  return candidates
}

function isImageGenerationRecord(value: JsonRecord): boolean {
  return [value.type, value.name]
    .map((item) => (typeof item === 'string' ? item.toLowerCase() : ''))
    .some((item) => item.includes('image_generation'))
}

function imageDataUrlFromString(value: string | undefined): string {
  const text = value?.trim() ?? ''
  if (!text) return ''
  if (text.startsWith('data:image/')) return text
  if (!looksLikeBase64Image(text)) return ''
  return `data:image/png;base64,${text}`
}

function looksLikeBase64Image(value: string): boolean {
  const text = value.trim()
  return (
    /^(iVBORw0KGgo|\/9j\/|R0lGOD|UklGR|PHN2Z)/.test(text) ||
    (text.length > 200 && /^[A-Za-z0-9+/=_-]+$/.test(text))
  )
}

export function parseStructuredPreview(value: unknown): StructuredPreview {
  if (value === undefined || value === null) {
    return { type: 'empty', formatted: '' }
  }

  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return { type: 'empty', formatted: '' }
    const parsed = safeParseJson(text)
    if (parsed !== undefined) {
      const normalized = normalizeStructuredJson(parsed)
      return {
        type: 'json',
        value: normalized,
        formatted: formatUnknown(normalized),
      }
    }
    return { type: 'text', value: text, formatted: text }
  }

  const normalized = normalizeStructuredJson(value)
  return {
    type: 'json',
    value: normalized,
    formatted: formatUnknown(normalized),
  }
}

export function summarizeAuditText(value: unknown, maxLength = 42): string {
  const normalized = stringifyText(value).replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 1)}...`
}

function isLikelyMarkdown(text: string): boolean {
  const trimmed = text.trim()
  if (
    (trimmed.startsWith('{') || trimmed.startsWith('[')) &&
    safeParseJson(trimmed) !== undefined
  ) {
    return false
  }

  if (text.length > 160 && text.includes('\n')) return true
  let matches = 0
  for (const pattern of MARKDOWN_PATTERNS) {
    if (pattern.test(text)) {
      matches += 1
      if (matches >= 1) return true
    }
  }
  return false
}

function isImageReference(value: string): boolean {
  if (value.startsWith('data:image/')) return true
  if (!/^https?:\/\//i.test(value)) return false

  const lower = value.toLowerCase()
  if (IMAGE_EXTENSIONS.some((ext) => lower.includes(`.${ext}`))) {
    return true
  }

  return /\/(image|images|img|photo|photos)\//i.test(value)
}

function stringifyText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  return formatUnknown(value)
}

function sanitizePreviewUrl(value: string | undefined): string {
  return (value ?? '')
    .trim()
    .replace(/\\\//g, '/')
    .replace(/^<|>$/g, '')
    .replace(/[\\.,;:!?\])}'"]+$/g, '')
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function normalizeStructuredJson(
  value: unknown,
  depth = MAX_STRUCTURED_JSON_DEPTH,
  key = ''
): unknown {
  if (depth <= 0) return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return value
    if (STRUCTURED_JSON_FIELD_KEYS.has(key) || looksLikeJson(trimmed)) {
      const parsed = safeParseJson(trimmed)
      if (parsed !== undefined) {
        return normalizeStructuredJson(parsed, depth - 1, key)
      }
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeStructuredJson(item, depth - 1, key))
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        normalizeStructuredJson(childValue, depth - 1, childKey),
      ])
    )
  }
  return value
}

function looksLikeJson(value: string): boolean {
  return (
    (value.startsWith('{') && value.endsWith('}')) ||
    (value.startsWith('[') && value.endsWith(']'))
  )
}

function formatUnknown(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (isRecord(value) || Array.isArray(value)) {
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
