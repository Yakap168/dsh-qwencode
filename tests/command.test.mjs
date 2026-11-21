import test from 'node:test'
import assert from 'node:assert/strict'
import { registerQwenLoginCommand } from '../index.js'

const silentLogger = { info() {}, warn() {}, error() {} }

function makeContext() {
  const definitions = []
  return {
    definitions,
    ctx: {
      get(name) {
        if (name === 'commands') {
          return { register(definition) { definitions.push(definition); return () => {} } }
        }
        return undefined
      },
      effect(fn) { fn() },
    },
  }
}

function makeBridge({ hasAccount = true, loginStatus = 'success', error = null } = {}) {
  return {
    auth: {
      status: () => ({
        hasAccount,
        userName: 'tester',
        region: 'cn',
        accessTokenExpiresAt: Date.now() + 3_600_000,
      }),
    },
    login: {
      credentialPath: 'C:/Users/tester/.qwen/qoder_oauth_creds.json',
      start: () => ({ id: 'session-1', authUrl: 'https://qoder.cn/device/selectAccounts?nonce=x' }),
      status: () => ({ status: loginStatus, userName: 'tester', error }),
      cancel: () => true,
      open: () => true,
    },
  }
}

test('registerQwenLoginCommand：注册命令并支持 status / cancel / open', async () => {
  const { ctx, definitions } = makeContext()
  const dispose = registerQwenLoginCommand(ctx, makeBridge(), silentLogger)
  assert.equal(definitions.length, 1)
  assert.equal(definitions[0].name, 'qwen-login')
  const signal = new AbortController().signal
  const status = await definitions[0].handler({ rawInput: ' status ', signal })
  assert.equal(status.kind, 'success')
  assert.match(status.text, /已登录 Qwen Code/)
  const cancelled = await definitions[0].handler({ rawInput: 'cancel', signal })
  assert.equal(cancelled.kind, 'success')
  const opened = await definitions[0].handler({ rawInput: 'open', signal })
  assert.equal(opened.kind, 'success')
  dispose()
})

test('registerQwenLoginCommand：未登录时发起登录并返回成功', async () => {
  const { ctx, definitions } = makeContext()
  const dispose = registerQwenLoginCommand(ctx, makeBridge({ hasAccount: false, loginStatus: 'success' }), silentLogger)
  const result = await definitions[0].handler({ rawInput: '', signal: new AbortController().signal })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /登录成功/)
  dispose()
})

test('registerQwenLoginCommand：登录失败与卸载后不可用', async () => {
  const { ctx, definitions } = makeContext()
  const dispose = registerQwenLoginCommand(
    ctx,
    makeBridge({ hasAccount: false, loginStatus: 'error', error: '授权被拒绝' }),
    silentLogger,
  )
  const failed = await definitions[0].handler({ rawInput: '', signal: new AbortController().signal })
  assert.equal(failed.kind, 'error')
  assert.match(failed.text, /授权被拒绝/)
  dispose()
  const disposed = await definitions[0].handler({ rawInput: 'status', signal: new AbortController().signal })
  assert.equal(disposed.kind, 'error')
  assert.match(disposed.text, /插件已卸载/)
})
