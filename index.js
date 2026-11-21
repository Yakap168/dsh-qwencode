/**
 * dsh-qwencode Host 插件。
 *
 * 职责：
 *   1. 在 127.0.0.1 上启动本地桥接服务（src/bridge.mjs），把 DSH 的
 *      OpenAI Responses 请求适配成 Qwen Code（Qoder 网关）可接受的请求，
 *      并负责 Qoder access token 的自动刷新；
 *   2. 通过 DSH 官方 configEditor 服务，把 provider `qwencode` 路由写进
 *      `@deepseek-ai/dsh-llm-pi-ai` 的配置，使模型出现在 DSH 模型选择器中。
 *
 * 这里不实现任何 agent 逻辑：工具调用、skill、文件读写全部由 DSH 自身完成。
 */
import { createBridge, DEFAULT_MODELS } from './src/bridge.mjs'
import { fetchModelCatalog } from './src/catalog.mjs'
import { recordDiagnostic } from './src/diagnostics.mjs'

export const name = 'dsh-qwencode'
/** 依赖 DSH 的命令注册表；桌面/Web/headless 都由 dsh-base 提供 commands。 */
export const inject = ['commands']

/** provider 路由键，模型选择器里的分组名由 provider 配置的 displayName 决定。 */
const PROVIDER_ROUTE = 'qwencode'
/** 目标 LLM 插件包名。 */
const LLM_PI_AI_NAME = '@deepseek-ai/dsh-llm-pi-ai'

/** 插件默认配置。 */
export const DEFAULT_OPTIONS = {
  /** 本地桥接服务监听端口。 */
  port: 45917,
  /** Qoder 地域：cn / global；缺省时由凭证文件推断。 */
  region: undefined,
  /** Qoder AgentId 查询参数（qwen-code 固定值）。 */
  agentId: 'agent_common',
  /** 上游 metadata.session_type（qwen-code 固定值 qcode）。 */
  sessionType: 'qcode',
  /** 伪装成 qwen CLI 的 Cosy-ClientType。 */
  clientType: '13',
  /** 伪装成 qwen CLI 的 Cosy-Version。 */
  clientVersion: '1.0.0-preview.2',
  /** 付费模型遇到 MODEL_PAID_CONFIRM_REQUIRED 时是否自动确认（会消耗付费额度，默认关闭）。 */
  autoConfirmPaid: false,
  /** 是否自动把 provider 路由写入 llm-pi-ai 配置。 */
  manageProviderConfig: true,
  /** 自定义凭证路径（默认 ~/.qwen/qoder_oauth_creds.json）。 */
  credentialPath: undefined,
  /** Qoder OAuth client_id（与 qwen-code 一致，一般不需要改）。 */
  clientId: 'ecaf4a7a-5e5b-4659-9a95-7a1570012a41',
  /** 登录会话最长等待时间（毫秒）。 */
  loginTimeoutMs: 10 * 60 * 1000,
  /** 登录轮询间隔（毫秒）。 */
  loginPollIntervalMs: 2000,
  /** 发起登录时是否自动打开系统浏览器。 */
  openBrowserOnLogin: true,
  /** 自定义模型表（数组）；缺省时用 Qoder 目录，失败回退内置表。 */
  models: undefined,
  /** 启动时是否从 Qoder 拉取实时模型目录（默认开启）。 */
  useLiveCatalog: true,
  /** 模型目录请求超时（毫秒）；超时沿用内置表，不阻塞插件启动。 */
  catalogTimeoutMs: 3000,
  /**
   * 会话未显式选择思考档位时的默认 effort。`low` 是四个模型都支持的档位；
   * 不写 `high` 是因为 Qwen3.8 系列不支持 high（会把会话卡在 UNSUPPORTED_REASONING_EFFORT）。
   * 设为空字符串/删除可回到 Qwen 各模型自己的默认档位，但此时 DSH 的 off 无法关闭思考
   * （DSH 用「省略 reasoning」表示 off，Qwen 的默认是开启）。
   */
  defaultReasoningEffort: 'low',
}

