import type {
  LogAuditMessage,
  LogAuditPayload,
  LogAuditResponse,
} from '../types'

type JsonObject = Record<string, unknown>

export interface HeaderRow {
  name: string
  value: string
}

export interface AuditField {
  name: string
  value: string
}

export interface AuditContentPart {
  type: string
  text: string
  renderAsMarkdown?: boolean
  toolCall?: AuditToolCall
}

export interface AuditConversationItem {
  id: string
  role: string
  title?: string
  parts: AuditContentPart[]
  raw: string
}

export interface AuditToolDefinition {
  name: string
  type: string
  description?: string
  raw: string
}

export interface AuditToolCall {
  kind: 'call' | 'result'
  id?: string
  name: string
  type: string
  input: string
  inputValue?: unknown
  output?: string
  outputValue?: unknown
  inputFields: AuditField[]
  summary: string
  isError?: boolean
  raw: string
}

export interface AuditSseEvent {
  index: number
  data: string
  parsed?: unknown
  isDone: boolean
}

export interface AuditSseSummary {
  events: AuditSseEvent[]
  eventCount: number
  jsonEventCount: number
  done: boolean
  completed: boolean
  eventTypes: AuditField[]
  text: string
  finishReasons: string[]
  reasoning: AuditContentPart[]
  toolCalls: AuditToolCall[]
  usage: AuditField[]
}

export interface AuditRequestView {
  raw: string
  parseError?: string
  parameters: AuditField[]
  system: AuditConversationItem[]
  messages: AuditConversationItem[]
  tools: AuditToolDefinition[]
  toolChoice?: string
}

export interface AuditResponseView {
  raw: string
  parseError?: string
  type?: string
  text: string
  usage: AuditField[]
  finishReasons: string[]
  reasoning: AuditContentPart[]
  toolCalls: AuditToolCall[]
  sse?: AuditSseSummary
}

export interface AuditViewModel {
  payload: LogAuditPayload
  protocol: string
  protocolLabel: string
  overview: AuditField[]
  request: AuditRequestView
  response: AuditResponseView
  requestHeaders: HeaderRow[]
  responseHeaders: HeaderRow[]
  rawPayload: string
  warnings: string[]
}

const REQUEST_PARAMETER_KEYS = [
  'model',
  'stream',
  'temperature',
  'top_p',
  'top_k',
  'max_tokens',
  'max_output_tokens',
  'max_completion_tokens',
  'reasoning_effort',
  'thinking',
  'response_format',
  'tool_choice',
  'toolConfig',
  'parallel_tool_calls',
  'include',
  'seed',
  'stop',
  'n',
  'presence_penalty',
  'frequency_penalty',
  'metadata',
  'store',
  'encoding_format',
  'dimensions',
  'user',
  'top_n',
  'return_documents',
  'size',
  'quality',
  'style',
  'background',
  'output_format',
  'output_compression',
  'voice',
  'speed',
  'taskType',
  'outputDimensionality',
  'generationConfig',
  'safetySettings',
]

const USAGE_KEYS = [
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'cached_tokens',
  'reasoning_tokens',
  'thoughtsTokenCount',
  'promptTokenCount',
  'candidatesTokenCount',
  'totalTokenCount',
]

const TOOL_CALL_TYPES = new Set(['function_call', 'tool_call', 'tool_use'])
const TOOL_RESULT_TYPES = new Set([
  'function_call_output',
  'tool_result',
  'function_response',
])
const NON_TOOL_OUTPUT_TYPES = new Set([
  'message',
  'text',
  'input_text',
  'output_text',
  'input_image',
  'output_image',
  'image',
  'reasoning',
  'refusal',
])
const TOOL_JSON_FIELD_KEYS = new Set([
  'arguments',
  'args',
  'input',
  'output',
  'response',
  'result',
  'content',
  'text',
])
const MAX_RECURSIVE_JSON_DEPTH = 4
const MAX_TOOL_FIELD_ROWS = 12
const TOOL_RESULT_TEXT_KEYS = [
  'text',
  'message',
  'error',
  'showapi_res_error',
  'msg',
  'errmsg',
  'error_message',
]
const TOOL_RESULT_PAYLOAD_KEYS = [
  'showapi_res_body',
  'content',
  'body',
  'data',
  'result',
  'output',
  'response',
]
const WEATHER_FIELD_KEYS = [
  'city',
  'cityName',
  'area',
  'areaName',
  'name',
  'c3',
  'c5',
  'weather',
  'weatherText',
  'condition',
  'day_weather',
  'night_weather',
  'temperature',
  'temp',
  'now_temperature',
  'min_temperature',
  'max_temperature',
  'humidity',
  'sd',
  'wind',
  'wind_direction',
  'wind_power',
  'aqi',
  'quality',
]

export function parseLogAuditPayload(raw: string): LogAuditPayload | null {
  const parsed = safeParseJson(raw)
  if (isRecord(parsed)) return parsed as unknown as LogAuditPayload
  return null
}

export function buildAuditViewModel(
  payload: LogAuditPayload,
  rawPayload: string
): AuditViewModel {
  const requestJson = safeParseJson(payload.request?.raw)
  const responseJson = safeParseJson(payload.response?.raw)
  const protocol = detectProtocol(payload, requestJson, responseJson)
  const sse =
    payload.response?.type === 'stream'
      ? buildSseSummary(payload.response?.raw, protocol)
      : undefined
  const request = buildRequestView(payload.request, requestJson, protocol)
  const response = buildResponseView(
    payload.response,
    responseJson,
    protocol,
    sse
  )

  return {
    payload,
    protocol,
    protocolLabel: protocolToLabel(protocol),
    overview: buildOverview(payload, protocol, request, response, sse),
    request,
    response,
    requestHeaders: toHeaderRows(payload.request?.headers),
    responseHeaders: toHeaderRows(payload.response?.headers),
    rawPayload: formatJsonLike(rawPayload),
    warnings: buildWarnings(payload, request, response),
  }
}

export function toHeaderRows(
  headers: Record<string, unknown> | undefined
): HeaderRow[] {
  if (!headers) return []
  return Object.entries(headers)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([name, values]) => {
      if (!Array.isArray(values) || values.length === 0) {
        return [{ name, value: summarizeJsonValue(values) }]
      }
      return values.map((value) => ({ name, value: summarizeJsonValue(value) }))
    })
}

function buildRequestView(
  message: LogAuditMessage | undefined,
  json: unknown,
  protocol: string
): AuditRequestView {
  const raw = formatRawBody(message)
  const request = isRecord(json) ? json : undefined
  const system = request ? extractSystemItems(request, protocol) : []
  const messages = request ? extractConversationItems(request, protocol) : []
  const tools = request ? extractToolDefinitions(request, protocol) : []
  const toolChoice = request ? summarizeJsonValue(request.tool_choice) : ''

  return {
    raw,
    parseError: raw && !request ? 'Body is not valid JSON' : undefined,
    parameters: request ? extractFields(request, REQUEST_PARAMETER_KEYS) : [],
    system,
    messages,
    tools,
    toolChoice,
  }
}

function buildResponseView(
  message: LogAuditResponse | undefined,
  json: unknown,
  protocol: string,
  sse: AuditSseSummary | undefined
): AuditResponseView {
  const raw = formatRawBody(message)
  const response = isRecord(json) ? json : undefined
  if (sse) {
    return {
      raw,
      parseError: undefined,
      type: message?.type,
      text: sse.text,
      usage: sse.usage,
      finishReasons: sse.finishReasons,
      reasoning: response
        ? extractReasoning(response, protocol)
        : sse.reasoning,
      toolCalls: linkToolEvents(sse.toolCalls),
      sse,
    }
  }

  return {
    raw,
    parseError: raw && !response ? 'Body is not valid JSON' : undefined,
    type: message?.type,
    text: response ? extractResponseTextFromJson(response, protocol) : '',
    usage: response ? extractUsage(response) : [],
    finishReasons: response ? extractFinishReasons(response, protocol) : [],
    reasoning: response ? extractReasoning(response, protocol) : [],
    toolCalls: response
      ? linkToolEvents(extractToolCalls(response, protocol))
      : [],
  }
}

function buildOverview(
  payload: LogAuditPayload,
  protocol: string,
  request: AuditRequestView,
  response: AuditResponseView,
  sse: AuditSseSummary | undefined
): AuditField[] {
  const source = payload.source
  const rows: AuditField[] = [
    { name: 'Protocol', value: protocolToLabel(protocol) },
    { name: 'Request Format', value: stringValue(source?.request_format) },
    { name: 'Relay Format', value: stringValue(source?.relay_format) },
    { name: 'Endpoint', value: stringValue(source?.endpoint) },
    { name: 'Upstream URL', value: stringValue(source?.upstream_url) },
    { name: 'Original Model', value: stringValue(source?.original_model) },
    { name: 'Upstream Model', value: stringValue(source?.upstream_model) },
    {
      name: 'Transport',
      value:
        source?.stream || payload.response?.type === 'stream'
          ? 'Stream'
          : 'Non-stream',
    },
    { name: 'Request Bytes', value: byteValue(payload.request) },
    { name: 'Response Bytes', value: byteValue(payload.response) },
    { name: 'Messages', value: countValue(request.messages.length) },
    { name: 'Tools', value: countValue(request.tools.length) },
    { name: 'Tool Calls', value: countValue(response.toolCalls.length) },
    { name: 'SSE Events', value: sse ? countValue(sse.eventCount) : '' },
  ]

  return rows.filter((row) => row.value !== '')
}

function buildWarnings(
  payload: LogAuditPayload,
  request: AuditRequestView,
  response: AuditResponseView
): string[] {
  const warnings: string[] = []
  if (payload.request?.truncated) warnings.push('Request body was truncated')
  if (payload.response?.truncated) warnings.push('Response body was truncated')
  if (request.parseError) warnings.push('Request body is not JSON')
  if (response.parseError) warnings.push('Response body is not JSON')
  if (!request.raw && !response.raw)
    warnings.push('No request or response body')
  return warnings
}

