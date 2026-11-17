import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_OPTIONS, desiredProviderConfig } from '../index.js'
import { DEFAULT_MODELS } from '../src/bridge.mjs'

test('provider 配置只包含模型实际支持的思考档位', () => {
  const config = desiredProviderConfig(45917)
  assert.equal(config.displayName, 'Qwen Code · 免费额度')
  assert.equal(config.api, 'openai-responses')
  assert.equal(config.baseURL, 'http://127.0.0.1:45917/v1')
  assert.equal(config.models.length, DEFAULT_MODELS.length)
  assert.equal('reasoning' in config, false)

  const latest = config.models.find((model) => model.id === 'qmodel_latest')
  assert.deepEqual(latest.reasoningEfforts, { off: 'none', low: 'low', high: 'high', xhigh: 'xhigh' })
  const flash = config.models.find((model) => model.id === 'qfmodel')
  assert.deepEqual(flash.reasoningEfforts, { off: 'none', low: 'low', medium: 'medium', xhigh: 'xhigh' })
  assert.equal(flash.contextWindow, 180_000)
})

test('插件默认档位是 low，且四个模型都支持', () => {
  assert.equal(DEFAULT_OPTIONS.defaultReasoningEffort, 'low')
  const config = desiredProviderConfig(45917, DEFAULT_MODELS, {
    defaultReasoningEffort: DEFAULT_OPTIONS.defaultReasoningEffort,
  })
  assert.equal(config.reasoning, 'low')
  for (const model of config.models) {
    assert.ok(Object.hasOwn(model.reasoningEfforts, 'low'), `${model.id} 应支持 low`)
  }
})

test('显式配置 defaultReasoningEffort 时可覆盖', () => {
  const config = desiredProviderConfig(45917, DEFAULT_MODELS, { defaultReasoningEffort: 'xhigh' })
  assert.equal(config.reasoning, 'xhigh')
})

test('可用自定义模型表生成 provider 配置', () => {
  const models = [{
    id: 'custom',
    name: 'Custom',
    contextWindow: 200_000,
    maxTokens: 64_000,
    input: ['text'],
    reasoningEfforts: { off: 'none', low: 'low' },
  }]
  const config = desiredProviderConfig(46000, models)
  assert.deepEqual(config.models, [{
    id: 'custom',
    name: 'Custom',
    contextWindow: 200_000,
    maxTokens: 64_000,
    input: ['text'],
    reasoningEfforts: { off: 'none', low: 'low' },
  }])
  assert.equal(config.baseURL, 'http://127.0.0.1:46000/v1')
})

test('没有真实思考档位的模型不写 reasoningEfforts', () => {
  const config = desiredProviderConfig(46000, [{
    id: 'plain',
    name: 'Plain',
    contextWindow: 128_000,
    maxTokens: 32_000,
    input: ['text'],
    reasoningEfforts: { off: 'none' },
  }])
  assert.equal('reasoningEfforts' in config.models[0], false)
})
