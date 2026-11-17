# Qwen Code 免费额度

把本机 **Qwen Code**（用 Qoder 账号登录的 `qwen` CLI，版本 1.0 preview 及以后）的模型额度，作为 DeepSeek Harness 的一个模型 provider（路由键 `qwencode`）接入。当前版本 **2.0.1**。

插件本身不实现 agent：工具调用、skill 读取、文件修改、子代理等全部由 DSH 原生完成；本插件只做两件事：

1. 在 `127.0.0.1:45917` 起一个本地桥接服务，把 DSH 发出的 OpenAI Responses 请求补上 Qoder 网关要求的 `AgentId` 查询参数、`metadata.session_type`、`Cosy-*` 头，并用 `~/.qwen/qoder_oauth_creds.json` 里的 Qoder OAuth 凭证鉴权；token 临近过期时自动刷新并原样写回，保证 `qwen` CLI 与 DSH 共用同一份有效凭证。
2. 通过 DSH 官方的 `configEditor` 服务，把 provider 路由写进 `@deepseek-ai/dsh-llm-pi-ai` 的配置，让模型出现在模型选择器里（可在 Models 设置里看到并继续编辑）。

## 架构

```
DSH 会话（工具 / skill / 文件 / 子代理）
          │  OpenAI Responses 协议（pi-ai）
          ▼
@deepseek-ai/dsh-llm-pi-ai  ──►  http://127.0.0.1:45917/v1
                                   （本插件桥接服务）
          │  补 AgentId / session_type / Cosy-* 头，注入 Qoder OAuth token
          ▼
https://gateway.qoder.com.cn/qsvr/api/v1/responses?AgentId=agent_common
          │  标准 Responses SSE（含 reasoning_text 思考增量、function_call 工具调用）
          ▼
Qwen4-Max / Qwen3.8-Max / Qwen3.8-Flash（账号额度由 Qwen Code 的计划决定）
```

## 前置条件

- 本机已安装并登录 Qwen Code CLI（`qwen` 命令），凭证文件 `~/.qwen/qoder_oauth_creds.json` 存在且 `accounts.cn`（或 `accounts.global`）里有 `accessToken` / `refreshToken`。
- 若凭证缺失：运行 `qwen`，在交互界面执行 `/auth` 完成 Qoder 浏览器登录，然后重启 DSH 或重载插件。

## 模型目录（随 provider 一起注册）

| 模型 id | 显示名 | 上下文 | 思考强度档位 |
|---|---|---|---|
| `qmodel_latest` | Qwen4-Max | 1M | off, low, high, xhigh |
| `qmodel_latest_preview` | Qwen4-Max-Preview | 1M | off, low, high, xhigh |
| `qmodel_38max` | Qwen3.8-Max | 180K | off, low, medium, xhigh |
| `qfmodel` | Qwen3.8-Flash | 180K | off, low, medium, xhigh |

插件启动时请求 Qoder 的 `api/v3/model/list?categories=qcode` 获取实时目录；上表是拉取失败时的内置回退。上下文取 `max_input_tokens`，因此 Qwen3.8-Max / Flash 是 180K（`context_config` 里的 1M 是账号预设，不是模型输入上限）。

思考强度直接映射到 Responses 协议的 `reasoning.effort`。每个模型的档位集合与 Qwen 模型目录的 `thinking_config` 一致，不会给出模型不支持的档位。**provider 默认档位是 `low`**：四个模型都支持它；不写 `high` 是因为 Qwen3.8 系列不支持 high，DSH 会报 `UNSUPPORTED_REASONING_EFFORT`。DSH 把 `off` 翻译成“省略 reasoning 字段”，而 Qwen 自身默认开启思考，所以桥接在启用默认档位时把“省略”补成 `reasoning.effort="none"`，`off` 才真正关闭思考（实测 0 个思考增量）；把 `defaultReasoningEffort` 设为空可回到 Qwen 各模型原生默认，但此时 `off` 无法关闭思考。已实测带 `reasoning.effort=high` 的 DSH 会话收到思考增量、并在会话日志中记录为 `reasoning` 内容块。

## 配置项（插件行 config）

