# dsh-qwencode

把本机 **Qwen Code**（`qwen` CLI 1.0 preview，Qoder 账号登录）的免费额度作为 DeepSeek Harness 的模型 provider（路由键 `qwencode`）接入。

插件附赠一个只监听 `127.0.0.1` 的桥接服务：

```
DSH 会话 ──(OpenAI Responses / pi-ai)──► http://127.0.0.1:45917/v1 ──► Qoder 网关
                                              ▲
                        Qoder OAuth token（~/.qwen/qoder_oauth_creds.json，自动刷新并写回）
```

桥接只做鉴权与协议适配，**不实现 agent**。工具调用、skill 读取、文件修改、子代理、目标/计划等全部由 DSH 原生完成；模型侧只负责推理与函数调用。

## 前置条件

1. 本机安装并登录 Qwen Code：`qwen` 命令可运行，且已通过 `/auth` 用 Qoder 账号登录。
2. 凭证文件存在：`%USERPROFILE%\.qwen\qoder_oauth_creds.json`（`accounts.cn` 或 `accounts.global` 下有 `accessToken`/`refreshToken`）。
3. DSH 0.2.x（本项目针对 0.2.2-rc.3 开发验证）。

## 安装

在 DSH 里用 Plugin Manager 安装本地目录：

```
plugin_manager(action: "install_bundle", target: "D:\\ds.harness\\dsh-qwencode")
```

安装后插件会：

- 启动桥接服务（端口 45917）；
- 通过官方 `configEditor` 把 provider `qwencode` 写入 `@deepseek-ai/dsh-llm-pi-ai` 的配置；
- 新建会话时在模型选择器里出现 **Qwen Code · 免费额度** 分组。

> 自动写配置等价于在 Models 设置页保存一次 provider 配置，会改 profile 的 `cordis.patch.yml`。不希望自动改配置时，把插件配置 `manageProviderConfig` 设为 `false`，然后按插件日志打印的 YAML 手动添加。

## 模型与思考强度

| 模型 id | 显示名 | 上下文 | 思考档位 |
|---|---|---|---|
| `qmodel_latest` | Qwen4-Max | 1M | off / low / high / xhigh |
| `qmodel_latest_preview` | Qwen4-Max-Preview | 1M | off / low / high / xhigh |
| `qmodel_38max` | Qwen3.8-Max | 1M | off / low / medium / xhigh |
| `qfmodel` | Qwen3.8-Flash | 1M | off / low / medium / xhigh |

档位与 Qwen 模型目录的 `thinking_config` 一致；映射到 Responses 协议的 `reasoning.effort`，`off` 发送 `none`（等价 Qwen Code `--thinking disabled`）。provider 还配置了 `reasoning: high` 作为默认档位：会话没有显式选择时默认开启思考（对齐 Qwen Code 默认 `--thinking auto` 的行为），每个会话仍可在模型选择器里改成 `off` 或其它档位。思考过程以 DSH 思考块显示。

## 配置项

插件行的 `config` 字段（默认值见 `index.js` 的 `DEFAULT_OPTIONS`）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `port` | `45917` | 本地桥接端口；改动会同步更新 provider baseURL。 |
| `region` | 自动 | `cn` / `global`；缺省按凭证文件推断。 |
| `agentId` | `agent_common` | Qoder 网关 `AgentId` 查询参数。 |
| `sessionType` | `qcode` | 上游 `metadata.session_type`。 |
| `clientVersion` | `1.0.0-preview.2` | 上游 `Cosy-Version` 头。 |
| `autoConfirmPaid` | `false` | 付费确认模型是否自动确认（会扣付费额度）。 |
| `manageProviderConfig` | `true` | 是否自动写 provider 配置。 |
| `credentialPath` | 默认凭证路径 | 自定义凭证文件路径。 |

## 验证

```powershell
# 1) 桥接健康检查（DSH 运行时）
curl http://127.0.0.1:45917/healthz

# 2) 不经过 DSH 的独立自测（真实打上游，消耗少量额度）
pwsh -File scripts\run-node.ps1 scripts\selftest.mjs --model qfmodel

# 3) DSH 内：新建会话选择「Qwen Code · 免费额度」下的模型，
#    让它读写文件 / 执行一条命令，确认工具调用与思考过程正常。
```

