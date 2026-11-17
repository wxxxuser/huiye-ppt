# 汇页 PPT：Anna 官方开发流程与 staging 接入

现有平台 App：**Name `汇页PPT` / slug `huiye-ppt`**。本目录独立于 `mini-notes-anna`；不复制旧 App 的身份缓存、manifest 或凭据。工程使用官方 `@anna-ai/cli`，并按 `manifest.json` + `app.json` + `bundle/` 的结构运行。已有工程无需重新 `init`，已有平台身份不重复创建。下列登录、上传及真实模型步骤需在完成本地检查后由操作者执行；写出命令不表示已经完成平台测试或发布。

## 1. 配置对应关系

| 文件 / 能力 | 用途 |
|---|---|
| `app.json` | 已有 App 的 slug、名称、商店描述与拟发布版本号 |
| `manifest.json` | schema 4、一个 `main` 视图、静态 SPA 入口、CSP |
| `bundle/` | 官方 CLI 默认运行与上传的静态资源目录；由 `npm run build` 生成 |
| `src/` 与根目录 `index.html` | React / TypeScript 和 Vite 源入口；这是本项目的工程选择 |
| `package.json` 与 `vite.config.ts` | 本项目的依赖、命令与构建配置，不是 Anna Manifest 字段 |
| `src/platform.ts` | Anna SDK 连接、单次 LLM 补全、草稿、宿主下载 |
| `.anna/app.json` | 官方 CLI 自动生成的远程 App 身份缓存；不要从其他项目复制 |

源码到平台的路径为：`src/` + `index.html` → Vite → `bundle/index.html` 和 `bundle/assets/` → 官方 CLI → 已有 `huiye-ppt` 的 working draft。`manifest.ui.bundle.entry` 为 `index.html`，相对于构建产物根目录。编辑源文件，不直接编辑 `bundle/`。

开发、校验和上传统一使用 `bundle/` 作为静态资源目录。

这是 **UI-only / bundle-only App**，`required_executas` 和 `optional_executas` 都为空，因而没有 `executas/` 目录。官方最小模板包含一个用于演示的 Executa；当前 schema 4 明确允许只依赖 Host API 的界面 App 留空两个数组，不要求逐文件照搬模板。已安装、启用的 App 可直接使用 `llm.complete`、自身作用域的 `storage.*` / `files.*` 与 `window.*`，没有第三方账号或本地设备工具需求，因此没有 `host_api`、`credentials` 或跨 App `storage.scopes` 声明。

SDK 从 Anna 宿主的 `/static/anna-apps/_sdk/latest/index.js` 动态导入。仅在顶层页面且完全没有 Anna 启动参数时显示“本地演示”；在 iframe 中缺少参数、SDK 失败或握手超时都会明确报错，不伪装成成功的 AI App。

## 2. 官方本地开发与无模型检查

要求 Node.js ≥ 22.12、npm、uv。项目锁定 `@anna-ai/cli` 0.1.64；本次核对的依赖为 SDK 0.27.0、schema 0.33.0、Python local runtime 0.2.0a33。`npm run anna -- <命令>` 直接运行 `node_modules/.bin/anna-app` 的官方 CLI，无需全局安装，也不经过项目包装脚本。

```powershell
npm install
npm run anna -- --help
npm run build
npm run anna -- validate --strict
npm run anna:prepare
npm test
npm run test:host
```

`prepare-runtime` 只下载并启动 CLI 对应的 Python bridge，收到 `_ready` 后退出，不登录、不创建平台会话、不调用模型。`smoke-host` 启动一次独立的官方本地容器，验证 `window.hello`、自身 App 存储读写与窗口标题后关闭；明确传入 `--no-llm`，不会读取平台 PAT。

Windows 若未把 `uvx` 放入 PATH，`scripts/runtime-env.mjs` 可复用同级 Mini Notes 的 uv **可执行文件**；Python 包缓存始终使用本项目 `.tools/uv-cache`，不写入 Mini Notes。也可把 `HUIYE_UV_BIN` 指向自己的 uv / uvx 目录。

### 日常开发：两个终端

```powershell
# 终端 1：predev 先执行 build，随后启动 Anna 官方本地容器
npm run dev
```

等终端 1 显示 dashboard 地址后，再启动终端 2，避免两个 Vite 构建同时清空输出目录：

```powershell
# 终端 2：持续把源码改动写入 bundle/
npm run build:watch
```

