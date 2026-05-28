import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { LogAuditPayload } from '../types'
import { buildAuditViewModel } from './audit'

function buildStreamView(protocol: string, events: unknown[]) {
  const raw = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join('')
  const payload: LogAuditPayload = {
    version: 1,
    source: {
      protocol,
      stream: true,
    },
    response: {
      type: 'stream',
      raw,
      bytes: raw.length,
      truncated: false,
    },
  }
  return buildAuditViewModel(payload, JSON.stringify(payload))
}

describe('审计流式工具调用聚合', () => {
  test('按 OpenAI tool index 聚合参数分片并保留全部 Raw 事件', () => {
    const view = buildStreamView('openai_chat', [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_cf7b37d57d314341900ab38a',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"city":"' } }],
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: 'Tokyo' } }],
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '"' } }],
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '}' } }],
            },
          },
        ],
      },
    ])

    assert.equal(view.response.toolCalls.length, 1)
    const call = view.response.toolCalls[0]
    assert.equal(call.name, 'get_weather')
    assert.equal(call.id, 'call_cf7b37d57d314341900ab38a')
    assert.deepEqual(call.inputValue, { city: 'Tokyo' })
    assert.deepEqual(call.inputFields, [{ name: 'city', value: 'Tokyo' }])
    assert.equal((JSON.parse(call.raw) as unknown[]).length, 5)
  })

  test('隔离并行且同名的 OpenAI 工具调用', () => {
    const view = buildStreamView('openai_chat', [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_a',
                  function: { name: 'lookup', arguments: '{"id":"' },
                },
                {
                  index: 1,
                  id: 'call_b',
                  function: { name: 'lookup', arguments: '{"id":"' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: 'A"}' } },
                { index: 1, function: { arguments: 'B"}' } },
              ],
            },
          },
        ],
      },
    ])

    assert.equal(view.response.toolCalls.length, 2)
    assert.deepEqual(
      view.response.toolCalls.map((call) => call.inputValue),
      [{ id: 'A' }, { id: 'B' }]
    )
  })

  test('聚合旧式 OpenAI function_call 名称和参数', () => {
    const view = buildStreamView('openai_chat', [
      {
        choices: [
          {
            index: 0,
            delta: {
              function_call: {
                name: 'search',
                arguments: '{"query":"',
              },
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              function_call: {
                arguments: 'audit"}',
              },
            },
          },
        ],
      },
    ])

    assert.equal(view.response.toolCalls.length, 1)
    assert.equal(view.response.toolCalls[0].name, 'search')
    assert.deepEqual(view.response.toolCalls[0].inputValue, {
      query: 'audit',
    })
  })

  test('按 Claude content block index 聚合 input_json_delta', () => {
    const view = buildStreamView('claude_messages', [
      {
        type: 'content_block_start',
        index: 2,
        content_block: {
          type: 'tool_use',
          id: 'toolu_123',
          name: 'get_weather',
          input: {},
        },
      },
      {
        type: 'content_block_delta',
        index: 2,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"city":"Tokyo"}',
        },
      },
    ])

    assert.equal(view.response.toolCalls.length, 1)
    assert.equal(view.response.toolCalls[0].id, 'toolu_123')
    assert.equal(view.response.toolCalls[0].name, 'get_weather')
    assert.deepEqual(view.response.toolCalls[0].inputValue, {
      city: 'Tokyo',
    })
  })

  test('合并 OpenAI Responses item、delta 和 done 快照且不重复参数', () => {
    const view = buildStreamView('openai_responses', [
      {
        type: 'response.output_item.added',
        item: {
          id: 'fc_123',
          call_id: 'call_123',
          type: 'function_call',
          name: 'get_weather',
          arguments: '',
        },
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_123',
        delta: '{"city":"Tokyo"}',
      },
      {
        type: 'response.function_call_arguments.done',
        item_id: 'fc_123',
        arguments: '{"city":"Tokyo"}',
      },
      {
        type: 'response.output_item.done',
        item: {
          id: 'fc_123',
          call_id: 'call_123',
          type: 'function_call',
          name: 'get_weather',
          arguments: '{"city":"Tokyo"}',
        },
      },
    ])

    assert.equal(view.response.toolCalls.length, 1)
    assert.equal(view.response.toolCalls[0].id, 'call_123')
    assert.deepEqual(view.response.toolCalls[0].inputValue, {
      city: 'Tokyo',
    })
  })

  test('在 Responses 后续事件桥接 item ID 和 call ID 时回收临时状态', () => {
    const view = buildStreamView('openai_responses', [
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_bridge',
        delta: '{"city":"',
      },
      {
        type: 'response.function_call_arguments.delta',
        call_id: 'call_bridge',
        delta: 'Tokyo"}',
      },
      {
        type: 'response.output_item.done',
        item: {
          id: 'fc_bridge',
          call_id: 'call_bridge',
          type: 'function_call',
          name: 'get_weather',
          arguments: '{"city":"Tokyo"}',
        },
      },
    ])

    assert.equal(view.response.toolCalls.length, 1)
    assert.equal(view.response.toolCalls[0].id, 'call_bridge')
    assert.equal(view.response.toolCalls[0].name, 'get_weather')
    assert.deepEqual(view.response.toolCalls[0].inputValue, {
      city: 'Tokyo',
    })
  })

  test('去重 Gemini 重复函数调用快照', () => {
    const event = {
      candidates: [
        {
          index: 0,
          content: {
            parts: [
              {
                functionCall: {
                  name: 'get_weather',
                  args: { city: 'Tokyo' },
                },
              },
            ],
          },
        },
      ],
    }
    const view = buildStreamView('gemini_generate_content', [event, event])

    assert.equal(view.response.toolCalls.length, 1)
    assert.equal(view.response.toolCalls[0].name, 'get_weather')
    assert.deepEqual(view.response.toolCalls[0].inputValue, {
      city: 'Tokyo',
    })
  })

  test('聚合后保持工具调用与结果的事件顺序', () => {
    const view = buildStreamView('openai_responses', [
      {
        type: 'response.output_item.done',
        item: {
          id: 'fc_first',
          call_id: 'call_first',
          type: 'function_call',
          name: 'first',
          arguments: '{}',
        },
      },
      {
        type: 'response.output_item.done',
        item: {
          type: 'function_call_output',
          call_id: 'call_first',
          output: '{"ok":true}',
        },
      },
      {
        type: 'response.output_item.done',
        item: {
          id: 'fc_second',
          call_id: 'call_second',
          type: 'function_call',
          name: 'second',
          arguments: '{}',
        },
      },
    ])

    assert.deepEqual(
      view.response.toolCalls.map((call) => [call.kind, call.name]),
      [
        ['call', 'first'],
        ['result', 'first'],
        ['call', 'second'],
      ]
    )
  })

  test('保留未完成 JSON 参数文本且不抛出异常', () => {
    const view = buildStreamView('openai_chat', [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_partial',
                  function: {
                    name: 'lookup',
                    arguments: '{"query":"unfinished',
                  },
                },
              ],
            },
          },
        ],
      },
    ])

    assert.equal(view.response.toolCalls.length, 1)
    assert.equal(view.response.toolCalls[0].inputValue, '{"query":"unfinished')
  })
})
