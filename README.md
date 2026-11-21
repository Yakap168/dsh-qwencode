# dsh-qwencode

把本机 **Qwen Code**（`qwen` CLI 1.0 preview，Qoder 账号登录）的免费额度作为 DeepSeek Harness 的模型 provider（路由键 `qwencode`）接入。当前版本 **1.0.1**（正式版），变更见 [CHANGELOG.md](./CHANGELOG.md)。

> **1.0.1 正式版**包含 **`/qwen-login` 插件内登录**：不用离开 DSH、不用在终端里运行 Qwen Code，浏览器授权一次即可拿到免费额度；支持 `cn` / `global` 区域选择（见「🔑 插件内登录」）。

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

> ⚡ **只想在 DSH 里用、不想碰终端？** 可以跳过第 1、2 步：直接看 **第 3 步装插件**，装好后在 DSH 输入 `/qwen-login`，插件会自己完成 Qoder 登录（详见「🔑 插件内登录」）。

### 第 0 步：先理清三样东西

想象你要开车去一个"免费的加油站"：

| 角色 | 在本项目里是什么 | 你需要做什么 |
|---|---|---|
| 🚗 车 | **DeepSeek Harness（DSH）** | 已装好（你能看到这个插件市场就说明有了） |
| ⛽ 免费的油站 | 你 Qoder 账号的模型额度 | 登录一次 Qoder（Qwen Code CLI 或插件 `/qwen-login` 都行） |
| 🔌 转接头 | 本插件 `dsh-qwencode` | 装它，把"油站"接到"车"上 |

**Qwen Code** 是阿里 Qwen 官方的终端编程工具，用 **Qoder 账号** 登录后，自带一份模型额度（含免费模型 `Qwen3.8-Flash`）。本插件就是把这份额度"转接"进 DSH，让你在 DSH 里像用普通模型一样用它——而且**工具调用、读文件、写代码、加载 skill 全都照常工作**。

> 一句话：**Qwen Code 负责发"油卡"，插件负责把油加进 DSH 这台车。**

### 第 1 步（可选）：安装 Qwen Code（拿"油卡"的前提）

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

### 第 2 步（可选）：用 Qoder 账号登录（真正领到"油卡"）

> 💡 **已经装好本插件了？** 可以跳过这一步：直接在 DSH 输入框输入 `/qwen-login`，浏览器授权后自动完成登录（详见下面的「🔑 插件内登录」）。两种方式写的是同一份凭证，随时可以混用。

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

装好之后，插件会自动做四件事，你**什么都不用配**：

- 在本机 `127.0.0.1:45917` 起一个"转接服务"；
- 把 `qwencode` 这个模型来源注册进 DSH；
- 在**模型选择器**里多出一个分组：**Qwen Code · 免费额度**；
- 在输入框注册 **`/qwen-login`** 登录命令（如果输入后没有提示，重启一次 DSH 让新模块生效）。

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

返回里 `ok: true`、`models` 有 4 个、`auth.hasAccount: true`、`login.status` 为 `idle`/`success`，就说明全链路通了。

---

## 🔑 插件内登录：`/qwen-login`

**这是 1.0.1 正式版提供的登录入口（支持 cn / global 区域选择）。** 不需要终端、不需要在终端里运行 Qwen Code，在 DSH 里一条命令就能完成 Qoder OAuth 登录。

### 第一次登录（3 步）

1. 在 DSH 的输入框直接输入并发送：

   ```text
   /qwen-login
   ```

2. 插件会自动打开系统默认浏览器，进入 Qoder 授权页（`qoder.cn`）。没有自动打开？把命令返回结果里的**授权链接**复制到浏览器打开即可。
3. 在页面里登录 Qoder 账号并确认授权。回到 DSH，命令会自动返回：

   ```text
   ✅ 登录成功：<你的账号>
   凭证已写入 ...\.qwen\qoder_oauth_creds.json
   ```

   > 命令最多等 2 分钟；如果你在浏览器里操作得慢，超过 2 分钟后再运行 `/qwen-login status` 查看结果，成功后同样会写入凭证。

### 常用子命令

| 命令 | 作用 |
|---|---|
| `/qwen-login` | 未登录时发起登录；已登录时显示当前区域、账号和已保存账号列表 |
| `/qwen-login status` | 查看当前区域、当前账号和已保存区域账号 |
| `/qwen-login cn` | 登录**中国区**（`qoder.cn` / `openapi.qoder.com.cn`） |
| `/qwen-login global` | 登录**国际区**（`qoder.com` / `openapi.qoder.sh`） |
| `/qwen-login use cn` | 切换到已登录的中国区账号（运行时生效） |
| `/qwen-login use global` | 切换到已登录的国际区账号（运行时生效） |
| `/qwen-login relogin [cn\|global]` | 重新登录指定区域（不写区域则沿用当前区域） |
| `/qwen-login open` | 重新打开当前授权页 |
| `/qwen-login cancel` | 取消进行中的登录 |

### 选择区域：中国区 / 国际区

插件支持两个 Qoder 区域，登录时按区域分别保存，**互不覆盖**：