打开 CLI 打印的 dashboard 地址（端口 `5184`）。Anna 官方容器将 `bundle/index.html` 加载到 iframe，提供 SDK 和 dispatcher，并监听资源变化刷新 iframe。它不直接编译 React / TypeScript；第二个终端负责构建。`build:watch` 仅持续打包，准备上传前仍运行 `npm run build` 完成 TypeScript 检查。

`npm run dev` 的宿主命令等价于 `anna-app dev --slug huiye-ppt --port 5184 --no-llm`，使用 CLI 默认的 `bundle/`。项目通过 `scripts/anna.mjs` 补充 Windows uv 路径与独立缓存；它启动官方 CLI，不实现另一套 Anna 协议。`npm run anna:dev` 保留为同一流程的兼容入口。在 uv 已正确配置到 PATH 的环境，也可于构建后直接执行官方命令：

```powershell
npm run anna -- dev --slug huiye-ppt --port 5184 --no-llm
```

此容器用于检查 SDK 握手、窗口、草稿存储和失败状态；LLM 关闭时生成操作应报告 `llm_disabled`，不会切换为本地规则结果。查看与编辑固定示例不需要模型。

若只需快速调整界面，另开 Vite 演示：

```powershell
npm run dev:ui
```

这是 `http://127.0.0.1:5174/` 的顶层页面，使用明确标记的规则生成和本机存储，不能验证 Anna iframe、真实模型、APS 或宿主下载。它是辅助演示入口，不是平台开发流程。

**CLI 与部分旧文档的差异：** 已核对的 CLI 0.1.64 没有 `--llm off` / `--llm real` 选项。关闭用 `--no-llm`；模拟用 `--mock-llm <JSONL>`；真实桥使用登录账号且不传前两项。`npm run dev` 固定传入 `--no-llm`。通用入口 `npm run anna -- dev` 则保留官方默认行为，已有登录态时可能连接真实平台，离线检查必须显式加 `--no-llm`。

本地 `legacy` 存储是内存态；重启容器后不持久化。生产环境草稿使用 Anna APS；二者都通过 `storage.get/set({key, scope:'app'})`。平台层遵守 `exists`、保存 etag，并串行化写入，检测到并发修改会报错而非覆盖。

## 3. 登录并确认绑定已存在的 App

以下命令会接入平台，需要操作者完成浏览器设备授权。不要在聊天、截图、Git 中暴露 PAT，也不要手工读取或复制 credentials.json。

```powershell
npm run anna -- login --host https://staging.anna.partners
npm run anna -- apps status huiye-ppt --account https://staging.anna.partners --json
npm run anna -- apps push --bundle-dir bundle --account https://staging.anna.partners --dry-run
```

先确认 `status` 显示的是自己已创建的 `汇页PPT`。当前 CLI 会先匹配本项目身份缓存，再按当前账号下的 `app.json.slug` 查找已有 App；找到后复用其 `app_id`。**如果 dry-run 显示 `would create AnnaApp slug=huiye-ppt`，停止上传并检查登录账号、host、slug；不要重复创建另一个 App。** `--dry-run` 不上传 working draft，但 CLI 可能将已解析的身份写入本地 `.anna/app.json`。

确认身份后上传已构建的文件：

```powershell
npm run build
npm run anna -- validate --strict
npm run anna -- apps push --bundle-dir bundle --account https://staging.anna.partners
```

`push` 更新可变 working draft 与资源，不代表公开上架。请在 staging Developer Console 打开这个 App 的工作草稿 / 安装入口进行真实 iframe 测试。CLI 0.1.64 的帮助中没有 `apps install` 子命令，不依赖文档中未实现的安装命令。

## 4. 最小真实测试与额度记录

优先在 staging 中打开**已有 `huiye-ppt` 的 working draft**，覆盖实际 iframe、CSP、模型与 APS。上传 / 登录本身不是 AI 生成测试，必须在 App 内真实执行生成动作才能验收 AI 链路。

本地真实桥是可选的另一条调试路径，不作为本项目首选。CLI 的真实 `dev` 会调用 dev App 注册接口，并维护 `.anna/dev-app.json`；`--llm-app-slug` 用于注册 / 查找该 dev App，并不保证复用 `.anna/app.json` 指向的商店 App。为避免把 dev App 与已有 `huiye-ppt` 混淆，此处不提供真实 `dev` 作为接入命令。若以后确需调试该路径，先明确 dev App 的独立身份；`--storage aps` 需要真实桥，不能与 `--no-llm` / `--mock-llm` 组合。