function detectProtocol(
  payload: LogAuditPayload,
  requestJson: unknown,
  responseJson: unknown
): string {
  const sourceText = [
    payload.source?.protocol,
    payload.source?.request_format,
    payload.source?.relay_format,
    payload.source?.endpoint,
    payload.source?.upstream_url,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  if (
    sourceText.includes('responses/compact') ||
    sourceText.includes('responses_compact') ||
    sourceText.includes('compaction')
  ) {
    return 'openai_responses_compact'
  }
  if (
    sourceText.includes(':embedcontent') ||
    sourceText.includes(':batchembedcontents') ||
    (sourceText.includes('gemini') && sourceText.includes('embedding'))
  ) {
    return 'gemini_embeddings'
  }
  if (
    sourceText.includes('/v1/completions') &&
    !sourceText.includes('/chat/completions')
  ) {
    return 'openai_completions'
  }
  if (sourceText.includes('/v1/chat/completions')) return 'openai_chat'
  if (sourceText.includes('/v1/embeddings')) return 'openai_embeddings'
  if (sourceText.includes('/v1/moderations')) return 'openai_moderations'
  if (sourceText.includes('/v1/rerank') || sourceText.includes('rerank')) {
    return 'rerank'
  }
  if (sourceText.includes('/v1/images') || sourceText.includes('image')) {
    return 'openai_image'
  }
  if (
    sourceText.includes('/v1/audio/speech') ||
    sourceText.includes('audio_speech') ||
    sourceText.includes('tts')
  ) {
    return 'openai_audio_speech'
  }
  if (sourceText.includes('responses')) return 'openai_responses'
  if (sourceText.includes('claude') || sourceText.includes('anthropic')) {
    return 'claude_messages'
  }
  if (sourceText.includes('gemini') || sourceText.includes('generatecontent')) {
    return 'gemini_generate_content'
  }
  if (isRecord(requestJson)) {
    if (hasOwn(requestJson, 'query') && hasOwn(requestJson, 'documents')) {
      return 'rerank'
    }
    if (hasOwn(requestJson, 'prompt') && hasOwn(requestJson, 'size')) {
      return 'openai_image'
    }
    if (hasOwn(requestJson, 'prompt') && !Array.isArray(requestJson.messages)) {
      return 'openai_completions'
    }
    if (hasOwn(requestJson, 'voice') && hasOwn(requestJson, 'input')) {
      return 'openai_audio_speech'
    }
    if (
      hasOwn(requestJson, 'moderation') ||
      hasOwn(requestJson, 'categories')
    ) {
      return 'openai_moderations'
    }
    if (
      hasOwn(requestJson, 'encoding_format') ||
      hasOwn(requestJson, 'dimensions')
    ) {
      return 'openai_embeddings'
    }
    if (
      hasOwn(requestJson, 'taskType') ||
      hasOwn(requestJson, 'outputDimensionality') ||
      Array.isArray(requestJson.requests)
    ) {
      return 'gemini_embeddings'
    }
    if (Array.isArray(requestJson.contents)) return 'gemini_generate_content'
    if ('input' in requestJson || 'instructions' in requestJson) {
      return 'openai_responses'
    }
    if ('system' in requestJson && 'max_tokens' in requestJson) {
      return 'claude_messages'
    }
    if (Array.isArray(requestJson.messages)) return 'openai_chat'
  }
  if (isRecord(responseJson)) {
    if (hasEmbeddingData(responseJson)) return 'openai_embeddings'
    if (hasRerankData(responseJson)) return 'rerank'
    if (hasModerationData(responseJson)) return 'openai_moderations'
    if (hasImageData(responseJson)) return 'openai_image'
    if (hasGeminiEmbeddingData(responseJson)) return 'gemini_embeddings'
    if ('output' in responseJson || 'output_text' in responseJson) {
      return 'openai_responses'
    }
    if ('candidates' in responseJson) return 'gemini_generate_content'
    if ('stop_reason' in responseJson) return 'claude_messages'
    if ('choices' in responseJson) return 'openai_chat'
  }
  return 'unknown'
}

function protocolToLabel(protocol: string): string {
  switch (protocol) {
    case 'openai_chat':
      return 'OpenAI Chat'
    case 'openai_responses':
      return 'OpenAI Responses'
    case 'openai_responses_compact':
      return 'OpenAI Responses Compact'
    case 'openai_completions':
      return 'OpenAI Completions'
    case 'openai_embeddings':
      return 'OpenAI Embeddings'
    case 'openai_moderations':
      return 'OpenAI Moderations'
    case 'openai_image':
      return 'OpenAI Images'
    case 'openai_audio_speech':
      return 'OpenAI Audio Speech'
    case 'claude_messages':
      return 'Claude Messages'
    case 'gemini_generate_content':
      return 'Gemini generateContent'
    case 'gemini_embeddings':
      return 'Gemini Embeddings'
    case 'rerank':
      return 'Rerank'
    default:
      return 'Unknown'
  }
}

function extractSystemItems(
  request: JsonObject,
  protocol: string
): AuditConversationItem[] {
  const items: AuditConversationItem[] = []
  if (protocol === 'claude_messages' && request.system !== undefined) {
    items.push(toConversationItem(request.system, 'system', 'system-0'))
  }
  if (
    (protocol === 'openai_responses' ||
      protocol === 'openai_responses_compact') &&
    request.instructions !== undefined
  ) {
    items.push(
      toConversationItem(request.instructions, 'system', 'instructions')
    )
  }
  if (
    protocol === 'gemini_generate_content' &&
    request.systemInstruction !== undefined
  ) {
    items.push(
      toConversationItem(
        request.systemInstruction,
        'system',
        'systemInstruction'
      )
    )
  }
  return items
}

function extractConversationItems(
  request: JsonObject,
  protocol: string
): AuditConversationItem[] {
  if (protocol === 'gemini_generate_content') {
    return linkConversationToolEvents(
      arrayValue(request.contents).map((item, index) =>
        toConversationItem(
          item,
          roleFromRecord(item, 'user'),
          `content-${index}`
        )
      )
    )
  }
  if (protocol === 'gemini_embeddings') {
    return extractGeminiEmbeddingInputs(request)
  }
  if (
    protocol === 'openai_responses' ||
    protocol === 'openai_responses_compact'
  ) {
    return extractResponsesInput(request.input)
  }
  if (
    protocol === 'openai_completions' ||
    protocol === 'openai_image' ||
    protocol === 'openai_audio_speech'
  ) {
    return extractScalarOrArrayInput(
      firstDefined(request.prompt, request.input),
      'user',
      'input'
    )
  }
  if (protocol === 'openai_embeddings' || protocol === 'openai_moderations') {
    return extractScalarOrArrayInput(request.input, 'user', 'input')
  }
  if (protocol === 'rerank') {
    return extractRerankInputs(request)
  }
  return linkConversationToolEvents(
    arrayValue(request.messages).map((item, index) => {
      const role = roleFromRecord(item, 'message')
      return toConversationItem(item, role, `message-${index}`)
    })
  )
}

function extractResponsesInput(input: unknown): AuditConversationItem[] {
  if (typeof input === 'string') {
    return [toConversationItem(input, 'user', 'input-0')]
  }
  if (Array.isArray(input)) {
    return linkConversationToolEvents(
      input.map((item, index) => {
        const role = roleFromRecord(item, 'input')
        return toConversationItem(item, role, `input-${index}`)
      })
    )
  }
  if (input !== undefined)
    return [toConversationItem(input, 'input', 'input-0')]
  return []
}

function extractScalarOrArrayInput(
  value: unknown,
  role: string,
  idPrefix: string
): AuditConversationItem[] {
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      toConversationItem(item, role, `${idPrefix}-${index}`)
    )
  }
  if (value !== undefined) {
    return [toConversationItem(value, role, `${idPrefix}-0`)]
  }
  return []
}

function extractRerankInputs(request: JsonObject): AuditConversationItem[] {
  const items: AuditConversationItem[] = []
  if (request.query !== undefined) {
    items.push(toConversationItem(request.query, 'query', 'query-0'))
  }
  items.push(
    ...arrayValue(request.documents).map((document, index) =>
      toConversationItem(document, 'document', `document-${index}`)
    )
  )
  return items
}

function extractGeminiEmbeddingInputs(
  request: JsonObject
): AuditConversationItem[] {
  if (Array.isArray(request.requests)) {
    return request.requests.map((item, index) =>
      toConversationItem(item, roleFromRecord(item, 'user'), `request-${index}`)
    )
  }
  return extractScalarOrArrayInput(request.content, 'user', 'content')
}

function toConversationItem(
  value: unknown,
  fallbackRole: string,
  id: string
): AuditConversationItem {
  const record = isRecord(value) ? value : undefined
  const role = record ? stringValue(record.role) || fallbackRole : fallbackRole
  const title = record ? stringValue(record.name || record.type) : undefined
  return {
    id,
    role,
    title,
    parts: extractContentParts(value),
    raw: formatUnknown(value),
  }
}