| 区域 | 授权网站 | API 端点 | 凭证条目 |
|---|---|---|---|
| `cn` 中国区 | `qoder.cn` | `openapi.qoder.com.cn` | `accounts.cn` |
| `global` 国际区 | `qoder.com` | `openapi.qoder.sh` | `accounts.global` |

**怎么选：**

1. 想登录哪个区域，就直接运行对应命令：
   - 中国区：`/qwen-login cn`
   - 国际区：`/qwen-login global`
2. 登录成功后，插件会**自动把当前使用区域切到刚登录的区域**，并立即生效。
3. 之后想换回另一个已登录账号，运行 `/qwen-login use cn` 或 `/qwen-login use global`，不需要重新登录。
4. `/qwen-login status` 会列出两个区域已保存的账号和到期时间，方便确认。

> **永久默认区域**：`use` 的切换只在本次 DSH 运行期间有效。想重启后仍默认使用国际区，把插件配置 `region` 设为 `global`（中国区设为 `cn`），然后重载插件/重启 DSH。两个区域的模型目录可能略有差异（国际区实测为 `qmodel_latest`、`qmodel_38max`、`qfmodel`），切换区域后建议重启一次 DSH 让模型目录按新区域重新拉取。

### 给脚本 / 自动化用：HTTP 端点

桥接服务同时暴露三个本地端点（仅 `127.0.0.1`）：

```powershell
# 发起登录，返回 authUrl / id / expiresAt
curl -X POST http://127.0.0.1:45917/login/start

# 查询进度（不传 id 查最近一次）：pending / success / error / expired / cancelled
curl "http://127.0.0.1:45917/login/status?id=<id>"

# 取消
curl -X POST http://127.0.0.1:45917/login/cancel -H "Content-Type: application/json" -d "{\"id\":\"<id>\"}"
```

### 它到底做了什么（安心版）

1. 插件在本地生成 PKCE 校验串（`verifier` / `challenge` / `nonce`），拼出 Qoder 官方授权页；
2. 你在浏览器里登录、授权，Qoder 把授权结果绑定到这次 `nonce`；
3. 插件每 2 秒向 Qoder 官方轮询一次（404 = 你还没点完，不是报错），拿到 `accessToken` / `refreshToken`；
4. 按 Qwen Code CLI **完全相同的 schema** 写入 `~/.qwen/qoder_oauth_creds.json`，并立即热加载给桥接服务使用。

整个流程与 Qwen Code CLI 的 `/auth` 是同一套官方 OAuth 协议，只是把"终端里操作"换成了"DSH 里一条命令"。插件不会接触你的 Qoder 密码，也不会把 token 发到任何第三方。

---

## 前置条件（速查）

1. 有一个可用的 **Qoder 账号**（免费额度与模型权限由账号计划决定）。
2. 登录方式任选其一：
   - **在 DSH 里运行 `/qwen-login`**（推荐；插件装好后可用，不需要终端、不需要在终端里运行 Qwen Code）；
   - 或者安装并登录 Qwen Code CLI：`qwen` 命令可运行，且已通过 `/auth` 用 Qoder 账号登录。
3. 凭证文件存在：`%USERPROFILE%\.qwen\qoder_oauth_creds.json`（`accounts.cn` 或 `accounts.global` 下有 `accessToken`/`refreshToken`）。
4. DSH 0.2.x（本项目针对 0.2.2-rc.3 开发验证）。

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
| `clientId` | `ecaf4a7a-…-7a1570012a41` | Qoder OAuth 的 `client_id`（qwen-code 内置 UUID，一般不用改）。 |
| `loginTimeoutMs` | `600000` | 登录会话最长等待时间（毫秒）；超时后需重新发起。 |
| `loginPollIntervalMs` | `2000` | 登录轮询间隔（毫秒）。 |
| `openBrowserOnLogin` | `true` | 发起登录时是否自动打开系统默认浏览器。 |
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

# 4) DSH 内登录：在输入框运行 /qwen-login，浏览器授权后应返回"登录成功"
#    （首次使用、换账号或凭证过期时）

