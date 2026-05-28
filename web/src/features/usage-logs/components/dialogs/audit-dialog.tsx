import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown01Icon,
  BrainIcon,
  ClipboardCopyIcon,
  FileSearchIcon,
  Loading03Icon,
  MessageMultiple02Icon,
  Tick02Icon,
  ToolsIcon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Response } from '@/components/ai-elements/response'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  sideDrawerContentClassName,
  sideDrawerFormClassName,
  sideDrawerHeaderClassName,
} from '@/components/drawer-layout'
import { getLogAuditDetail } from '../../api'
import type { UsageLog } from '../../data/schema'
import {
  buildAuditViewModel,
  parseLogAuditPayload,
  type AuditContentPart,
  type AuditConversationItem,
  type AuditField,
  type AuditToolCall,
  type AuditToolDefinition,
  type AuditViewModel,
  type HeaderRow,
} from '../../lib/audit'
import {
  detectImagePreviews,
  normalizeMarkdownPreviewContent,
  parseStructuredPreview,
  summarizeAuditText,
  type AuditPreviewImage,
  type AuditPreviewItem,
} from '../../lib/audit-preview'
import type { LogAuditDetail } from '../../types'

interface AuditDialogProps {
  log: UsageLog
  isAdmin: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}

type AuditSectionKey =
  | 'overview'
  | 'request'
  | 'conversation'
  | 'response'
  | 'tools'
  | 'raw'

const AUDIT_SECTIONS: Array<{
  key: AuditSectionKey
  label: string
  icon: IconSvgElement
}> = [
  { key: 'overview', label: 'Overview', icon: FileSearchIcon },
  { key: 'request', label: 'Request Parameters', icon: FileSearchIcon },
  { key: 'conversation', label: 'Conversation', icon: MessageMultiple02Icon },
  { key: 'response', label: 'Response', icon: ArrowDown01Icon },
  { key: 'tools', label: 'Tools', icon: ToolsIcon },
  { key: 'raw', label: 'Raw', icon: FileSearchIcon },
]

interface AuditNavChildItem {
  id: string
  label: string
  labelKey?: string
  labelParams?: Record<string, string | number>
  description?: string
  section: AuditSectionKey
  targetId: string
}

interface AuditNavItem {
  key: AuditSectionKey
  label: string
  icon: IconSvgElement
  targetId?: string
  children?: AuditNavChildItem[]
}

type AuditPreviewDialogState = {
  item: AuditPreviewItem
  imageIndex?: number
} | null

type PreviewOpenHandler = (item: AuditPreviewItem, imageIndex?: number) => void

const RESPONSE_TARGET_IDS = {
  final: 'audit-response-final',
  usage: 'audit-response-usage',
  finishReasons: 'audit-response-finish-reasons',
  sse: 'audit-response-sse',
  reasoning: 'audit-response-reasoning',
  toolCalls: 'audit-response-tool-calls',
  raw: 'audit-response-raw',
} as const

const TOOL_TARGET_IDS = {
  definitions: 'audit-tools-definitions',
  calls: 'audit-tools-calls',
} as const

const TRANSLATED_VALUES = new Set([
  'Stream',
  'Non-stream',
  'Unknown',
  'OpenAI Chat',
  'OpenAI Responses',
  'OpenAI Responses Compact',
  'OpenAI Completions',
  'OpenAI Embeddings',
  'OpenAI Moderations',
  'OpenAI Images',
  'OpenAI Audio Speech',
  'Claude Messages',
  'Gemini generateContent',
  'Gemini Embeddings',
  'Rerank',
])

function InlineIcon(props: { icon: IconSvgElement; className?: string }) {
  return (
    <HugeiconsIcon
      icon={props.icon}
      className={cn('shrink-0', props.className)}
      strokeWidth={2}
      aria-hidden='true'
    />
  )
}

function escapeVisibleThinkingTags(value: string): string {
  return value.replaceAll(/<\/?think(?:ing)?\b[^>]*>/gi, (tag) =>
    tag
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
  )
}

function AuditMarkdown(props: { children: string; className?: string }) {
  return (
    <div dir='auto'>
      <Response
        className={cn(
          'h-auto w-auto max-w-none text-sm',
          '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
          '[overflow-wrap:anywhere] break-words',
          props.className
        )}
      >
        {escapeVisibleThinkingTags(props.children)}
      </Response>
    </div>
  )
}

function CopyButton(props: { value: string; label?: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(props.value)
      setCopied(true)
      toast.success(t('Copied'))
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      toast.error(t('Failed to copy'))
    }
  }

  return (
    <Button
      type='button'
      variant='outline'
      size='sm'
      onClick={copy}
      disabled={!props.value}
    >
      <InlineIcon
        icon={copied ? Tick02Icon : ClipboardCopyIcon}
        className={copied ? 'text-success' : undefined}
      />
      {props.label ?? t('Copy')}
    </Button>
  )
}

function buildGatewayCurlCommand(view: AuditViewModel): string {
  const endpoint = view.payload.source?.endpoint?.trim()
  const url = buildGatewayCurlUrl(endpoint)
  if (!url) return ''

  const lines = [
    `curl -X POST ${shellQuote(url)} \\`,
    ...buildGatewayCurlHeaders(view).map(
      (header) => `  -H ${shellQuote(header)} \\`
    ),
  ]

  if (view.request.raw) {
    lines.push(`  --data-raw ${shellQuote(view.request.raw)}`)
  } else {
    const lastIndex = lines.length - 1
    lines[lastIndex] = lines[lastIndex].replace(/ \\$/, '')
  }

  return lines.join('\n')
}

function buildGatewayCurlUrl(endpoint?: string): string {
  if (!endpoint || typeof window === 'undefined') return ''

  try {
    const endpointPath = /^https?:\/\//i.test(endpoint)
      ? new URL(endpoint).pathname + new URL(endpoint).search
      : endpoint
    const normalizedEndpoint = endpointPath.startsWith('/')
      ? endpointPath
      : `/${endpointPath}`
    return new URL(normalizedEndpoint, window.location.origin).toString()
  } catch {
    return ''
  }
}

