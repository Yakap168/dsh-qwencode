import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  DEFAULT_CLIENT_ID,
  QoderLoginManager,
  createLoginRequest,
  openExternalUrl,
  pollLoginOnce,
  writeLoginCredentials,
} from '../src/qoder-login.mjs'
import { createBridge } from '../src/bridge.mjs'

const NOW = 1_700_000_000_000
const silentLogger = { info() {}, warn() {}, error() {} }

function workspace(t, name = 'dsh-qwencode-login-') {
  const dir = mkdtempSync(path.join(tmpdir(), name))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, credentialPath: path.join(dir, 'qoder_oauth_creds.json') }
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

function fakeAuth(credentialPath, region = 'cn') {
  return {
    credentialPath,
    region,
    reloadCount: 0,
    reload() { this.reloadCount += 1 },
    status() {
      return { hasAccount: existsSync(credentialPath), region, userName: 'tester' }
    },
  }
}

test('createLoginRequest 生成正确的 PKCE 与授权页地址', () => {
  const request = createLoginRequest({ region: 'cn', now: () => NOW })
  const url = new URL(request.authUrl)
  assert.equal(url.origin, 'https://qoder.cn')
  assert.equal(url.pathname, '/device/selectAccounts')
  assert.equal(url.searchParams.get('sourceType'), 'QwenCode')
  assert.equal(url.searchParams.get('challenge_method'), 'S256')
  assert.equal(url.searchParams.get('client_id'), DEFAULT_CLIENT_ID)
  assert.equal(DEFAULT_CLIENT_ID, 'ecaf4a7a-5e5b-4659-9a95-7a1570012a41')
  assert.equal(url.searchParams.get('nonce'), request.nonce)
  assert.equal(url.searchParams.get('challenge'), request.challenge)
  const expected = createHash('sha256').update(request.verifier).digest('base64url')
  assert.equal(request.challenge, expected)
  assert.equal(request.createdAt, NOW)
})

test('createLoginRequest 支持 global 地域', () => {
  const request = createLoginRequest({ region: 'global' })
  assert.match(request.authUrl, /^https:\/\/qoder\.com\/device\/selectAccounts\?/)
})

test('pollLoginOnce：404 视为等待授权', async () => {
  const request = createLoginRequest({ region: 'cn' })
  const result = await pollLoginOnce(request, {
    fetchImpl: async () => jsonResponse({ errorCode: 'NotFound' }, 404),
  })
  assert.deepEqual(result, { status: 'pending' })
})

test('pollLoginOnce：成功响应映射 token 与相对有效期', async () => {
  const request = createLoginRequest({ region: 'cn' })
  const result = await pollLoginOnce(request, {
    now: () => NOW,
    fetchImpl: async () => jsonResponse({
      token: 'dt-access',
      refresh_token: 'drt-refresh',
      user_id: 'u-1',
      user_name: 'Alice',
      expires_in: 3600,
      refresh_token_expires_in: 86_400,
    }),
  })
  assert.equal(result.status, 'success')
  assert.equal(result.token.accessToken, 'dt-access')
  assert.equal(result.token.refreshToken, 'drt-refresh')
  assert.equal(result.token.userId, 'u-1')
  assert.equal(result.token.userName, 'Alice')
  assert.equal(result.token.expiresAt, NOW + 3_600_000)
  assert.equal(result.token.refreshTokenExpiresAt, NOW + 86_400_000)
})

test('pollLoginOnce：缺 refresh_token 时报错', async () => {
  const request = createLoginRequest({ region: 'cn' })
  await assert.rejects(
    () => pollLoginOnce(request, { fetchImpl: async () => jsonResponse({ token: 'dt-access' }) }),
    /refresh_token/,
  )
})

test('writeLoginCredentials 生成 CLI 兼容的凭证并保留其它地域', (t) => {
  const { credentialPath } = workspace(t)
  writeFileSync(credentialPath, `${JSON.stringify({
    version: 1,
    accounts: {
      global: {
        region: 'global', userId: 'g-1', userName: 'Global', accessToken: 'g', refreshToken: 'gr',
        expiresAt: NOW, createdAt: NOW, updatedAt: NOW,
      },
    },
  }, null, 2)}\n`, 'utf8')
  const account = writeLoginCredentials({
    credentialPath,
    region: 'cn',
    now: NOW,
    token: { accessToken: 'dt-a', refreshToken: 'drt-r', expiresAt: NOW + 1000, refreshTokenExpiresAt: NOW + 2000 },
    profile: { uid: 'cn-1', name: '本地用户', email: 'a@example.com' },
  })
  assert.equal(account.userId, 'cn-1')
  assert.equal(account.userName, '本地用户')
  const store = JSON.parse(readFileSync(credentialPath, 'utf8'))
  assert.equal(store.version, 1)
  assert.equal(store.accounts.cn.accessToken, 'dt-a')
  assert.equal(store.accounts.cn.refreshToken, 'drt-r')
  assert.equal(store.accounts.cn.userId, 'cn-1')
  assert.equal(store.accounts.cn.createdAt, NOW)
  assert.equal(store.accounts.cn.updatedAt, NOW)
  assert.equal(store.accounts.global.accessToken, 'g')
})

