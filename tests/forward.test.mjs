import test from 'node:test'
import assert from 'node:assert/strict'
import { createBridge, DEFAULT_MODELS } from '../src/bridge.mjs'

const silentLogger = { info() {}, warn() {}, error() {} }

/** 构造一个返回 SSE 的最小 Response（供 fetchImpl 桩使用）。 */
function sseResponse(text, { status = 200, headers = {} } = {}) {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/event-stream', 'sw-trace-id': 'trace-test', ...headers },
  })
}

/** 构造一个返回 JSON 错误的上游响应。 */
function jsonError(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeAuth({ token = 'test-token', refreshTokens = [] } = {}) {
  let calls = 0
  return {
    region: 'cn',
    status: () => ({ hasAccount: true, region: 'cn', canRefresh: true }),
    async getAccessToken(options = {}) {
      calls += 1
      if (options.forceRefresh && refreshTokens.length > 0) return refreshTokens.shift()
      return token
    },
    get calls() {
      return calls
    },
  }
}

async function postResponses(url, body) {
  const response = await fetch(`${url}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer local' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, text }
}

test('转发成功：SSE 原样透传、统计与 think 增量计数', async (t) => {
  const sse = [
    'event:response.reasoning_text.delta',
    'data:{"type":"response.reasoning_text.delta","delta":"想"}',
    '',
    'event:response.output_text.delta',
    'data:{"type":"response.output_text.delta","delta":"OK"}',
    '',
    'event:response.completed',
    'data:{"type":"response.completed","response":{"status":"completed"}}',
    '',
    '',
  ].join('\n')
  const auth = makeAuth()
  let capturedUrl
  const bridge = createBridge({
    port: 0,
    auth,
    logger: silentLogger,
    fetchImpl: async (url) => {
      capturedUrl = String(url)
      return sseResponse(sse)
    },
  })
  const url = await bridge.start()
  t.after(() => bridge.stop())

  const result = await postResponses(url, { model: 'qmodel_latest', input: 'hi', stream: true })
  assert.equal(result.status, 200)
  assert.match(result.text, /response\.reasoning_text\.delta/)
  assert.match(result.text, /response\.output_text\.delta/)
  // 请求被改写成 Qoder 网关可接受的形式：带上 AgentId 查询参数。
  assert.match(capturedUrl, /\/api\/v1\/responses\?AgentId=agent_common$/)
  assert.equal(bridge.stats.successRequests, 1)
  // event 行与 data 行各含一次类型名，故计数为 2。
  assert.equal(bridge.stats.lastReasoningDeltas, 2)
})

test('上游 401：强制刷新 token 后重试一次并成功', async (t) => {
  const auth = makeAuth({ reload: true, refreshTokens: ['refreshed-token'] })
  let attempt = 0
  const seenAuth = []
  const bridge = createBridge({
    port: 0,
    auth,
    logger: silentLogger,
    fetchImpl: async (_url, init) => {
      attempt += 1
      seenAuth.push(init.headers.Authorization)
      if (attempt === 1) return jsonError(401, { error: { message: 'token expired', code: 'TOKEN_EXPIRE' } })
      return sseResponse('event:response.completed\ndata:{"type":"response.completed","response":{}}\n\n')
    },
  })
  const url = await bridge.start()
  t.after(() => bridge.stop())

  const result = await postResponses(url, { model: 'qmodel_latest', input: 'hi' })
  assert.equal(result.status, 200)
  assert.equal(attempt, 2)
  assert.equal(bridge.stats.upstream401Retries, 1)
  assert.equal(seenAuth[0], 'Bearer test-token')
  assert.equal(seenAuth[1], 'Bearer refreshed-token')
})

test('付费确认：默认返回 402 且不静默扣费', async (t) => {
  let attempt = 0
  const bridge = createBridge({
    port: 0,
    auth: makeAuth(),
    logger: silentLogger,
    autoConfirmPaid: false,
    fetchImpl: async () => {
      attempt += 1
      return jsonError(403, { error: { code: 'PAID_REQUIRED', subCode: 'MODEL_PAID_CONFIRM_REQUIRED', message: '需要付费确认' } })
    },
  })
  const url = await bridge.start()
  t.after(() => bridge.stop())

  const result = await postResponses(url, { model: 'qmodel_latest', input: 'hi' })
  assert.equal(result.status, 402)
  assert.match(result.text, /付费确认|PAID_CONFIRM|MODEL_PAID_CONFIRM_REQUIRED/)
  assert.equal(attempt, 1, '默认不应自动重试')
})

test('付费确认：autoConfirmPaid=true 时附带确认头重试', async (t) => {
  const confirmHeaders = []
  let attempt = 0
  const bridge = createBridge({
    port: 0,
    auth: makeAuth(),
    logger: silentLogger,
    autoConfirmPaid: true,
    fetchImpl: async (_url, init) => {
      attempt += 1
      confirmHeaders.push(init.headers['Cosy-Paid-Confirmed'] ?? null)
      if (attempt === 1) return jsonError(403, { error: { code: 'PAID_REQUIRED', subCode: 'MODEL_PAID_CONFIRM_REQUIRED', message: '需要付费确认' } })
      return sseResponse('event:response.completed\ndata:{"type":"response.completed","response":{}}\n\n')
    },
  })
  const url = await bridge.start()
  t.after(() => bridge.stop())

  const result = await postResponses(url, { model: 'qmodel_latest', input: 'hi' })
  assert.equal(result.status, 200)
  assert.equal(attempt, 2)
  assert.equal(confirmHeaders[0], null)
  assert.equal(confirmHeaders[1], 'true')
})

test('上游错误体里的 token 片段被脱敏，不回传原始 body', async (t) => {
  const bridge = createBridge({
    port: 0,
    auth: makeAuth(),
    logger: silentLogger,
    fetchImpl: async () => jsonError(400, {
      error: { message: 'bad token dt-ABCDEFGH12345678 leaked', code: 'invalid_request' },
      access_token: 'dt-SECRETSECRETSECRET',
    }),
  })
  const url = await bridge.start()
  t.after(() => bridge.stop())

  const result = await postResponses(url, { model: 'qmodel_latest', input: 'hi' })
  assert.equal(result.status, 400)
  assert.match(result.text, /\[REDACTED\]/)
  assert.doesNotMatch(result.text, /dt-SECRETSECRETSECRET/)
  assert.doesNotMatch(result.text, /ABCDEFGH12345678/)
})

test('healthz 默认不泄露凭证路径与账号名', async (t) => {
  const bridge = createBridge({
    port: 0,
    auth: makeAuth(),
    logger: silentLogger,
    models: DEFAULT_MODELS,
  })
  const url = await bridge.start()
  t.after(() => bridge.stop())
  const health = await (await fetch(`${url}/healthz`)).json()
  assert.equal(health.ok, true)
  assert.equal('credentialPath' in health.auth, false)
  assert.equal('userName' in health.auth, false)
  assert.equal(health.modelCount, DEFAULT_MODELS.length)
})

test('非 loopback host 拒绝启动', async (t) => {
  const bridge = createBridge({ host: '0.0.0.0', port: 0, auth: makeAuth(), logger: silentLogger })
  await assert.rejects(() => bridge.start(), /回环地址/)
})