function extractContentParts(value: unknown[]): AuditContentPart[]
function extractContentParts(value: unknown): AuditContentPart[]
function extractContentParts(value: unknown): AuditContentPart[] {
  if (Array.isArray(value)) {
    return value.flatMap((part): AuditContentPart[] => {
      if (typeof part === 'string') return [{ type: 'text', text: part }]
      if (!isRecord(part))
        return [{ type: 'value', text: summarizeJsonValue(part) }]
      const imageText = imageReferenceFromRecord(part)
      if (imageText) {
        return [
          {
            type: stringValue(part.type) || 'image',
            text: imageText,
          },
        ]
      }
      const toolCall = toolEventFromRecord(part)
      if (toolCall) {
        return [
          {
            type: toolCall.type,
            text: toolCall.summary || toolCall.raw,
            toolCall,
          },
        ]
      }
      if (isReasoningType(part.type)) {
        const reasoningText = extractReadableReasoningText(part)
        if (reasoningText)
          return [
            {
              type: stringValue(part.type) || 'reasoning',
              text: reasoningText,
              renderAsMarkdown: true,
            },
          ]
        return []
      }
      if (isRecord(part.functionCall)) {
        const nestedToolCall = toolEventFromRecord(part.functionCall, {
          kind: 'call',
          type: 'function_call',
        })
        if (nestedToolCall) {
          return [
            {
              type: nestedToolCall.type,
              text: nestedToolCall.summary || nestedToolCall.raw,
              toolCall: nestedToolCall,
            },
          ]
        }
      }
      if (isRecord(part.functionResponse)) {
        const nestedToolCall = toolEventFromRecord(part.functionResponse, {
          kind: 'result',
          type: 'function_response',
        })
        if (nestedToolCall) {
          return [
            {
              type: nestedToolCall.type,
              text: nestedToolCall.summary || nestedToolCall.raw,
              toolCall: nestedToolCall,
            },
          ]
        }
      }
      const text = firstString(part.text, part.input_text, part.output_text)
      if (text) return [{ type: stringValue(part.type) || 'text', text }]
      if (part.function_call !== undefined) {
        const nestedToolCall = toolEventFromRecord(part.function_call, {
          kind: 'call',
          type: 'function_call',
        })
        return [
          nestedToolCall
            ? {
                type: nestedToolCall.type,
                text: nestedToolCall.summary || nestedToolCall.raw,
                toolCall: nestedToolCall,
              }
            : {
                type: 'function_call',
                text: formatUnknown(part.function_call),
              },
        ]
      }
      if (part.tool_use !== undefined) {
        const nestedToolCall = toolEventFromRecord(part.tool_use, {
          kind: 'call',
          type: 'tool_use',
        })
        return [
          nestedToolCall
            ? {
                type: nestedToolCall.type,
                text: nestedToolCall.summary || nestedToolCall.raw,
                toolCall: nestedToolCall,
              }
            : { type: 'tool_use', text: formatUnknown(part.tool_use) },
        ]
      }
      return [
        { type: stringValue(part.type) || 'object', text: formatUnknown(part) },
      ]
    })
  }
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  if (!isRecord(value))
    return [{ type: 'value', text: summarizeJsonValue(value) }]

  const parts: AuditContentPart[] = []
  const directToolCall = toolEventFromRecord(value)
  if (directToolCall) {
    return [
      {
        type: directToolCall.type,
        text: directToolCall.summary || directToolCall.raw,
        toolCall: directToolCall,
      },
    ]
  }
  const imageText = imageReferenceFromRecord(value)
  if (imageText) {
    return [
      {
        type: stringValue(value.type) || 'image',
        text: imageText,
      },
    ]
  }
  if (isReasoningType(value.type)) {
    const reasoningText = extractReadableReasoningText(value)
    if (reasoningText) {
      return [
        {
          type: stringValue(value.type) || 'reasoning',
          text: reasoningText,
          renderAsMarkdown: true,
        },
      ]
    }
    return []
  }
  if (isRecord(value.function_call)) {
    const nestedToolCall = toolEventFromRecord(value.function_call, {
      kind: 'call',
      type: 'function_call',
    })
    if (nestedToolCall) {
      parts.push({
        type: nestedToolCall.type,
        text: nestedToolCall.summary || nestedToolCall.raw,
        toolCall: nestedToolCall,
      })
    }
  }
  for (const call of arrayValue(value.tool_calls)) {
    const toolCall = toolEventFromRecord(call, {
      kind: 'call',
      type: 'tool_call',
    })
    if (toolCall) {
      parts.push({
        type: toolCall.type,
        text: toolCall.summary || toolCall.raw,
        toolCall,
      })
    }
  }
  if (isRecord(value.functionResponse)) {
    const nestedToolCall = toolEventFromRecord(value.functionResponse, {
      kind: 'result',
      type: 'function_response',
    })
    if (nestedToolCall) {
      parts.push({
        type: nestedToolCall.type,
        text: nestedToolCall.summary || nestedToolCall.raw,
        toolCall: nestedToolCall,
      })
    }
  }
  if (value.content !== undefined) {
    parts.push(...extractContentParts(value.content))
  }
  if (value.parts !== undefined) {
    parts.push(...extractContentParts(value.parts))
  }
  if (value.text !== undefined && parts.length === 0) {
    parts.push({ type: 'text', text: stringValue(value.text) })
  }
  if (value.input !== undefined && parts.length === 0) {
    parts.push(...extractContentParts(value.input))
  }
  if (parts.length > 0) return dedupeContentParts(parts)

  return [
    { type: stringValue(value.type) || 'object', text: formatUnknown(value) },
  ]
}

function extractToolDefinitions(
  request: JsonObject,
  protocol: string
): AuditToolDefinition[] {
  const rawTools =
    protocol === 'gemini_generate_content'
      ? extractGeminiToolDefinitionItems(request.tools)
      : arrayValue(request.tools)

  return rawTools.map((tool, index) => {
    const record = isRecord(tool) ? tool : {}
    const nested = isRecord(record.function) ? record.function : record
    const type = inferToolDefinitionType(record)
    const name =
      firstString(nested.name, record.name, record.type) ||
      type ||
      `tool_${index + 1}`
    return {
      name,
      type: type || 'function',
      description: firstString(nested.description, record.description),
      raw: formatUnknown(tool),
    }
  })
}

function extractGeminiToolDefinitionItems(value: unknown): unknown[] {
  return arrayValue(value).flatMap((tool) => {
    if (!isRecord(tool)) return [tool]

    const items: unknown[] = []
    const declarations = arrayValue(tool.functionDeclarations)
    items.push(...declarations)

    const hasNonFunctionCapability = Object.keys(tool).some(
      (key) => key !== 'functionDeclarations' && tool[key] !== undefined
    )
    if (declarations.length === 0 || hasNonFunctionCapability) {
      items.push(tool)
    }
    return items
  })
}

function inferToolDefinitionType(record: JsonObject): string {
  const explicit = stringValue(record.type)
  if (explicit) return explicit
  if (isRecord(record.function)) return 'function'
  if ('functionDeclarations' in record) return 'function'
  const capabilityKey = Object.keys(record).find(
    (key) => key !== 'name' && key !== 'description'
  )
  return capabilityKey || ''
}

function extractToolCalls(
  response: JsonObject,
  protocol: string
): AuditToolCall[] {
  if (
    protocol === 'openai_responses' ||
    protocol === 'openai_responses_compact'
  ) {
    return arrayValue(response.output)
      .filter((item) => {
        if (!isRecord(item)) return false
        return isOpenAIResponseToolOutputType(stringValue(item.type))
      })
      .flatMap((item) => toolEventArrayFromRecord(item as JsonObject))
  }
  if (protocol === 'claude_messages') {
    return arrayValue(response.content)
      .filter(
        (item) =>
          isRecord(item) &&
          ['tool_use', 'tool_result'].includes(stringValue(item.type))
      )
      .flatMap((item) => toolEventArrayFromRecord(item as JsonObject))
  }
  if (protocol === 'gemini_generate_content') {
    return arrayValue(response.candidates).flatMap((candidate) => {
      const content = isRecord(candidate) ? candidate.content : undefined
      const parts = isRecord(content) ? arrayValue(content.parts) : []
      return parts.flatMap((part) => {
        if (!isRecord(part)) return []
        if (isRecord(part.functionCall)) {
          return toolEventArrayFromRecord(part.functionCall as JsonObject, {
            kind: 'call',
            type: 'function_call',
          })
        }
        if (isRecord(part.functionResponse)) {
          return toolEventArrayFromRecord(part.functionResponse as JsonObject, {
            kind: 'result',
            type: 'function_response',
          })
        }
        return []
      })
    })
  }
  return arrayValue(response.choices).flatMap((choice) => {
    const message = isRecord(choice) ? choice.message : undefined
    const delta = isRecord(choice) ? choice.delta : undefined
    const messageCalls = isRecord(message) ? arrayValue(message.tool_calls) : []
    const deltaCalls = isRecord(delta) ? arrayValue(delta.tool_calls) : []
    const functionCalls =
      isRecord(message) && isRecord(message.function_call)
        ? [
            toolEventFromRecord(message.function_call, {
              kind: 'call',
              type: 'function_call',
            }),
          ]
        : []
    return [
      ...messageCalls.flatMap((call) =>
        toolEventArrayFromRecord(call, { kind: 'call', type: 'tool_call' })
      ),
      ...deltaCalls.flatMap((call) =>
        toolEventArrayFromRecord(call, { kind: 'call', type: 'tool_call' })
      ),
      ...functionCalls.filter((call): call is AuditToolCall => Boolean(call)),
    ]
  })
}

function toolEventArrayFromRecord(
  value: unknown,
  hint?: Partial<Pick<AuditToolCall, 'kind' | 'type'>>
): AuditToolCall[] {
  const toolCall = toolEventFromRecord(value, hint)
  return toolCall ? [toolCall] : []
}

function linkConversationToolEvents(
  items: AuditConversationItem[]
): AuditConversationItem[] {
  const namesById = new Map<string, string>()
  return items.map((item) => {
    let changed = false
    const parts = item.parts.map((part) => {
      if (!part.toolCall) return part
      const toolCall = linkToolEvent(part.toolCall, namesById)
      if (toolCall === part.toolCall) return part
      changed = true
      return {
        ...part,
        text: toolCall.summary || toolCall.raw,
        toolCall,
      }
    })
    return changed ? { ...item, parts } : item
  })
}

function linkToolEvents(events: AuditToolCall[]): AuditToolCall[] {
  const namesById = new Map<string, string>()
  return events.map((event) => linkToolEvent(event, namesById))
}

function linkToolEvent(
  event: AuditToolCall,
  namesById: Map<string, string>
): AuditToolCall {
  if (event.kind === 'call') {
    if (event.id && !isFallbackToolName(event.name, event.type)) {
      namesById.set(event.id, event.name)
    }
    return event
  }
  if (!event.id || !isFallbackToolName(event.name, event.type)) return event
  const linkedName = namesById.get(event.id)
  return linkedName ? { ...event, name: linkedName } : event
}

function isFallbackToolName(name: string, type: string): boolean {
  const normalized = name.trim().toLowerCase()
  return (
    !normalized ||
    normalized === type.trim().toLowerCase() ||
    normalized === 'tool_result' ||
    normalized === 'function_call_output' ||
    normalized === 'function_response'
  )
}