test('QoderLoginManager：轮询成功后写回凭证并重载 auth', async (t) => {
  const { credentialPath } = workspace(t)
  const auth = fakeAuth(credentialPath)
  let polls = 0
  const manager = new QoderLoginManager({
    auth,
    credentialPath,
    region: 'cn',
    pollIntervalMs: 5,
    openBrowser: false,
    logger: silentLogger,
    fetchImpl: async (url) => {
      if (String(url).includes('/api/v1/deviceToken/poll')) {
        polls += 1
        if (polls < 2) return jsonResponse({ errorCode: 'NotFound' }, 404)
        return jsonResponse({ token: 'dt-access', refresh_token: 'drt-refresh', user_name: 'Alice', expires_in: 3600 })
      }
      if (String(url).includes('/api/v1/userinfo')) {
        return jsonResponse({ id: 'u-1', name: 'Alice', email: 'alice@example.com' })
      }
      throw new Error(`unexpected url: ${url}`)
    },
  })
  const session = manager.start()
  assert.equal(session.status, 'pending')
  for (let index = 0; index < 200; index += 1) {
    if (manager.status(session.id).status !== 'pending') break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const status = manager.status(session.id)
  assert.equal(status.status, 'success')
  assert.equal(status.userName, 'Alice')
  assert.equal(auth.reloadCount, 1)
  const store = JSON.parse(readFileSync(credentialPath, 'utf8'))
  assert.equal(store.accounts.cn.accessToken, 'dt-access')
  assert.equal(store.accounts.cn.userId, 'u-1')
  manager.dispose()
})

test('QoderLoginManager：取消后不再写凭证', async (t) => {
  const { credentialPath } = workspace(t)
  const manager = new QoderLoginManager({
    credentialPath,
    region: 'cn',
    pollIntervalMs: 5,
    openBrowser: false,
    logger: silentLogger,
    fetchImpl: async () => jsonResponse({ errorCode: 'NotFound' }, 404),
  })
  const session = manager.start()
  assert.equal(manager.cancel(session.id), true)
  assert.equal(manager.status(session.id).status, 'cancelled')
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(existsSync(credentialPath), false)
  manager.dispose()
})

test('pollLoginOnce：非 404 的 HTTP 错误抛可读错误', async () => {
  const request = createLoginRequest({ region: 'cn' })
  await assert.rejects(
    () => pollLoginOnce(request, { fetchImpl: async () => jsonResponse({ message: 'boom' }, 500) }),
    (error) => error.code === 'http' && /HTTP 500/.test(error.message),
  )
})

test('pollLoginOnce：非法 JSON 抛 invalid_response', async () => {
  const request = createLoginRequest({ region: 'cn' })
  await assert.rejects(
    () => pollLoginOnce(request, {
      fetchImpl: async () => new Response('not-json', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
    }),
    (error) => error.code === 'invalid_response' && /非法 JSON/.test(error.message),
  )
})

test('QoderLoginManager：超过会话时限后标记 expired', async (t) => {
  const { credentialPath } = workspace(t)
  const manager = new QoderLoginManager({
    credentialPath,
    region: 'cn',
    pollIntervalMs: 5,
    timeoutMs: 1,
    openBrowser: false,
    logger: silentLogger,
    fetchImpl: async () => jsonResponse({ errorCode: 'NotFound' }, 404),
  })
  const session = manager.start()
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(manager.status(session.id).status, 'expired')
  manager.dispose()
})

test('writeLoginCredentials：拒绝不支持的凭证版本', (t) => {
  const { credentialPath } = workspace(t)
  writeFileSync(credentialPath, `${JSON.stringify({ version: 2, accounts: {} })}\n`, 'utf8')
  assert.throws(
    () => writeLoginCredentials({
      credentialPath,
      region: 'cn',
      token: { accessToken: 'a', refreshToken: 'r', expiresAt: NOW },
    }),
    (error) => error.code === 'invalid_response' && /版本/.test(error.message),
  )
})

test('writeLoginCredentials：写入失败时抛可读错误且不留下临时文件', (t) => {
  const { dir } = workspace(t)
  const blocker = path.join(dir, 'blocker')
  writeFileSync(blocker, 'not a directory', 'utf8')
  const credentialPath = path.join(blocker, 'creds.json')
  assert.throws(
    () => writeLoginCredentials({
      credentialPath,
      region: 'cn',
      token: { accessToken: 'a', refreshToken: 'r', expiresAt: NOW },
    }),
    (error) => error.code === 'invalid_response' && /写回 Qwen Code 凭证失败/.test(error.message),
  )
})

test('bridge.setRegion 动态切换上游网关', async (t) => {
  const calls = []
  const bridge = createBridge({
    port: 0,
    region: 'cn',
    auth: {
      region: 'cn',
      reload() {},
      status: () => ({ hasAccount: true, region: 'cn' }),
      getAccessToken: async () => 'test-token',
    },
    openBrowserOnLogin: false,
    logger: silentLogger,
    fetchImpl: async (url) => {
      calls.push(String(url))
      return new Response('data: {"type":"response.completed"}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    },
  })
  await bridge.start()
  t.after(() => bridge.stop())
  assert.equal(bridge.gatewayBaseUrl, 'https://gateway.qoder.com.cn/qsvr')
  bridge.setRegion('global')
  assert.equal(bridge.gatewayBaseUrl, 'https://api2.qoder.sh/qsvr')
  const response = await fetch(`${bridge.url}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qfmodel', input: [{ role: 'user', content: 'hi' }] }),
  })
  await response.text()
  assert.equal(calls.length, 1)
  assert.match(calls[0], /^https:\/\/api2\.qoder\.sh\/qsvr\/api\/v1\/responses\?/)
})

test('openExternalUrl 按平台调用系统浏览器', () => {
  const calls = []
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options })
    return { on() {}, unref() {} }
  }
  assert.equal(openExternalUrl('https://example.com/a?b=1&c=2', { spawnImpl, platform: 'win32' }), true)
  assert.equal(calls[0].command, 'rundll32.exe')
  assert.deepEqual(calls[0].args, ['url.dll,FileProtocolHandler', 'https://example.com/a?b=1&c=2'])
  assert.equal(calls[0].options.detached, true)
  openExternalUrl('https://example.com', { spawnImpl, platform: 'darwin' })
  assert.equal(calls[1].command, 'open')
  openExternalUrl('https://example.com', { spawnImpl, platform: 'linux' })
  assert.equal(calls[2].command, 'xdg-open')
})

test('桥接 /login/start 完整成功流程写回凭证', async (t) => {
  const { credentialPath } = workspace(t)
  let polls = 0
  const bridge = createBridge({
    port: 0,
    credentialPath,
    auth: fakeAuth(credentialPath),
    openBrowserOnLogin: false,
    loginPollIntervalMs: 5,
    loginTimeoutMs: 5000,
    logger: silentLogger,
    fetchImpl: async (url) => {
      if (String(url).includes('/deviceToken/poll')) {
        polls += 1
        if (polls < 2) return jsonResponse({ errorCode: 'NotFound' }, 404)
        return jsonResponse({ token: 'dt-access', refresh_token: 'drt-refresh', user_id: 'u-1', user_name: 'Alice', expires_in: 3600 })
      }
      if (String(url).includes('/userinfo')) return jsonResponse({ id: 'u-1', name: 'Alice' })
      throw new Error(`unexpected url: ${url}`)
    },
  })
  await bridge.start()
  t.after(() => bridge.stop())
  const started = await (await fetch(`${bridge.url}/login/start`, { method: 'POST' })).json()
  let status = started
  for (let index = 0; index < 200; index += 1) {
    status = await (await fetch(`${bridge.url}/login/status?id=${started.id}`)).json()
    if (status.status !== 'pending') break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(status.status, 'success')
  assert.equal(status.userName, 'Alice')
  const store = JSON.parse(readFileSync(credentialPath, 'utf8'))
  assert.equal(store.accounts.cn.accessToken, 'dt-access')
})

test('桥接服务暴露 /login/start、/login/status、/login/cancel', async (t) => {
  const { credentialPath } = workspace(t)
  const bridge = createBridge({
    port: 0,
    credentialPath,
    auth: fakeAuth(credentialPath),
    openBrowserOnLogin: false,
    loginPollIntervalMs: 5,
    loginTimeoutMs: 5000,
    logger: silentLogger,
    fetchImpl: async (url) => {
      if (String(url).includes('/deviceToken/poll')) return jsonResponse({ errorCode: 'NotFound' }, 404)
      throw new Error(`unexpected url: ${url}`)
    },
  })
  await bridge.start()
  t.after(() => bridge.stop())
  const base = bridge.url
  const started = await (await fetch(`${base}/login/start`, { method: 'POST' })).json()
  assert.equal(started.ok, true)
  assert.equal(started.status, 'pending')
  assert.match(started.authUrl, /\/device\/selectAccounts\?/)
  const status = await (await fetch(`${base}/login/status?id=${started.id}`)).json()
  assert.equal(status.status, 'pending')
  const cancelled = await (await fetch(`${base}/login/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: started.id }),
  })).json()
  assert.equal(cancelled.cancelled, true)
  assert.equal(cancelled.status.status, 'cancelled')
  const health = await (await fetch(`${base}/healthz`)).json()
  assert.equal(health.login.status, 'cancelled')
})
