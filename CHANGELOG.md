# Changelog

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