/**
 * 生成 provider 在 llm-pi-ai 配置中的完整声明。
 * 注意：`headers.Authorization` 只是为了让 pi-ai 认为路由已有鉴权头（它会用
 * "unused" 作为 apiKey）；本地桥接服务会忽略该值，真正鉴权发生在桥上。
 * @param {number} port
 * @param {Array<Record<string, any>>} [models] 当前模型表
 * @param {{defaultReasoningEffort?: string}} [options]
 * @returns {Record<string, unknown>}
 */
export function desiredProviderConfig(port, models = DEFAULT_MODELS, options = {}) {
  const provider = {
    displayName: 'Qwen Code · 免费额度',
    api: 'openai-responses',
    baseURL: `http://127.0.0.1:${port}/v1`,
    headers: {
      Authorization: 'Bearer dsh-qwencode-local-bridge',
    },
    streamIdleTimeoutMs: 600_000,
    models: models.map((model) => {
      const efforts = model.reasoningEfforts && typeof model.reasoningEfforts === 'object'
        ? { ...model.reasoningEfforts }
        : {}
      const entry = {
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        input: Array.isArray(model.input) && model.input.length > 0 ? [...model.input] : ['text'],
      }
      // DSH 的配置 schema 拒绝“只有 off”或空的 reasoningEfforts：
      // 没有至少一个真实档位时整段省略，模型按非推理模型注册。
      if (Object.keys(efforts).some((level) => level !== 'off')) entry.reasoningEfforts = efforts
      return entry
    }),
  }
  // 不写死全局默认档位：Qwen 各模型的默认 effort 不同（latest=high，
  // 3.8 系列=medium），写死 high 会让 qmodel_38max/qfmodel 收到不支持的档位。
  // 需要强制默认时由用户显式配置 defaultReasoningEffort。
  const defaultEffort = options?.defaultReasoningEffort
  if (typeof defaultEffort === 'string' && defaultEffort.length > 0) provider.reasoning = defaultEffort
  return provider
}

/** 判断两个 JSON 值是否深度相等（配置里只有普通 JSON 类型）。 */
function deepEqual(left, right) {
  if (left === right) return true
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]))
}

/** 给用户看的"手工配置"提示（configEditor 不可用时）。 */
function manualConfigHint(port, models = DEFAULT_MODELS, defaultReasoningEffort) {
  const lines = [
    '请手动把下面的 provider 路由加入 @deepseek-ai/dsh-llm-pi-ai 的 config.providers：',
    `  ${PROVIDER_ROUTE}:`,
    '    displayName: Qwen Code · 免费额度',
    '    api: openai-responses',
    `    baseURL: http://127.0.0.1:${port}/v1`,
    '    headers:',
    '      Authorization: Bearer dsh-qwencode-local-bridge',
  ]
  if (typeof defaultReasoningEffort === 'string' && defaultReasoningEffort.length > 0) {
    lines.push(`    reasoning: ${defaultReasoningEffort}`)
  }
  lines.push('    models:')
  for (const model of models) {
    const efforts = model.reasoningEfforts && typeof model.reasoningEfforts === 'object'
      ? model.reasoningEfforts
      : {}
    lines.push(
      `      - id: ${model.id}`,
      `        name: ${model.name}`,
      `        contextWindow: ${model.contextWindow}`,
      `        maxTokens: ${model.maxTokens}`,
      `        input: [${(model.input ?? ['text']).join(', ')}]`,
    )
    if (Object.keys(efforts).some((level) => level !== 'off')) {
      lines.push(
        '        reasoningEfforts:',
        ...Object.entries(efforts).map(([level, wire]) => `          "${level}": ${wire}`),
      )
    }
  }
  return lines.join('\n')
}

/**
 * 确保 llm-pi-ai 里存在（且内容匹配）qwencode provider 路由。
 * @returns {Promise<{ status: 'updated' | 'unchanged' | 'retry' | 'unavailable', detail: Record<string, unknown> }>}
 */
