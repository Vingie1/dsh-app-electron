# dsh-app

DeepSeek Harness 桌面应用（Electron + pnpm monorepo）。

## 图片处理规则（重要）

本项目的 Claude Code 后端是 **DeepSeek（纯文本模型）**，无法直接理解图片：

- **不要用 Read 工具读取图片文件**（png/jpg/jpeg/webp/gif），不会得到内容。
- 需要分析图片/截图时，调用 **`analyze_image`** MCP 工具（vision 服务器）：传入图片绝对路径和可选问题，它会把图片交给视觉模型（智谱 GLM-4V 等）并返回文字描述。
- 纯文本型截图（报错信息、代码、日志）也可以直接请用户粘贴文字，或先用 OCR 命令转成文本。

## 模型映射（用户级 settings.json）

| 界面选择 | 实际模型 | 计费 |
|---|---|---|
| Sonnet（默认） | deepseek-v4-flash[1m] | flash |
| Opus | deepseek-v4-pro[1m] | pro |
| Haiku / 子代理 | deepseek-v4-flash[1m] | flash |

不要开 `/fast`（走 Opus 档，会按 pro 计费）。