| 字段 | 默认 | 说明 |
|---|---|---|
| `port` | `45917` | 本地桥接端口；修改后插件会同步更新 provider 的 baseURL。 |
| `region` | 自动 | `cn` / `global`；缺省时按凭证文件里的账号推断。 |
| `agentId` | `agent_common` | Qoder 网关 `AgentId` 查询参数（与 qwen-code 一致）。 |
| `sessionType` | `qcode` | 上游 `metadata.session_type`（与 qwen-code 一致）。 |
| `clientType` | `13` | 上游 `Cosy-ClientType` 头。 |
| `clientVersion` | `1.0.0-preview.2` | 上游 `Cosy-Version` 头。 |
| `autoConfirmPaid` | `false` | 上游返回 `MODEL_PAID_CONFIRM_REQUIRED` 时是否自动带 `Cosy-Paid-Confirmed: true` 重试（可能消耗付费额度）。默认关闭，返回可读的 402 错误。 |
| `manageProviderConfig` | `true` | 是否自动把 provider 路由写入 `llm-pi-ai` 配置。关闭后需自行在 Models 设置页添加（错误日志会打印 YAML 片段）。 |
| `credentialPath` | `~/.qwen/qoder_oauth_creds.json` | 自定义凭证路径。 |
| `useLiveCatalog` | `true` | 启动时从 Qoder 拉实时模型目录；关闭后只用内置表。 |
| `catalogTimeoutMs` | `3000` | 模型目录请求超时；失败不阻塞启动。 |
| `defaultReasoningEffort` | `low` | 全局默认档位；`low` 四个模型都支持。设为空可回到 Qwen 各模型默认，但 DSH 的 `off` 将无法关闭思考。 |
| `models` | 不设 | 自定义模型数组；设置后以它为准，不再被实时目录覆盖。 |

## 特色行为

- **实时模型目录**：启动时按 Qwen Code 的同一接口拉 `qcode` 目录，模型 id、显示名、上下文、视觉能力与 `thinking_config` 档位都以目录为准；目录失败时回退内置表，不阻塞启动。Qwen 上新模型不需要升级插件。
- **token 自动刷新并写回**：access token 到期前 5 分钟自动用 refresh token 刷新；新 token 按原文件 schema（camelCase、`version`、`accounts.<region>`、`updatedAt`）原子写回，`qwen` CLI 下次运行可直接复用。上游 401 会触发一次强制刷新后重试。刷新响应只给 `expires_in` 时按相对秒数换算，不会写成 1970 年。
- **与 qwen CLI 共存**：每次取 token 前按凭证文件 mtime/size 检测外部刷新；写回前核对 refresh_token，若已被 CLI 轮换则采用磁盘版本、不覆盖对方凭证。已实测：插件刷新写回后 `qwen -p` 仍正常；外部轮换后桥接自动采用新 token。
- **请求清洗**：按 qwen-code 的规则删除上游不接受的字段（`temperature`、`top_p`、`prompt_cache_key`、`previous_response_id` 等），强制 `stream: true`、`store: false`，并注入必填的 `metadata.session_type`。
- **思考过程可见**：Qoder 网关返回的 `response.reasoning_text.delta` 由 pi-ai 解析成 DSH 的思考块，与正常 API 模型表现一致。
- **工具调用**：`function_call` / `function_call_output` 往返、并行工具调用、多轮 agent 循环均走标准 Responses 事件，DSH 侧无需特殊处理。
- **视觉输入**：模型目录声明 `input: [text, image]`，图片按 pi-ai 的 `input_image` 编码透传。
- **错误映射**：Qoder 错误体（`invalid_request`、`TOKEN_EXPIRE` 等）会转成 DSH 可读的 `error.message`；付费确认错误单独提示，不静默扣费。
- **仅本机监听**：桥接服务只绑定 `127.0.0.1`，token 只存在于本机进程与原有凭证文件，不经过任何第三方。

## 限制

- 依赖 Qwen Code 的 Qoder 登录与账号额度；额度、限流、计费均由 Qwen 账号计划决定，插件不绕过。
- 不支持 Qwen Code 的 `--thinking auto/adaptive` 这两种"由模型决定"的模式：DSH 的模型选择器只有明确的档位，`off` 与各 effort 档位之外没有 auto；需要"让模型自己决定"时建议选 `high` 或模型默认档位。
- 自动写 provider 配置会改 profile 的 patch 文件（通过官方 configEditor 完成，等价于在 Models 页面保存一次配置）；如不希望改动，把 `manageProviderConfig` 设为 `false` 并手动配置。
- 端口被占用时插件启动失败并在日志中提示改 `port`。

## 验证

- 单元测试：`node --test "tests/*.test.mjs"`（不联网；覆盖请求清洗、目录映射、token 刷新与 provider 配置；PATH 里没有 node 时用 `& $env:DSH_NODE_EXECUTABLE --test "tests/*.test.mjs"`）。
- 健康检查：`curl http://127.0.0.1:45917/healthz`（返回版本、模型表、凭证状态、请求计数、最近日志）。
- 独立自测（不经过 DSH，直接验证桥接与真实上游）：`pwsh -File scripts\run-node.ps1 scripts\selftest.mjs`。
- DSH 内验证：新建会话选择 **Qwen Code · 免费额度** 分组下的模型，让它执行一次文件读写或 bash 命令，确认工具调用与思考过程正常。