async function ensureProviderRoute(ctx, options, models = DEFAULT_MODELS) {
  const editor = ctx.get('configEditor')
  if (editor === undefined) return { status: 'unavailable', detail: { reason: 'configEditor 服务不可用' } }
  const entries = editor.entries()
  const target = entries.find((entry) => entry.options.name === LLM_PI_AI_NAME || entry.options.name?.includes('dsh-llm-pi-ai'))
  if (target === undefined) {
    return { status: 'unavailable', detail: { reason: '未找到 llm-pi-ai 配置行', entryNames: entries.map((entry) => entry.options.name) } }
  }
  const desired = desiredProviderConfig(options.port, models, { defaultReasoningEffort: options.defaultReasoningEffort })
  const currentProviders = target.options.config?.providers && typeof target.options.config.providers === 'object'
    ? target.options.config.providers
    : {}
  if (deepEqual(currentProviders[PROVIDER_ROUTE], desired)) {
    return { status: 'unchanged', detail: { entryId: target.options.id } }
  }
  try {
    await editor.edit(target, (current) => ({
      ...current,
      providers: {
        ...(current.providers && typeof current.providers === 'object' ? current.providers : {}),
        [PROVIDER_ROUTE]: desired,
      },
    }))
    return { status: 'updated', detail: { entryId: target.options.id } }
  } catch (error) {
    return {
      status: 'retry',
      detail: {
        entryId: target.options.id,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        currentProviderKeys: Object.keys(currentProviders),
      },
    }
  }
}

/**
 * 在 HMR 事务的 AsyncLocalStorage 之外安排一次延时任务。
 *
 * 插件 apply 发生在 HMR 事务内，因此从这里 `setTimeout` 的回调会继承
 * HMR 的 AsyncLocalStorage 标记；回调里再调用 `configEditor.edit()`（其内部
 * 走 `hmr.runExclusive`）会报 "HMR transactions cannot be nested"。
 * 这里借用 hmr 服务自身的 `executing.exit()` 创建一个不带该标记的异步上下文。
 * 拿不到内部字段时退回普通定时器（headless profile 没有 HMR，本来也不冲突）。
 */
function scheduleOutsideHmr(ctx, callback, delay) {
  const hmr = ctx.get('hmr')
  const schedule = () => setTimeout(callback, delay)
  if (hmr && hmr.executing && typeof hmr.executing.exit === 'function') {
    try {
      hmr.executing.exit(schedule)
      return
    } catch {
      // 内部 API 形状变化时退回普通定时器。
    }
  }
  schedule()
}

/**
 * 在 Loader 稳定后写入 provider 配置；失败时按次数退避重试。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {typeof DEFAULT_OPTIONS} options
 */
function scheduleProviderRoute(ctx, options, getModels = () => DEFAULT_MODELS) {
  if (options.manageProviderConfig === false) {
    ctx.logger?.info?.('[dsh-qwencode] manageProviderConfig=false，跳过自动写入 provider 配置')
    return () => {}
  }
  let cancelled = false
  const attempts = [1200, 1800, 2500, 3500, 5000, 7000]
  const attempt = async (index) => {
    if (cancelled) return
    let result
    try {
      result = await ensureProviderRoute(ctx, options, getModels())
    } catch (error) {
      result = { status: 'retry', detail: { error: error instanceof Error ? error.message : String(error) } }
    }
    if (cancelled) return
    recordDiagnostic({ attempt: index, port: options.port, ...result })
    if (result.status === 'updated' || result.status === 'unchanged') {
      const count = getModels().length
      ctx.logger?.info?.(
        result.status === 'updated'
          ? `[dsh-qwencode] 已写入 llm-pi-ai provider 路由 "${PROVIDER_ROUTE}"（端口 ${options.port}，${count} 个模型）`
          : `[dsh-qwencode] provider 路由 "${PROVIDER_ROUTE}" 已是最新（${count} 个模型）`,
      )
      return
    }
    if (result.status === 'unavailable') {
      ctx.logger?.warn?.(
        `[dsh-qwencode] 找不到 configEditor 或 llm-pi-ai 插件行，无法自动注册模型。\n${manualConfigHint(options.port, getModels(), options.defaultReasoningEffort)}`,
      )
      return
    }
    if (index + 1 >= attempts.length) {
      ctx.logger?.warn?.(
        `[dsh-qwencode] 自动写入 provider 配置多次失败，请手动处理。\n${manualConfigHint(options.port, getModels(), options.defaultReasoningEffort)}`,
      )
      return
    }
    scheduleOutsideHmr(ctx, () => void attempt(index + 1), attempts[index + 1])
  }
  scheduleOutsideHmr(ctx, () => void attempt(0), attempts[0])
  return () => {
    cancelled = true
  }
}