function toolEventFromRecord(
  value: unknown,
  hint?: Partial<Pick<AuditToolCall, 'kind' | 'type'>>
): AuditToolCall | undefined {
  if (!isRecord(value)) return undefined

  const record = value
  const type = hint?.type || stringValue(record.type)
  const normalizedType = type.toLowerCase()
  if (!hint?.kind && isNonToolOutputType(normalizedType)) return undefined
  const hasFunctionPayload = isRecord(record.function)
  const hasArgumentPayload =
    hasOwn(record, 'arguments') || hasOwn(record, 'args')
  const hasKnownCallPayload =
    hasFunctionPayload ||
    hasArgumentPayload ||
    (hasOwn(record, 'input') && hasAnyToolIdentity(record))
  const hasKnownResultPayload =
    hasOwn(record, 'output') ||
    hasOwn(record, 'response') ||
    hasOwn(record, 'result') ||
    hasOwn(record, 'functionResponse') ||
    (hasOwn(record, 'content') && hasAnyToolIdentity(record))

  let kind = hint?.kind
  if (!kind && TOOL_RESULT_TYPES.has(normalizedType)) kind = 'result'
  if (!kind && TOOL_CALL_TYPES.has(normalizedType)) kind = 'call'
  if (!kind && stringValue(record.role).toLowerCase() === 'tool') {
    kind = 'result'
  }
  if (!kind && hasKnownResultPayload && hasAnyToolIdentity(record)) {
    kind = 'result'
  }
  if (!kind && hasKnownCallPayload) kind = 'call'
  if (!kind) return undefined

  const fn = isRecord(record.function) ? record.function : record
  if (kind === 'call') {
    const inputValue = normalizeNestedJson(
      firstDefined(
        fn.arguments,
        fn.args,
        fn.input,
        record.arguments,
        record.args,
        record.input
      )
    )
    const input = formatUnknown(inputValue)
    const name =
      firstString(fn.name, record.name, record.functionName, record.type) ||
      'tool_call'
    return {
      kind,
      id: extractToolIdentity(record),
      name,
      type: type || 'function_call',
      input,
      inputValue,
      inputFields: toToolFieldRows(inputValue),
      summary: summarizeToolArguments(inputValue),
      raw: formatUnknown(value),
    }
  }

  const outputSource = firstDefined(
    record.output,
    record.response,
    record.result,
    record.content,
    record.text
  )
  const outputValue = unwrapToolResultEnvelope(
    outputSource,
    3,
    hasAnyToolIdentity(record)
  )
  const displayOutputValue = unwrapToolDisplayValue(outputValue)
  const output = formatUnknown(displayOutputValue)
  const name =
    firstString(record.name, record.functionName, record.type) || 'tool_result'
  const summary = summarizeToolResult(displayOutputValue)
  return {
    kind,
    id: extractToolIdentity(record),
    name,
    type: type || 'tool_result',
    input: '',
    output,
    outputValue: displayOutputValue,
    inputFields: [],
    summary,
    isError: Boolean(record.is_error || record.isError || record.error),
    raw: formatUnknown(value),
  }
}

function unwrapToolResultEnvelope(
  value: unknown,
  depth = 3,
  forceUnwrap = false
): unknown {
  const parsedValue = normalizeNestedJson(value)
  if (depth <= 0 || !isRecord(parsedValue)) return parsedValue

  const hasInputPayload = ['input', 'arguments', 'args'].some((key) =>
    hasOwn(parsedValue, key)
  )
  const hasCallIdentity = hasAnyToolIdentity(parsedValue)
  const shouldUnwrap =
    forceUnwrap ||
    hasInputPayload ||
    hasCallIdentity ||
    isSingleToolResultEnvelope(parsedValue)
  if (!shouldUnwrap) return parsedValue

  for (const key of ['output', 'response', 'result', 'content']) {
    if (hasOwn(parsedValue, key)) {
      return unwrapToolResultEnvelope(parsedValue[key], depth - 1)
    }
  }
  return parsedValue
}

function unwrapToolDisplayValue(value: unknown, depth = 3): unknown {
  const parsedValue = normalizeNestedJson(value)
  if (depth <= 0) return parsedValue

  if (Array.isArray(parsedValue)) {
    if (parsedValue.length === 1) {
      return unwrapToolDisplayValue(parsedValue[0], depth - 1)
    }
    return parsedValue.map((item) => unwrapToolDisplayValue(item, depth - 1))
  }

  if (!isRecord(parsedValue)) return parsedValue

  const type = stringValue(parsedValue.type).toLowerCase()
  if (!type || ['text', 'output_text', 'input_text'].includes(type)) {
    const contentValue = firstDefined(parsedValue.text, parsedValue.content)
    if (contentValue !== undefined) {
      return unwrapToolDisplayValue(contentValue, depth - 1)
    }
  }

  if (isSingleToolResultEnvelope(parsedValue)) {
    for (const key of ['output', 'response', 'result', 'content']) {
      if (hasOwn(parsedValue, key)) {
        return unwrapToolDisplayValue(parsedValue[key], depth - 1)
      }
    }
  }

  return parsedValue
}

function isSingleToolResultEnvelope(value: JsonObject): boolean {
  const payloadKeys = ['output', 'response', 'result', 'content']
  const metadataKeys = new Set([
    'type',
    'id',
    'call_id',
    'callId',
    'tool_call_id',
    'toolCallId',
    'tool_use_id',
    'toolUseId',
    'name',
    'functionName',
    'is_error',
    'isError',
    'error',
  ])
  const matchedPayloadKeys = payloadKeys.filter((key) => hasOwn(value, key))
  if (matchedPayloadKeys.length !== 1) return false
  return Object.keys(value).every(
    (key) => payloadKeys.includes(key) || metadataKeys.has(key)
  )
}

function normalizeNestedJson(
  value: unknown,
  depth = MAX_RECURSIVE_JSON_DEPTH,
  key = ''
): unknown {
  if (depth <= 0) return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return value
    if (TOOL_JSON_FIELD_KEYS.has(key) || looksLikeJson(trimmed)) {
      const parsed = safeParseJson(trimmed)
      if (parsed !== undefined) {
        return normalizeNestedJson(parsed, depth - 1, key)
      }
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeNestedJson(item, depth - 1, key))
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        normalizeNestedJson(childValue, depth - 1, childKey),
      ])
    )
  }
  return value
}

function toToolFieldRows(value: unknown): AuditField[] {
  if (!isRecord(value)) {
    const summary = summarizeJsonValue(value)
    return summary ? [{ name: 'value', value: summary }] : []
  }
  return Object.entries(value)
    .slice(0, MAX_TOOL_FIELD_ROWS)
    .map(([name, fieldValue]) => ({
      name,
      value: summarizeJsonValue(fieldValue),
    }))
}

function summarizeToolArguments(value: unknown): string {
  const rows = toToolFieldRows(value)
  if (rows.length > 0) {
    return rows
      .slice(0, 4)
      .map((row) => `${row.name}=${summarizeInline(row.value, 28)}`)
      .join(', ')
  }
  return summarizeAuditValue(value, 96)
}

function summarizeToolResult(value: unknown): string {
  const text = extractToolResultSummary(value)
  if (text) return summarizeInline(text, 120)
  return summarizeAuditValue(value, 120)
}

function extractToolResultSummary(value: unknown): string {
  const parsedValue = normalizeNestedJson(value)
  if (typeof parsedValue === 'string') return parsedValue.trim()
  if (Array.isArray(parsedValue)) {
    return summarizeToolResultArray(parsedValue)
  }
  if (!isRecord(parsedValue)) return ''

  if (Array.isArray(parsedValue.content)) {
    const contentText = summarizeToolResultArray(parsedValue.content)
    if (contentText) return contentText
  }

  for (const key of TOOL_RESULT_TEXT_KEYS) {
    const directText = readableScalar(parsedValue[key])
    if (directText) return directText
  }

  const showapiSummary = summarizeShowapiResult(parsedValue)
  if (showapiSummary) return showapiSummary

  const weatherSummary = summarizeWeatherRecord(parsedValue)
  if (weatherSummary) return weatherSummary

  for (const key of TOOL_RESULT_PAYLOAD_KEYS) {
    if (!hasOwn(parsedValue, key)) continue
    const nestedSummary = extractToolResultSummary(parsedValue[key])
    if (nestedSummary) return nestedSummary
  }

  return ''
}

function summarizeToolResultArray(values: unknown[]): string {
  return values
    .map((item) => extractToolResultSummary(item))
    .filter(Boolean)
    .join('\n')
    .trim()
}

function summarizeShowapiResult(value: JsonObject): string {
  const parts: string[] = []
  const code = readableScalar(value.showapi_res_code)
  const error = readableScalar(value.showapi_res_error)
  if (code) parts.push(`code=${code}`)
  if (error) parts.push(error)

  if (hasOwn(value, 'showapi_res_body')) {
    const body = normalizeNestedJson(value.showapi_res_body)
    const bodySummary = isRecord(body)
      ? summarizeWeatherRecord(body) || extractToolResultSummary(body)
      : extractToolResultSummary(body)
    if (bodySummary) parts.push(bodySummary)
  }

  return parts.join(', ')
}

function summarizeWeatherRecord(value: JsonObject): string {
  const directRows = extractWeatherRows(value)
  if (directRows.length >= 2) {
    return dedupeStrings(directRows).slice(0, 6).join(', ')
  }

  const nestedCandidates = [
    value.now,
    value.today,
    value.f1,
    value.forecast,
    value.cityInfo,
    value.location,
    value.weather,
    value.condition,
  ]
  const nestedRows = nestedCandidates.flatMap((candidate) =>
    isRecord(candidate) ? extractWeatherRows(candidate) : []
  )
  const rows = dedupeStrings([...directRows, ...nestedRows]).slice(0, 6)
  if (rows.length >= 2) return rows.join(', ')
  return ''
}

function extractWeatherRows(value: JsonObject): string[] {
  const rows: string[] = []
  for (const key of WEATHER_FIELD_KEYS) {
    const text = readableScalar(value[key])
    if (!text) continue
    rows.push(`${key}=${text}`)
  }
  return rows
}

function readableScalar(value: unknown): string {
  const normalized = normalizeNestedJson(value)
  if (typeof normalized === 'string') return normalized.trim()
  if (typeof normalized === 'number' || typeof normalized === 'boolean') {
    return String(normalized)
  }
  if (isRecord(normalized)) {
    const text = firstString(
      normalized.text,
      normalized.message,
      normalized.error
    )
    if (text) return text.trim()
  }
  return ''
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>()
  return values.filter((value) => {
    if (seen.has(value)) {
      return false
    }
    seen.add(value)
    return true
  })
}

function summarizeAuditValue(value: unknown, maxLength: number): string {
  return summarizeInline(summarizeJsonValue(value), maxLength)
}

