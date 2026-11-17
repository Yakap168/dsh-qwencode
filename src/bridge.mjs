/**
 * dsh-qwencode 本地桥接服务。
 *
 * DSH 的 llm-pi-ai provider（api: openai-responses）把请求发到本服务的
 * /v1/responses；本服务补上 Qoder 网关要求的 query 参数（AgentId）、
 * metadata.session_type、Cosy-* 头与动态 access token，再把标准
 * OpenAI Responses 的 SSE 原样回传。
 *
 * 因此 DSH 侧的工具调用、skill、文件读写等全部由 DSH 自己执行，
 * 本服务只做协议/鉴权适配，不实现任何 agent 逻辑。
 */
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { QoderAuth, QoderAuthError, normalizeRegion, regionEndpoints } from './qoder-auth.mjs'
import { VERSION } from './version.mjs'

/** 与 Qwen Code 模型目录一致的默认模型清单（可在插件 config 中覆盖）。 */
export const DEFAULT_MODELS = [
  {
    id: 'qmodel_latest',
    name: 'Qwen4-Max',
    contextWindow: 1000000,
    maxTokens: 128000,
    input: ['text', 'image'],
    reasoningEfforts: { 'off': 'none', low: 'low', high: 'high', xhigh: 'xhigh' },
    description: 'Qwen4-Max（Qoder 计划内模型）',
  },
  {
    id: 'qmodel_latest_preview',
    name: 'Qwen4-Max-Preview',
    contextWindow: 1000000,
    maxTokens: 128000,
    input: ['text', 'image'],
    reasoningEfforts: { 'off': 'none', low: 'low', high: 'high', xhigh: 'xhigh' },
    description: 'Qwen4-Max 预览版',
  },
  {
    id: 'qmodel_38max',
    name: 'Qwen3.8-Max',
    // Qoder 目录的 max_input_tokens 为 180000；context_config 里的 1M 是账号
    // 预设，不是模型本身的输入上限。保守取 180000，避免 DSH 按 1M 压缩。
    contextWindow: 180000,
    maxTokens: 128000,
    input: ['text', 'image'],
    reasoningEfforts: { 'off': 'none', low: 'low', medium: 'medium', xhigh: 'xhigh' },
    description: 'Qwen3.8-Max',
  },
  {
    id: 'qfmodel',
    name: 'Qwen3.8-Flash',
    // 同 qmodel_38max：目录 max_input_tokens=180000。
    contextWindow: 180000,
    maxTokens: 128000,
    input: ['text', 'image'],
    reasoningEfforts: { 'off': 'none', low: 'low', medium: 'medium', xhigh: 'xhigh' },
    description: 'Qwen3.8-Flash（免费额度模型）',
  },
]

/** 桥接服务默认配置。 */
export const DEFAULT_CONFIG = {
  host: '127.0.0.1',
  port: 45917,
  region: undefined,
  credentialPath: undefined,
  gatewayBaseUrl: undefined,
  agentId: 'agent_common',
  sessionType: 'qcode',
  clientType: '13',
  clientVersion: '1.0.0-preview.2',
  autoConfirmPaid: false,
  maxBodyBytes: 128 * 1024 * 1024,
  upstreamIdleTimeoutMs: 600_000,
  /**
   * DSH 把「off」翻译成省略 reasoning 字段（见 dsh-llm-pi-ai 的 profileOptions），
   * 而 Qwen 的默认是开启思考。插件配置了默认档位时，把「省略」翻译成
   * reasoning.effort="none"，off 才真正关掉思考。默认关闭，避免影响直接调用者。
   */
  missingReasoningMeansOff: false,
  models: DEFAULT_MODELS,
}

/** 上游错误体里可能出现的"付费确认"标记。 */
const PAID_CONFIRM_SUBCODE = 'MODEL_PAID_CONFIRM_REQUIRED'

/**
 * 把 DSH（pi-ai）发来的 OpenAI Responses 请求体改写成 Qoder 网关可接受的形式。
 * 规则对齐 qwen-code 内部对 responses body 的清洗逻辑。
 * @param {Record<string, any>} body
 * @param {{sessionType?: string}} [options]
 * @returns {Record<string, any>}
 */
