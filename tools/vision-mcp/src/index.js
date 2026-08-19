// Claude Code 视觉 MCP 工具
// 主模型（DeepSeek）不支持多模态；本工具把图片转发给 OpenAI 兼容的视觉 API（默认智谱 GLM-4V-Flash）并返回文字描述。
//
// 环境变量（在 .mcp.json 的 vision 服务器 env 中配置）：
//   VISION_API_KEY  必填；也兼容 GLM_API_KEY / ZHIPU_API_KEY
//   VISION_API_BASE 默认 https://open.bigmodel.cn/api/paas/v4（智谱）
//   VISION_MODEL    默认 glm-4v-flash（免费档）
//                   换 Kimi：base 改为 https://api.moonshot.cn/v1，model 改为 moonshot-v1-8k-vision-preview

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs/promises";

const API_KEY = process.env.VISION_API_KEY || process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY || "";
const API_BASE = (process.env.VISION_API_BASE || "https://open.bigmodel.cn/api/paas/v4").replace(/\/+$/, "");
const MODEL = process.env.VISION_MODEL || "glm-4v-flash";
const MAX_BYTES = 5 * 1024 * 1024; // GLM-4V 单图上限 5MB

const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
const DEFAULT_PROMPT =
  "请详细描述这张图片的内容，包括其中的文字、界面元素和布局。如果是截图，请尽可能完整地列出可见的信息。";

async function analyze(imagePath, prompt) {
  if (!API_KEY) {
    throw new Error(
      "缺少 VISION_API_KEY：请在项目根目录 .mcp.json 的 vision 服务器 env 中填入智谱 API Key（https://open.bigmodel.cn 创建，glm-4v-flash 免费档）"
    );
  }
  let buf;
  try {
    buf = await fs.readFile(imagePath);
  } catch (e) {
    throw new Error(`无法读取图片文件: ${imagePath} (${e.message})`);
  }
  const ext = imagePath.slice(imagePath.lastIndexOf(".")).toLowerCase();
  const mime = MIME[ext];
  if (!mime) {
    throw new Error(`不支持的图片格式 ${ext || "(无扩展名)"}，支持: ${Object.keys(MIME).join(" / ")}`);
  }
  if (buf.length > MAX_BYTES) {
    throw new Error(`图片 ${(buf.length / 1024 / 1024).toFixed(1)}MB 超过 ${MAX_BYTES / 1024 / 1024}MB 上限，请先压缩`);
  }
  const b64 = buf.toString("base64");
  const body = {
    model: MODEL,
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
          { type: "text", text: prompt || DEFAULT_PROMPT },
        ],
      },
    ],
  };
  let resp;
  try {
    resp = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`请求视觉 API 失败（${API_BASE}）: ${e.message}`);
  }
  if (!resp.ok) {
    let detail = "";
    try {
      detail = (await resp.text()).slice(0, 500);
    } catch {
      /* ignore */
    }
    if (detail.includes("1305") || detail.includes("访问量过大")) {
      throw new Error(
        `视觉 API 繁忙（免费档 glm-4.6v-flash 限流），请稍后重试；或改用付费模型：把 .mcp.json 里 VISION_MODEL 改为 glm-4v-plus`
      );
    }
    throw new Error(`视觉 API 返回 HTTP ${resp.status}: ${detail}`);
  }
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error(`视觉 API 响应缺少内容: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return text;
}

const server = new McpServer({ name: "vision-mcp", version: "0.1.0" });

server.registerTool(
  "analyze_image",
  {
    description:
      "分析本地图片/截图并返回文字描述。主模型（DeepSeek）无法直接看图片，凡涉及查看图片、截图、图表、UI 设计稿等场景都必须调用本工具。传入图片绝对路径和可选问题；大图可能需要几秒。",
    inputSchema: {
      imagePath: z.string().describe("图片文件的绝对路径，支持 png/jpg/jpeg/webp/gif"),
      prompt: z.string().optional().describe("可选：想从图片中确认的具体问题，例如「这张截图里的报错是什么？」"),
    },
  },
  async ({ imagePath, prompt }) => {
    const text = await analyze(imagePath, prompt);
    return { content: [{ type: "text", text }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
