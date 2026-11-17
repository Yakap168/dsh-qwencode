# dsh-qwencode

把本机 **Qwen Code**（`qwen` CLI 1.0 preview，Qoder 账号登录）的免费额度作为 DeepSeek Harness 的模型 provider（路由键 `qwencode`）接入。当前版本 **1.0.0-rc.1**（release candidate），变更见 [CHANGELOG.md](./CHANGELOG.md)。

插件附赠一个只监听 `127.0.0.1` 的桥接服务：

```
DSH 会话 ──(OpenAI Responses / pi-ai)──► http://127.0.0.1:45917/v1 ──► Qoder 网关
                                              ▲
                        Qoder OAuth token（~/.qwen/qoder_oauth_creds.json，自动刷新并写回）
```

桥接只做鉴权与协议适配，**不实现 agent**。工具调用、skill 读取、文件修改、子代理、目标/计划等全部由 DSH 原生完成；模型侧只负责推理与函数调用。

---

## 🚀 保姆级上手：从零开始接入免费额度

下面按 "我什么都还没装" 的视角走一遍。全程大概 10 分钟，卡住的地方看每一步最后的 🧯。

### 第 0 步：先理清三样东西

想象你要开车去一个"免费的加油站"：

| 角色 | 在本项目里是什么 | 你需要做什么 |
|---|---|---|
| 🚗 车 | **DeepSeek Harness（DSH）** | 已装好（你能看到这个插件市场就说明有了） |
| ⛽ 免费的油站 | 你 Qoder 账号的模型额度 | 用 **Qwen Code** 登录一次，拿到"油卡" |
| 🔌 转接头 | 本插件 `dsh-qwencode` | 装它，把"油站"接到"车"上 |

**Qwen Code** 是阿里 Qwen 官方的终端编程工具，用 **Qoder 账号** 登录后，自带一份模型额度（含免费模型 `Qwen3.8-Flash`）。本插件就是把这份额度"转接"进 DSH，让你在 DSH 里像用普通模型一样用它——而且**工具调用、读文件、写代码、加载 skill 全都照常工作**。

> 一句话：**Qwen Code 负责发"油卡"，插件负责把油加进 DSH 这台车。**

### 第 1 步：安装 Qwen Code（拿"油卡"的前提）