export function buildUpstreamPayload(body, options = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('请求体必须是 JSON 对象')
  }
  const payload = { ...body }
  // Qoder 网关要求流式且不落库。
  payload.stream = true
  payload.store = false
  // 这些字段上游不接受或会改变语义（与 qwen-code 的清洗一致）。
  delete payload.prompt_cache_key
  delete payload.prompt_cache_options
  delete payload.temperature
  delete payload.top_p
  delete payload.service_tier
  delete payload.previous_response_id
  if (payload.truncation === 'auto') delete payload.truncation
  if (Array.isArray(payload.include)) {
    const kept = payload.include.filter((item) => item === 'reasoning.encrypted_content')
    if (kept.length > 0) payload.include = kept
    else delete payload.include
  }
  if (payload.text && typeof payload.text === 'object') {
    const text = { ...payload.text }
    delete text.verbosity
    if (Object.keys(text).length > 0) payload.text = text
    else delete payload.text
  }
  if (payload.reasoning && typeof payload.reasoning === 'object') {
    const reasoning = { ...payload.reasoning }
    delete reasoning.summary
    // DSH 的档位 id 叫 off，真正发给 Qwen 的值是 none。
    if (reasoning.effort === 'off') reasoning.effort = 'none'
    if (Object.keys(reasoning).length > 0) payload.reasoning = reasoning
    else delete payload.reasoning
  }
  // DSH 的 off 会被适配器翻译成「不带 reasoning 字段」。Qwen 自己默认开思考，
  // 所以只省略字段并不会关掉它；插件启用该选项时补一个 none，off 才生效。
  if (options.missingReasoningMeansOff === true && payload.reasoning === undefined) {
    payload.reasoning = { effort: 'none' }
  }
  // Qoder 网关不接受 input 里 role=system 的消息（要求放 instructions），
  // 但接受 developer 角色；pi-ai 在 supportsDeveloperRole 时用 developer，
  // 这里再兜底把 system 改成 developer，避免 400 "Use instructions"。
  if (Array.isArray(payload.input)) {
    payload.input = payload.input.map((item) => (
      item && typeof item === 'object' && !Array.isArray(item) && item.role === 'system'
        ? { ...item, role: 'developer' }
        : item
    ))
  }
  // Qoder 网关必填：metadata.session_type。
  const sessionType = options.sessionType ?? DEFAULT_CONFIG.sessionType
  const metadata = payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
    ? { ...payload.metadata }
    : {}
  if (sessionType) metadata.session_type = sessionType
  if (Object.keys(metadata).length > 0) payload.metadata = metadata
  else delete payload.metadata
  return payload
}

