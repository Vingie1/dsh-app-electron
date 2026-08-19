// 冒烟测试：不依赖真实 API key，用本地 mock HTTP 服务验证全链路
// （工具注册 → 读文件 → base64 data URI → 请求视觉 API → 返回文字）
// 运行：pnpm --dir tools/vision-mcp test 或 cd tools/vision-mcp && npm test

import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const assert = (cond, msg) => {
  if (!cond) throw new Error(`✗ ${msg}`);
  console.log(`✓ ${msg}`);
};

// 1) mock 视觉 API：记录收到的请求并返回固定描述
let received = null;
const api = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "mock 描述：这是一张测试图片" } }] }));
  });
});
await new Promise((r) => api.listen(0, "127.0.0.1", r));
const port = api.address().port;

// 2) 生成临时测试图片
const img = path.join(os.tmpdir(), `vision-mcp-${Date.now()}.png`);
fs.writeFileSync(img, PNG_1PX);

try {
  // 3) 以子进程方式启动 MCP server 并连接（与 Claude Code 的启动方式一致）
  const client = new Client({ name: "vision-mcp-smoke", version: "0.0.1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "src/index.js")],
    env: {
      ...process.env,
      VISION_API_KEY: "test-key",
      VISION_API_BASE: `http://127.0.0.1:${port}`,
    },
  });
  await client.connect(transport);

  // 4) 工具已注册
  const tools = (await client.listTools()).tools.map((t) => t.name);
  assert(tools.includes("analyze_image"), `工具已注册（实际: ${tools.join(", ")}）`);

  // 5) 正常路径：读图 → 调 mock API → 返回描述
  const res = await client.callTool({ name: "analyze_image", arguments: { imagePath: img } });
  const text = res.content.map((c) => c.text).join("");
  assert(text.includes("mock 描述"), `返回文字描述（${text.slice(0, 40)}...）`);

  // 6) 请求形态正确：OpenAI 兼容、带鉴权、图片为 data URI
  assert(received.url === "/chat/completions", `请求路径 ${received.url}`);
  assert(received.auth === "Bearer test-key", "携带 Authorization: Bearer");
  assert(received.body.model === "glm-4v-flash", `模型 ${received.body.model}`);
  const imageUrl = received.body.messages[0].content[0].image_url.url;
  assert(imageUrl.startsWith("data:image/png;base64,"), "图片以 data:image/png;base64, 传递");

  // 7) 错误路径：文件不存在返回可读错误而非崩溃
  const bad = await client.callTool({
    name: "analyze_image",
    arguments: { imagePath: path.join(os.tmpdir(), "no-such-file.png") },
  });
  const badText = bad.content.map((c) => c.text).join("");
  assert(badText.includes("无法读取图片文件"), "文件不存在时返回可读错误");

  await client.close();
} finally {
  api.close();
  fs.unlinkSync(img);
}

console.log("\n全部通过 ✅");
