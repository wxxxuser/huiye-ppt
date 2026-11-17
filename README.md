# 汇页PPT

将已有材料整理成大纲、编辑幻灯片并导出可继续修改的 PPTX。AI 生成通过 Anna 平台提供，用户先确认大纲，再生成页面，保留对内容与格式的控制。

Anna App：**汇页PPT** · Slug：**`huiye-ppt`**。公开上架状态以 [Anna staging 平台](https://staging.anna.partners) 为准。

## 功能

- **材料到文稿**：粘贴材料或导入 TXT / Markdown，设置受众、目的与页数，生成并调整大纲，再生成完整文稿；支持单页 AI 改写和材料来源导航。
- **页面编辑**：新增、删除、复制、排序，编辑正文与讲稿；提供封面、要点、对比、步骤、总结和图文版式，以及三种配色。
- **图片与字号**：上传 PNG / JPEG / WebP，调整图片左右位置和显示方式；单独设置标题、核心信息和正文的字号。
- **撤销与保存**：支持最近 50 步撤销/重做，材料、大纲和编辑阶段均自动保存。重新打开时可继续上次草稿或新建演示。
- **导出与备份**：导出原生可编辑文字、形状和图片组成的 PPTX；含图草稿使用 `.huiye.zip` 备份，兼容纯文字 `.huiye.json`。
- **无额度演示**：本地规则演示和完整示例均不调用 AI，方便体验编辑、保存和导出。

初次生成支持 4–10 页，手工编辑支持 1–30 页。暂不支持导入 PPTX 模板、网络搜图或 AI 生图。

## 本地运行

需要 **Node.js ≥ 22.12.0** 和 npm。在项目根目录执行：

```powershell
npm ci
npm run dev:ui
```

打开终端给出的地址，默认是 `http://127.0.0.1:5174/`。这是 Vite 界面演示，使用本机存储和明确标记的规则结果，不调用 Anna 模型，也不需要登录平台。

点击“打开示例”可直接编辑完整成稿；也可以使用示例材料，依次体验材料、大纲、幻灯片和导出流程。自动保存只保留当前工作稿，需要保留多个成稿时请下载草稿备份。

## Anna 开发与发布

项目使用官方 `@anna-ai/cli`，通过 `npm run anna -- <命令>` 调用项目内的 `anna-app`，无需全局安装。

本地宿主调试还需要 uv。首次执行 `npm run anna:prepare`，随后运行：

```powershell
# 终端 1：构建并启动官方 Anna 本地宿主，关闭模型调用
npm run dev
```

等宿主显示 dashboard 地址后，在另一个终端运行：

```powershell
# 终端 2：源码变化后持续重新构建 bundle/
npm run build:watch
```

`npm run dev` 固定使用 `--no-llm`，用于检查 iframe、SDK、草稿与界面。真实 AI 生成需要在 Anna 平台中使用。平台登录、App 身份绑定、工作草稿上传、真实测试、版本冻结及审核发布详见 [Anna 接入与发布指南](docs/ANNA-SETUP.md)。上传工作草稿或冻结版本不等于公开上架。

## 架构与目录

应用是 **React + TypeScript 静态 SPA**，没有额外部署业务后端。通过 Anna SDK 调用 `llm.complete`、应用作用域的 `storage.*`、`files.*` 和窗口接口。当前采用 UI-only App，不需要自定义 Executa。

```text
src/ + index.html → npm run build → bundle/ → Anna CLI → 平台内 iframe
```

| 路径 | 用途 |
| --- | --- |
| `app.json` | 官方 CLI 使用的 App 名称、slug 和商店信息 |
| `manifest.json` | Anna schema 4 配置：静态入口、窗口与资源策略 |
| `bundle/` | 构建产物，供官方 CLI 运行和上传；不提交 Git，不直接编辑 |
| `src/` | 编辑器、数据校验、AI 提示词、Anna 适配、排版与 PPTX 导出 |
| `public/examples/` | 随应用打包的示例图片及素材来源 |
| `scripts/` | 本地宿主辅助、无模型检查和示例文件构建脚本 |
| `tests/` | 内容校验、页面操作、存储、平台适配与导出测试 |
| `examples/` | 可直接打开或导入的演示文件 |
| `docs/` | Anna 接入说明、功能设计及验收记录 |

`app.json`、`manifest.json` 和 `bundle/` 遵循 Anna App 结构；`src/`、React、TypeScript 和 Vite 是本项目的工程选择，Anna 不强制使用这些技术。修改源码后重新构建即可生成平台运行资源。

## 构建与检查

```powershell
npm run build       # TypeScript 检查并构建 bundle/
npm test            # 自动测试，不调用真实模型
npm run validate    # 官方 CLI 严格校验 Manifest 和 UI bundle
npm run test:host   # 官方本地宿主接口检查，需先准备 runtime，模型关闭
```

当前本地验收已通过 **106 项自动测试、构建和 Anna 严格校验**，并检查了浏览器编辑、图片、字号、保存恢复和实际下载的 PPTX 内容。详细范围见 [编辑体验验收](docs/editor-polish-acceptance.md) 与 [图片功能验收](docs/image-upload-acceptance.md)。PowerPoint / WPS 逐页视觉效果及最新提示词的真实生成质量仍需单独验收。

## 额度控制

| 操作 | 模型调用 | 输出上限 |
| --- | ---: | ---: |
| 生成大纲 | 1 次 | 1600 tokens |
| 生成整稿 | 1 次 | `min(6500, 页数 × 550 + 400)` |
| 单页改写 | 1 次 | 900 tokens |
| 手工编辑、图片上传、自动保存、撤销/重做与导出 | 0 次 | — |
| 本地规则演示与固定示例 | 0 次 | — |

输入材料最多 8000 字。生成没有隐式重试或额外修复调用，单页改写只发送当前页及关联材料，不发送图片与字号配置。输出先检查 JSON、页数、引用与字数等合同，失败时保留已有内容及真实用量记录。

输出 token 上限不是平台 CU 预算。用量只展示 Anna 实际返回的数据，缺失值显示未知；撤销编辑不会回退已发生的费用。提示词设计与验证边界见 [大纲提示词说明](docs/outline-prompt.md)。

## 示例与素材

“南桥咖啡午高峰外带流程复盘”是虚构门店示例，包含问题、流程调整、前后记录、剩余异常及下周安排。

- [带图片的 PPTX](examples/huiye-demo.pptx)：可直接打开，文字与图片可继续编辑。
- [完整草稿 ZIP](examples/huiye-demo.huiye.zip)：通过“导入汇页草稿”恢复文稿和图片。
- [纯文字草稿 JSON](examples/huiye-demo.huiye.json)：不依赖图片的兼容格式。
- [示例说明与重新生成方法](examples/README.md)。

咖啡照片由 **Valeriia Miller** 提供，来源于 [Pexels](https://www.pexels.com/photo/a-person-holding-a-cup-of-coffee-6150134/)，按 [Pexels License](https://www.pexels.com/license/) 使用；等待时长图表为本项目原创。照片仅作场景示意，素材来源、处理及许可说明见 [SOURCES.txt](public/examples/SOURCES.txt)。