# 5) DSH 内：新建会话选择「Qwen Code · 免费额度」下的模型，
#    让它读写文件 / 执行一条命令，确认工具调用与思考过程正常。
```

`selftest.mjs` 覆盖：healthz、实时模型目录、模型列表、纯文本+思考流、工具调用、工具结果回传、错误映射。单元测试覆盖请求清洗、Qoder 目录映射、token 刷新（含 `expires_in` 与并发轮换）、provider 配置生成，以及 `/qwen-login` 的 PKCE、轮询、凭证写回与桥接登录端点。

已在 DSH 0.2.2-rc.3 的桌面 profile 实测：
- **1.0.1 正式版**：汇聚 rc.1 / rc.2 内容，交付插件内登录 `/qwen-login`（含 `cn` / `global` 区域选择、`use` 运行时切换、动态网关）与完整新手使用说明；全套 48 项测试 PASS，2 位 reviewer 独立审查通过（含修复复核）。
- **1.0.1-rc.2**：新增 `/qwen-login cn`、`/qwen-login global`、`/qwen-login use cn|global` 区域选择命令；`status` 同时列出两个区域已保存账号；登录成功后自动切换运行中的区域，上游网关按 `auth.region` 动态切换（不再出现 global token 打 cn 网关）。补充 README「选择区域：中国区 / 国际区」。单元测试 48 项全 PASS（新增 2 项区域命令与网关切换测试）。
- **1.0.1-rc.1**：单元测试 46 项全 PASS（新增 19 项登录流程测试：PKCE 生成、轮询 404 等待/成功映射、缺 refresh_token、非 404/非法 JSON 错误、凭证写回与多地域合并、版本校验与写失败、登录管理器成功/取消/超时、浏览器打开、命令 handler 分支与卸载、桥接 `/login/*` 端点及完整成功流程）；真实网络验证 `/login/start` 返回合法 `authUrl`（`qoder.cn/device/selectAccounts?sourceType=QwenCode...`），`/login/status` 在未完成浏览器授权时保持 `pending`（官方轮询返回 404），`/login/cancel` 正常。
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
│   ├── qoder-login.mjs   # Qoder OAuth 设备登录（PKCE + 轮询 + 凭证写回）
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
- `/qwen-login` 复刻的是 Qwen Code 1.0 preview 的 Qoder 官方 OAuth 流程（PKCE + 轮询，按 qwen-code 1.0.0-preview.2 的二进制实现；该版本不发送 `machine_id`）。如果 Qoder 后续调整授权页或端点，需要按新版 qwen-code 同步更新；届时仍可回退到 `qwen` CLI 的 `/auth` 登录。

## 排障

- **端口被占用**：插件行状态会失败并在日志里提示；把插件配置的 `port` 改成其它值（provider 的 baseURL 会自动同步），重载插件/重启 DSH。
- **provider 没出现在模型选择器**：查看 `%TEMP%\dsh-qwencode\provider-sync.json` 里的自动注册诊断（最近的尝试、失败原因）；把插件配置 `manageProviderConfig` 设为 `false` 后按日志打印的 YAML 手动添加。
- **凭证缺失/过期**：在 DSH 里运行 `/qwen-login`（或 `/qwen-login relogin`）重新登录；也可以继续用 `qwen` 后执行 `/auth`。`curl http://127.0.0.1:45917/healthz` 的 `auth` 字段会给出状态与错误。
- **`/qwen-login` 找不到命令或没反应**：新模块需要重装插件或重启 DSH 才会加载（见「开发」）；确认当前是桌面/Web profile（headless 没有 commands 服务，可改用 `/login/*` HTTP 端点）。
- **登录时浏览器没自动打开**：把命令返回的 `authUrl` 复制到浏览器；或先 `/qwen-login open` 再试。仍不行就检查系统默认浏览器是否可用。
- **`/qwen-login status` 一直 pending**：确认浏览器里已经点了"授权/允许"且没有关闭页面；授权页会话默认 10 分钟过期，过期后重新 `/qwen-login`。网络抖动时插件会自动重试，不需要手动刷新。
- **额度/付费确认**：上游返回 `MODEL_PAID_CONFIRM_REQUIRED` 时桥接返回 402 并说明；需要自动确认时把 `autoConfirmPaid` 设为 `true`（会消耗付费额度）。
- **模型回话但不动手（不调工具）**：确认选中的是 `Qwen Code · 免费额度` 分组里的模型，而不是别的 provider；再确认会话权限允许执行工具（不是纯聊天模式）。
- **改了 `src/*.mjs` 不生效**：插件模块需要重装/重启才加载新代码（见「开发」）。

## 安全说明

- 桥接只绑定 `127.0.0.1`，并会把非 loopback 的 `host` 配置视为错误拒绝启动；不向局域网暴露。
- `/healthz` 默认只返回版本、模型 id 列表、凭证状态（可用/到期时间/region）与去敏后的请求计数；`credentialPath`、用户名、userId 仅在显式 `healthzDetail: true` 时返回。
- 凭证文件按原 schema 原子写回（临时文件 + rename）；POSIX 上设为 0o600，Windows 上依赖用户 profile 目录的默认 ACL（Windows 无法用 chmod 收紧，见「限制」）。
- 登录接口（`/login/start`、`/login/status`、`/login/cancel`）与桥接服务一样只监听 `127.0.0.1`；授权链接里的 `nonce`/`challenge` 是一次性随机值，不包含账号密码。插件全程不接触、不保存你的 Qoder 密码。
- 登录会话只保存在内存中（默认 10 分钟过期），插件重启即失效；已经写入磁盘的凭证不受影响。
- 刷新与错误信息不含 access/refresh token；上游错误详情只保留脱敏后的短摘要，不落盘。

## 开发

- 桥接模块可用任意 Node ≥ 20 直接 import；单元测试 `npm test`（即 `node --test "tests/*.test.mjs"`），端到端自测见 `scripts/selftest.mjs`。
- 修改 `src/*.mjs` 后：重新安装插件（Plugin Manager 移除再安装）或重启 DSH 使新模块生效。
