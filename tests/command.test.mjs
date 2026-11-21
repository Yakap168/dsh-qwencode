import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
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

function makeBridge({ hasAccount = true, loginStatus = 'success', error = null, credentialPath = 'C:/Users/tester/.qwen/qoder_oauth_creds.json' } = {}) {
  let currentRegion = 'cn'
  const auth = {
    region: 'cn',
    reloadCount: 0,
    reload() { this.reloadCount += 1 },
    status: () => ({
      hasAccount,
      userName: 'tester',
      region: auth.region,
      accessTokenExpiresAt: Date.now() + 3_600_000,
    }),
  }
  const login = {
    credentialPath,
    region: 'cn',
    requestedRegion: undefined,
    lastStartRegion: undefined,
    start(options = {}) {
      this.lastStartRegion = options.region ?? this.region
      currentRegion = this.lastStartRegion
      return {
        id: 'session-1',
        authUrl: `https://${currentRegion === 'global' ? 'qoder.com' : 'qoder.cn'}/device/selectAccounts?nonce=x`,
        region: currentRegion,
      }
    },
    status: () => ({ status: loginStatus, userName: 'tester', error, region: currentRegion }),
    cancel: () => true,
    open: () => true,
  }
  return {
    auth,
    login,
    setRegion(next) {
      auth.region = next
      auth.reload?.()
      login.region = next
      login.requestedRegion = next
      return next
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

test('registerQwenLoginCommand：按区域登录并切换当前区域', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-qwencode-command-'))
  const credentialPath = path.join(dir, 'qoder_oauth_creds.json')
  writeFileSync(credentialPath, `${JSON.stringify({
    version: 1,
    accounts: {
      cn: { region: 'cn', userName: '中国账号', expiresAt: Date.now() + 1000 },
      global: { region: 'global', userName: '国际账号', expiresAt: Date.now() + 2000 },
    },
  }, null, 2)}\n`, 'utf8')
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const bridge = makeBridge({ credentialPath })
  const { ctx, definitions } = makeContext()
  const dispose = registerQwenLoginCommand(ctx, bridge, silentLogger)
  const signal = new AbortController().signal

  const globalLogin = await definitions[0].handler({ rawInput: 'global', signal })
  assert.equal(globalLogin.kind, 'success')
  assert.match(globalLogin.text, /区域：global/)
  assert.equal(bridge.login.lastStartRegion, 'global')
  assert.equal(bridge.auth.region, 'global')

  const useCn = await definitions[0].handler({ rawInput: 'use cn', signal })
  assert.equal(useCn.kind, 'success')
  assert.equal(bridge.auth.region, 'cn')

  const missingRegion = await definitions[0].handler({ rawInput: 'use xx', signal })
  assert.equal(missingRegion.kind, 'error')
  assert.match(missingRegion.text, /用法/)
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
