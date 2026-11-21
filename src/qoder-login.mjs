/**
 * Qoder 设备登录（PKCE + 轮询）。
 *
 * 协议来源：qwen-code 1.0.0-preview.2 二进制里的 QoderOAuth 实现，并已逐个
 * 端点实测。注意：该版本不发送 machine_id / device_id（二进制中无相关字段），
 * 与部分第三方 Qoder 客户端实现不同；以官方 CLI 为准。
 *
 *   1. 本地生成 PKCE：
 *        verifier  = randomBytes(32).toString('base64url')
 *        challenge = sha256(verifier).digest('base64url')
 *        nonce     = randomUUID()
 *   2. 浏览器打开授权页：
 *        {websiteBaseUrl}/device/selectAccounts
 *          ?sourceType=QwenCode&challenge=...&challenge_method=S256
 *          &nonce=...&client_id=<qwen-code 内置 UUID，见 DEFAULT_CLIENT_ID>
 *   3. 轮询（404 表示用户还没完成授权，不是错误）：
 *        GET {openApiBaseUrl}/api/v1/deviceToken/poll
 *          ?nonce=...&verifier=...&challenge_method=S256
 *   4. 成功响应含 token / refresh_token / user_id / user_name /
 *      expires_at / expires_in / refresh_token_expires_at /
 *      refresh_token_expires_in。
 *   5. 用 Bearer token 请求 GET {openApiBaseUrl}/api/v1/userinfo 取账号资料。
 *
 * 登录成功后凭证写入与 Qwen Code CLI 完全相同的
 * `~/.qwen/qoder_oauth_creds.json`（version 1），因此 CLI 与插件可以共用同一份
 * 登录态；后续日常刷新仍由 qoder-auth.mjs 负责。
 */
import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_ACCESS_TOKEN_TTL_MS,
  defaultCredentialPath,
  expiryFromDuration,
  normalizeRegion,
  parseExpiry,
  regionEndpoints,
} from './qoder-auth.mjs'

/** 与 qwen-code 一致的 OAuth client_id（Qoder 内置 UUID，不是字面量 "qwen-code"）。 */
export const DEFAULT_CLIENT_ID = 'ecaf4a7a-5e5b-4659-9a95-7a1570012a41'
/** 授权页来源标记，Qoder 用它区分客户端类型。 */
export const SOURCE_TYPE = 'QwenCode'

/** 登录流程错误。 */
export class QoderLoginError extends Error {
  /**
   * @param {string} code 稳定错误码：http / invalid_response / expired / cancelled
   * @param {string} message 面向用户的中文提示
   * @param {{status?: number, detail?: unknown}} [options]
   */
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'QoderLoginError'
    this.code = code
    this.status = options.status
    this.detail = options.detail
  }
}

