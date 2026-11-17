# 汇页 PPT：已有模板复用可行性分析

日期：2026-11-17  
状态：**仅分析，尚未实现模板库或 PPTX 模板上传功能。**

目标是让用户复用在 PowerPoint 等软件中制作的真实 PPTX 模板，保留其设计与可编辑元素。建议先支持少量经过适配的模板，再开放用户上传，不在首期承诺任意 PPT 文件自动套用且完全保真。

## 1. 当前实现

当前的“模板”实际是代码定义的版式与配色，并未加载外部 PPT 模板。

| 项目 | 当前行为 |
| --- | --- |
| 版式 | `types.ts` 定义封面、要点、双栏、步骤、收尾，共 5 类 |
| 配色 | `presentation.ts` 定义 3 套主题，共用同一套排版规则 |
| 布局 | `createSlideScene()` 计算固定文本区、装饰、页脚和字体；根据文字量换行、缩小字号或采用密集布局 |
| 预览 | SVG 根据内部 Scene 渲染 |
| 导出 | `export-pptx.ts` 使用 PptxGenJS 新建宽屏 PPTX，添加原生文本、形状和备注 |
| 导入 | 支持汇页 JSON 草稿及文本材料，不支持读取 PPTX |

AI 负责生成内容并选择现有版式，不会自行设计新布局。现有 Scene 只覆盖文本和基本图形，不能完整表示外部 PPT 的母版、图片、图表、组合对象等。