/** 从请求体推导稳定的上游 session id（用于日志关联/前缀缓存），否则随机。 */
function deriveSessionId(body) {
  const seed = typeof body?.prompt_cache_key === 'string' && body.prompt_cache_key.trim()
    ? body.prompt_cache_key.trim()
    : typeof body?.metadata?.session_id === 'string' ? body.metadata.session_id.trim() : ''
  if (!seed) return randomUUID()
  const hex = createHash('sha256').update(seed).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** 读取请求体，限制最大字节数。 */
function readRequestBody(req, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBodyBytes) {
        reject(Object.assign(new Error(`请求体超过上限 ${maxBodyBytes} 字节`), { statusCode: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 统一 JSON 响应。 */
function sendJson(res, status, value) {
  const text = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

/** 构造 OpenAI 风格错误体，便于 pi-ai 解析出可读错误。 */
function sendError(res, status, message, extra = {}) {
  sendJson(res, status, {
    error: {
      message,
      type: extra.type ?? 'qoder_bridge_error',
      code: extra.code ?? undefined,
      param: extra.param ?? undefined,
    },
  })
}

/** 统计子串出现次数（用于观察思考增量事件数量）。 */
function countOccurrences(text, needle) {
  if (!text) return 0
  let count = 0
  let index = 0
  for (;;) {
    index = text.indexOf(needle, index)
    if (index < 0) return count
    count += 1
    index += needle.length
  }
}

/** 尝试从上游响应体里提取可读错误信息。 */
function describeUpstreamError(status, text) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return { message: text.trim() || `Qoder 网关返回 HTTP ${status}`, code: undefined, subCode: undefined, raw: undefined }
  }
  const error = body?.error && typeof body.error === 'object' ? body.error : body
  const message = typeof error?.message === 'string' && error.message.trim()
    ? error.message.trim()
    : typeof body?.message === 'string' && body.message.trim() ? body.message.trim() : `Qoder 网关返回 HTTP ${status}`
  return {
    message,
    code: typeof error?.code === 'string' ? error.code : undefined,
    subCode: typeof error?.subCode === 'string' ? error.subCode : undefined,
    param: typeof error?.param === 'string' ? error.param : undefined,
    raw: body,
  }
}

/**
 * 创建桥接服务。
 * @param {Partial<typeof DEFAULT_CONFIG> & {
 *   credentialPath?: string,
 *   fetchImpl?: typeof fetch,
 *   logger?: {info?: Function, warn?: Function, error?: Function},
 *   auth?: QoderAuth,
 * }} [userConfig]
 */
export function createBridge(userConfig = {}) {
  const config = { ...DEFAULT_CONFIG, ...userConfig }
  const logger = config.logger ?? console
  const region = normalizeRegion(config.region)
  const endpoints = regionEndpoints(region)
  const gatewayBaseUrl = String(config.gatewayBaseUrl ?? endpoints.gatewayBaseUrl).replace(/\/+$/, '')
  // 供 index.js / selftest 复用同一个规范化后的上游地址（config 是副本，
  // 不把 undefined 或结尾斜杠传给目录请求）。
  config.gatewayBaseUrl = gatewayBaseUrl
  const auth = config.auth ?? new QoderAuth({
    credentialPath: config.credentialPath,
    region,
    logger,
    fetchImpl: config.fetchImpl,
  })

  /** @type {import('node:http').Server | undefined} */
  let server
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set()
  let startedAt
  const stats = {
    startedAt: null,
    responseRequests: 0,
    successRequests: 0,
    failedRequests: 0,
    upstream401Retries: 0,
    paidConfirmRetries: 0,
    lastRequestAt: null,
    lastUpstreamStatus: null,
    lastTraceId: null,
    lastError: null,
    lastModel: null,
    lastReasoningEffort: null,
    lastReasoningDeltas: null,
    lastToolsCount: null,
  }
  const recentLog = []

  function log(level, message, extra) {
    const entry = { at: new Date().toISOString(), level, message, ...(extra ? { extra } : {}) }
    recentLog.push(entry)
    if (recentLog.length > 200) recentLog.shift()
    const target = level === 'error' ? logger.error : level === 'warn' ? logger.warn : logger.info
    target?.(`[dsh-qwencode] ${message}${extra ? ` ${JSON.stringify(extra)}` : ''}`)
  }

  function upstreamUrl() {
    const query = new URLSearchParams({ AgentId: config.agentId })
    return `${gatewayBaseUrl}/api/v1/responses?${query.toString()}`
  }

  function upstreamHeaders(token, body, requestId, sessionId, forcePaidConfirmation = false) {
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'Cosy-ClientType': String(config.clientType),
      'Cosy-Version': String(config.clientVersion),
      'X-Request-Id': requestId,
      'X-Session-Id': sessionId,
      'X-Request-Set-Id': randomUUID(),
    }
    if (forcePaidConfirmation) headers['Cosy-Paid-Confirmed'] = 'true'
    void body
    return headers
  }

  /** 当前使用的模型表：优先目录/配置，否则内置表。 */
  function currentModels() {
    return Array.isArray(config.models) && config.models.length > 0 ? config.models : DEFAULT_MODELS
  }

  async function handleModels(res) {
    const models = currentModels()
    sendJson(res, 200, {
      object: 'list',
      data: models.map((model) => ({
        id: model.id,
        object: 'model',
        created: 0,
        owned_by: 'qwen-code',
        display_name: model.name,
        context_length: model.contextWindow,
        max_output_tokens: model.maxTokens,
        modalities: { input: model.input ?? ['text'], output: ['text'] },
        reasoning: Boolean(model.reasoningEfforts && Object.keys(model.reasoningEfforts).length > 0),
        supported_reasoning_levels: model.reasoningEfforts
          ? Object.entries(model.reasoningEfforts).map(([level, effort]) => ({ level, effort }))
          : [],
      })),
    })
  }

  function handleHealth(res) {
    sendJson(res, 200, {
      ok: true,
      service: 'dsh-qwencode-bridge',
      version: VERSION,
      host: config.host,
      port: config.port,
      gatewayBaseUrl,
      region: auth.region,
      agentId: config.agentId,
      modelCount: currentModels().length,
      models: currentModels().map((model) => model.id),
      auth: auth.status(),
      stats: { ...stats, uptimeMs: startedAt ? Date.now() - startedAt : 0 },
      recentLog: recentLog.slice(-20),
    })
  }

  /** 把上游 SSE 原样转发给 DSH 侧。 */
  async function relaySse(upstream, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...(stats.lastTraceId ? { 'X-Qwencode-Trace-Id': stats.lastTraceId } : {}),
    })
    if (typeof res.flushHeaders === 'function') res.flushHeaders()
    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    let reasoningDeltas = 0
    let idleTimer
    let closed = false
    const armIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        if (closed) return
        log('warn', `上游流空转超过 ${config.upstreamIdleTimeoutMs}ms，主动中断`)
        closed = true
        reader.cancel().catch(() => {})
        res.destroy(new Error('上游流空闲超时'))
      }, config.upstreamIdleTimeoutMs)
      idleTimer.unref?.()
    }
    try {
      armIdleTimer()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (closed) break
        armIdleTimer()
        const text = decoder.decode(value, { stream: true })
        reasoningDeltas += countOccurrences(text, 'response.reasoning_text.delta')
        res.write(Buffer.from(value))
      }
      if (!closed) {
        res.end()
      }
      stats.lastReasoningDeltas = reasoningDeltas
      log('info', `推理流结束：思考增量事件 ${reasoningDeltas} 个`, { traceId: stats.lastTraceId })
    } finally {
      if (idleTimer) clearTimeout(idleTimer)
      reader.releaseLock?.()
    }
  }

  /** 转发一次推理请求。 */
  async function forwardInference(payload, { res, req, sessionId, requestId, forcePaidConfirmation = false, retriedAuth = false }) {
    let token
    try {
      token = await auth.getAccessToken({ forceRefresh: retriedAuth })
    } catch (error) {
      stats.failedRequests += 1
      stats.lastError = error instanceof Error ? error.message : String(error)
      const message = error instanceof QoderAuthError
        ? error.message
        : `获取 Qoder 凭证失败：${error?.message ?? error}`
      sendError(res, 401, message, { code: error instanceof QoderAuthError ? error.code : 'auth_failed' })
      return
    }
    const controller = new AbortController()
    const onClose = () => {
      if (!res.writableEnded) controller.abort(new Error('客户端已断开'))
    }
    res.on('close', onClose)
    try {
      const upstream = await fetch(upstreamUrl(), {
        method: 'POST',
        headers: upstreamHeaders(token, payload, requestId, sessionId, forcePaidConfirmation),
        body: JSON.stringify(payload),
        signal: controller.signal,
        redirect: 'follow',
      })
      stats.lastUpstreamStatus = upstream.status
      stats.lastTraceId = upstream.headers.get('sw-trace-id') ?? upstream.headers.get('x-request-id') ?? null
      if (upstream.status === 401 && !retriedAuth) {
        stats.upstream401Retries += 1
        stats.lastError = 'upstream 401，尝试刷新 token 后重试'
        log('warn', '上游返回 401，强制刷新 token 后重试一次')
        try {
          await upstream.body?.cancel().catch(() => {})
        } catch {
          // 忽略
        }
        return forwardInference(payload, { res, req, sessionId, requestId: randomUUID(), retriedAuth: true, forcePaidConfirmation })
      }
      if (!upstream.ok) {
        const text = await upstream.text().catch(() => '')
        const detail = describeUpstreamError(upstream.status, text)
        if (detail.subCode === PAID_CONFIRM_SUBCODE && config.autoConfirmPaid !== true && !forcePaidConfirmation) {
          stats.lastError = 'MODEL_PAID_CONFIRM_REQUIRED'
          sendError(
            res,
            402,
            `模型 ${payload.model} 需要付费确认（MODEL_PAID_CONFIRM_REQUIRED）：该模型会消耗付费额度，DSH 插件默认不自动确认。`
              + '请换用免费模型（qfmodel）或自行调整插件配置 autoConfirmPaid。',
            { code: detail.code ?? 'model_paid_confirm_required', type: 'model_paid_confirm_required', param: detail.param },
          )
          stats.failedRequests += 1
          return
        }
        if (detail.subCode === PAID_CONFIRM_SUBCODE && config.autoConfirmPaid === true && !forcePaidConfirmation) {
          stats.paidConfirmRetries += 1
          log('warn', '上游要求付费确认，autoConfirmPaid=true，附带 Cosy-Paid-Confirmed 重试一次')
          try {
            await upstream.body?.cancel().catch(() => {})
          } catch {
            // 忽略
          }
          return forwardInference(payload, { res, req, sessionId, requestId: randomUUID(), forcePaidConfirmation: true })
        }
        stats.failedRequests += 1
        stats.lastError = `上游 HTTP ${upstream.status}: ${detail.message}`
        log('error', `上游推理失败 HTTP ${upstream.status}`, {
          code: detail.code,
          subCode: detail.subCode,
          message: detail.message,
          traceId: stats.lastTraceId,
        })
        sendError(res, upstream.status >= 500 ? 502 : 400, `Qoder 推理失败：${detail.message}`, {
          type: 'qoder_upstream_error',
          code: detail.code,
          param: detail.param,
        })
        return
      }
      stats.successRequests += 1
      await relaySse(upstream, res)
    } catch (error) {
      if (res.headersSent) {
        res.destroy()
        return
      }
      stats.failedRequests += 1
      stats.lastError = error instanceof Error ? error.message : String(error)
      sendError(res, controller.signal.aborted ? 499 : 502, `Qoder 桥接请求失败：${stats.lastError}`, {
        type: 'qoder_bridge_error',
      })
    } finally {
      res.off('close', onClose)
    }
  }

  async function handleResponses(req, res) {
    stats.responseRequests += 1
    stats.lastRequestAt = new Date().toISOString()
    let raw
    try {
      raw = await readRequestBody(req, config.maxBodyBytes)
    } catch (error) {
      sendError(res, error?.statusCode ?? 400, `读取请求体失败：${error?.message ?? error}`)
      return
    }
    let body
    try {
      body = raw.trim() ? JSON.parse(raw) : {}
    } catch (error) {
      sendError(res, 400, `请求体不是合法 JSON：${error?.message ?? error}`)
      return
    }
    let payload
    try {
      payload = buildUpstreamPayload(body, {
        sessionType: config.sessionType,
        missingReasoningMeansOff: config.missingReasoningMeansOff,
      })
    } catch (error) {
      sendError(res, 400, error?.message ?? String(error))
      return
    }
    if (typeof payload.model !== 'string' || payload.model.length === 0) {
      sendError(res, 400, '请求体缺少 model 字段')
      return
    }
    stats.lastModel = payload.model
    stats.lastReasoningEffort = typeof payload.reasoning?.effort === 'string' ? payload.reasoning.effort : null
    stats.lastToolsCount = Array.isArray(payload.tools) ? payload.tools.length : 0
    const sessionId = deriveSessionId(body)
    const requestId = randomUUID()
    log('info', `转发推理请求 model=${payload.model}`, {
      requestId,
      sessionId,
      inputBytes: raw.length,
      reasoningEffort: stats.lastReasoningEffort ?? 'omitted',
      tools: stats.lastToolsCount,
    })
    await forwardInference(payload, { res, req, sessionId, requestId })
  }

  async function route(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    const pathname = url.pathname.replace(/\/+$/, '') || '/'
    if (req.method === 'GET' && (pathname === '/healthz' || pathname === '/health')) return handleHealth(res)
    if (req.method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) return handleModels(res)
    if (req.method === 'POST' && (pathname === '/v1/responses' || pathname === '/responses')) return handleResponses(req, res)
    if (pathname === '/' || pathname === '/v1') {
      return sendJson(res, 200, { service: 'dsh-qwencode-bridge', ok: true })
    }
    sendError(res, 404, `未知路径：${req.method} ${pathname}`, { type: 'not_found' })
  }

  return {
    config,
    auth,
    stats,
    /** 当前模型表（目录拉取成功后由 setModels 替换）。 */
    get models() {
      return currentModels()
    },
    /** 替换运行中的模型表；空数组忽略，避免目录异常时把可用模型清空。 */
    setModels(next) {
      if (!Array.isArray(next) || next.length === 0) return false
      config.models = next
      return true
    },
    get address() {
      const address = server?.address()
      return address && typeof address === 'object' ? address : undefined
    },
    get url() {
      const address = this.address
      return address ? `http://${config.host}:${address.port}` : undefined
    },
    /** 启动 HTTP 服务；端口冲突时抛出带提示的错误。 */
    async start() {
      if (server) return this.url
      server = createServer((req, res) => {
        Promise.resolve(route(req, res)).catch((error) => {
          log('error', `请求处理异常：${error?.message ?? error}`)
          if (!res.headersSent) sendError(res, 500, `桥接服务内部错误：${error?.message ?? error}`)
          else res.destroy()
        })
      })
      server.on('connection', (socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
      })
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening)
          server = undefined
          if (error?.code === 'EADDRINUSE') {
            reject(new Error(`端口 ${config.host}:${config.port} 已被占用。请修改 dsh-qwencode 插件配置里的 port，或关闭占用进程后重启 DSH。`))
          } else {
            reject(error)
          }
        }
        const onListening = () => {
          server.off('error', onError)
          startedAt = Date.now()
          stats.startedAt = new Date(startedAt).toISOString()
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(config.port, config.host)
      })
      log('info', `桥接服务已启动 ${this.url}（region=${auth.region}，上游 ${gatewayBaseUrl}）`)
      return this.url
    },
    /** 停止 HTTP 服务并断开所有连接。 */
    async stop() {
      if (!server) return
      const current = server
      server = undefined
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await new Promise((resolve) => current.close(() => resolve()))
      log('info', '桥接服务已停止')
    },
  }
}