function summarizeInline(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 1)}...`
}

function extractToolIdentity(record: JsonObject): string | undefined {
  return (
    firstString(
      record.call_id,
      record.callId,
      record.tool_call_id,
      record.toolCallId,
      record.tool_use_id,
      record.toolUseId,
      record.id
    ) || undefined
  )
}

function hasAnyToolIdentity(record: JsonObject): boolean {
  return Boolean(extractToolIdentity(record))
}

function isNonToolOutputType(type: string): boolean {
  return NON_TOOL_OUTPUT_TYPES.has(type)
}

function isOpenAIResponseToolOutputType(type: string): boolean {
  const normalized = type.toLowerCase()
  if (!normalized || isNonToolOutputType(normalized)) return false
  if (normalized.includes('image_generation_call')) return false
  return (
    TOOL_CALL_TYPES.has(normalized) ||
    TOOL_RESULT_TYPES.has(normalized) ||
    normalized.includes('tool') ||
    normalized.includes('function_call') ||
    normalized.includes('function_response') ||
    normalized.endsWith('_call') ||
    normalized.endsWith('_call_output')
  )
}

function isReasoningType(value: unknown): boolean {
  const normalized = stringValue(value).toLowerCase()
  return normalized.includes('reasoning') || normalized.includes('thinking')
}

function firstDefined(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined) return value
  }
  return undefined
}

function hasOwn(record: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function hasEmbeddingData(value: JsonObject): boolean {
  return arrayValue(value.data).some(
    (item) => isRecord(item) && Array.isArray(item.embedding)
  )
}

function hasGeminiEmbeddingData(value: JsonObject): boolean {
  return (
    (isRecord(value.embedding) && Array.isArray(value.embedding.values)) ||
    Array.isArray(value.embeddings) ||
    Array.isArray(value.values) ||
    arrayValue(value.predictions).some(
      (item) =>
        isRecord(item) &&
        (Array.isArray(item.embeddings) || Array.isArray(item.values))
    )
  )
}

function hasRerankData(value: JsonObject): boolean {
  return arrayValue(value.results).some(
    (item) =>
      isRecord(item) &&
      (hasOwn(item, 'relevance_score') ||
        hasOwn(item, 'score') ||
        hasOwn(item, 'document_index'))
  )
}

function hasModerationData(value: JsonObject): boolean {
  return arrayValue(value.results).some(
    (item) =>
      isRecord(item) &&
      (hasOwn(item, 'flagged') ||
        hasOwn(item, 'categories') ||
        hasOwn(item, 'category_scores'))
  )
}

function hasImageData(value: JsonObject): boolean {
  return arrayValue(value.data).some(
    (item) =>
      isRecord(item) &&
      (typeof item.url === 'string' || typeof item.b64_json === 'string')
  )
}

function imageReferenceFromRecord(value: JsonObject): string {
  const direct = firstString(value.image_url, value.url, value.uri, value.src)
  if (direct) return direct
  const b64 = firstString(value.b64_json)
  if (b64) return `data:image/png;base64,${b64}`
  for (const key of ['image_url', 'image']) {
    const nested = value[key]
    if (!isRecord(nested)) continue
    const nestedUrl = firstString(nested.url, nested.uri, nested.src)
    if (nestedUrl) return nestedUrl
  }
  return ''
}

function looksLikeJson(value: string): boolean {
  return (
    (value.startsWith('{') && value.endsWith('}')) ||
    (value.startsWith('[') && value.endsWith(']'))
  )
}

function dedupeContentParts(parts: AuditContentPart[]): AuditContentPart[] {
  const seen = new Set<string>()
  return parts.filter((part, index) => {
    const key = [
      part.type,
      part.toolCall?.kind ?? '',
      part.toolCall?.id ?? '',
      part.toolCall?.name ?? '',
      part.text,
      index,
    ].join('::')
    const stableKey =
      part.toolCall || part.text
        ? key.replace(`::${index}`, '')
        : `${key}::${index}`
    if (seen.has(stableKey)) return false
    seen.add(stableKey)
    return true
  })
}

function sanitizeVisibleText(text: string, _protocol: string): string {
  return text.trim()
}

function extractResponseTextFromJson(
  response: JsonObject,
  protocol: string
): string {
  if (
    protocol === 'openai_responses' ||
    protocol === 'openai_responses_compact'
  ) {
    const direct = stringValue(response.output_text)
    const outputItems = arrayValue(response.output)
    const outputText = direct
      ? direct
      : outputItems
          .flatMap((item) => extractContentParts(item))
          .filter((part) => part.type.includes('text'))
          .map((part) => part.text)
          .join('\n')
    const imageText = extractOpenAIResponseImageMarkdown(
      outputItems.filter((item): item is JsonObject => isRecord(item))
    )
    return [outputText, imageText].filter(Boolean).join('\n\n')
  }
  if (protocol === 'claude_messages') {
    return arrayValue(response.content)
      .flatMap((item) => extractContentParts(item))
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
  }
  if (protocol === 'gemini_generate_content') {
    return arrayValue(response.candidates)
      .flatMap((candidate) => {
        const content = isRecord(candidate) ? candidate.content : undefined
        if (!isRecord(content)) return []
        return extractContentParts(content.parts)
      })
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
  }
  if (protocol === 'openai_completions') {
    return arrayValue(response.choices)
      .map((choice) =>
        isRecord(choice)
          ? sanitizeVisibleText(stringValue(choice.text), protocol)
          : ''
      )
      .filter(Boolean)
      .join('\n')
  }
  if (protocol === 'openai_embeddings' || protocol === 'gemini_embeddings') {
    return summarizeEmbeddingResponse(response)
  }
  if (protocol === 'openai_moderations') {
    return summarizeModerationResponse(response)
  }
  if (protocol === 'rerank') {
    return summarizeRerankResponse(response)
  }
  if (protocol === 'openai_image') {
    return summarizeImageResponse(response)
  }
  if (protocol === 'openai_audio_speech') {
    return summarizeAudioSpeechResponse(response)
  }
  return arrayValue(response.choices)
    .flatMap((choice) => {
      const message = isRecord(choice) ? choice.message : undefined
      if (!isRecord(message)) return []
      return extractContentParts(message.content).map((part) =>
        part.type.includes('text')
          ? { ...part, text: sanitizeVisibleText(part.text, protocol) }
          : part
      )
    })
    .map((part) => part.text)
    .filter(Boolean)
    .join('\n')
}

function summarizeEmbeddingResponse(response: JsonObject): string {
  const rows: string[] = []
  const data = arrayValue(response.data)
  if (data.length > 0) {
    rows.push(`Embeddings: ${data.length}`)
    const first = data.find(isRecord)
    const embedding = isRecord(first) ? first.embedding : undefined
    if (Array.isArray(embedding)) {
      rows.push(`Dimensions: ${embedding.length}`)
    }
  }
  if (Array.isArray(response.embeddings)) {
    rows.push(`Embeddings: ${response.embeddings.length}`)
    const first = response.embeddings.find(isRecord)
    const values = isRecord(first) ? first.values : undefined
    if (Array.isArray(values)) {
      rows.push(`Dimensions: ${values.length}`)
    }
  }
  if (
    isRecord(response.embedding) &&
    Array.isArray(response.embedding.values)
  ) {
    rows.push('Embeddings: 1')
    rows.push(`Dimensions: ${response.embedding.values.length}`)
  }
  if (Array.isArray(response.values)) {
    rows.push(`Dimensions: ${response.values.length}`)
  }
  const usage = extractUsage(response)
  if (usage.length > 0) {
    rows.push(
      `Usage: ${usage.map((row) => `${row.name}=${row.value}`).join(', ')}`
    )
  }
  return rows.join('\n')
}

function summarizeModerationResponse(response: JsonObject): string {
  return arrayValue(response.results)
    .map((result, index) => {
      if (!isRecord(result)) return ''
      const flagged = stringValue(result.flagged)
      const categories = isRecord(result.categories)
        ? Object.entries(result.categories)
            .filter(([, value]) => Boolean(value))
            .map(([key]) => key)
        : []
      const parts = [`Result #${index + 1}`]
      if (flagged) parts.push(`flagged=${flagged}`)
      if (categories.length > 0)
        parts.push(`categories=${categories.join(', ')}`)
      return parts.join(', ')
    })
    .filter(Boolean)
    .join('\n')
}

function summarizeRerankResponse(response: JsonObject): string {
  return arrayValue(response.results)
    .map((result, index) => {
      if (!isRecord(result)) return ''
      const rank =
        firstString(result.index, result.document_index) || String(index)
      const score = firstString(result.relevance_score, result.score)
      const document = summarizeAuditValue(
        firstDefined(result.document, result.text),
        120
      )
      return [
        `#${index + 1}`,
        `index=${rank}`,
        score && `score=${score}`,
        document,
      ]
        .filter(Boolean)
        .join(' ')
    })
    .filter(Boolean)
    .join('\n')
}

function summarizeImageResponse(response: JsonObject): string {
  const lines: string[] = []
  for (const [index, item] of arrayValue(response.data).entries()) {
    if (!isRecord(item)) continue
    const url = firstString(item.url)
    const b64 = firstString(item.b64_json)
    const revisedPrompt = firstString(item.revised_prompt)
    if (url) lines.push(`Image #${index + 1}: ${url}`)
    if (b64) lines.push(`Image #${index + 1}: data:image/png;base64,${b64}`)
    if (revisedPrompt)
      lines.push(`Revised Prompt #${index + 1}: ${revisedPrompt}`)
  }
  return lines.join('\n')
}

function summarizeAudioSpeechResponse(response: JsonObject): string {
  const type = firstString(response.type, response.format, response.mime_type)
  const bytes = firstString(response.bytes, response.size)
  return [type && `Type: ${type}`, bytes && `Bytes: ${bytes}`]
    .filter(Boolean)
    .join('\n')
}