PptxGenJS 作者明确说明，该库不能直接导入已有 PPTX 模板，母版需通过代码定义。因此接入真实模板需要增加新的处理能力，不能只添加上传入口。[官方答复](https://github.com/gitbrent/PptxGenJS/discussions/1393)

## 2. 路线对比

| 路线 | 实际效果 | 代价与限制 | 建议 |
| --- | --- | --- | --- |
| 提取颜色、字体、Logo | 将品牌样式应用到当前版式 | 开发较轻，但不会保留原布局 | 可作为独立的“品牌样式”功能 |
| 模板页转背景图片，再覆盖文字 | 保留背景外观 | 背景元素不可编辑，旧文字清理和内容适配困难 | 不作为主要方案 |
| 复制真实模板页，替换指定内容槽位 | 保留母版、装饰和多数原生元素，结果继续可编辑 | 需模板适配、PPTX 处理引擎及预览机制 | **推荐** |
| 任意 PPTX 自动理解、重排全部对象 | 适用范围最广 | 接近完整演示编辑器，兼容性和验证成本高 | 暂不纳入首期 |

PPTX 包含幻灯片、母版、布局、主题及其关联部件。复用模板需要维护这些关系，不能将“读取颜色”或“提取截图”等同于完整导入。[Microsoft PresentationML 说明](https://learn.microsoft.com/en-us/office/open-xml/presentation/structure-of-a-presentationml-document)

## 3. 推荐实施顺序

### 第一阶段：精选真实 PPTX 模板库

先适配约 4–6 套现成模板，覆盖工作汇报、项目答辩、产品介绍等常见用途。

1. 取得实际 PPTX 文件，记录来源、版本和使用授权。产品内置模板应具有明确的再分发许可；用户或团队自有模板可先用于私有模板验证。
2. 保留原始文件，在模板接入时标注封面、目录、双栏、图文、结论等参考页。
3. 为每个参考页标注标题、正文、图片、表格等可替换内容槽位，以及长度和数量限制。
4. 生成时复制对应模板页，将结构化内容填入槽位，保留原有装饰与设计。
5. 生成预览并检查文字溢出，允许用户缩短文案或更换参考页。

模板元数据建议包含：`templateId`、原始文件引用、版本、缩略图、页面类型、槽位名称、容量约束、支持对象及来源信息。这里复用的是已有 PPTX 文件，而不是再用代码画一批相似模板。

### 第二阶段：用户上传并适配模板

建议交互：

```text
上传 PPTX → 查看页面缩略图 → 选择参考页及用途
          → 确认标题/正文等槽位 → 保存私有模板 → 重复使用
```

有标准占位符或命名文本框的模板可以自动识别更多信息；普通成稿通常缺少可靠的语义标记，需要用户确认映射。可选用一次 AI 调用建议槽位，不必在每次生成时重复识别整个模板。

首期以静态、宽屏 PPTX 为范围。其他软件中的模板优先通过其正常导出方式取得 PPTX；转换后的文件仍需通过兼容性检查。暂不直接处理 `.key`、旧 `.ppt`、宏文件或带密码文件。

## 4. 技术架构建议

`pptx-automizer` 值得作为验证候选。其官方说明支持加载已有 PPTX、合并模板和修改页面元素，并可通过 PptxGenJS 补充新内容。[项目仓库](https://github.com/singerla/pptx-automizer)

```text
汇页前端
  ├─ Anna LLM：生成结构化内容
  ├─ Anna 文件/存储：保存模板文件、槽位映射与结果引用
  └─ Node Executa
       ├─ 模板检查、槽位识别、容量校验
       ├─ pptx-automizer：加载模板、替换内容、导出 PPTX
       └─ 可选 LibreOffice：生成 PDF / 页面预览
```

该库要求 Node.js 运行环境，适合放入独立 Executa，而非直接加入浏览器 bundle。Anna 官方建议将平台已有的 LLM、存储能力交给 Host API，将需要独立进程的能力放入 Executa。[Anna 架构指南](https://staging.anna.partners/developers/apps/host-api-vs-executa)

现有 `Slide` 主要描述标题、副标题和正文要点。模板模式需要扩展为 `templateId / layoutId / slotValues` 等数据，并保留当前简单版式模式作为可用路径。

预览是关键改造项：当前 SVG 渲染器不能准确复现任意外部模板。建议模板模式从生成后的 PPTX 渲染预览；首期可以提供内容表单编辑和刷新预览，不承诺网页内自由拖拽所有原始对象。

LibreOffice 官方支持 `--headless` 与 `--convert-to`，可作为预览转换候选。必须先验证目标 Anna Agent 中的安装方式、资源、字体及转换结果，不能默认云端已经具备这些依赖。[LibreOffice 参数文档](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html)

## 5. 额度与执行成本

- 模板解包、页面复制、槽位替换和渲染可以确定性执行，不要求调用 LLM；仍有运行时间、存储和执行环境成本。
- 按模板文件哈希缓存解析结果、槽位映射和缩略图；相同模板只适配一次。
- 优先使用人工确认的槽位与容量约束，只有需要时才让 AI 建议映射。
- 延续现有“大纲一次、全稿一次、单页修改按需”的内容生成方式。
- 字体、配色、布局切换和静态预览不触发 AI；溢出优先通过容量限制和规则检测处理。
- 先用固定样例与模板做兼容性测试，再少量调用真实 LLM 验证完整流程。

## 6. 风险与首期验收范围

`pptx-automizer` 官方指出动画、部分特殊媒体关系和复杂母版内容存在限制，测试重点为 PowerPoint 2019 PPTX 格式。导入支持不等于所有对象完全保真。[官方限制说明](https://singerla.github.io/pptx-automizer/limitations)

| 验收项 | 建议要求 |
| --- | --- |
| 模板复用 | 输出保留所选模板的背景、Logo、主要布局和装饰；不以整页截图替代所有元素 |
| 可编辑性 | 填入的文本及支持的对象在 PowerPoint/WPS 中可编辑 |
| 兼容性 | 每套内置模板均验证打开无修复提示；测试实际目标软件，不只检查 ZIP/XML |
| 内容容量 | 用短文案、接近上限文案和中文长标题验证；溢出应提示并允许调整 |
| 字体与预览 | 明确缺失字体的替代策略；对照实际打开的成品检查换行与位置 |
| 不支持对象 | 能识别并明确提示不支持的动画、媒体或复杂对象，避免静默丢失 |
| 重复使用 | 同模板重复生成不需重新上传或重新调用 AI 识别 |
| 文件处理 | 设置大小、页数和解压资源上限；不执行输入文件中的宏或外部程序 |
| 模板隔离 | 用户上传模板作为私有资产处理；系统模板来源和授权信息可追溯 |

建议先用两套真实模板完成小规模验证：导入、槽位替换、导出、预览以及目标软件打开。验证通过后再确定模板库规模和是否开放用户上传。

## 7. 主要来源

- [PptxGenJS：已有模板导入答复](https://github.com/gitbrent/PptxGenJS/discussions/1393)
- [PptxGenJS：不解析已有演示文稿的说明](https://github.com/gitbrent/PptxGenJS/issues/1314)
- [pptx-automizer 官方仓库](https://github.com/singerla/pptx-automizer)
- [pptx-automizer 的要求与限制](https://singerla.github.io/pptx-automizer/limitations)
- [Microsoft：PresentationML 文件结构](https://learn.microsoft.com/en-us/office/open-xml/presentation/structure-of-a-presentationml-document)
- [LibreOffice：命令行参数](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html)
- [Anna：Host API 与 Executa 的职责边界](https://staging.anna.partners/developers/apps/host-api-vs-executa)
