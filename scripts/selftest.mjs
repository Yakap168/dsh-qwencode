/**
 * 桥接服务自测（独立于 DSH 运行）：
 *   node/bun 环境执行 `node scripts/selftest.mjs [--port 45999] [--model qfmodel]`
 *
 * 覆盖：healthz、/v1/models、纯文本推理 + 思考事件、工具调用、工具结果回传、
 * 错误映射（非法模型）。会真实请求 Qoder 网关，消耗少量额度。
 */
import { createBridge } from '../src/bridge.mjs'
import { fetchModelCatalog } from '../src/catalog.mjs'

const args = process.argv.slice(2)
function argValue(name, fallback) {
  const index = args.indexOf(`--${name}`)
  if (index >= 0 && args[index + 1]) return args[index + 1]
  return fallback
}

const port = Number(argValue('port', '45999'))
const model = argValue('model', 'qfmodel')
const verbose = args.includes('--verbose')
const bridge = createBridge({
  port,
  logger: {
    info: (...parts) => console.log('[bridge:info]', ...parts),
    warn: (...parts) => console.log('[bridge:warn]', ...parts),
    error: (...parts) => console.log('[bridge:error]', ...parts),
  },
})

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 解析 SSE 文本为事件数组。 */
function parseSse(text) {
  const events = []
  let current = {}
  for (const line of text.split(/\r?\n/)) {
    if (line === '') {
      if (current.event || current.data) events.push(current)
      current = {}
      continue
    }
    if (line.startsWith('event:')) current.event = line.slice(6).trim()
    else if (line.startsWith('data:')) current.data = (current.data ?? '') + line.slice(5).trim()
    else if (line.startsWith(':')) continue
  }
  if (current.event || current.data) events.push(current)
  return events
}

/** 发起一次 Responses 请求并收集 SSE 事件。 */
async function postResponses(body, { timeoutMs = 180_000 } = {}) {
  const started = Date.now()
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer local-bridge' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    const text = await response.text()
    return { status: response.status, events: [], text, durationMs: Date.now() - started }
  }
  const text = await response.text()
  return { status: response.status, events: parseSse(text), text, durationMs: Date.now() - started }
}

/** 从事件里取最终文本。 */
function finalText(events) {
  const parts = []
  for (const event of events) {
    if (!event.data) continue
    try {
      const data = JSON.parse(event.data)
      if (data?.type === 'response.output_text.delta' && typeof data.delta === 'string') parts.push(data.delta)
    } catch {
      // 非 JSON 的 SSE 注释/心跳跳过。
    }
  }
  return parts.join('')
}

/** 从事件里取函数调用。 */
function functionCalls(events) {
  const calls = []
  for (const event of events) {
    if (!event.data) continue
    let data
    try {
      data = JSON.parse(event.data)
    } catch {
      continue
    }
    if (data.type === 'response.output_item.done' && data.item?.type === 'function_call') {
      calls.push(data.item)
    }
  }
  return calls
}

try {
  const url = await bridge.start()
  record('bridge.start', Boolean(url), url)
  const health = await (await fetch(`${url}/healthz`)).json()
  record('healthz', health.ok === true, `region=${health.region} user=${health.auth?.userName ?? '?'} account=${health.auth?.hasAccount} version=${health.version}`)

  // 实时目录：Qoder 的模型目录不消耗推理额度，失败了仍可继续用内置表。
  let catalog = []
  let catalogError = ''
  try {
    catalog = await fetchModelCatalog({
      auth: bridge.auth,
      gatewayBaseUrl: bridge.gatewayBaseUrl,
      clientType: '13',
      clientVersion: '1.0.0-preview.2',
      timeoutMs: 5_000,
    })
  } catch (error) {
    catalogError = error?.message ?? String(error)
  }
  if (catalog.length > 0) bridge.setModels(catalog)
  record(
    'live_catalog',
    catalog.length > 0,
    catalog.length > 0 ? catalog.map((model) => `${model.id}@${model.contextWindow}`).join(' ') : catalogError,
  )

  const models = await (await fetch(`${url}/v1/models`)).json()
  record('/v1/models', Array.isArray(models.data) && models.data.length >= 1, `${models.data?.length ?? 0} models`)

  const plainStarted = Date.now()
  const plain = await postResponses({
    model,
    instructions: 'You are a terse assistant.',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply with exactly the single word: PONG' }] }],
    stream: true,
    store: false,
    reasoning: { effort: 'low' },
  })
  const plainText = finalText(plain.events)
  const reasoningDeltas = plain.events.filter((event) => event.data && JSON.parse(event.data)?.type === 'response.reasoning_text.delta').length
  record(
    'text+reasoning',
    plain.status === 200 && plainText.includes('PONG') && reasoningDeltas > 0,
    `status=${plain.status} text=${JSON.stringify(plainText)} reasoningEvents=${reasoningDeltas} ${Date.now() - plainStarted}ms`,
  )

  const tools = [{
    type: 'function',
    name: 'get_weather',
    description: 'Get the current weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  }]
  const toolRound = await postResponses({
    model,
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'What is the weather in Beijing? Call get_weather.' }] }],
    tools,
    tool_choice: 'auto',
    stream: true,
    store: false,
    reasoning: { effort: 'low' },
  })
  const calls = functionCalls(toolRound.events)
  record('tool_call', toolRound.status === 200 && calls.length > 0, calls.length ? `${calls[0].name} ${calls[0].arguments}` : 'no function_call event')

  const call = calls[0]
  if (call) {
    let parsedArgs = {}
    try {
      parsedArgs = JSON.parse(call.arguments || '{}')
    } catch {
      parsedArgs = {}
    }
    const second = await postResponses({
      model,
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'What is the weather in Beijing? Call get_weather.' }] },
        { type: 'function_call', call_id: call.call_id, name: call.name, arguments: call.arguments },
        { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify({ city: parsedArgs.city ?? 'Beijing', temperatureC: 21, condition: 'sunny' }) },
        { role: 'user', content: [{ type: 'input_text', text: 'Now report the weather in one short sentence.' }] },
      ],
      tools,
      stream: true,
      store: false,
      reasoning: { effort: 'low' },
    })
    const secondText = finalText(second.events)
    record('tool_result_roundtrip', second.status === 200 && secondText.length > 0, `text=${JSON.stringify(secondText.slice(0, 160))}`)
  }

  const bad = await postResponses({ model: 'definitely-not-a-model', input: 'hi', stream: true })
  record('error_mapping', bad.status >= 400 && bad.status < 500, `status=${bad.status} body=${bad.text.slice(0, 200)}`)

  const summary = { ok: results.every((item) => item.ok), results, stats: bridge.stats, health: { region: health.region, auth: health.auth } }
  console.log('\n=== SELFTEST SUMMARY ===')
  console.log(JSON.stringify(summary, null, 2))
  if (verbose) console.log(JSON.stringify(bridge.stats, null, 2))
  await bridge.stop()
  process.exit(summary.ok ? 0 : 1)
} catch (error) {
  console.error('SELFTEST ERROR', error)
  await bridge.stop().catch(() => {})
  process.exit(2)
}