/** 取对象里的字符串字段（trim 后非空）。 */
function pickString(payload, keys) {
  if (!payload || typeof payload !== 'object') return undefined
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/** 取对象里的原始字段。 */
function pickRaw(payload, keys) {
  if (!payload || typeof payload !== 'object') return undefined
  for (const key of keys) {
    const value = payload[key]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

/** 去敏错误文本：抹掉疑似 token 片段与 URL 里的 PKCE 参数。 */
function sanitizeDetail(value) {
  if (typeof value !== 'string') return value
  return value
    .replace(/\b(?:dt|drt)-[A-Za-z0-9]{8,}/g, '[REDACTED]')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:verifier|nonce|challenge)=)[^&\s"']+/gi, '$1[REDACTED]')
}

/**
 * 生成一次登录请求（PKCE + nonce + 授权页地址）。
 * @param {{region?: string, clientId?: string, now?: () => number}} [options]
 * @returns {{region: string, nonce: string, verifier: string, challenge: string, authUrl: string, createdAt: number}}
 */
export function createLoginRequest(options = {}) {
  const region = normalizeRegion(options.region)
  const clientId = options.clientId ?? DEFAULT_CLIENT_ID
  const now = options.now ?? Date.now
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const nonce = randomUUID()
  const endpoints = regionEndpoints(region)
  const query = new URLSearchParams({
    sourceType: SOURCE_TYPE,
    challenge,
    challenge_method: 'S256',
    nonce,
    client_id: clientId,
  })
  return {
    region,
    nonce,
    verifier,
    challenge,
    authUrl: `${endpoints.websiteBaseUrl}/device/selectAccounts?${query.toString()}`,
    createdAt: now(),
  }
}

/**
 * 轮询一次登录结果。
 * @param {{region: string, nonce: string, verifier: string}} request createLoginRequest 的返回值
 * @param {{fetchImpl?: typeof fetch, signal?: AbortSignal, timeoutMs?: number, now?: () => number}} [options]
 * @returns {Promise<{status: 'pending'} | {status: 'success', token: Record<string, any>}>}
 */
export async function pollLoginOnce(request, options = {}) {
  const endpoints = regionEndpoints(request.region)
  const query = new URLSearchParams({
    nonce: request.nonce,
    verifier: request.verifier,
    challenge_method: 'S256',
  })
  const url = `${endpoints.openApiBaseUrl}/api/v1/deviceToken/poll?${query.toString()}`
  const fetchImpl = options.fetchImpl ?? fetch
  const signal = options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 15_000)
  let response
  try {
    response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal })
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw error
    throw new QoderLoginError('http', `Qoder 登录轮询请求失败：${sanitizeDetail(String(error?.message ?? error))}`)
  }
  // 404 是官方约定的「还没授权完成」状态。
  if (response.status === 404) {
    await response.body?.cancel?.().catch(() => {})
    return { status: 'pending' }
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new QoderLoginError('http', `Qoder 登录轮询返回 HTTP ${response.status}`, {
      status: response.status,
      detail: sanitizeDetail(detail).slice(0, 300),
    })
  }
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new QoderLoginError('invalid_response', 'Qoder 登录返回了非法 JSON')
  }
  const accessToken = pickString(payload, ['token', 'device_token', 'access_token'])
  if (!accessToken) return { status: 'pending' }
  const refreshToken = pickString(payload, ['refresh_token'])
  if (!refreshToken) {
    throw new QoderLoginError('invalid_response', 'Qoder 登录没有返回 refresh_token（无法长期保持登录）')
  }
  const now = (options.now ?? Date.now)()
  const expiresAt = parseExpiry(pickRaw(payload, ['expires_at']))
    ?? expiryFromDuration(pickRaw(payload, ['expires_in']), now)
    ?? now + DEFAULT_ACCESS_TOKEN_TTL_MS
  const refreshTokenExpiresAt = parseExpiry(pickRaw(payload, ['refresh_token_expires_at']))
    ?? expiryFromDuration(pickRaw(payload, ['refresh_token_expires_in']), now)
  return {
    status: 'success',
    token: {
      accessToken,
      refreshToken,
      userId: pickString(payload, ['user_id', 'userId', 'uid']),
      userName: pickString(payload, ['user_name', 'userName', 'name']),
      expiresAt,
      ...(refreshTokenExpiresAt !== undefined ? { refreshTokenExpiresAt } : {}),
    },
  }
}

/**
 * 用 access token 读取 Qoder 账号资料。
 * @param {string} accessToken
 * @param {{region?: string, fetchImpl?: typeof fetch, signal?: AbortSignal, timeoutMs?: number}} [options]
 * @returns {Promise<{uid?: string, name?: string, nickName?: string, email?: string, organizationName?: string}>}
 */