/**
 * 注册 `/qwen-login` 斜杠命令。
 *
 * DSH 的 commands 服务由 dsh-base 提供，模块级 inject 保证 apply 前已就绪；
 * 这里仍做防御性检查，服务缺失时只跳过命令注册，桥接服务不受影响。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<typeof createBridge>} bridge
 * @param {{warn?: Function}} logger
 * @returns {() => void} 注销函数
 */
export function registerQwenLoginCommand(ctx, bridge, logger) {
  // 优先走注入后的 ctx.commands 属性（与官方 dsh-command-* 一致）；
  // 测试/旧 Cordis 环境退回 ctx.get。
  const commands = ctx.commands ?? ctx.get('commands')
  if (!commands || typeof commands.register !== 'function') {
    logger.warn?.('[dsh-qwencode] commands 服务不可用，/qwen-login 命令未注册；仍可通过 /login/* HTTP 端点登录')
    return () => {}
  }
  // 插件卸载/HMR 重载时置位，让仍在等待的 handler 尽快退出。
  let disposed = false
  const formatTime = (value) => {
    if (!Number.isFinite(value)) return '未知'
    try {
      return new Date(value).toLocaleString('zh-CN', { hour12: false })
    } catch {
      return new Date(value).toISOString()
    }
  }
  const statusText = () => {
    const auth = bridge.auth.status()
    if (!auth.hasAccount) {
      return '❌ 还没有 Qwen Code 登录凭证。\n运行 /qwen-login 打开浏览器完成登录（免费额度需要 Qoder 账号）。'
    }
    return [
      '✅ 已登录 Qwen Code',
      `账号：${auth.userName || '未知'}`,
      `Region：${auth.region}`,
      `Access Token 到期：${formatTime(auth.accessTokenExpiresAt)}`,
      '',
      '要切换账号或重新登录，运行 /qwen-login relogin。',
    ].join('\n')
  }
  const waitForLogin = async (session, signal) => {
    const deadline = Date.now() + 120_000
    while (!disposed && Date.now() < deadline) {
      if (signal?.aborted) {
        bridge.login.cancel(session.id)
        return { kind: 'error', text: '登录等待已取消。' }
      }
      const status = bridge.login.status(session.id)
      if (status.status === 'success') {
        return {
          kind: 'success',
          text: [
            `✅ 登录成功：${status.userName || 'Qwen 用户'}`,
            `凭证已写入 ${bridge.login.credentialPath}`,
            '现在可以在模型选择器里使用「Qwen Code · 免费额度」了。',
          ].join('\n'),
        }
      }
      if (status.status === 'error') return { kind: 'error', text: `❌ 登录失败：${status.error ?? '未知错误'}` }
      if (status.status === 'expired') return { kind: 'error', text: '⌛ 登录等待超时，请重新运行 /qwen-login。' }
      if (status.status === 'cancelled') return { kind: 'error', text: '登录已取消。' }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    if (disposed) return { kind: 'error', text: '插件已卸载，登录等待已停止（后台登录会话已取消）。' }
    return {
      kind: 'error',
      text: [
        '⌛ 还没有检测到授权完成（浏览器页面可能还开着）。',
        `授权链接：${session.authUrl}`,
        '完成登录后运行 /qwen-login status 查看结果；需要重新打开授权页可运行 /qwen-login open。',
      ].join('\n'),
    }
  }
  const disposeCommand = commands.register({
    name: 'qwen-login',
    description: '登录 Qwen Code（Qoder 免费额度），或查看登录状态',
    input: { hint: '[status|relogin|open|cancel]' },
    handler: async ({ rawInput, signal }) => {
      if (disposed) return { kind: 'error', text: '插件已卸载，/qwen-login 暂不可用。' }
      const input = String(rawInput ?? '').trim().toLowerCase()
      if (input === 'status') {
        return bridge.auth.status().hasAccount
          ? { kind: 'success', text: statusText() }
          : { kind: 'error', text: statusText() }
      }
      if (input === 'cancel') {
        const cancelled = bridge.login.cancel()
        return cancelled
          ? { kind: 'success', text: '已取消进行中的 Qwen Code 登录。' }
          : { kind: 'error', text: '当前没有进行中的登录。' }
      }
      if (input === 'open') {
        const opened = bridge.login.open()
        return opened
          ? { kind: 'success', text: '已重新打开 Qwen Code 授权页。' }
          : { kind: 'error', text: '当前没有进行中的登录，请先运行 /qwen-login。' }
      }
      const force = input === 'relogin' || input === 'force'
      if (!force && bridge.auth.status().hasAccount) {
        return { kind: 'success', text: statusText() }
      }
      const session = bridge.login.start()
      const intro = [
        '🔐 已打开浏览器，请在页面中完成 Qwen Code / Qoder 登录。',
        `授权链接：${session.authUrl}`,
        '浏览器没有自动打开时，把上面的链接复制到浏览器即可。',
        '',
        '登录完成后本命令会自动返回结果（最多等待 2 分钟）…',
      ].join('\n')
      const result = await waitForLogin(session, signal)
      return result.kind === 'success' ? result : { kind: 'error', text: `${intro}\n\n${result.text}` }
    },
  })
  return () => {
    disposed = true
    // 插件卸载时中断仍在等待的 handler，并取消后台登录会话。
    bridge.login.cancel()
    disposeCommand()
  }
}

/**
 * Cordis 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Partial<typeof DEFAULT_OPTIONS>} [config]
 */
export async function apply(ctx, config) {
  const options = { ...DEFAULT_OPTIONS, ...(config ?? {}) }
  const logger = {
    info: (...parts) => ctx.logger?.info?.(...parts),
    warn: (...parts) => ctx.logger?.warn?.(...parts),
    error: (...parts) => ctx.logger?.error?.(...parts),
  }
  const bridge = createBridge({
    port: options.port,
    region: options.region,
    agentId: options.agentId,
    sessionType: options.sessionType,
    clientType: options.clientType,
    clientVersion: options.clientVersion,
    autoConfirmPaid: options.autoConfirmPaid,
    credentialPath: options.credentialPath,
    clientId: options.clientId,
    loginTimeoutMs: options.loginTimeoutMs,
    loginPollIntervalMs: options.loginPollIntervalMs,
    openBrowserOnLogin: options.openBrowserOnLogin,
    models: options.models,
    // 配置了默认档位时，DSH 省略 reasoning 就代表用户选了 off；桥接补 none。
    missingReasoningMeansOff: Boolean(options.defaultReasoningEffort),
    logger,
  })
  await bridge.start()
  ctx.effect(() => () => {
    void bridge.stop()
  })

  // commands 服务由模块级 inject 保证就绪后再 apply。
  const disposeLoginCommand = registerQwenLoginCommand(ctx, bridge, logger)
  ctx.effect(() => () => disposeLoginCommand())

  // 先起服务，再拉目录：目录超时/失败不阻塞插件启动，模型选择器仍可用内置表。
  // 用户显式给了 models 时以自定义表为准，不再让实时目录覆盖。
  const hasCustomModels = Array.isArray(options.models) && options.models.length > 0
  if (options.useLiveCatalog !== false && !hasCustomModels) {
    try {
      const live = await fetchModelCatalog({
        auth: bridge.auth,
        gatewayBaseUrl: bridge.config.gatewayBaseUrl,
        clientType: options.clientType,
        clientVersion: options.clientVersion,
        timeoutMs: options.catalogTimeoutMs,
        logger,
      })
      if (live.length > 0) {
        bridge.setModels(live)
        ctx.logger?.info?.(`[dsh-qwencode] 已从 Qoder 目录加载 ${live.length} 个模型：${live.map((model) => model.id).join(', ')}`)
      }
    } catch (error) {
      ctx.logger?.warn?.(
        `[dsh-qwencode] 拉取 Qoder 模型目录失败，沿用内置模型表：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const cancelProviderSync = scheduleProviderRoute(ctx, options, () => bridge.models)
  ctx.effect(() => () => cancelProviderSync())
  ctx.logger?.info?.(
    `[dsh-qwencode] 桥接服务就绪：${bridge.url}；${bridge.models.length} 个模型；Qoder 凭证 ${bridge.auth.status().hasAccount ? `已就绪（${bridge.auth.status().userName}）` : '缺失，运行 /qwen-login 登录'}`,
  )
}