> 官方文档：[Qwen Code 概览](https://qwenlm.github.io/qwen-code-docs/en/users/overview/) · [快速开始](https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/)

**Windows（PowerShell 一行装，推荐）**：

```powershell
irm https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1 | iex
```

**Linux / macOS**：

```bash
curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash
```

装完后**关掉终端再开一个新的**（让 `qwen` 命令进 PATH），然后验证：

```powershell
qwen --version      # 能打印版本号就成功，例如 1.0.0-preview.2
```

> 脚本会优先下"独立可执行文件"，没有的话回退到 npm（需要 Node.js 22+）。如果你更习惯 npm：`npm install -g @qwen-code/qwen-code`。

🧯 **卡住？**
- `qwen` 不是命令 → 重开终端；还不行就用 `where qwen`（Windows）/ `which qwen`（mac/Linux）找它装到哪了，手动把目录加进 PATH。
- 公司网络装不动 → 换手机热点再试，或改用上面注释里的 npm 方式。

### 第 2 步：用 Qoder 账号登录（真正领到"油卡"）

在终端直接输入 `qwen` 进入交互界面，然后：

```text
/auth
```

会弹出一个菜单，选 **Qwen 账号 / Qoder 登录** 那一项（"Qwen Account with Subscription" 之类），它会：

1. 给出一个**设备码 + 授权链接**（并尽量自动帮你打开浏览器）；
2. 你在浏览器里确认、登录 Qoder 账号；
3. 回到终端，看到登录成功的提示即可。

登录成功后，**别急着关**——先在里面敲一句验证额度能用：

```text
你好，用一句话介绍你自己
```

能正常回话，就说明"油卡"到手了。此时输入 `/quit` 或 `Ctrl+C` 退出即可。

🧯 **卡住？**
- 浏览器没自动弹 → 复制终端里那条链接，手动粘到浏览器。
- 提示没有订阅/计划 → 你登录的 Qoder 账号可能没有可用计划；换个账号，或先确认账号状态。
- 登录成功后仍想确认"油卡"在不在，可以看文件：`%USERPROFILE%\.qwen\qoder_oauth_creds.json`（Windows）或 `~/.qwen/qoder_oauth_creds.json`（mac/Linux）。**这个文件是隐私文件，别分享、别提交到 git。**

### 第 3 步：把这个插件装进 DSH

**方式 A：DSH 界面安装（对新手最友好）**

打开 DSH 的 **Plugins（插件）** 页面 → **Add plugin / 安装本地插件** → 选中本仓库目录（`dsh-qwencode` 文件夹）→ 安装并启用。

**方式 B：在 DSH 会话里让 AI 帮你装**

在 DSH 新建一个会话，直接说：

```text
把本地目录 D:\ds.harness\dsh-qwencode 作为插件安装并启用
```

（对应工具调用是 `plugin_manager(action: "install_bundle", target: "<本仓库绝对路径>")`。）

装好之后，插件会自动做三件事，你**什么都不用配**：

- 在本机 `127.0.0.1:45917` 起一个"转接服务"；
- 把 `qwencode` 这个模型来源注册进 DSH；
- 在**模型选择器**里多出一个分组：**Qwen Code · 免费额度**。

> 插件每次启动都会核对这份配置是否最新（端口/模型目录/默认档位），不一致会自动更新；等价于你在 Models 设置页手动保存一次。不想让它自动改，把插件配置 `manageProviderConfig` 设为 `false`，日志会打印可手动粘贴的 YAML。

### 第 4 步：开始用（爽点在这里）

1. 在 DSH **新建会话**；
2. 点开**模型选择器**，找到 **Qwen Code · 免费额度**，挑一个：
   - `Qwen3.8-Flash`：**免费**、快，日常首选；
   - `Qwen4-Max` / `Qwen3.8-Max`：更强，是否免费取决于你的 Qwen 计划。
3. 随便派个活给它，比如：

   ```text
   帮我在当前目录建一个 hello.py，打印 1 到 10 的和，然后运行它。
   ```

   你会看到它**真的去调工具、写文件、跑命令**，还会展示"思考过程"——和用官方 API 一模一样。

### 第 5 步：确认一切正常（可选，30 秒）

```powershell
# 看转接服务是否活着（会返回版本、模型列表、凭证状态）
curl http://127.0.0.1:45917/healthz
```

返回里 `ok: true`、`models` 有 4 个、`auth.hasAccount: true`，就说明全链路通了。

---

## 前置条件（速查）

1. 本机安装并登录 Qwen Code：`qwen` 命令可运行，且已通过 `/auth` 用 Qoder 账号登录。
2. 凭证文件存在：`%USERPROFILE%\.qwen\qoder_oauth_creds.json`（`accounts.cn` 或 `accounts.global` 下有 `accessToken`/`refreshToken`）。
3. DSH 0.2.x（本项目针对 0.2.2-rc.3 开发验证）。

## 安装（技术版速查）

在 DSH 里用 Plugin Manager 安装本地目录：

```
plugin_manager(action: "install_bundle", target: "D:\\ds.harness\\dsh-qwencode")
```

安装后插件会：

- 启动桥接服务（端口 45917）；
- 通过官方 `configEditor` 把 provider `qwencode` 写入 `@deepseek-ai/dsh-llm-pi-ai` 的配置；
- 新建会话时在模型选择器里出现 **Qwen Code · 免费额度** 分组。

> 自动写配置等价于在 Models 设置页保存一次 provider 配置，会改 profile 的 `cordis.patch.yml`。插件每次启动都会核对这条路由是否与插件版本一致（端口/模型目录/默认档位），不一致时用 configEditor 更新。不希望自动改配置时，把插件配置 `manageProviderConfig` 设为 `false`，然后按插件日志打印的 YAML 手动添加。

## 模型与思考强度

| 模型 id | 显示名 | 上下文 | 思考档位 |
|---|---|---|---|
| `qmodel_latest` | Qwen4-Max | 1M | off / low / high / xhigh |
| `qmodel_latest_preview` | Qwen4-Max-Preview | 1M | off / low / high / xhigh |
| `qmodel_38max` | Qwen3.8-Max | 180K | off / low / medium / xhigh |
| `qfmodel` | Qwen3.8-Flash | 180K | off / low / medium / xhigh |

插件启动时会请求 Qoder 的 `api/v3/model/list?categories=qcode` 获取**实时模型目录**，以上表格是拉取失败时的内置回退。上下文取目录里的 `max_input_tokens`：Qwen3.8-Max / Flash 实际是 180K，不是 1M（目录里的 `context_config` 1M 是账号预设，不是模型输入上限）。

档位与 Qwen 模型目录的 `thinking_config` 一致，映射到 Responses 协议的 `reasoning.effort`。**provider 默认档位是 `low`**：四个模型都支持它，不会再让 Qwen3.8 系列收到不支持的 `high`（DSH 会直接报 `UNSUPPORTED_REASONING_EFFORT`）。DSH 把用户选择 `off` 翻译成“省略 reasoning 字段”，而 Qwen 自身默认开启思考，所以桥接在启用默认档位时把“省略”补成 `reasoning.effort="none"`，`off` 才真正关闭思考（实测 0 个思考增量）；想回到 Qwen 各模型原生默认档位，把 `defaultReasoningEffort` 设为空，但此时 `off` 无法关闭思考。思考过程以 DSH 思考块显示。

## 配置项

插件行的 `config` 字段（默认值见 `index.js` 的 `DEFAULT_OPTIONS`）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `port` | `45917` | 本地桥接端口；改动会同步更新 provider baseURL。 |
| `region` | 自动 | `cn` / `global`；缺省按凭证文件推断。 |
| `agentId` | `agent_common` | Qoder 网关 `AgentId` 查询参数。 |
| `sessionType` | `qcode` | 上游 `metadata.session_type`。 |
| `clientType` | `13` | 上游 `Cosy-ClientType` 头。 |
| `clientVersion` | `1.0.0-preview.2` | 上游 `Cosy-Version` 头。 |
| `autoConfirmPaid` | `false` | 付费确认模型是否自动确认（会扣付费额度）。 |
| `manageProviderConfig` | `true` | 是否自动写 provider 配置。 |
| `credentialPath` | 默认凭证路径 | 自定义凭证文件路径。 |
| `useLiveCatalog` | `true` | 启动时从 Qoder 拉实时模型目录；关闭后只用内置表。 |
| `catalogTimeoutMs` | `3000` | 模型目录请求超时；失败不阻塞启动，回退内置表。 |
| `defaultReasoningEffort` | `low` | 全局默认档位；`low` 四个模型都支持。设为空可回到 Qwen 各模型默认，但 DSH 的 `off` 将无法关闭思考。 |
| `models` | 不设 | 自定义模型数组（高级用法）；设置后以它为准，不再被实时目录覆盖。 |

## 验证

```powershell
# 1) 桥接健康检查（DSH 运行时）
curl http://127.0.0.1:45917/healthz

# 2) 单元测试（不联网、不消耗额度）
node --test "tests/*.test.mjs"
#    若 PATH 里没有 node（只用 DSH 自带 Node）：& $env:DSH_NODE_EXECUTABLE --test "tests/*.test.mjs"

# 3) 不经过 DSH 的独立自测（真实打上游，消耗少量额度）
pwsh -File scripts\run-node.ps1 scripts\selftest.mjs --model qfmodel

# 4) DSH 内：新建会话选择「Qwen Code · 免费额度」下的模型，
#    让它读写文件 / 执行一条命令，确认工具调用与思考过程正常。
```

`selftest.mjs` 覆盖：healthz、实时模型目录、模型列表、纯文本+思考流、工具调用、工具结果回传、错误映射。单元测试覆盖请求清洗、Qoder 目录映射、token 刷新（含 `expires_in` 与并发轮换）、provider 配置生成。

已在 DSH 0.2.2-rc.3 的桌面 profile 实测：
- **1.0.0-rc.1**：单元测试 20 项全 PASS；独立 `selftest.mjs` 8 项全 PASS，其中 `live_catalog` 从 Qoder 拉到 4 个模型（`qmodel_38max@180000`、`qfmodel@180000`），文本+思考流、工具调用、工具结果回传与错误映射均通过。另实测：不带 `reasoning` 字段请求 `qfmodel` 时上游返回 18 个思考增量（Qwen 默认开启）；带 `reasoning.effort="none"` 时返回 0 个思考增量，证明 `off` 映射有效。
- 0.1.0 安装即生效：`dsh-plugin` 行状态 active，`/healthz` 正常，provider 配置自动写入 profile patch；2026-11-17 17:08 桥接随本次 DSH 启动重新拉起并正常服务，说明已安装 bundle 的持久化生效。
- 用 `provider=qwencode, model=qmodel_latest` 的真实子代理会话完成：`pwsh` 写文件 → `read` 读回 → `skill` 加载 `dsh-doc` → 目录列举，全部真实工具调用成功；
- 同一会话日志记录到 `provider=qwencode/model=qmodel_latest` 与 `reasoning` 思考块，桥接侧观测到 `reasoning.effort=high` 与 90 个思考增量事件；
- `model=qfmodel`（免费模型）同样完成真实工具调用；
- token 刷新实测：自动刷新并写回后 `qwen` CLI 仍可正常使用；外部进程轮换凭证后桥接能检测文件变化并采用新 token。
- 升级模块（1.0.0-rc.1）后需重启 DSH 或重装插件使新代码生效；profile 里的 `link:` 依赖会直接读取新版本。

## 目录结构

```
dsh-qwencode/
├── index.js              # Cordis Host 插件：启动桥接 + 注册 provider
├── src/
│   ├── bridge.mjs        # 本地 HTTP 桥接（Responses 透传、请求清洗、错误映射）
│   ├── catalog.mjs       # Qoder 实时模型目录（qcode）解析与拉取
│   ├── qoder-auth.mjs    # Qoder OAuth 凭证读取/刷新/原子写回
│   ├── diagnostics.mjs   # provider 自动注册诊断
│   └── version.mjs       # 版本号（读 package.json）
├── tests/                # node:test 单元测试（不联网）
├── scripts/
│   ├── selftest.mjs      # 独立端到端自测（真实上游）
│   └── run-node.ps1      # 用 DSH 自带 Electron 以 node 模式跑脚本
├── cordis.patch.yml      # bundle patch：插入插件行
├── locale/{zh,en}.json   # Plugin Manager 显示元数据
├── docs/DETAIL.md        # 插件详情页
├── CHANGELOG.md          # 版本变更
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
- **模型回话但不动手（不调工具）**：确认选中的是 `Qwen Code · 免费额度` 分组里的模型，而不是别的 provider；再确认会话权限允许执行工具（不是纯聊天模式）。
- **改了 `src/*.mjs` 不生效**：插件模块需要重装/重启才加载新代码（见「开发」）。

## 安全说明

- 桥接只绑定 `127.0.0.1`，并会把非 loopback 的 `host` 配置视为错误拒绝启动；不向局域网暴露。
- `/healthz` 默认只返回版本、模型 id 列表、凭证状态（可用/到期时间/region）与去敏后的请求计数；`credentialPath`、用户名、userId 仅在显式 `healthzDetail: true` 时返回。
- 凭证文件按原 schema 原子写回（临时文件 + rename）；POSIX 上设为 0o600，Windows 上依赖用户 profile 目录的默认 ACL（Windows 无法用 chmod 收紧，见「限制」）。
- 刷新与错误信息不含 access/refresh token；上游错误详情只保留脱敏后的短摘要，不落盘。

## 开发

- 桥接模块可用任意 Node ≥ 20 直接 import；单元测试 `npm test`（即 `node --test "tests/*.test.mjs"`），端到端自测见 `scripts/selftest.mjs`。
- 修改 `src/*.mjs` 后：重新安装插件（Plugin Manager 移除再安装）或重启 DSH 使新模块生效。