建议使用一份简短、没有隐私的项目材料，生成最少页数的大纲和文稿，再执行一次单页改写。先确认大纲再生成页面，避免重复整篇生成。本 App 不自动重试，不主动调用图像、搜索、Agent 或探测模型；只发送文本 `messages`、明确的 `maxTokens` 和 `thinking:false`，模型由用户 Anna 设置选择。强制推理模型可能无法关闭思考；实际扣费仍以平台为准。

记录每次生成前后余额，以及响应 `model`、`usage.inputTokens/outputTokens/totalTokens`、`_meta.quotaConsumed`。缺少 `quotaConsumed` 表示未知，不能记作 0 CU。`maxTokens` 是输出 token 上限，不是 CU 预算；平台按最坏情况预检，余额不足时可减少页数 / 输出上限。超时不等于平台已取消，先查用量再手动重试。

至少验收：

1. 平台内显示 Anna 已连接，真实生成结果能进入编辑器；模型返回错误时不显示示例冒充结果。
2. 修改文字后保存，关闭并重新打开 App，草稿恢复；不同用户不会读取到对方草稿。
3. 导出 PPTX 后，PowerPoint / WPS 能打开且文字可继续编辑，页数与编辑器一致。
4. 平台内下载走 `files.list` → `upload_init` → 浏览器 PUT → `upload_finalize` → `files.download`。只有宿主返回 `ok:true` 才报告下载已启动；这不代表浏览器已经完成写盘。
5. 再导出同一格式时复用 `exports/current.<扩展名>` 并传 etag，避免每次生成一个新存储路径。上传失败的 `pending` 条目由平台按 TTL 回收；未完成的上传不得显示下载成功。

### 仍需 staging 真实核实的 CSP / CORS

manifest 的 `csp_overrides.connect-src` 允许 `https://*.r2.cloudflarestorage.com`，供平台返回的 R2 预签名 PUT 使用；这与禁止通配符的 `ui.bundle.external_origins` 是两个不同字段。当前 npm schema / CLI 校验接受此配置，但**本地开发容器不执行完整生产 CSP**，不能据此声称真实上传已经通过。

需在 staging 核实实际 `put_url` 来源匹配 CSP、R2 CORS 允许 PUT 和平台提供的签名请求头、`upload_finalize` 校验通过、宿主 `files.download` 弹出保存。代码按返回 headers 上传，不附带账号 cookie，不猜测 R2 账户 ID；若平台改用不同对象存储域名，应根据真实返回的 origin 更新 CSP 后重测。

## 5. 冻结版本、审核和公开发布

真实验收通过后，再冻结尚未使用的 SemVer。以下 `0.1.0` 必须比已有最高版本更大；已有同名版本时使用新的版本号。

```powershell
npm run anna -- apps cut 0.1.0 --account https://staging.anna.partners
npm run anna -- apps submit-review huiye-ppt --account https://staging.anna.partners
# 等平台审核批准后再执行：
npm run anna -- apps release 0.1.0 --account https://staging.anna.partners
```

`apps publish` 是 push + cut，不等于公开发布。最终需另一个用户从 App Store 安装、实际使用，并保留平台版本号及真实用量记录。GitHub 仓库地址与平台 Name / slug 应在完成发布后填写，不能预先声称已上架。

## 官方依据

- [CLI 快速开始与目录结构](https://staging.anna.partners/developers/apps/app-quickstart)
- [官方本地开发容器](https://staging.anna.partners/developers/apps/local-dev)
- [App Manifest / UI-only App](https://staging.anna.partners/developers/apps/app-manifest)
- [SDK 连接](https://staging.anna.partners/developers/apps/app-ui-sdk)
- [LLM 请求、额度与输出上限](https://staging.anna.partners/developers/reference/host-api-llm)
- [APS 草稿存储](https://staging.anna.partners/developers/reference/host-api-storage)
- [文件上传与宿主下载](https://staging.anna.partners/developers/reference/host-api-files)
- [CSP 配置](https://staging.anna.partners/developers/apps/app-ui-manifest)
- [发布生命周期](https://staging.anna.partners/developers/apps/app-publish)

对应本地资料位于同级 `Anna开发者文档/英文原文/`。模板与部分旧页面包含早期 schema 或命令示例；本项目以当前 schema 4 和锁定 CLI 的实际参数为准。可用 `npm run anna -- <命令> --help` 核对参数，例如 `npm run anna -- apps push --help`。
