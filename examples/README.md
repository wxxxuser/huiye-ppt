# 南桥咖啡演示文件

这是“午高峰外带流程复盘”的虚构门店样例，包含具体问题、前后记录、剩余异常和下周负责人。配图用于场景说明，不是门店现场证据。

| 文件 | 用途 |
|---|---|
| `huiye-demo.pptx` | 6 页演示文稿，第 2、4 页为图文版式；图片已嵌入，文字为可编辑文本框 |
| `huiye-demo.huiye.zip` | 可通过汇页“导入汇页草稿”恢复的完整备份，包含文稿和两张图片 |
| `huiye-demo.huiye.json` | 不依赖图片的纯文字版本，用于旧格式兼容验收 |

在项目目录重新生成带图片的 PPTX 和 ZIP：

```powershell
npx tsx scripts/build-example.mts
```

脚本从仓库素材生成文件，校验 PPTX 的 6 页 / 2 张内嵌图片，以及 ZIP 的完整恢复；不会调用 Anna 或修改运行时草稿。

照片由 Valeriia Miller 提供，按 Pexels License 使用；等待时长图表为本项目原创。来源及许可见 [素材说明](../public/examples/SOURCES.txt)。