function buildGatewayCurlHeaders(view: AuditViewModel): string[] {
  const endpoint = view.payload.source?.endpoint?.toLowerCase() ?? ''
  const sourceText = [
    view.protocol,
    view.payload.source?.request_format,
    view.payload.source?.relay_format,
    endpoint,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  const headers = ['Content-Type: application/json']
  if (
    sourceText.includes('claude') ||
    sourceText.includes('anthropic') ||
    endpoint.includes('/v1/messages')
  ) {
    headers.push('x-api-key: <YOUR_API_KEY>')
    headers.push('anthropic-version: 2023-06-01')
  } else if (
    sourceText.includes('gemini') ||
    endpoint.includes('/v1beta/models') ||
    (endpoint.includes('/v1/models/') && endpoint.includes(':generatecontent'))
  ) {
    headers.push('x-goog-api-key: <YOUR_API_KEY>')
  } else {
    headers.push('Authorization: Bearer <YOUR_API_KEY>')
  }

  return headers
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function EmptyBlock(props: { label?: string }) {
  const { t } = useTranslation()
  return (
    <div className='text-muted-foreground bg-muted/30 rounded-md px-3 py-8 text-center text-sm'>
      {props.label ?? t('No content')}
    </div>
  )
}

function AuditPreviewDialog(props: {
  state: AuditPreviewDialogState
  onOpenChange: (open: boolean) => void
  onImageIndexChange: (index: number) => void
}) {
  const { t } = useTranslation()
  const item = props.state?.item
  const open = Boolean(item)

  if (!item) {
    return <Dialog open={false} onOpenChange={props.onOpenChange} />
  }

  return (
    <Dialog open={open} onOpenChange={props.onOpenChange}>
      <DialogContent className='max-h-[min(760px,calc(100vh-2rem))] overflow-hidden sm:max-w-4xl'>
        <DialogHeader>
          <DialogTitle>
            {item.kind === 'markdown'
              ? t('Markdown Preview')
              : t('Image Preview')}
          </DialogTitle>
          <DialogDescription className='sr-only'>
            {t('Preview')}
          </DialogDescription>
        </DialogHeader>
        {item.kind === 'markdown' ? (
          <MarkdownPreviewContent
            value={item.content ?? ''}
            images={item.images ?? []}
          />
        ) : (
          <ImagePreviewContent
            images={item.images ?? []}
            imageIndex={props.state?.imageIndex ?? 0}
            onImageIndexChange={props.onImageIndexChange}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function MarkdownPreviewContent(props: {
  value: string
  images?: AuditPreviewImage[]
}) {
  const { t } = useTranslation()
  const previewValue = useMemo(
    () => normalizeMarkdownPreviewContent(props.value),
    [props.value]
  )
  return (
    <div className='flex min-h-0 flex-col gap-3 overflow-hidden'>
      <div className='border-border/70 max-h-[55vh] overflow-auto rounded-md border p-3'>
        {previewValue && <AuditMarkdown>{previewValue}</AuditMarkdown>}
        {props.images && props.images.length > 0 && (
          <div className={cn('grid gap-3', previewValue && 'mt-3')}>
            {props.images.map((image, index) => (
              <InlinePreviewImage
                key={image.id}
                image={image}
                label={`${t('Image')} #${index + 1}`}
              />
            ))}
          </div>
        )}
      </div>
      <div className='flex justify-end'>
        <CopyButton value={props.value} label={t('Copy Raw')} />
      </div>
    </div>
  )
}

function InlinePreviewImage(props: {
  image: AuditPreviewImage
  label?: string
  onClick?: () => void
}) {
  const { t } = useTranslation()
  const [failed, setFailed] = useState(false)
  const [objectUrl, setObjectUrl] = useState<string>()

  useEffect(() => {
    setFailed(false)
    setObjectUrl(undefined)
    if (!props.image.url.startsWith('data:image/')) return

    try {
      const url = createObjectUrlFromDataImage(props.image.url)
      setObjectUrl(url)
      return () => URL.revokeObjectURL(url)
    } catch {
      setFailed(true)
    }
  }, [props.image.url])

  const imageSrc = objectUrl ?? props.image.url

  return (
    <div className='border-border/70 bg-muted/20 flex min-w-0 flex-col gap-2 rounded-md border p-3'>
      <div className='flex min-w-0 flex-wrap items-center gap-2'>
        <Badge variant='secondary'>{props.label ?? t('Image')}</Badge>
        <span className='text-muted-foreground min-w-0 truncate font-mono text-xs'>
          {formatPreviewImageSource(props.image)}
        </span>
      </div>
      <button
        type='button'
        className='bg-background/80 border-border/70 flex max-h-[48vh] min-h-40 max-w-full items-center justify-center overflow-hidden rounded-md border p-0 disabled:cursor-default'
        onClick={props.onClick}
        disabled={!props.onClick}
      >
        {!failed ? (
          <img
            src={imageSrc}
            alt={props.image.alt ?? t('Image Preview')}
            className='max-h-[48vh] max-w-full object-contain'
            onError={() => setFailed(true)}
          />
        ) : (
          <div className='text-muted-foreground flex min-h-40 items-center justify-center p-3 text-sm'>
            {t('Failed to load image')}
          </div>
        )}
      </button>
    </div>
  )
}

function ImagePreviewContent(props: {
  images: AuditPreviewImage[]
  imageIndex: number
  onImageIndexChange: (index: number) => void
}) {
  const { t } = useTranslation()
  const [failed, setFailed] = useState(false)
  const [objectUrl, setObjectUrl] = useState<string>()
  const image = props.images[props.imageIndex] ?? props.images[0]

  useEffect(() => {
    setFailed(false)
    setObjectUrl(undefined)
    if (!image?.url?.startsWith('data:image/')) return

    try {
      const url = createObjectUrlFromDataImage(image.url)
      setObjectUrl(url)
      return () => URL.revokeObjectURL(url)
    } catch {
      setFailed(true)
    }
  }, [image?.url])

  if (!image) return <EmptyBlock />

  const imageSrc = objectUrl ?? image.url

  return (
    <div className='flex min-h-0 flex-col gap-3 overflow-hidden'>
      {props.images.length > 1 && (
        <div className='flex gap-2 overflow-x-auto pb-1'>
          {props.images.map((candidate, index) => (
            <Button
              key={candidate.id}
              type='button'
              variant={index === props.imageIndex ? 'secondary' : 'outline'}
              size='sm'
              className='h-7 shrink-0 px-2 text-xs'
              onClick={() => props.onImageIndexChange(index)}
            >
              {t('Image')} #{index + 1}
            </Button>
          ))}
        </div>
      )}
      <div className='bg-muted/40 border-border/70 relative flex max-h-[52vh] min-h-64 items-center justify-center overflow-hidden rounded-md border'>
        <img
          src={imageSrc}
          alt={image.alt ?? t('Image Preview')}
          className={cn(
            'max-h-[52vh] max-w-full object-contain',
            failed && 'opacity-0'
          )}
          onError={() => setFailed(true)}
        />
        {failed && (
          <div className='text-muted-foreground absolute inset-0 flex items-center justify-center p-4 text-center text-sm'>
            {t('Failed to load image')}
          </div>
        )}
      </div>
      <div className='text-muted-foreground bg-muted/40 truncate rounded-md p-2 font-mono text-xs'>
        {formatPreviewImageSource(image)}
      </div>
      <div className='flex flex-wrap justify-end gap-2'>
        <CopyButton value={image.url} label={t('Copy URL')} />
        <Button
          type='button'
          variant='outline'
          size='sm'
          onClick={() =>
            window.open(image.url, '_blank', 'noopener,noreferrer')
          }
        >
          {t('Open')}
        </Button>
      </div>
    </div>
  )
}

function createObjectUrlFromDataImage(value: string): string {
  const commaIndex = value.indexOf(',')
  if (commaIndex < 0) throw new Error('Invalid data image')

  const metadata = value.slice(5, commaIndex)
  const payload = value.slice(commaIndex + 1).replace(/\s/g, '')
  const mimeType = metadata.split(';')[0] || 'image/*'
  const bytes = metadata.includes(';base64')
    ? base64ToBytes(payload)
    : new TextEncoder().encode(decodeURIComponent(payload))
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)

  return URL.createObjectURL(new Blob([buffer], { type: mimeType }))
}

function base64ToBytes(value: string): Uint8Array {
  const binary = window.atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function formatPreviewImageSource(image: AuditPreviewImage): string {
  if (!image.url.startsWith('data:image/')) return image.url

  const commaIndex = image.url.indexOf(',')
  const metadata =
    commaIndex >= 0 ? image.url.slice(5, commaIndex) : 'data:image'
  const payloadLength =
    commaIndex >= 0 ? image.url.length - commaIndex - 1 : image.url.length
  return `${metadata} · ${payloadLength.toLocaleString()}`
}

function compactLargePayloadForDisplay(value: string): string {
  return value
    .replace(
      /(data:image\/[a-zA-Z0-9.+-]+;base64,)([A-Za-z0-9+/=_-]{256,})/g,
      (_match, prefix: string, payload: string) =>
        `${prefix}<base64 image, ${formatApproxBase64Bytes(payload)}>`
    )
    .replace(
      /("(?:partial_image_b64|b64_json|image_b64)"\s*:\s*")([A-Za-z0-9+/=_-]{256,})(")/g,
      (_match, before: string, payload: string, after: string) =>
        `${before}<base64 image, ${formatApproxBase64Bytes(payload)}>${after}`
    )
}

function formatApproxBase64Bytes(payload: string): string {
  const normalized = payload.replace(/\s/g, '')
  const padding = normalized.endsWith('==')
    ? 2
    : normalized.endsWith('=')
      ? 1
      : 0
  const bytes = Math.max(0, Math.floor((normalized.length * 3) / 4) - padding)
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function removeInlineImageNoise(value: string): string {
  return value
    .replace(/!\[([^\]]*)]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '')
    .replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[^\s)"']+/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function SectionTitle(props: {
  title: string
  description?: string
  icon?: IconSvgElement
  count?: number
  action?: React.ReactNode
}) {
  return (
    <div className='flex min-w-0 items-start justify-between gap-3'>
      <div className='flex min-w-0 items-start gap-2'>
        {props.icon && (
          <InlineIcon
            icon={props.icon}
            className='text-muted-foreground mt-0.5'
          />
        )}
        <div className='min-w-0'>
          <div className='flex min-w-0 items-center gap-2'>
            <div className='truncate text-sm font-medium'>{props.title}</div>
            {typeof props.count === 'number' && (
              <Badge
                variant='secondary'
                className='h-5 shrink-0 px-1.5 font-mono text-[11px]'
              >
                {props.count}
              </Badge>
            )}
          </div>
          {props.description && (
            <div className='text-muted-foreground mt-0.5 text-xs'>
              {props.description}
            </div>
          )}
        </div>
      </div>
      {props.action}
    </div>
  )
}

function FieldGrid(props: { rows: AuditField[] }) {
  const { t } = useTranslation()
  if (props.rows.length === 0)
    return <EmptyBlock label={t('No parsed fields')} />
  return (
    <div className='grid gap-2 sm:grid-cols-2 lg:grid-cols-3'>
      {props.rows.map((row) => (
        <div
          key={row.name}
          className='border-border/70 min-w-0 rounded-md border px-3 py-2'
        >
          <div className='text-muted-foreground text-[11px]'>{t(row.name)}</div>
          <div className='mt-1 min-w-0 font-mono text-xs break-all'>
            {TRANSLATED_VALUES.has(row.value) ? t(row.value) : row.value}
          </div>
        </div>
      ))}
    </div>
  )
}

function KeyValueList(props: { rows: AuditField[]; translateName?: boolean }) {
  const { t } = useTranslation()
  if (props.rows.length === 0)
    return <EmptyBlock label={t('No parsed fields')} />
  return (
    <div className='border-border/70 overflow-hidden rounded-md border'>
      {props.rows.map((row, index) => (
        <div
          key={`${row.name}-${index}`}
          className={cn(
            'grid min-w-0 grid-cols-1 text-xs sm:grid-cols-[minmax(8rem,13rem)_minmax(0,1fr)]',
            index > 0 && 'border-border/70 border-t'
          )}
        >
          <div className='bg-muted/40 min-w-0 px-3 py-2 font-medium break-words'>
            {props.translateName ? t(row.name) : row.name}
          </div>
          <div className='min-w-0 px-3 py-2 font-mono break-all'>
            {row.value}
          </div>
        </div>
      ))}
    </div>
  )
}

function HeaderTable(props: { rows: HeaderRow[] }) {
  if (props.rows.length === 0) return <EmptyBlock />
  return (
    <div className='border-border/70 overflow-hidden rounded-md border'>
      {props.rows.map((row, index) => (
        <div
          key={`${row.name}-${index}`}
          className={cn(
            'grid min-w-0 grid-cols-1 text-xs sm:grid-cols-[minmax(8rem,14rem)_minmax(0,1fr)]',
            index > 0 && 'border-border/70 border-t'
          )}
        >
          <div className='bg-muted/40 min-w-0 px-3 py-2 font-medium break-words'>
            {row.name}
          </div>
          <div className='min-w-0 px-3 py-2 font-mono break-all'>
            {row.value}
          </div>
        </div>
      ))}
    </div>
  )
}

function TextBlock(props: {
  title: string
  value: string
  meta?: string
  targetId?: string
  disablePreview?: boolean
  onPreviewOpen?: PreviewOpenHandler
}) {
  const displayValue = props.disablePreview
    ? compactLargePayloadForDisplay(props.value)
    : props.value

  if (!props.value) {
    return (
      <div id={props.targetId} className='flex scroll-mt-4 flex-col gap-2'>
        <SectionTitle title={props.title} description={props.meta} />
        <EmptyBlock />
      </div>
    )
  }

  return (
    <div id={props.targetId} className='flex scroll-mt-4 flex-col gap-2'>
      <SectionTitle
        title={props.title}
        description={props.meta}
        action={<CopyButton value={props.value} />}
      />
      {props.disablePreview ? (
        <pre className='bg-muted/50 max-h-[48vh] max-w-full min-w-0 overflow-auto rounded-md p-3 text-xs leading-relaxed [overflow-wrap:anywhere] break-words whitespace-pre-wrap'>
          {displayValue}
        </pre>
      ) : (
        <RenderedContentBlock
          value={props.value}
          onPreviewOpen={props.onPreviewOpen}
          maxHeightClassName='max-h-[48vh]'
        />
      )}
    </div>
  )
}

function StructuredPreviewPanel(props: {
  title: string
  value: unknown
  rawValue?: string
  targetId?: string
  onPreviewOpen?: PreviewOpenHandler
}) {
  const { t } = useTranslation()
  const preview = useMemo(
    () => parseStructuredPreview(props.value),
    [props.value]
  )
  const images = useMemo(
    () => (preview.type === 'json' ? detectImagePreviews(props.value) : []),
    [preview.type, props.value]
  )
  const copyValue = props.rawValue ?? preview.formatted
  const displayValue = compactLargePayloadForDisplay(preview.formatted)

  if (preview.type === 'empty') {
    return (
      <div id={props.targetId} className='flex scroll-mt-4 flex-col gap-2'>
        <SectionTitle title={props.title} />
        <EmptyBlock />
      </div>
    )
  }

  return (
    <div id={props.targetId} className='flex scroll-mt-4 flex-col gap-2'>
      <SectionTitle
        title={props.title}
        action={<CopyButton value={copyValue} label={t('Copy Raw')} />}
      />
      {preview.type === 'text' ? (
        <RenderedMarkdownContent
          value={preview.formatted}
          onPreviewOpen={props.onPreviewOpen}
          className='max-h-72'
        />
      ) : (
        <>
          <pre className='bg-muted/40 border-border/70 max-h-72 max-w-full min-w-0 overflow-auto rounded-md border p-3 text-xs leading-relaxed [overflow-wrap:anywhere] break-words whitespace-pre-wrap'>
            {displayValue}
          </pre>
          <InlineImageGrid
            images={images}
            itemId='structured-images'
            onPreviewOpen={props.onPreviewOpen}
          />
        </>
      )}
    </div>
  )
}

function RawEventDebugBlock(props: { title: string; value: string }) {
  const { t } = useTranslation()
  const displayValue = compactLargePayloadForDisplay(props.value)

  if (!props.value) return null

  return (
    <div className='border-border/60 bg-muted/20 overflow-hidden rounded-md border'>
      <div className='flex min-w-0 items-center justify-between gap-2 px-3 py-2'>
        <span className='text-muted-foreground truncate text-xs font-medium'>
          {t(props.title)}
        </span>
        <CopyButton value={props.value} label={t('Copy Raw')} />
      </div>
      <div className='border-border/60 flex flex-col gap-2 border-t p-2'>
        <pre className='text-muted-foreground bg-background/50 max-h-24 max-w-full min-w-0 overflow-auto rounded-sm p-2 font-mono text-[11px] leading-relaxed [overflow-wrap:anywhere] break-words whitespace-pre-wrap'>
          {displayValue}
        </pre>
      </div>
    </div>
  )
}

function ToolEventCard(props: {
  event: AuditToolCall
  sequenceNumber?: number
  targetId?: string
  onPreviewOpen?: PreviewOpenHandler
}) {
  const { t } = useTranslation()
  const isResult = props.event.kind === 'result'
  const panelValue = isResult
    ? (props.event.outputValue ?? props.event.output)
    : (props.event.inputValue ?? props.event.input)
  const panelRawValue = isResult ? props.event.output : props.event.input

  return (
    <div
      id={props.targetId}
      className={cn(
        'min-w-0 scroll-mt-4 rounded-md border p-3',
        isResult
          ? props.event.isError
            ? 'border-destructive/30 bg-destructive/5'
            : 'border-success/30 bg-success/5'
          : 'border-warning/30 bg-warning/5'
      )}
    >
      <div className='mb-3 flex min-w-0 flex-wrap items-center gap-2'>
        {props.sequenceNumber !== undefined && (
          <Badge variant='outline' className='font-mono'>
            #{props.sequenceNumber}
          </Badge>
        )}
        <Badge
          variant={
            isResult
              ? props.event.isError
                ? 'destructive'
                : 'default'
              : 'secondary'
          }
        >
          {isResult
            ? props.event.isError
              ? t('Tool Error Result')
              : t('Tool Result')
            : t('Tool Call')}
        </Badge>
        <span className='min-w-0 font-mono text-sm font-medium break-all'>
          {props.event.name || t('Unnamed Tool')}
        </span>
        {props.event.id && (
          <Badge variant='outline' className='max-w-full font-mono'>
            {t('Call ID')}: {props.event.id}
          </Badge>
        )}
        {props.event.type && (
          <Badge variant='outline' className='max-w-full font-mono'>
            {props.event.type}
          </Badge>
        )}
      </div>

      {!isResult && props.event.inputFields.length > 0 && (
        <div className='mb-3'>
          <div className='mb-2 text-sm font-medium'>{t('Arguments')}</div>
          <KeyValueList rows={props.event.inputFields} />
        </div>
      )}

      <div className='mt-3 flex flex-col gap-3'>
        {(isResult || props.event.inputFields.length === 0) && (
          <StructuredPreviewPanel
            title={
              isResult ? t('Structured Result') : t('Structured Arguments')
            }
            value={panelValue}
            rawValue={panelRawValue}
            onPreviewOpen={props.onPreviewOpen}
          />
        )}
        <RawEventDebugBlock title='Raw Tool Event' value={props.event.raw} />
      </div>
    </div>
  )
}

function ConversationList(props: {
  title: string
  items: AuditConversationItem[]
  emptyLabel: string
  targetPrefix: string
  onPreviewOpen?: PreviewOpenHandler
}) {
  if (props.items.length === 0) return <EmptyBlock label={props.emptyLabel} />
  return (
    <div className='flex flex-col gap-3'>
      <SectionTitle title={props.title} icon={MessageMultiple02Icon} />
      {props.items.map((item, index) => (
        <ConversationCard
          key={item.id}
          item={item}
          index={index}
          targetPrefix={props.targetPrefix}
          onPreviewOpen={props.onPreviewOpen}
        />
      ))}
    </div>
  )
}

function ConversationCard(props: {
  item: AuditConversationItem
  index: number
  targetPrefix: string
  onPreviewOpen?: PreviewOpenHandler
}) {
  const hasToolCall = props.item.parts.some((part) => part.toolCall)
  const rawMessageEvent = props.item.raw

  return (
    <div
      id={conversationTargetId(props.targetPrefix, props.item.id, props.index)}
      className='border-border/70 min-w-0 rounded-md border p-3'
    >
      {!hasToolCall && (
        <div className='mb-3 flex flex-wrap items-center gap-2'>
          <Badge variant='outline' className='font-mono'>
            #{props.index + 1}
          </Badge>
          <Badge variant='secondary'>{props.item.role}</Badge>
          {props.item.title && (
            <Badge variant='outline'>{props.item.title}</Badge>
          )}
        </div>
      )}
      <ContentParts
        parts={props.item.parts}
        sequenceNumber={props.index + 1}
        onPreviewOpen={props.onPreviewOpen}
      />
      {!hasToolCall && rawMessageEvent && (
        <div className='mt-3'>
          <RawEventDebugBlock
            title='Raw Message Event'
            value={rawMessageEvent}
          />
        </div>
      )}
    </div>
  )
}

function ContentParts(props: {
  parts: AuditContentPart[]
  sequenceNumber?: number
  onPreviewOpen?: PreviewOpenHandler
}) {
  const { t } = useTranslation()
  if (props.parts.length === 0) return <EmptyBlock />
  return (
    <div className='flex flex-col gap-2'>
      {props.parts.map((part, index) => {
        if (part.toolCall) {
          return (
            <ToolEventCard
              key={`${part.toolCall.kind}-${part.toolCall.id ?? index}-${part.toolCall.name}`}
              event={part.toolCall}
              sequenceNumber={props.sequenceNumber}
              onPreviewOpen={props.onPreviewOpen}
            />
          )
        }

        const imagePreviewItem = buildImagePartPreviewItem(part)
        const structuredTitle = part.renderAsMarkdown
          ? undefined
          : contentPartStructuredTitle(part.type, t)
        const showPartType =
          !part.renderAsMarkdown && !isPlainTextPartType(part.type)

        return (
          <div key={`${part.type}-${index}`} className='flex flex-col gap-1'>
            {imagePreviewItem ? (
              <ImagePartCard
                type={part.type}
                item={imagePreviewItem}
                onPreviewOpen={props.onPreviewOpen}
              />
            ) : (
              showPartType && (
                <Badge variant='outline' className='w-fit'>
                  {part.type}
                </Badge>
              )
            )}
            {structuredTitle ? (
              <StructuredPreviewPanel
                title={structuredTitle}
                value={part.text}
                rawValue={part.text}
                onPreviewOpen={props.onPreviewOpen}
              />
            ) : imagePreviewItem ? null : (
              <RenderedContentBlock
                value={part.text}
                onPreviewOpen={props.onPreviewOpen}
                className='p-2'
                maxHeightClassName='max-h-72'
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

function RenderedContentBlock(props: {
  value: string
  onPreviewOpen?: PreviewOpenHandler
  className?: string
  maxHeightClassName?: string
}) {
  const preview = useMemo(
    () => parseStructuredPreview(props.value),
    [props.value]
  )
  const images = useMemo(
    () => (preview.type === 'json' ? detectImagePreviews(props.value) : []),
    [preview.type, props.value]
  )

  if (preview.type === 'json') {
    return (
      <div className='flex min-w-0 flex-col gap-2'>
        <pre
          className={cn(
            'bg-muted/40 border-border/70 max-w-full min-w-0 overflow-auto rounded-md border p-3 text-xs leading-relaxed [overflow-wrap:anywhere] break-words whitespace-pre-wrap',
            props.maxHeightClassName ?? 'max-h-72',
            props.className
          )}
        >
          {preview.formatted}
        </pre>
        <InlineImageGrid
          images={images}
          itemId='inline-json-images'
          onPreviewOpen={props.onPreviewOpen}
        />
      </div>
    )
  }

  return (
    <RenderedMarkdownContent
      value={props.value}
      onPreviewOpen={props.onPreviewOpen}
      className={cn(props.maxHeightClassName ?? 'max-h-72', props.className)}
    />
  )
}

function RenderedMarkdownContent(props: {
  value: string
  onPreviewOpen?: PreviewOpenHandler
  className?: string
}) {
  const images = useMemo(() => detectImagePreviews(props.value), [props.value])
  const markdownValue = useMemo(
    () => removeInlineImageNoise(normalizeMarkdownPreviewContent(props.value)),
    [props.value]
  )

  return (
    <div
      className={cn(
        'bg-muted/40 border-border/70 max-w-full min-w-0 overflow-auto rounded-md border p-3',
        props.className
      )}
    >
      {markdownValue && <AuditMarkdown>{markdownValue}</AuditMarkdown>}
      <InlineImageGrid
        images={images}
        itemId='inline-images'
        className={markdownValue ? 'mt-3' : undefined}
        onPreviewOpen={props.onPreviewOpen}
      />
    </div>
  )
}

function InlineImageGrid(props: {
  images: AuditPreviewImage[]
  itemId: string
  className?: string
  onPreviewOpen?: PreviewOpenHandler
}) {
  const { t } = useTranslation()
  const previewItem = useMemo<AuditPreviewItem | undefined>(() => {
    if (props.images.length === 0) return undefined
    return {
      id: props.itemId,
      kind: 'image',
      label: 'Image Preview',
      images: props.images,
    }
  }, [props.images, props.itemId])

  if (props.images.length === 0) return null

  return (
    <div className={cn('grid gap-3', props.className)}>
      {props.images.map((image, index) => (
        <InlinePreviewImage
          key={`${image.id}-${index}`}
          image={image}
          label={`${t('Image')} #${index + 1}`}
          onClick={
            previewItem
              ? () => props.onPreviewOpen?.(previewItem, index)
              : undefined
          }
        />
      ))}
    </div>
  )
}

function ImagePartCard(props: {
  type: string
  item: AuditPreviewItem
  onPreviewOpen?: PreviewOpenHandler
}) {
  const { t } = useTranslation()
  const [failed, setFailed] = useState(false)
  const [objectUrl, setObjectUrl] = useState<string>()
  const image = props.item.images?.[0]

  useEffect(() => {
    setFailed(false)
    setObjectUrl(undefined)
    if (!image?.url?.startsWith('data:image/')) return

    try {
      const url = createObjectUrlFromDataImage(image.url)
      setObjectUrl(url)
      return () => URL.revokeObjectURL(url)
    } catch {
      setFailed(true)
    }
  }, [image?.url])

  if (!image) return null

  const imageSrc = objectUrl ?? image.url

  return (
    <div className='border-border/70 bg-muted/20 flex min-w-0 flex-col gap-2 rounded-md border p-3'>
      <div className='flex min-w-0 flex-wrap items-center gap-2'>
        <Badge variant='secondary'>{t('Image')}</Badge>
        <Badge variant='outline' className='font-mono'>
          {props.type}
        </Badge>
        <span className='text-muted-foreground min-w-0 truncate font-mono text-xs'>
          {formatPreviewImageSource(image)}
        </span>
      </div>
      <button
        type='button'
        className='bg-background/80 border-border/70 flex h-48 w-fit max-w-full overflow-hidden rounded-md border p-0'
        onClick={() => props.onPreviewOpen?.(props.item)}
        disabled={!props.onPreviewOpen}
      >
        {!failed ? (
          <img
            src={imageSrc}
            alt={image.alt ?? t('Image Preview')}
            className='h-full max-w-full object-contain'
            onError={() => setFailed(true)}
          />
        ) : (
          <div className='text-muted-foreground flex h-full w-64 items-center justify-center p-3 text-sm'>
            {t('Failed to load image')}
          </div>
        )}
      </button>
    </div>
  )
}

function buildImagePartPreviewItem(
  part: AuditContentPart
): AuditPreviewItem | undefined {
  if (!isImagePartType(part.type)) return undefined

  const images = detectImagePreviews(part.text)
  if (images.length === 0) return undefined

  return {
    id: `image-${part.type}`,
    kind: 'image',
    label: 'Image Preview',
    images,
  }
}

function isImagePartType(type: string): boolean {
  const normalized = type.toLowerCase()
  return (
    normalized.includes('image') ||
    normalized.includes('input_image') ||
    normalized.includes('image_url')
  )
}

function isPlainTextPartType(type: string): boolean {
  return type === 'text' || type === 'input_text' || type === 'output_text'
}

function ToolDefinitions(props: {
  tools: AuditToolDefinition[]
  targetPrefix?: string
  onPreviewOpen?: PreviewOpenHandler
}) {
  const { t } = useTranslation()
  if (props.tools.length === 0)
    return <EmptyBlock label={t('No tools parsed')} />
  return (
    <div className='flex flex-col gap-2'>
      {props.tools.map((tool, index) => (
        <div
          key={`${tool.name}-${index}`}
          id={
            props.targetPrefix
              ? toolDefinitionTargetId(props.targetPrefix, tool, index)
              : undefined
          }
          className='border-border/70 min-w-0 rounded-md border p-3'
        >
          <div className='mb-2 flex min-w-0 flex-wrap items-center justify-between gap-2'>
            <div className='flex min-w-0 flex-wrap items-center gap-2'>
              <Badge>{tool.name}</Badge>
              <Badge variant='outline'>{tool.type}</Badge>
            </div>
            <CopyButton value={tool.raw} label={t('Copy Raw')} />
          </div>
          {tool.description && (
            <p className='text-muted-foreground mb-2 text-xs'>
              {tool.description}
            </p>
          )}
          <ToolDefinitionDetails tool={tool} />
        </div>
      ))}
    </div>
  )
}

interface ToolParameterRow {
  name: string
  type: string
  required: boolean
  description: string
}

type AuditJsonRecord = Record<string, unknown>

function ToolDefinitionDetails(props: { tool: AuditToolDefinition }) {
  const { t } = useTranslation()
  const parsed = parseToolDefinition(props.tool.raw)
  const parameters = parsed ? extractToolParameterRows(parsed) : []
  const configRows = parsed ? extractToolConfigRows(parsed) : []

  if (parameters.length > 0) {
    return (
      <div className='flex flex-col gap-2'>
        <div className='text-sm font-medium'>{t('Parameters')}</div>
        <ToolParameterTable rows={parameters} />
      </div>
    )
  }

  if (configRows.length > 0) {
    return (
      <div className='flex flex-col gap-2'>
        <div className='text-sm font-medium'>{t('Configuration')}</div>
        <KeyValueList rows={configRows} />
      </div>
    )
  }

  return <EmptyBlock label={t('No parsed fields')} />
}

function ToolParameterTable(props: { rows: ToolParameterRow[] }) {
  const { t } = useTranslation()
  return (
    <div className='border-border/70 max-h-72 overflow-auto rounded-md border'>
      <div className='bg-muted/40 border-border/70 sticky top-0 grid min-w-[48rem] grid-cols-[minmax(9rem,1fr)_8rem_6rem_minmax(18rem,2fr)] border-b text-xs font-medium'>
        <div className='px-3 py-2'>{t('Name')}</div>
        <div className='px-3 py-2'>{t('Type')}</div>
        <div className='px-3 py-2'>{t('Required')}</div>
        <div className='px-3 py-2'>{t('Description')}</div>
      </div>
      {props.rows.map((row, index) => (
        <div
          key={`${row.name}-${index}`}
          className={cn(
            'grid min-w-[48rem] grid-cols-[minmax(9rem,1fr)_8rem_6rem_minmax(18rem,2fr)] text-xs',
            index > 0 && 'border-border/70 border-t'
          )}
        >
          <div className='px-3 py-2 font-mono font-medium break-all'>
            {row.name}
          </div>
          <div className='px-3 py-2 font-mono break-all'>{row.type}</div>
          <div className='px-3 py-2'>{row.required ? t('Yes') : t('No')}</div>
          <div className='text-muted-foreground px-3 py-2 break-words'>
            {row.description || '-'}
          </div>
        </div>
      ))}
    </div>
  )
}

function parseToolDefinition(raw: string): AuditJsonRecord | undefined {
  const preview = parseStructuredPreview(raw)
  return isAuditJsonRecord(preview.value) ? preview.value : undefined
}

function extractToolParameterRows(tool: AuditJsonRecord): ToolParameterRow[] {
  const schema = findToolInputSchema(tool)
  if (!schema) return []

  const properties = isAuditJsonRecord(schema.properties)
    ? schema.properties
    : undefined
  if (!properties) return []

  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter(
          (item): item is string => typeof item === 'string'
        )
      : []
  )

  return Object.entries(properties).map(([name, property]) => {
    const record = isAuditJsonRecord(property) ? property : {}
    return {
      name,
      type: formatSchemaType(record),
      required: required.has(name),
      description: formatSchemaDescription(record),
    }
  })
}

function findToolInputSchema(
  tool: AuditJsonRecord
): AuditJsonRecord | undefined {
  const nested = isAuditJsonRecord(tool.function) ? tool.function : tool
  const candidates = [
    nested.parameters,
    nested.input_schema,
    nested.inputSchema,
    nested.schema,
    tool.parameters,
    tool.input_schema,
    tool.inputSchema,
    tool.schema,
    isAuditJsonRecord(tool.json_schema) ? tool.json_schema.schema : undefined,
  ]
  return candidates.find(isAuditJsonRecord)
}

function extractToolConfigRows(tool: AuditJsonRecord): AuditField[] {
  const skipped = new Set([
    'description',
    'function',
    'inputSchema',
    'input_schema',
    'json_schema',
    'name',
    'parameters',
    'schema',
    'type',
  ])

  return Object.entries(tool)
    .filter(([key, value]) => !skipped.has(key) && value !== undefined)
    .map(([name, value]) => ({ name, value: formatToolConfigValue(value) }))
}

function formatSchemaType(schema: AuditJsonRecord): string {
  if (Array.isArray(schema.type)) return schema.type.join(' | ')
  if (typeof schema.type === 'string') {
    if (schema.type === 'array' && isAuditJsonRecord(schema.items)) {
      return `array<${formatSchemaType(schema.items)}>`
    }
    return schema.type
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const variants = schema[key]
    if (Array.isArray(variants)) {
      const types = variants
        .filter(isAuditJsonRecord)
        .map((item) => formatSchemaType(item))
        .filter(Boolean)
      if (types.length > 0) return types.join(' | ')
    }
  }
  if (schema.enum !== undefined) return 'enum'
  if (schema.const !== undefined) return 'const'
  return 'value'
}

function formatSchemaDescription(schema: AuditJsonRecord): string {
  const parts: string[] = []
  if (typeof schema.description === 'string') parts.push(schema.description)
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    parts.push(`enum: ${schema.enum.map(formatToolConfigValue).join(', ')}`)
  }
  if (schema.default !== undefined) {
    parts.push(`default: ${formatToolConfigValue(schema.default)}`)
  }
  return parts.join(' ')
}

function formatToolConfigValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function isAuditJsonRecord(value: unknown): value is AuditJsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function ToolCalls(props: {
  calls: AuditToolCall[]
  targetId?: string
  targetPrefix?: string
  onPreviewOpen?: PreviewOpenHandler
}) {
  const { t } = useTranslation()
  if (props.calls.length === 0)
    return <EmptyBlock label={t('No tool calls parsed')} />
  return (
    <div id={props.targetId} className='flex scroll-mt-4 flex-col gap-2'>
      {props.calls.map((call, index) => (
        <ToolEventCard
          key={`${call.kind}-${call.name}-${call.id ?? index}`}
          event={call}
          sequenceNumber={index + 1}
          targetId={
            props.targetPrefix
              ? toolCallTargetId(props.targetPrefix, call, index)
              : undefined
          }
          onPreviewOpen={props.onPreviewOpen}
        />
      ))}
    </div>
  )
}

function SseSummaryBlock(props: { view: AuditViewModel; targetId?: string }) {
  const { t } = useTranslation()
  const sse = props.view.response.sse
  if (!sse) return null
  const rows: AuditField[] = [
    { name: 'Event Count', value: String(sse.eventCount) },
    { name: 'JSON Events', value: String(sse.jsonEventCount) },
    { name: 'Completed', value: sse.completed ? t('Yes') : t('No') },
    { name: 'DONE Received', value: sse.done ? t('Yes') : t('No') },
  ]

  return (
    <div id={props.targetId} className='flex scroll-mt-4 flex-col gap-3'>
      <SectionTitle title={t('SSE Event Summary')} />
      <FieldGrid rows={rows} />
      <div className='flex flex-col gap-2'>
        <SectionTitle title={t('Event Types')} />
        <KeyValueList rows={sse.eventTypes} />
      </div>
    </div>
  )
}

function OverviewTab(props: {
  view: AuditViewModel
  onPreviewOpen?: PreviewOpenHandler
}) {
  const { t } = useTranslation()
  const curlCommand = useMemo(
    () => buildGatewayCurlCommand(props.view),
    [props.view]
  )
  return (
    <div className='flex flex-col gap-4'>
      <SectionTitle
        title={t('Overview')}
        action={<CopyButton value={curlCommand} label={t('Copy cURL')} />}
      />
      {props.view.warnings.length > 0 && (
        <div className='border-border/70 bg-muted/30 rounded-md border p-3'>
          <div className='mb-2 text-sm font-medium'>{t('Warnings')}</div>
          <div className='flex flex-wrap gap-2'>
            {props.view.warnings.map((warning) => (
              <Badge key={warning} variant='outline'>
                {t(warning)}
              </Badge>
            ))}
          </div>
        </div>
      )}
      <FieldGrid rows={props.view.overview} />
      <TextBlock
        title={t('Final Text')}
        value={props.view.response.text}
        onPreviewOpen={props.onPreviewOpen}
      />
      <OverviewHeaders view={props.view} />
    </div>
  )
}

function RequestTab(props: {
  view: AuditViewModel
  onPreviewOpen?: PreviewOpenHandler
}) {
  const { t } = useTranslation()

  return (
    <div className='flex flex-col gap-4'>
      <SectionTitle title={t('Request Parameters')} />
      <KeyValueList rows={props.view.request.parameters} />
      <TextBlock
        title={t('Raw Request')}
        value={props.view.request.raw}
        disablePreview
        onPreviewOpen={props.onPreviewOpen}
      />
    </div>
  )
}

function ConversationTab(props: {
  view: AuditViewModel
  onPreviewOpen?: PreviewOpenHandler
}) {
  const { t } = useTranslation()
  return (
    <div className='flex flex-col gap-4'>
      <ConversationList
        title={t('System Instructions')}
        items={props.view.request.system}
        emptyLabel={t('No system instructions parsed')}
        targetPrefix='system'
        onPreviewOpen={props.onPreviewOpen}
      />
      <Separator />
      <ConversationList
        title={t('Messages / Input')}
        items={props.view.request.messages}
        emptyLabel={t('No messages parsed')}
        targetPrefix='message'
        onPreviewOpen={props.onPreviewOpen}
      />
    </div>
  )
}

function ResponseTab(props: {
  view: AuditViewModel
  onPreviewOpen?: PreviewOpenHandler
}) {
  const { t } = useTranslation()
  const finishRows = props.view.response.finishReasons.map((reason, index) => ({
    name: `${t('Reason')} ${index + 1}`,
    value: reason,
  }))

  return (
    <div className='flex flex-col gap-4'>
      <TextBlock
        title={t('Final Reply')}
        value={props.view.response.text}
        targetId={RESPONSE_TARGET_IDS.final}
        onPreviewOpen={props.onPreviewOpen}
      />
      <div id={RESPONSE_TARGET_IDS.usage} className='scroll-mt-4'>
        <SectionTitle title={t('Usage')} />
        <div className='mt-2'>
          <KeyValueList rows={props.view.response.usage} />
        </div>
      </div>
      <div id={RESPONSE_TARGET_IDS.finishReasons} className='scroll-mt-4'>
        <SectionTitle title={t('Finish Reasons')} />
        <div className='mt-2'>
          <KeyValueList rows={finishRows} />
        </div>
      </div>
      <SseSummaryBlock view={props.view} targetId={RESPONSE_TARGET_IDS.sse} />
      {props.view.response.reasoning.length > 0 && (
        <div id={RESPONSE_TARGET_IDS.reasoning} className='scroll-mt-4'>
          <SectionTitle title={t('Reasoning / Thinking')} icon={BrainIcon} />
          <div className='mt-2'>
            <ContentParts
              parts={props.view.response.reasoning}
              onPreviewOpen={props.onPreviewOpen}
            />
          </div>
        </div>
      )}
      <div className='flex flex-col gap-2'>
        <SectionTitle title={t('Tool Calls')} icon={ToolsIcon} />
        <ToolCalls
          calls={props.view.response.toolCalls}
          targetId={RESPONSE_TARGET_IDS.toolCalls}
          onPreviewOpen={props.onPreviewOpen}
        />
      </div>
      <TextBlock
        title={t('Raw Response')}
        value={props.view.response.raw}
        targetId={RESPONSE_TARGET_IDS.raw}
        disablePreview
        onPreviewOpen={props.onPreviewOpen}
      />
    </div>
  )
}

function ToolsTab(props: {
  view: AuditViewModel
  onPreviewOpen?: PreviewOpenHandler
}) {
  const { t } = useTranslation()
  return (
    <div className='flex flex-col gap-4'>
      <div id={TOOL_TARGET_IDS.definitions} className='scroll-mt-4'>
        <SectionTitle
          title={t('Tool Definitions')}
          icon={ToolsIcon}
          count={props.view.request.tools.length}
        />
      </div>
      <ToolDefinitions
        tools={props.view.request.tools}
        targetPrefix='tools'
        onPreviewOpen={props.onPreviewOpen}
      />
      <Separator />
      <div id={TOOL_TARGET_IDS.calls} className='scroll-mt-4'>
        <SectionTitle title={t('Tool Calls')} icon={ToolsIcon} />
      </div>
      <ToolCalls
        calls={props.view.response.toolCalls}
        targetPrefix='tools'
        onPreviewOpen={props.onPreviewOpen}
      />
    </div>
  )
}

function OverviewHeaders(props: { view: AuditViewModel }) {
  const { t } = useTranslation()
  return (
    <div className='grid gap-4 md:grid-cols-2'>
      <div className='flex min-w-0 flex-col gap-2'>
        <SectionTitle
          title={t('Request Headers')}
          action={
            <CopyButton
              value={serializeHeaders(props.view.requestHeaders)}
              label={t('Copy All')}
            />
          }
        />
        <HeaderTable rows={props.view.requestHeaders} />
      </div>
      <div className='flex min-w-0 flex-col gap-2'>
        <SectionTitle
          title={t('Response Headers')}
          action={
            <CopyButton
              value={serializeHeaders(props.view.responseHeaders)}
              label={t('Copy All')}
            />
          }
        />
        <HeaderTable rows={props.view.responseHeaders} />
      </div>
    </div>
  )
}

function RawTab(props: {
  view: AuditViewModel
  onPreviewOpen?: PreviewOpenHandler
}) {
  const { t } = useTranslation()
  return (
    <div className='flex flex-col gap-4'>
      <TextBlock
        title={t('Raw Request')}
        value={props.view.request.raw}
        disablePreview
        onPreviewOpen={props.onPreviewOpen}
      />
      <TextBlock
        title={t('Raw Response')}
        value={props.view.response.raw}
        disablePreview
        onPreviewOpen={props.onPreviewOpen}
      />
      <TextBlock
        title={t('Raw Audit Payload')}
        value={props.view.rawPayload}
        disablePreview
        onPreviewOpen={props.onPreviewOpen}
      />
    </div>
  )
}

function AuditSectionNav(props: {
  activeSection: AuditSectionKey
  activeTargetId?: string
  items: AuditNavItem[]
  onSectionChange: (section: AuditSectionKey, targetId?: string) => void
}) {
  const { t } = useTranslation()
  const [expandedSections, setExpandedSections] = useState<
    Set<AuditSectionKey>
  >(() => new Set(['conversation', 'response', 'tools']))

  function toggleSection(section: AuditSectionKey) {
    setExpandedSections((current) => {
      const next = new Set(current)
      if (next.has(section)) {
        next.delete(section)
      } else {
        next.add(section)
      }
      return next
    })
  }

  return (
    <nav
      aria-label={t('Audit Details')}
      className='border-border/70 bg-muted/20 min-w-0 border-b px-4 py-3 lg:border-r lg:border-b-0 lg:bg-transparent lg:px-4 lg:py-4'
    >
      <div className='flex min-w-0 gap-2 overflow-x-auto pb-1 lg:max-h-full lg:flex-col lg:overflow-x-visible lg:overflow-y-auto lg:pb-0'>
        {props.items.map((section) => {
          const active = props.activeSection === section.key
          const hasChildren = Boolean(section.children?.length)
          const expanded = expandedSections.has(section.key)
          return (
            <div key={section.key} className='min-w-40 shrink-0 lg:w-full'>
              <Button
                type='button'
                variant={active ? 'secondary' : 'ghost'}
                size='sm'
                className={cn(
                  'h-9 w-full justify-start gap-2 whitespace-nowrap',
                  active && 'font-medium'
                )}
                aria-current={
                  active && !props.activeTargetId ? 'page' : undefined
                }
                aria-expanded={hasChildren ? expanded : undefined}
                onClick={() => {
                  props.onSectionChange(section.key, section.targetId)
                  if (hasChildren) toggleSection(section.key)
                }}
              >
                <InlineIcon icon={section.icon} className='size-4' />
                <span className='min-w-0 flex-1 truncate text-left'>
                  {t(section.label)}
                </span>
                {hasChildren && (
                  <InlineIcon
                    icon={ArrowDown01Icon}
                    className={cn(
                      'size-3 transition-transform',
                      !expanded && '-rotate-90'
                    )}
                  />
                )}
              </Button>
              {hasChildren && expanded && (
                <div className='mt-1 flex gap-1 overflow-x-auto pl-2 lg:flex-col lg:overflow-x-visible lg:pl-5'>
                  {section.children?.map((child) => {
                    const childActive = props.activeTargetId === child.targetId
                    return (
                      <Button
                        key={child.id}
                        type='button'
                        variant={childActive ? 'secondary' : 'ghost'}
                        size='sm'
                        className={cn(
                          'h-auto min-h-8 w-44 shrink-0 justify-start px-2 py-1.5 text-left lg:w-full',
                          childActive && 'font-medium'
                        )}
                        aria-current={childActive ? 'location' : undefined}
                        onClick={() =>
                          props.onSectionChange(child.section, child.targetId)
                        }
                      >
                        <span className='min-w-0'>
                          <span className='block truncate text-xs'>
                            {child.labelKey
                              ? t(child.labelKey, child.labelParams)
                              : child.label}
                          </span>
                          {child.description && (
                            <span className='text-muted-foreground mt-0.5 block truncate text-[11px]'>
                              {child.description}
                            </span>
                          )}
                        </span>
                      </Button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </nav>
  )
}

function buildAuditNavItems(view: AuditViewModel): AuditNavItem[] {
  return AUDIT_SECTIONS.map((section) => {
    if (section.key === 'conversation') {
      return {
        ...section,
        children: buildConversationNavChildren(view),
      }
    }

    if (section.key === 'response') {
      return {
        ...section,
        children: buildResponseNavChildren(view),
      }
    }

    if (section.key === 'tools') {
      return {
        ...section,
        children: buildToolsNavChildren(view),
      }
    }

    return section
  })
}

function buildConversationNavChildren(
  view: AuditViewModel
): AuditNavChildItem[] {
  const systemItems = view.request.system.map((item, index) =>
    conversationNavChild(item, index, 'system')
  )
  const messageItems = view.request.messages.map((item, index) =>
    conversationNavChild(item, index, 'message')
  )
  return [...systemItems, ...messageItems]
}

function conversationNavChild(
  item: AuditConversationItem,
  index: number,
  prefix: string
): AuditNavChildItem {
  const toolEvent = item.parts.find((part) => part.toolCall)?.toolCall
  if (toolEvent) {
    const isResult = toolEvent.kind === 'result'
    const fallbackDescription = isResult
      ? (toolEvent.output ?? toolEvent.raw)
      : toolEvent.input || toolEvent.id || toolEvent.raw

    return {
      id: `conversation-${prefix}-${item.id}-${index}`,
      label: toolEvent.name || toolEvent.type,
      labelKey: isResult ? 'Tool Result Nav Label' : 'Tool Call Nav Label',
      labelParams: {
        sequence: index + 1,
        tool: toolEvent.name || toolEvent.type,
      },
      description: summarizeAuditText(toolEvent.summary || fallbackDescription),
      section: 'conversation',
      targetId: conversationTargetId(prefix, item.id, index),
    }
  }

  const text = item.parts.map((part) => part.text).join(' ')
  return {
    id: `conversation-${prefix}-${item.id}-${index}`,
    label: `#${index + 1} ${item.role}`,
    description: summarizeAuditText(text || item.raw),
    section: 'conversation',
    targetId: conversationTargetId(prefix, item.id, index),
  }
}

function buildResponseNavChildren(view: AuditViewModel): AuditNavChildItem[] {
  const children: AuditNavChildItem[] = []

  if (view.response.text) {
    children.push(responseNavChild('final', 'Final Reply'))
  }
  if (view.response.usage.length > 0) {
    children.push(responseNavChild('usage', 'Usage'))
  }
  if (view.response.finishReasons.length > 0) {
    children.push(responseNavChild('finishReasons', 'Finish Reasons'))
  }
  if (view.response.sse) {
    children.push(responseNavChild('sse', 'SSE Events'))
  }
  if (view.response.reasoning.length > 0) {
    children.push(responseNavChild('reasoning', 'Reasoning / Thinking'))
  }
  if (view.response.toolCalls.length > 0) {
    children.push(responseNavChild('toolCalls', 'Tool Calls'))
  }
  if (view.response.raw) {
    children.push(responseNavChild('raw', 'Raw Response'))
  }

  return children
}

function responseNavChild(
  key: keyof typeof RESPONSE_TARGET_IDS,
  label: string
): AuditNavChildItem {
  return {
    id: `response-${key}`,
    label,
    labelKey: label,
    section: 'response',
    targetId: RESPONSE_TARGET_IDS[key],
  }
}

function buildToolsNavChildren(view: AuditViewModel): AuditNavChildItem[] {
  const children: AuditNavChildItem[] = []

  for (const [index, tool] of view.request.tools.entries()) {
    children.push({
      id: `tools-definition-${index}`,
      label: tool.name,
      labelKey: 'Tool Definition Nav Label',
      labelParams: { tool: tool.name },
      description: summarizeAuditText(tool.description || tool.type),
      section: 'tools',
      targetId: toolDefinitionTargetId('tools', tool, index),
    })
  }

  for (const [index, call] of view.response.toolCalls.entries()) {
    const isResult = call.kind === 'result'
    const fallbackDescription = isResult
      ? (call.output ?? call.raw)
      : call.input || call.id || call.raw
    children.push({
      id: `tools-call-${index}`,
      label: call.name || call.type,
      labelKey: isResult ? 'Tool Result Nav Label' : 'Tool Call Nav Label',
      labelParams: {
        sequence: index + 1,
        tool: call.name || call.type,
      },
      description: summarizeAuditText(call.summary || fallbackDescription),
      section: 'tools',
      targetId: toolCallTargetId('tools', call, index),
    })
  }

  return children
}

function conversationTargetId(
  prefix: string,
  itemId: string,
  index: number
): string {
  return `audit-conversation-${prefix}-${sanitizeDomId(itemId)}-${index}`
}

function toolDefinitionTargetId(
  prefix: string,
  tool: AuditToolDefinition,
  index: number
): string {
  return `audit-${prefix}-definition-${sanitizeDomId(tool.name || tool.type)}-${index}`
}

function toolCallTargetId(
  prefix: string,
  call: AuditToolCall,
  index: number
): string {
  return `audit-${prefix}-call-${sanitizeDomId(call.id || call.name || call.type)}-${index}`
}

function sanitizeDomId(value: string): string {
  const normalized = value
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-|-$/g, '')
  return normalized || 'item'
}

function contentPartStructuredTitle(
  type: string,
  t: (key: string) => string
): string | undefined {
  const normalized = type.toLowerCase()
  if (
    normalized.includes('tool_result') ||
    normalized.includes('function_call_output')
  ) {
    return t('Structured Result')
  }
  if (
    normalized.includes('tool_use') ||
    normalized.includes('tool_call') ||
    normalized.includes('function_call')
  ) {
    return t('Structured Arguments')
  }
  return undefined
}

function AuditSectionContent(props: {
  section: AuditSectionKey
  view: AuditViewModel
  onPreviewOpen?: PreviewOpenHandler
}) {
  switch (props.section) {
    case 'request':
      return (
        <RequestTab view={props.view} onPreviewOpen={props.onPreviewOpen} />
      )
    case 'conversation':
      return (
        <ConversationTab
          view={props.view}
          onPreviewOpen={props.onPreviewOpen}
        />
      )
    case 'response':
      return (
        <ResponseTab view={props.view} onPreviewOpen={props.onPreviewOpen} />
      )
    case 'tools':
      return <ToolsTab view={props.view} onPreviewOpen={props.onPreviewOpen} />
    case 'raw':
      return <RawTab view={props.view} onPreviewOpen={props.onPreviewOpen} />
    case 'overview':
    default:
      return (
        <OverviewTab view={props.view} onPreviewOpen={props.onPreviewOpen} />
      )
  }
}

function AuditDrawerBody(props: {
  view: AuditViewModel
  activeSection: AuditSectionKey
  activeTargetId?: string
  onSectionChange: (section: AuditSectionKey, targetId?: string) => void
}) {
  const [previewState, setPreviewState] =
    useState<AuditPreviewDialogState>(null)
  const mainRef = useRef<HTMLElement | null>(null)
  const navItems = useMemo(() => buildAuditNavItems(props.view), [props.view])

  useEffect(() => {
    if (!props.activeTargetId) return
    const timer = window.setTimeout(() => {
      const target = mainRef.current
        ? findElementById(mainRef.current, props.activeTargetId ?? '')
        : null
      if (!target || !mainRef.current) return

      const containerRect = mainRef.current.getBoundingClientRect()
      const targetRect = target.getBoundingClientRect()
      mainRef.current.scrollTo({
        top: mainRef.current.scrollTop + targetRect.top - containerRect.top,
        behavior: 'smooth',
      })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [props.activeSection, props.activeTargetId])

  function openPreview(item: AuditPreviewItem, imageIndex?: number) {
    setPreviewState({ item, imageIndex })
  }

  return (
    <div className='grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden lg:grid-cols-[15rem_minmax(0,1fr)] lg:grid-rows-1'>
      <AuditSectionNav
        activeSection={props.activeSection}
        activeTargetId={props.activeTargetId}
        items={navItems}
        onSectionChange={props.onSectionChange}
      />
      <main
        ref={mainRef}
        className={sideDrawerFormClassName(
          'min-w-0 gap-4 px-4 py-4 sm:px-6 sm:py-5'
        )}
      >
        <AuditSectionContent
          section={props.activeSection}
          view={props.view}
          onPreviewOpen={openPreview}
        />
      </main>
      <AuditPreviewDialog
        state={previewState}
        onOpenChange={(open) => {
          if (!open) setPreviewState(null)
        }}
        onImageIndexChange={(imageIndex) => {
          setPreviewState((current) =>
            current ? { ...current, imageIndex } : current
          )
        }}
      />
    </div>
  )
}

export function AuditDialog(props: AuditDialogProps) {
  const { t } = useTranslation()
  const [detail, setDetail] = useState<LogAuditDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [activeSection, setActiveSection] =
    useState<AuditSectionKey>('overview')
  const [activeTargetId, setActiveTargetId] = useState<string | undefined>()

  const logId = props.log.log_id || props.log.id

  useEffect(() => {
    if (!props.open) return
    setLoading(true)
    setDetail(null)
    setActiveSection('overview')
    setActiveTargetId(undefined)
    getLogAuditDetail(logId, props.isAdmin)
      .then((result) => {
        if (result.success && result.data) {
          setDetail(result.data)
        } else {
          toast.error(result.message || t('Failed to load audit details'))
        }
      })
      .catch(() => {
        toast.error(t('Failed to load audit details'))
      })
      .finally(() => setLoading(false))
  }, [logId, props.isAdmin, props.open, t])

  const payload = useMemo(
    () => parseLogAuditPayload(detail?.payload ?? ''),
    [detail?.payload]
  )
  const view = useMemo(() => {
    if (!payload) return null
    return buildAuditViewModel(payload, detail?.payload ?? '')
  }, [detail?.payload, payload])

  function handleSectionChange(
    section: AuditSectionKey,
    targetId?: string
  ): void {
    setActiveSection(section)
    setActiveTargetId(targetId)
  }

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent
        className={sideDrawerContentClassName(
          'max-w-none sm:max-w-[min(1120px,calc(100vw-3rem))]'
        )}
      >
        <SheetHeader className={sideDrawerHeaderClassName('pr-12')}>
          <SheetTitle className='flex items-center gap-2 text-base'>
            <InlineIcon icon={FileSearchIcon} />
            {t('Audit Details')}
            {view && <Badge variant='secondary'>{t(view.protocolLabel)}</Badge>}
          </SheetTitle>
          <SheetDescription className='sr-only'>
            {t('Request and response audit details')}
          </SheetDescription>
        </SheetHeader>

        <div className='flex min-h-0 flex-1 flex-col overflow-hidden'>
          {loading ? (
            <div className='text-muted-foreground flex min-h-0 flex-1 items-center justify-center gap-2 text-sm'>
              <InlineIcon icon={Loading03Icon} className='animate-spin' />
              {t('Loading')}
            </div>
          ) : view ? (
            <AuditDrawerBody
              view={view}
              activeSection={activeSection}
              activeTargetId={activeTargetId}
              onSectionChange={handleSectionChange}
            />
          ) : (
            <div className='text-muted-foreground flex min-h-0 flex-1 items-center justify-center px-4 py-12 text-center text-sm'>
              {t('No audit details')}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function serializeHeaders(rows: HeaderRow[]): string {
  return rows.map((row) => `${row.name}: ${row.value}`).join('\n')
}

function findElementById(
  container: HTMLElement,
  targetId: string
): HTMLElement | null {
  if (!targetId) return null
  if (container.id === targetId) return container

  const elements = container.querySelectorAll<HTMLElement>('[id]')
  for (const element of elements) {
    if (element.id === targetId) return element
  }
  return null
}
