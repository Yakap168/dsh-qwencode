import test from 'node:test'
import assert from 'node:assert/strict'
import { buildUpstreamPayload, createBridge, DEFAULT_MODELS } from '../src/bridge.mjs'
import { VERSION } from '../src/version.mjs'

const silentLogger = { info() {}, warn() {}, error() {} }

const fakeAuth = {
  region: 'cn',
  status: () => ({ hasAccount: true, userName: 'tester', region: 'cn' }),
  getAccessToken: async () => 'test-token',
}

test('buildUpstreamPayload 清洗上游不接受的字段', () => {
  const payload = buildUpstreamPayload({
    model: 'qmodel_latest',
    stream: false,
    store: true,
    temperature: 0.7,
    top_p: 0.9,
    prompt_cache_key: 'cache-key',
    prompt_cache_options: { mode: 'explicit' },
    service_tier: 'auto',
    previous_response_id: 'resp_1',
    truncation: 'auto',
    include: ['reasoning.encrypted_content', 'message.output_text.logprobs'],
    text: { verbosity: 'low' },
    reasoning: { effort: 'high', summary: 'auto' },
    metadata: { trace: 't1' },
    input: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'hello' },
    ],
  }, { sessionType: 'qcode' })

  assert.equal(payload.stream, true)
  assert.equal(payload.store, false)
  assert.equal('temperature' in payload, false)
  assert.equal('top_p' in payload, false)
  assert.equal('prompt_cache_key' in payload, false)
  assert.equal('prompt_cache_options' in payload, false)
  assert.equal('service_tier' in payload, false)
  assert.equal('previous_response_id' in payload, false)
  assert.equal('truncation' in payload, false)
  assert.deepEqual(payload.include, ['reasoning.encrypted_content'])
  assert.equal('text' in payload, false)
  assert.deepEqual(payload.reasoning, { effort: 'high' })
  assert.equal(payload.metadata.session_type, 'qcode')
  assert.equal(payload.metadata.trace, 't1')
  assert.equal(payload.input[0].role, 'developer')
  assert.equal(payload.input[1].role, 'user')
})

test('buildUpstreamPayload 拒绝非对象请求体', () => {
  assert.throws(() => buildUpstreamPayload(null), /JSON 对象/)
  assert.throws(() => buildUpstreamPayload([]), /JSON 对象/)
})

test('missingReasoningMeansOff 把 DSH 的 off（省略字段）补成 none', () => {
  const off = buildUpstreamPayload({ model: 'm', messages: [] }, { missingReasoningMeansOff: true })
  assert.deepEqual(off.reasoning, { effort: 'none' })
  const keep = buildUpstreamPayload({ model: 'm', messages: [] }, { missingReasoningMeansOff: false })
  assert.equal('reasoning' in keep, false)
  const explicit = buildUpstreamPayload(
    { model: 'm', messages: [], reasoning: { effort: 'high' } },
    { missingReasoningMeansOff: true },
  )
  assert.deepEqual(explicit.reasoning, { effort: 'high' })
  const offLevel = buildUpstreamPayload({ model: 'm', messages: [], reasoning: { effort: 'off' } })
  assert.deepEqual(offLevel.reasoning, { effort: 'none' })
})

test('DEFAULT_MODELS 使用目录里的真实输入上限', () => {
  assert.equal(DEFAULT_MODELS.find((model) => model.id === 'qmodel_latest').contextWindow, 1_000_000)
  assert.equal(DEFAULT_MODELS.find((model) => model.id === 'qmodel_38max').contextWindow, 180_000)
  assert.equal(DEFAULT_MODELS.find((model) => model.id === 'qfmodel').contextWindow, 180_000)
})

test('桥接服务的 healthz / models / 错误路径', async (t) => {
  const bridge = createBridge({
    host: '127.0.0.1',
    port: 0,
    auth: fakeAuth,
    models: [{
      id: 'test-model',
      name: 'Test Model',
      contextWindow: 1000,
      maxTokens: 100,
      input: ['text'],
      reasoningEfforts: { off: 'none', low: 'low' },
    }],
    logger: silentLogger,
  })
  const url = await bridge.start()
  t.after(() => bridge.stop())
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/)

  const health = await (await fetch(`${url}/healthz`)).json()
  assert.equal(health.ok, true)
  assert.equal(health.version, VERSION)
  assert.equal(health.modelCount, 1)
  assert.deepEqual(health.models, ['test-model'])

  const models = await (await fetch(`${url}/v1/models`)).json()
  assert.equal(models.data.length, 1)
  assert.equal(models.data[0].id, 'test-model')
  assert.equal(models.data[0].context_length, 1000)
  assert.deepEqual(models.data[0].supported_reasoning_levels, [
    { level: 'off', effort: 'none' },
    { level: 'low', effort: 'low' },
  ])

  const badJson = await fetch(`${url}/v1/responses`, { method: 'POST', body: '{' })
  assert.equal(badJson.status, 400)

  const missingModel = await fetch(`${url}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [] }),
  })
  assert.equal(missingModel.status, 400)

  const notFound = await fetch(`${url}/nope`)
  assert.equal(notFound.status, 404)
})