export async function fetchQoderUserInfo(accessToken, options = {}) {
  const endpoints = regionEndpoints(options.region ?? 'cn')
  const fetchImpl = options.fetchImpl ?? fetch
  const signal = options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 15_000)
  const response = await fetchImpl(`${endpoints.openApiBaseUrl}/api/v1/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal,
  })
  if (!response.ok) {
    throw new QoderLoginError('http', `Qoder 用户信息获取失败：HTTP ${response.status}`, { status: response.status })
  }
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new QoderLoginError('invalid_response', 'Qoder 用户信息返回了非法 JSON')
  }
  return {
    uid: pickString(payload, ['id', 'user_id', 'uid']),
    name: pickString(payload, ['name', 'username', 'user_name']),
    nickName: pickString(payload, ['nick_name', 'nickName']),
    email: pickString(payload, ['email']),
    organizationName: pickString(payload, ['organization_name', 'orgName']),
  }
}

/** 读取凭证 store；文件不存在时返回空 store，格式非法时抛错。 */
export function readCredentialStore(credentialPath) {
  if (!existsSync(credentialPath)) return { version: 1, accounts: {} }
  let text
  try {
    text = readFileSync(credentialPath, 'utf8')
  } catch (error) {
    throw new QoderLoginError('invalid_response', `读取 Qwen Code 凭证失败：${credentialPath}（${error?.message ?? error}）`)
  }
  let parsed
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new QoderLoginError('invalid_response', `Qwen Code 凭证不是合法 JSON：${credentialPath}（${error?.message ?? error}）`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new QoderLoginError('invalid_response', `Qwen Code 凭证格式不正确：${credentialPath}`)
  }
  if (parsed.version !== 1) {
    throw new QoderLoginError('invalid_response', `不支持的 Qwen Code 凭证版本：${String(parsed.version)}（仅支持 1）`)
  }
  const accounts = parsed.accounts && typeof parsed.accounts === 'object' && !Array.isArray(parsed.accounts)
    ? parsed.accounts
    : {}
  return { ...parsed, version: 1, accounts }
}

/** 原子写入凭证 JSON（0600），失败时清理临时文件。 */
function atomicWriteJson(filePath, value) {
  const dir = path.dirname(filePath)
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch {
    // 目录已存在时忽略。
  }
  const text = `${JSON.stringify(value, null, 2)}\n`
  const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
  try {
    writeFileSync(tmpPath, text, { encoding: 'utf8', mode: 0o600 })
    try {
      chmodSync(tmpPath, 0o600)
    } catch {
      // Windows 上 chmod 可能无效，忽略。
    }
    renameSync(tmpPath, filePath)
  } catch (error) {
    try {
      unlinkSync(tmpPath)
    } catch {
      // 忽略清理失败。
    }
    throw new QoderLoginError('invalid_response', `写回 Qwen Code 凭证失败：${error?.message ?? error}`)
  }
}

/**
 * 把登录结果写入 ~/.qwen/qoder_oauth_creds.json（与 CLI 共用 schema）。
 * 保留其它地域的账号与已有字段。
 * @param {{
 *   credentialPath?: string,
 *   region?: string,
 *   token: {accessToken: string, refreshToken: string, userId?: string, userName?: string, expiresAt: number, refreshTokenExpiresAt?: number},
 *   profile?: {uid?: string, name?: string, nickName?: string, email?: string, organizationName?: string},
 *   now?: number,
 * }} options
 * @returns {Record<string, any>} 写入的账号对象
 */
export function writeLoginCredentials(options) {
  const credentialPath = options.credentialPath ?? defaultCredentialPath()
  const region = normalizeRegion(options.region)
  const token = options.token
  const now = options.now ?? Date.now()
  const store = readCredentialStore(credentialPath)
  const previous = store.accounts[region]
  const profile = options.profile ?? {}
  const account = {
    region,
    userId: profile.uid || token.userId || previous?.userId || 'unknown',
    userName: profile.name || profile.nickName || token.userName || previous?.userName || 'Qoder 用户',
    ...(profile.email ? { email: profile.email } : {}),
    ...(profile.organizationName ? { organizationName: profile.organizationName } : {}),
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresAt,
    ...(token.refreshTokenExpiresAt !== undefined ? { refreshTokenExpiresAt: token.refreshTokenExpiresAt } : {}),
    createdAt: typeof previous?.createdAt === 'number' ? previous.createdAt : now,
    updatedAt: now,
  }
  store.accounts[region] = account
  atomicWriteJson(credentialPath, store)
  return account
}

/** 可中止的 sleep；定时器 unref，避免拖住进程退出。 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/**
 * 用系统默认浏览器打开 URL。失败不抛错（命令结果里始终带可复制链接）。
 * @param {string} url
 * @param {{spawnImpl?: typeof spawn, platform?: NodeJS.Platform}} [options]
 * @returns {boolean} 是否成功发起打开动作
 */
export function openExternalUrl(url, options = {}) {
  const spawnImpl = options.spawnImpl ?? spawn
  const platform = options.platform ?? process.platform
  try {
    // Windows 不走 `cmd /c start`：授权链接里的 `&` 会被 cmd 当命令分隔符截断。
    // rundll32 直接把 URL 交给 ShellExecute，参数不经过 shell 解析。
    const command = platform === 'win32' ? 'rundll32.exe' : platform === 'darwin' ? 'open' : 'xdg-open'
    const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url]
    const child = spawnImpl(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on?.('error', () => {})
    child.unref?.()
    return true
  } catch {
    return false
  }
}

/**
 * 登录会话管理器：发起授权、后台轮询、写回凭证。
 * 同一时间只保留一个活跃会话；重复调用 start() 会复用尚未超时的会话。
 */
export class QoderLoginManager {
  /**
   * @param {{
   *   auth?: {reload?: Function, status?: Function, credentialPath?: string, region?: string},
   *   credentialPath?: string,
   *   region?: string,
   *   clientId?: string,
   *   fetchImpl?: typeof fetch,
   *   logger?: {info?: Function, warn?: Function, error?: Function},
   *   now?: () => number,
   *   pollIntervalMs?: number,
   *   timeoutMs?: number,
   *   openBrowser?: boolean,
   *   browserOpener?: (url: string) => boolean,
   * }} [options]
   */
  constructor(options = {}) {
    this.auth = options.auth
    this.credentialPath = options.credentialPath ?? options.auth?.credentialPath ?? defaultCredentialPath()
    this.requestedRegion = options.region
    this.region = normalizeRegion(options.region ?? options.auth?.region)
    this.clientId = options.clientId ?? DEFAULT_CLIENT_ID
    this.fetchImpl = options.fetchImpl ?? fetch
    this.logger = options.logger ?? console
    this.now = options.now ?? Date.now
    this.pollIntervalMs = Number.isFinite(options.pollIntervalMs) ? options.pollIntervalMs : 2000
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 10 * 60 * 1000
    this.openBrowser = options.openBrowser !== false
    this.browserOpener = options.browserOpener ?? openExternalUrl
    /** @type {Map<string, Record<string, any>>} */
    this.sessions = new Map()
    this.currentId = undefined
  }

  /** 当前登录态（用于 /healthz 与命令提示）。 */
  authStatus() {
    try {
      return this.auth?.status?.() ?? { hasAccount: false }
    } catch {
      return { hasAccount: false }
    }
  }

  /**
   * 发起登录；已有未超时的活跃会话时复用。
   * @param {{region?: string}} [options]
   * @returns {Record<string, any>} 公开会话信息
   */
  start(options = {}) {
    const existing = this.currentId ? this.sessions.get(this.currentId) : undefined
    if (existing && existing.status === 'pending' && existing.expiresAt > this.now()) {
      if (this.openBrowser) this.browserOpener(existing.request.authUrl)
      return this.publicSession(existing)
    }
    const request = createLoginRequest({
      // 未显式配置 region 时，优先沿用凭证文件里检测到的地域（global / cn）。
      region: options.region ?? this.requestedRegion ?? this.authStatus().region ?? this.region,
      clientId: this.clientId,
      now: this.now,
    })
    const session = {
      id: request.nonce,
      request,
      status: 'pending',
      createdAt: this.now(),
      expiresAt: this.now() + this.timeoutMs,
      finishedAt: undefined,
      userName: undefined,
      error: undefined,
      account: undefined,
      controller: new AbortController(),
    }
    this.sessions.set(session.id, session)
    this.currentId = session.id
    if (this.openBrowser) this.browserOpener(request.authUrl)
    void this.runPolling(session)
    this.logger.info?.(`[dsh-qwencode] 已发起 Qwen Code 登录（region=${request.region}）`)
    return this.publicSession(session)
  }

  /**
   * 查询会话状态；不传 id 时查最近一次。
   * @param {string} [id]
   * @returns {Record<string, any>}
   */
  status(id) {
    const session = this.session(id)
    if (!session) {
      const auth = this.authStatus()
      return { status: 'idle', loggedIn: Boolean(auth.hasAccount), region: auth.region ?? this.region }
    }
    return this.publicSession(session)
  }

  /** 重新打开活跃会话的授权页。 */
  open(id) {
    const session = this.session(id)
    if (!session || session.status !== 'pending') return false
    this.browserOpener(session.request.authUrl)
    return true
  }

  /**
   * 取消登录会话。
   * @param {string} [id]
   * @returns {boolean} 是否取消了活跃会话
   */
  cancel(id) {
    const session = this.session(id)
    if (!session || session.status !== 'pending') return false
    this.settle(session, 'cancelled', '用户取消了登录')
    return true
  }

  /** 插件卸载时终止所有轮询。 */
  dispose() {
    for (const session of this.sessions.values()) {
      if (session.status === 'pending') this.settle(session, 'cancelled', '插件已卸载')
    }
  }

  /** @private 取会话；未指定 id 时取最近一次。 */
  session(id) {
    if (id) return this.sessions.get(id)
    return this.currentId ? this.sessions.get(this.currentId) : undefined
  }

  /** @private 对外公开的会话视图（不包含 verifier 等敏感值）。 */
  publicSession(session) {
    return {
      id: session.id,
      status: session.status,
      region: session.request.region,
      authUrl: session.request.authUrl,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      finishedAt: session.finishedAt,
      userName: session.userName,
      error: session.error,
      loggedIn: Boolean(this.authStatus().hasAccount),
    }
  }

  /** @private 结算会话并唤醒等待者。 */
  settle(session, status, error, account) {
    if (session.status !== 'pending') return
    session.status = status
    session.error = error
    session.account = account
    session.finishedAt = this.now()
    session.userName = account?.userName ?? session.userName
    try {
      session.controller.abort()
    } catch {
      // 忽略。
    }
    const finalStatus = status === 'success' ? 'success' : status
    this.logger.info?.(
      `[dsh-qwencode] Qwen Code 登录会话结束：${finalStatus}${error ? `：${error}` : ''}`,
    )
  }

  /** @private 后台轮询直到成功 / 超时 / 取消。 */
  async runPolling(session) {
    while (session.status === 'pending') {
      if (this.now() >= session.expiresAt) {
        this.settle(session, 'expired', '登录等待超时，请重新运行 /qwen-login')
        return
      }
      await sleep(this.pollIntervalMs, session.controller.signal)
      if (session.status !== 'pending') return
      let result
      try {
        result = await pollLoginOnce(session.request, {
          fetchImpl: this.fetchImpl,
          signal: session.controller.signal,
          timeoutMs: 15_000,
          now: this.now,
        })
      } catch (error) {
        if (session.controller.signal.aborted) return
        // 网络抖动不终止登录：继续轮询直到超时。
        this.logger.warn?.(`[dsh-qwencode] Qoder 登录轮询失败，稍后重试：${sanitizeDetail(String(error?.message ?? error))}`)
        continue
      }
      if (result.status !== 'success') continue
      try {
        let profile
        try {
          profile = await fetchQoderUserInfo(result.token.accessToken, {
            region: session.request.region,
            fetchImpl: this.fetchImpl,
            signal: session.controller.signal,
            timeoutMs: 15_000,
          })
        } catch {
          // 用户信息只是锦上添花，失败不影响登录。
        }
        const account = writeLoginCredentials({
          credentialPath: this.credentialPath,
          region: session.request.region,
          token: result.token,
          profile,
          now: this.now(),
        })
        this.region = session.request.region
        this.auth?.reload?.()
        this.settle(session, 'success', undefined, account)
      } catch (error) {
        this.settle(session, 'error', error instanceof Error ? error.message : String(error))
      }
      return
    }
  }
}