function extractReasoning(
  response: JsonObject,
  protocol: string
): AuditContentPart[] {
  const parts: AuditContentPart[] = []
  const direct = firstReadableReasoningText(
    response.reasoning,
    response.reasoning_content,
    response.reasoning_details,
    response.thinking
  )
  if (direct)
    parts.push({ type: 'reasoning', text: direct, renderAsMarkdown: true })

  parts.push(...extractChoiceReasoning(response))

  if (
    protocol === 'openai_responses' ||
    protocol === 'openai_responses_compact'
  ) {
    for (const item of arrayValue(response.output)) {
      if (!isRecord(item)) continue
      const type = stringValue(item.type)
      if (type.includes('reasoning')) {
        const text = extractReadableReasoningText(item)
        if (text)
          parts.push({
            type: type || 'reasoning',
            text,
            renderAsMarkdown: true,
          })
      }
    }
  }
  if (protocol === 'claude_messages') {
    for (const item of arrayValue(response.content)) {
      if (!isRecord(item)) continue
      const type = stringValue(item.type)
      if (type.includes('thinking')) {
        const text = extractReadableReasoningText(item.thinking ?? item)
        if (text)
          parts.push({ type: type || 'thinking', text, renderAsMarkdown: true })
      }
    }
  }
  if (protocol === 'gemini_generate_content') {
    parts.push(...extractGeminiReasoning(response))
  }
  return dedupeContentParts(parts)
}

function extractChoiceReasoning(response: JsonObject): AuditContentPart[] {
  return extractChoiceReasoningWithOptions(response)
}

function extractChoiceReasoningWithOptions(
  response: JsonObject,
  options?: { preserveWhitespace?: boolean }
): AuditContentPart[] {
  return arrayValue(response.choices).flatMap((choice): AuditContentPart[] => {
    if (!isRecord(choice)) return []
    const sources = [choice.message, choice.delta, choice].filter(isRecord)
    return sources.flatMap((source) => {
      const parts: AuditContentPart[] = []
      const text = options?.preserveWhitespace
        ? firstReadableStreamingReasoningText(
            source.reasoning,
            source.reasoning_content,
            source.reasoning_details,
            source.thinking
          )
        : firstReadableReasoningText(
            source.reasoning,
            source.reasoning_content,
            source.reasoning_details,
            source.thinking
          )
      if (text) {
        parts.push({
          type: 'reasoning',
          text,
          renderAsMarkdown: true,
        })
      }
      return parts
    })
  })
}

function extractGeminiReasoning(response: JsonObject): AuditContentPart[] {
  return arrayValue(response.candidates).flatMap(
    (candidate): AuditContentPart[] => {
      const content = isRecord(candidate) ? candidate.content : undefined
      const parts = isRecord(content) ? arrayValue(content.parts) : []
      return parts.flatMap((part): AuditContentPart[] => {
        if (!isRecord(part)) return []
        const type = stringValue(part.type)
        const isThought =
          Boolean(part.thought) ||
          type.toLowerCase().includes('thought') ||
          type.toLowerCase().includes('thinking')
        if (!isThought) return []
        const text = firstReadableReasoningText(part.text, part.thinking, part)
        return text
          ? [{ type: type || 'thinking', text, renderAsMarkdown: true }]
          : []
      })
    }
  )
}

const REASONING_SUMMARY_MODE_VALUES = new Set([
  'auto',
  'concise',
  'detailed',
  'none',
])

function extractReadableReasoningText(value: unknown, depth = 4): string {
  if (depth <= 0 || value === undefined || value === null) return ''
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    return value
      .map((item) => extractReadableReasoningText(item, depth - 1))
      .filter(Boolean)
      .join('\n\n')
  }
  if (!isRecord(value)) return ''

  const summaryText = firstString(value.summary_text)
  if (summaryText) return summaryText.trim()

  const summary = extractReadableReasoningSummary(value.summary, depth - 1)
  if (summary) return summary

  const text = firstString(value.text)
  if (text) return text.trim()

  const content = extractReadableReasoningText(value.content, depth - 1)
  if (content) return content

  for (const key of [
    'reasoning',
    'reasoning_content',
    'reasoning_details',
    'thinking',
  ]) {
    const text = extractReadableReasoningText(value[key], depth - 1)
    if (text) return text
  }

  return ''
}

function extractReadableReasoningSummary(
  value: unknown,
  depth: number
): string {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return REASONING_SUMMARY_MODE_VALUES.has(trimmed.toLowerCase())
      ? ''
      : trimmed
  }
  return extractReadableReasoningText(value, depth)
}

function firstReadableReasoningText(...values: unknown[]): string {
  for (const value of values) {
    const text = extractReadableReasoningText(value)
    if (text) return text
  }
  return ''
}

function extractReadableStreamingReasoningText(
  value: unknown,
  depth = 4
): string {
  if (depth <= 0 || value === undefined || value === null) return ''
  if (typeof value === 'string') {
    return REASONING_SUMMARY_MODE_VALUES.has(value.trim().toLowerCase())
      ? ''
      : value
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => extractReadableStreamingReasoningText(item, depth - 1))
      .filter(Boolean)
      .join('')
  }
  if (!isRecord(value)) return ''

  const summaryText = stringValue(value.summary_text)
  if (summaryText) return summaryText

  const summary = extractReadableStreamingReasoningSummary(
    value.summary,
    depth - 1
  )
  if (summary) return summary

  const text = stringValue(value.text)
  if (text) return text

  const content = extractReadableStreamingReasoningText(
    value.content,
    depth - 1
  )
  if (content) return content

  for (const key of [
    'reasoning',
    'reasoning_content',
    'reasoning_details',
    'thinking',
  ]) {
    const text = extractReadableStreamingReasoningText(value[key], depth - 1)
    if (text) return text
  }

  return ''
}

function extractReadableStreamingReasoningSummary(
  value: unknown,
  depth: number
): string {
  if (typeof value === 'string') {
    return REASONING_SUMMARY_MODE_VALUES.has(value.trim().toLowerCase())
      ? ''
      : value
  }
  return extractReadableStreamingReasoningText(value, depth)
}

function firstReadableStreamingReasoningText(...values: unknown[]): string {
  for (const value of values) {
    const text = extractReadableStreamingReasoningText(value)
    if (text) return text
  }
  return ''
}

function extractUsage(response: JsonObject): AuditField[] {
  let usage: JsonObject | undefined
  if (isRecord(response.usage)) {
    usage = response.usage
  } else if (isRecord(response.usageMetadata)) {
    usage = response.usageMetadata
  }
  if (!usage) return []
  return extractFields(usage, USAGE_KEYS)
}

function extractFinishReasons(
  response: JsonObject,
  protocol: string
): string[] {
  const reasons = new Set<string>()
  addString(reasons, response.finish_reason)
  addString(reasons, response.stop_reason)
  if (
    protocol === 'openai_responses' ||
    protocol === 'openai_responses_compact'
  ) {
    addFinishReason(reasons, response.status)
  }
  for (const choice of arrayValue(response.choices)) {
    if (isRecord(choice)) addString(reasons, choice.finish_reason)
  }
  for (const candidate of arrayValue(response.candidates)) {
    if (isRecord(candidate)) addString(reasons, candidate.finishReason)
  }
  return [...reasons]
}

function buildSseSummary(
  raw: string | undefined,
  protocolHint?: string
): AuditSseSummary {
  const events = parseSseEvents(raw)
  const jsonObjects = events
    .map((event) => event.parsed)
    .filter((event): event is JsonObject => isRecord(event))
  const nestedResponses = jsonObjects
    .map((event) => event.response)
    .filter((response): response is JsonObject => isRecord(response))
  const aggregate: JsonObject = {
    choices: [
      ...jsonObjects.flatMap((event) => arrayValue(event.choices)),
      ...nestedResponses.flatMap((response) => arrayValue(response.choices)),
    ],
    candidates: [
      ...jsonObjects.flatMap((event) => arrayValue(event.candidates)),
      ...nestedResponses.flatMap((response) => arrayValue(response.candidates)),
    ],
    output: [
      ...jsonObjects.flatMap((event) => arrayValue(event.output)),
      ...nestedResponses.flatMap((response) => arrayValue(response.output)),
    ],
    content: [
      ...jsonObjects.flatMap((event) => arrayValue(event.content)),
      ...nestedResponses.flatMap((response) => arrayValue(response.content)),
    ],
    status: lastString(...nestedResponses.map((response) => response.status)),
  }
  const protocol =
    protocolHint || detectProtocol({ version: 1 }, undefined, aggregate)
  const text = extractSseFinalText(jsonObjects, protocol)
  const usageSource = jsonObjects.find(
    (event) => isRecord(event.usage) || isRecord(event.usageMetadata)
  )
  const nestedUsageSource = nestedResponses.find((response) =>
    isRecord(response.usage)
  )
  const finishReasons = new Set(extractFinishReasons(aggregate, protocol))
  for (const event of jsonObjects) {
    addFinishReason(finishReasons, extractStreamFinishReason(event))
  }
  const finishReasonValues = [...finishReasons]

  return {
    events,
    eventCount: events.length,
    jsonEventCount: events.filter((event) => event.parsed !== undefined).length,
    done: events.some((event) => event.isDone),
    completed: isSseCompleted(events, jsonObjects, finishReasonValues),
    eventTypes: summarizeSseEventTypes(events),
    text,
    finishReasons: finishReasonValues,
    reasoning: extractSseReasoning(jsonObjects, protocol),
    toolCalls: compactSseToolCalls(
      jsonObjects.flatMap((event) => extractStreamToolCalls(event, protocol))
    ),
    usage: usageSource
      ? extractUsage(usageSource)
      : nestedUsageSource
        ? extractUsage(nestedUsageSource)
        : [],
  }
}

function summarizeSseEventTypes(events: AuditSseEvent[]): AuditField[] {
  const counts = new Map<string, number>()
  for (const event of events) {
    const type = inferSseEventType(event)
    counts.set(type, (counts.get(type) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, value: String(count) }))
}

function inferSseEventType(event: AuditSseEvent): string {
  if (event.isDone) return '[DONE]'

  const parsed = isRecord(event.parsed) ? event.parsed : undefined
  if (!parsed) return 'unknown'

  const explicitType = firstString(
    parsed.type,
    parsed.event,
    parsed.object,
    parsed.name
  )
  if (explicitType) return explicitType

  if (isRecord(parsed.usage) || isRecord(parsed.usageMetadata)) return 'usage'
  if (hasOwn(parsed, 'cost')) return 'cost'
  if (hasOwn(parsed, 'base_resp')) return 'provider_meta'
  if (arrayValue(parsed.choices).length > 0) return 'chat.completion.chunk'

  const choices = arrayValue(parsed.choices)
  if (choices.length === 0 && Object.keys(parsed).length <= 4) {
    return 'provider_meta'
  }

  return 'unknown'
}

