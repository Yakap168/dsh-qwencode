# Changelog

## 1.0.1-rc.1 — 2026-11-21

- 新增 **`/qwen-login` 插件内登录**：在 DSH 输入框直接发起 Qoder OAuth 登录，浏览器授权后自动写回凭证，不用离开 DSH，也不用在终端里运行 Qwen Code。
- 登录流程复刻 qwen-code 1.0.0-preview.2 的官方 OAuth：PKCE（`verifier`/`challenge`/`nonce`）+ `GET /api/v1/deviceToken/poll` 轮询（404 = 等待授权），成功后写 `~/.qwen/qoder_oauth_creds.json`（与 CLI 同一 schema），并调用 `QoderAuth.reload()` 热加载。
- 桥接服务新增 `/login/start`、`/login/status`、`/login/cancel` 三个本地端点，供命令、脚本和自动化使用。
- 登录子命令：`/qwen-login`、`/qwen-login status`、`/qwen-login relogin`、`/qwen-login open`、`/qwen-login cancel`。
- 新增配置项 `clientId`、`loginTimeoutMs`、`loginPollIntervalMs`、`openBrowserOnLogin`。
- 新增 19 项登录流程单元测试（PKCE、轮询、凭证写回、管理器、浏览器打开、命令 handler、桥接端点与完整成功流程、错误与超时路径）；全套 46 项测试通过。
- README 新增「🔑 插件内登录：/qwen-login」章节与排障说明。

## 1.0.0-rc.1 — 2026-11-17

首个公开发布候选（release candidate）。

- 把本机 Qwen Code（Qoder 登录）的免费额度接入 DeepSeek Harness：本地 OpenAI Responses 桥接 + Qoder OAuth 自动刷新。
- 自动注册 `qwencode` provider：Qwen4-Max / Qwen4-Max-Preview（1M 上下文）、Qwen3.8-Max / Qwen3.8-Flash（180K 上下文），保留每个模型的思考强度档位。
- 启动时同步 Qoder `api/v3/model/list?categories=qcode` 实时模型目录，失败回退内置表，不阻塞启动。
- DSH 的 `off` 由桥接补成 `reasoning.effort=none`，真正关闭思考；支持 `defaultReasoningEffort` 覆盖默认档位。
- 与 `qwen` CLI 共用凭证：mtime/size 感知外部刷新、写回前核对 refresh_token、原子写回；`expires_in` 走相对时长换算。
- 请求清洗对齐 qwen-code（stream/store、删除不支持的采样字段、system→developer 兜底、注入 `metadata.session_type`）。
- 20 项 `node:test` 离线单元测试；`scripts/selftest.mjs` 提供真实上游端到端自测。

> 版本沿革：早期内部迭代曾按 0.1.0 → 2.0.1 编号，现统一归口到语义化发布的 1.0.0-rc.1；下列历史条目按时间倒序列出当时的改动。

## 2.0.1 — 2026-11-17

- 启动时从 Qoder `api/v3/model/list?categories=qcode` 同步实时模型目录；目录失败回退内置表，不阻塞插件启动。
- 模型上下文改为以目录 `max_input_tokens` 为准：Qwen3.8-Max / Qwen3.8-Flash 从 1M 修正为 180K。
- provider 默认档位从写死的 `high` 改为 `low`：四个模型都支持，避免 Qwen3.8 系列收到不支持的 high 而报 `UNSUPPORTED_REASONING_EFFORT`；可用 `defaultReasoningEffort` 覆盖。
- 修复 DSH 的 `off` 无法关闭 Qwen 思考：DSH 把 off 翻译成省略 reasoning 字段，而 Qwen 默认开启；插件在配置默认档位时把“省略”补成 `reasoning.effort="none"`（实测 0 个思考增量）。
- 只为有真实思考档位的模型写 `reasoningEfforts`，避免 DSH 配置 schema 拒绝空表或只有 `off` 的模型；显式配置 `models` 时以自定义表为准，不再被实时目录覆盖。
- 修复刷新响应只带 `expires_in` 时被当成绝对时间、写成 1970 年并导致每个请求都刷新 token 的问题。
- 写回凭证时使用实际读取的账号 key，避免单账号兜底/region 规范化时写错条目。
- 刷新重试不再重试 AbortError/TimeoutError。
- 新增 `node:test` 单元测试（请求清洗、目录映射、token 刷新与并发轮换、provider 配置），`npm test` 可直接运行。
- `/healthz` 增加版本号、模型数量与模型 id 列表。
- README/DETAIL 更新为 2.0.1，补充实时目录、180K 上下文与默认思考档位说明。

## 0.1.0 — 2026-11-17

- 首个版本：Qoder OAuth 凭证读取/刷新/原子写回、OpenAI Responses 本地桥接、自动注册 `qwencode` provider、4 个模型与思考档位。