`selftest.mjs` 覆盖：healthz、模型列表、纯文本+思考流、工具调用、工具结果回传、错误映射。

已在 DSH 0.2.2-rc.3 的桌面 profile 实测（安装即生效，无需重启）：
- `dsh-plugin` 行状态 active，`/healthz` 正常，provider 配置自动写入 profile patch；
- 用 `provider=qwencode, model=qmodel_latest` 的真实子代理会话完成：`pwsh` 写文件 → `read` 读回 → `skill` 加载 `dsh-doc` → 目录列举，全部真实工具调用成功；
- 同一会话日志记录到 `provider=qwencode/model=qmodel_latest` 与 `reasoning` 思考块，桥接侧观测到 `reasoning.effort=high` 与 90 个思考增量事件；
- `model=qfmodel`（免费模型）同样完成真实工具调用；
- token 刷新实测：自动刷新并写回后 `qwen` CLI 仍可正常使用；外部进程轮换凭证后桥接能检测文件变化并采用新 token。

## 目录结构

```
dsh-qwencode/
├── index.js              # Cordis Host 插件：启动桥接 + 注册 provider
├── src/
│   ├── bridge.mjs        # 本地 HTTP 桥接（Responses 透传、请求清洗、错误映射）
│   └── qoder-auth.mjs    # Qoder OAuth 凭证读取/刷新/原子写回
├── scripts/
│   ├── selftest.mjs      # 独立端到端自测（真实上游）
│   └── run-node.ps1      # 用 DSH 自带 Electron 以 node 模式跑脚本
├── cordis.patch.yml      # bundle patch：插入插件行
├── locale/{zh,en}.json   # Plugin Manager 显示元数据
├── docs/DETAIL.md        # 插件详情页
└── icon.svg
```

## 限制与安全

- 额度、限流、计费由 Qwen 账号计划决定；插件不绕过任何限制。`qfmodel` 在模型目录里标为免费模型；Qwen4-Max 等是否免费取决于你的 Qwen Code 计划。
- 不支持 Qwen Code 的 `--thinking auto/adaptive`（DSH 选择器只有明确档位）；需要"模型自定"时选 `high` 或默认档位。
- `autoConfirmPaid` 默认关闭：遇到 `MODEL_PAID_CONFIRM_REQUIRED` 会返回可读错误而不是静默扣费。
- 与 Qwen Code CLI 共用同一份凭证：桥接按文件 mtime/size 感知 CLI 的并发刷新；写回前再次核对 refresh_token，发现已被 CLI 轮换则放弃本次写回、采用磁盘版本，避免互相覆盖。
- 桥接只绑定 `127.0.0.1`；access token 只存在于本机进程与既有凭证文件，刷新后按原 schema 原子写回，不向第三方泄露。
- 凭证失效（refresh_token 过期/被撤销）时插件报错并提示重新运行 `qwen` 登录，不会删除凭证文件。

## 排障

- **端口被占用**：插件行状态会失败并在日志里提示；把插件配置的 `port` 改成其它值（provider 的 baseURL 会自动同步），重载插件/重启 DSH。
- **provider 没出现在模型选择器**：查看 `%TEMP%\dsh-qwencode\provider-sync.json` 里的自动注册诊断（最近的尝试、失败原因）；把插件配置 `manageProviderConfig` 设为 `false` 后按日志打印的 YAML 手动添加。
- **凭证缺失/过期**：`curl http://127.0.0.1:45917/healthz` 的 `auth` 字段会给出状态与错误；运行 `qwen` 后执行 `/auth` 重新登录即可。
- **额度/付费确认**：上游返回 `MODEL_PAID_CONFIRM_REQUIRED` 时桥接返回 402 并说明；需要自动确认时把 `autoConfirmPaid` 设为 `true`（会消耗付费额度）。

## 开发

- 桥接模块可用任意 Node ≥ 20 直接 import；`npm test` 未配置，自测见 `scripts/selftest.mjs`。
- 修改 `src/bridge.mjs` 后：重新安装插件（Plugin Manager 移除再安装）或重启 DSH 使新模块生效。