function isSseCompleted(
  events: AuditSseEvent[],
  jsonObjects: JsonObject[],
  finishReasons: string[]
): boolean {
  if (events.some((event) => event.isDone)) return true
  if (
    finishReasons.some((reason) =>
      ['completed', 'stop', 'end_turn'].includes(reason.toLowerCase())
    )
  ) {
    return true
  }
  return jsonObjects.some((event) => {
    const type = firstString(event.type, event.event)
    if (type.toLowerCase().endsWith('.completed')) return true
    if (type.toLowerCase().endsWith('.done')) return true
    if (isRecord(event.response)) {
      return stringValue(event.response.status).toLowerCase() === 'completed'
    }
    return false
  })
}

function parseSseEvents(raw: string | undefined): AuditSseEvent[] {
  if (!raw) return []
  return raw
    .split(/\n\n+/)
    .map((event) => event.trim())
    .filter(Boolean)
    .map((event, index) => {
      const dataLines: string[] = []
      for (const line of event.split('\n')) {
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trim())
        } else if (
          dataLines.length > 0 &&
          !/^[a-zA-Z_-]+:/.test(line) &&
          line.trim()
        ) {
          dataLines.push(line.trim())
        }
      }
      const data = dataLines.join('\n')
      const payload = data || event
      const parsed = payload === '[DONE]' ? undefined : safeParseJson(payload)
      return {
        index: index + 1,
        data: payload,
        parsed,
        isDone: payload === '[DONE]',
      }
    })
}

function extractSseFinalText(
  jsonObjects: JsonObject[],
  protocol: string
): string {
  if (
    protocol === 'openai_responses' ||
    protocol === 'openai_responses_compact'
  ) {
    const doneText = lastString(
      ...jsonObjects.map(extractOpenAIResponseOutputDoneText)
    )
    const deltaText = jsonObjects
      .map(extractOpenAIResponseOutputTextDelta)
      .filter(Boolean)
      .join('')
    const imageText = extractOpenAIResponseImageMarkdown(jsonObjects)
    return [doneText || deltaText, imageText].filter(Boolean).join('\n\n')
  }

  const text = jsonObjects
    .map((event) => extractStreamText(event))
    .filter(Boolean)
    .join('')
  return text ? sanitizeVisibleText(text, protocol) : ''
}

function extractOpenAIResponseOutputTextDelta(event: JsonObject): string {
  const type = firstString(event.type, event.event).toLowerCase()
  if (type !== 'response.output_text.delta') return ''
  return firstString(event.delta)
}

function extractOpenAIResponseOutputDoneText(event: JsonObject): string {
  const type = firstString(event.type, event.event).toLowerCase()
  if (type === 'response.output_text.done') {
    return firstString(event.text)
  }
  if (type === 'response.completed' && isRecord(event.response)) {
    return extractResponseTextFromJson(event.response, 'openai_responses')
  }
  if (type === 'response.output_item.done' && isRecord(event.item)) {
    const itemType = stringValue(event.item.type).toLowerCase()
    if (itemType.includes('image_generation_call')) return ''
    if (itemType === 'output_text') return firstString(event.item.text)
    return extractContentParts(event.item)
      .filter(
        (part) => part.type.includes('text') && !isReasoningType(part.type)
      )
      .map((part) => part.text)
      .join('\n')
  }
  return ''
}

function extractOpenAIResponseImageMarkdown(jsonObjects: JsonObject[]): string {
  const images = new Map<string, string>()

  for (const event of jsonObjects) {
    const image = imageGenerationImageFromRecord(event)
    if (!image?.url) continue
    images.set(image.id || `image-${images.size + 1}`, image.url)
  }

  return Array.from(images.values())
    .map((url, index) => `![Image #${index + 1}](${url})`)
    .join('\n\n')
}

function extractStreamText(event: JsonObject): string {
  const eventType = firstString(event.type, event.event).toLowerCase()
  if (
    eventType.startsWith('response.') &&
    (eventType.includes('reasoning') ||
      eventType.includes('thinking') ||
      eventType.includes('image_generation_call'))
  ) {
    return ''
  }
  const direct = firstString(event.delta, event.text)
  if (direct) return direct
  if (isRecord(event.delta)) {
    const deltaText = firstString(event.delta.text)
    if (deltaText) return deltaText
  }
  const responseText = extractResponseTextFromJson(
    event,
    detectProtocol({ version: 1 }, undefined, event)
  )
  if (responseText) return responseText
  return arrayValue(event.choices)
    .map((choice) => {
      if (!isRecord(choice)) return ''
      const delta = isRecord(choice.delta) ? choice.delta : undefined
      if (!delta) return ''
      const content = delta.content ?? delta.text
      if (typeof content === 'string') return content
      return extractContentParts(content)
        .map((part) => part.text)
        .join('')
    })
    .join('')
}

function extractStreamReasoning(event: JsonObject): AuditContentPart[] {
  const parts: AuditContentPart[] = []
  const eventType = firstString(event.type, event.event).toLowerCase()
  if (eventType === 'response.reasoning_summary_text.delta') {
    const text = firstString(event.delta)
    if (text) parts.push({ type: 'reasoning', text, renderAsMarkdown: true })
    return parts
  }
  if (eventType === 'response.reasoning_summary_text.done') {
    const text = firstString(event.text)
    if (text) parts.push({ type: 'reasoning', text, renderAsMarkdown: true })
    return parts
  }
  if (isRecord(event.delta)) {
    const thinking = firstReadableStreamingReasoningText(
      event.delta.thinking,
      event.delta.reasoning,
      event.delta.reasoning_content,
      event.delta.reasoning_details,
      eventType.includes('thinking') || eventType.includes('reasoning')
        ? event.delta.text
        : undefined
    )
    if (thinking)
      parts.push({ type: 'thinking', text: thinking, renderAsMarkdown: true })
  }
  if (isRecord(event.content_block)) {
    const thinking = firstReadableStreamingReasoningText(
      event.content_block.thinking,
      event.content_block.reasoning,
      event.content_block.reasoning_content,
      event.content_block.reasoning_details,
      event.content_block
    )
    if (thinking)
      parts.push({ type: 'thinking', text: thinking, renderAsMarkdown: true })
  }
  parts.push(
    ...extractChoiceReasoningWithOptions(event, { preserveWhitespace: true })
  )
  parts.push(...extractGeminiReasoning(event))
  if (isRecord(event.response)) {
    parts.push(
      ...extractReasoning(
        event.response,
        detectProtocol({ version: 1 }, undefined, event.response)
      )
    )
  }
  return parts
}

function extractSseReasoning(
  jsonObjects: JsonObject[],
  protocol: string
): AuditContentPart[] {
  if (
    protocol === 'openai_responses' ||
    protocol === 'openai_responses_compact'
  ) {
    const doneText = lastString(
      ...jsonObjects
        .filter((event) => {
          const type = firstString(event.type, event.event).toLowerCase()
          return type === 'response.reasoning_summary_text.done'
        })
        .map((event) => firstString(event.text))
    )
    if (doneText) {
      return [{ type: 'reasoning', text: doneText, renderAsMarkdown: true }]
    }

    const deltaText = jsonObjects
      .filter((event) => {
        const type = firstString(event.type, event.event).toLowerCase()
        return type === 'response.reasoning_summary_text.delta'
      })
      .map((event) => firstString(event.delta))
      .filter(Boolean)
      .join('')
    if (deltaText) {
      return [{ type: 'reasoning', text: deltaText, renderAsMarkdown: true }]
    }
  }

  const parts = dedupeContentParts(
    jsonObjects.flatMap((event) => extractStreamReasoning(event))
  )
  return mergeStreamingReasoningParts(parts)
}

function mergeStreamingReasoningParts(
  parts: AuditContentPart[]
): AuditContentPart[] {
  const merged: AuditContentPart[] = []
  for (const part of parts) {
    const text = part.text
    if (!text) continue

    const last = merged[merged.length - 1]
    if (
      last &&
      last.type === part.type &&
      last.renderAsMarkdown === part.renderAsMarkdown &&
      !last.toolCall &&
      !part.toolCall
    ) {
      last.text = `${last.text}${text}`
      continue
    }

    merged.push({ ...part, text })
  }
  return dedupeContentParts(merged)
}

function extractStreamToolCalls(
  event: JsonObject,
  protocol: string
): AuditToolCall[] {
  const calls = [...extractToolCalls(event, protocol)]
  if (
    protocol === 'openai_responses' ||
    protocol === 'openai_responses_compact'
  ) {
    calls.push(...extractOpenAIResponseFunctionArgumentEvents(event))
  }
  if (isRecord(event.item)) {
    const itemType = stringValue(event.item.type)
    if (
      (protocol !== 'openai_responses' &&
        protocol !== 'openai_responses_compact') ||
      (!itemType.toLowerCase().includes('image_generation_call') &&
        isOpenAIResponseToolOutputType(itemType))
    ) {
      calls.push(...toolEventArrayFromRecord(event.item))
    }
  }
  if (isRecord(event.content_block)) {
    calls.push(...toolEventArrayFromRecord(event.content_block))
  }
  if (isRecord(event.response)) {
    calls.push(...extractToolCalls(event.response, protocol))
  }
  return calls
}

function extractOpenAIResponseFunctionArgumentEvents(
  event: JsonObject
): AuditToolCall[] {
  const eventType = firstString(event.type, event.event).toLowerCase()
  if (
    eventType !== 'response.function_call_arguments.delta' &&
    eventType !== 'response.function_call_arguments.done'
  ) {
    return []
  }

  const id =
    firstString(event.item_id, event.call_id, event.id) || undefined
  if (!id) return []

  const inputValue = normalizeNestedJson(
    firstDefined(event.arguments, event.delta, event.input)
  )
  const input = formatUnknown(inputValue)
  const name = firstString(event.name, event.function_name) || 'function_call'

  return [
    {
      kind: 'call',
      id,
      name,
      type: 'function_call',
      input,
      inputValue,
      inputFields: toToolFieldRows(inputValue),
      summary: summarizeToolArguments(inputValue),
      raw: formatUnknown(event),
    },
  ]
}

function compactSseToolCalls(calls: AuditToolCall[]): AuditToolCall[] {
  const compacted: AuditToolCall[] = []
  const imageGenerationIndexes = new Map<string, number>()
  const lifecycleIndexes = new Map<string, number>()

  for (const originalCall of calls) {
    const call = normalizeImageGenerationToolCall(originalCall)
    if (isImageGenerationToolCall(call)) {
      const key = call.id || call.name || call.type || 'image_generation'
      const nextCall = {
        ...call,
        summary: call.summary || 'Generated image preview',
      }
      const existingIndex = imageGenerationIndexes.get(key)
      if (existingIndex === undefined) {
        imageGenerationIndexes.set(key, compacted.length)
        compacted.push(nextCall)
      } else {
        compacted[existingIndex] = nextCall
      }
      continue
    }

    const lifecycleKeys = toolLifecycleKeys(call)
    if (lifecycleKeys.length === 0) {
      compacted.push(call)
      continue
    }

    const existingIndex = lifecycleKeys
      .map((key) => lifecycleIndexes.get(key))
      .find((index): index is number => index !== undefined)
    if (existingIndex === undefined) {
      for (const key of lifecycleKeys) {
        lifecycleIndexes.set(key, compacted.length)
      }
      compacted.push(call)
    } else {
      compacted[existingIndex] = mergeToolLifecycleCalls(
        compacted[existingIndex],
        call
      )
      for (const key of lifecycleKeys) {
        lifecycleIndexes.set(key, existingIndex)
      }
    }
  }

  return compacted
}

function toolLifecycleKeys(call: AuditToolCall): string[] {
  if (call.kind !== 'call') return []
  const type = call.type.toLowerCase()
  if (
    !(
      TOOL_CALL_TYPES.has(type) ||
      type.includes('function_call') ||
      type.includes('tool_call') ||
      type.includes('tool_use')
    )
  )
    return []

  const raw = safeParseJson(call.raw)
  const ids = new Set<string>()
  if (call.id) ids.add(call.id)
  if (isRecord(raw)) {
    for (const id of [
      raw.call_id,
      raw.callId,
      raw.item_id,
      raw.itemId,
      raw.tool_call_id,
      raw.toolCallId,
      raw.id,
    ]) {
      const text = stringValue(id)
      if (text) ids.add(text)
    }
  }

  return Array.from(ids).map((id) => `${call.kind}:${id}`)
}

function mergeToolLifecycleCalls(
  existing: AuditToolCall,
  incoming: AuditToolCall
): AuditToolCall {
  const mergedInputValue = mergeToolInputValue(
    existing.inputValue,
    incoming.inputValue
  )
  const hasMergedInput = hasReadableToolInput(mergedInputValue)
  const better = preferIncomingToolLifecycleCall(existing, incoming)
    ? incoming
    : existing
  const name = isFallbackToolName(better.name, better.type)
    ? existing.name || incoming.name
    : better.name
  const inputValue = hasMergedInput ? mergedInputValue : better.inputValue
  const input = formatUnknown(inputValue)
  const inputFields = toToolFieldRows(inputValue)
  const summary = summarizeToolArguments(inputValue)

  return {
    ...better,
    id: preferredToolLifecycleId(existing, incoming, better),
    name,
    input,
    inputValue,
    inputFields,
    summary,
  }
}

function preferredToolLifecycleId(
  existing: AuditToolCall,
  incoming: AuditToolCall,
  better: AuditToolCall
): string | undefined {
  const ids = [better.id, incoming.id, existing.id].filter(
    (id): id is string => Boolean(id)
  )
  return ids.find((id) => id.startsWith('call_')) || ids[0]
}

function preferIncomingToolLifecycleCall(
  existing: AuditToolCall,
  incoming: AuditToolCall
): boolean {
  return toolLifecycleScore(incoming) >= toolLifecycleScore(existing)
}

function toolLifecycleScore(call: AuditToolCall): number {
  const raw = safeParseJson(call.raw)
  const status = isRecord(raw) ? stringValue(raw.status).toLowerCase() : ''
  let score = 0
  if (status === 'completed' || status === 'complete') score += 100
  if (status === 'in_progress') score += 10
  if (hasReadableToolInput(call.inputValue)) score += 40
  if (call.inputFields.length > 0) score += 20 + call.inputFields.length
  if (call.summary) score += 10
  if (!isFallbackToolName(call.name, call.type)) score += 5
  return score
}

function mergeToolInputValue(existing: unknown, incoming: unknown): unknown {
  if (!hasReadableToolInput(existing)) return incoming
  if (!hasReadableToolInput(incoming)) return existing

  if (isRecord(existing) && isRecord(incoming)) {
    return { ...existing, ...incoming }
  }

  if (typeof existing === 'string' && typeof incoming === 'string') {
    const merged = `${existing}${incoming}`
    return normalizeNestedJson(merged)
  }

  return incoming
}

function hasReadableToolInput(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  if (isRecord(value)) return Object.keys(value).length > 0
  return true
}

function isImageGenerationToolCall(call: AuditToolCall): boolean {
  const type = call.type.toLowerCase()
  const name = call.name.toLowerCase()
  return (
    type.includes('image_generation_call') || name.includes('image_generation')
  )
}

function normalizeImageGenerationToolCall(call: AuditToolCall): AuditToolCall {
  if (!isImageGenerationToolCall(call)) return call

  const imageUrl =
    imageDataUrlFromGenerationRecord(call.outputValue) ||
    imageDataUrlFromGenerationRecord(safeParseJson(call.output)) ||
    imageDataUrlFromGenerationRecord(call.raw) ||
    imageDataUrlFromGenerationRecord(safeParseJson(call.raw))

  if (!imageUrl) {
    return {
      ...call,
      summary: call.summary || 'Generated image preview',
    }
  }

  const outputValue = {
    type: 'image',
    image_url: imageUrl,
    status: call.type,
  }

  return {
    ...call,
    name: call.name || 'image_generation',
    output: formatUnknown(outputValue),
    outputValue,
    summary: 'Generated image preview',
  }
}

function imageDataUrlFromGenerationRecord(value: unknown): string {
  return imageGenerationImageFromRecord(value)?.url ?? ''
}

function imageGenerationImageFromRecord(
  value: unknown
): { id?: string; url: string } | undefined {
  if (typeof value === 'string') {
    const url = imageDataUrlFromString(value)
    return url ? { url } : undefined
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const itemImage = imageGenerationImageFromRecord(item)
      if (itemImage) return itemImage
    }
    return undefined
  }
  if (!isRecord(value)) return undefined

  const mimeType = imageMimeTypeFromRecord(value)
  const direct = firstString(
    value.partial_image_b64,
    value.image_b64,
    value.b64_json,
    value.result,
    value.output
  )
  const directUrl = imageDataUrlFromString(direct, mimeType)
  if (directUrl) {
    return {
      id: firstString(value.item_id, value.id, value.call_id) || undefined,
      url: directUrl,
    }
  }

  for (const key of [
    'image_url',
    'image',
    'item',
    'response',
    'result',
    'output',
    'content',
    'data',
  ]) {
    const nested: unknown = value[key]
    if (nested === value) continue
    const nestedImage = imageGenerationImageFromRecord(nested)
    if (nestedImage) {
      return {
        id:
          nestedImage.id ||
          firstString(value.item_id, value.call_id) ||
          undefined,
        url: nestedImage.url,
      }
    }
  }

  return undefined
}

function imageMimeTypeFromRecord(value: JsonObject): string {
  const format = firstString(value.output_format, value.format, value.mime_type)
    .toLowerCase()
    .replace(/^image\//, '')
  if (!format) return 'image/png'
  if (format === 'jpg') return 'image/jpeg'
  return `image/${format}`
}

function imageDataUrlFromString(value: string, mimeType = 'image/png'): string {
  const text = value.trim()
  if (!text) return ''
  if (text.startsWith('data:image/')) return text
  if (!looksLikeBase64Image(text)) return ''
  return `data:${mimeType};base64,${text}`
}

function looksLikeBase64Image(value: string): boolean {
  const text = value.trim()
  return (
    /^(iVBORw0KGgo|\/9j\/|R0lGOD|UklGR|PHN2Z)/.test(text) ||
    (text.length > 200 && /^[A-Za-z0-9+/=_-]+$/.test(text))
  )
}

function extractStreamFinishReason(event: JsonObject): string {
  if (isRecord(event.delta)) {
    const reason = firstString(
      event.delta.stop_reason,
      event.delta.finish_reason
    )
    if (reason) return reason
  }
  if (isRecord(event.response)) {
    const status = stringValue(event.response.status)
    if (status && !isTransientResponseStatus(status)) return status
    return firstString(event.response.stop_reason)
  }
  return firstString(event.stop_reason, event.finish_reason)
}

function extractFields(source: JsonObject, keys: string[]): AuditField[] {
  return keys
    .filter((key) => source[key] !== undefined)
    .map((key) => ({ name: key, value: summarizeJsonValue(source[key]) }))
}

function formatRawBody(message?: LogAuditMessage | LogAuditResponse): string {
  const raw = message?.raw ?? ''
  return formatJsonLike(raw)
}

function formatJsonLike(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : formatUnknown(raw)
  if (!text) return ''
  const parsed = safeParseJson(text)
  if (parsed === undefined) return text
  return formatUnknown(parsed)
}

function formatUnknown(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function summarizeJsonValue(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value)
  return formatUnknown(value)
}

function safeParseJson(raw: string | undefined): unknown {
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value)
  return ''
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = stringValue(value)
    if (text) return text
  }
  return ''
}

function lastString(...values: unknown[]): string {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const text = stringValue(values[index])
    if (text) return text
  }
  return ''
}

function addString(target: Set<string>, value: unknown): void {
  const text = stringValue(value)
  if (text) target.add(text)
}

function addFinishReason(target: Set<string>, value: unknown): void {
  const text = stringValue(value)
  if (text && !isTransientResponseStatus(text)) target.add(text)
}

function isTransientResponseStatus(value: string): boolean {
  return ['in_progress', 'queued'].includes(value.toLowerCase())
}

function roleFromRecord(value: unknown, fallback: string): string {
  if (!isRecord(value)) return fallback
  // developer 是一等会话角色，这里直接透传，不归并到 system。
  return firstString(value.role, value.author, value.type) || fallback
}

function byteValue(
  message: LogAuditMessage | LogAuditResponse | undefined
): string {
  if (!message || message.bytes == null) return ''
  return String(message.bytes)
}

function countValue(value: number): string {
  return value > 0 ? String(value) : ''
}
