# dsh-app-electron

DeepSeek Harness 桌面端全家桶——Electron 壳 + DeepSeek 快问副窗插件 + 可复现的 DSH 配置脚手架。clone 下来跑一次 `setup.js`，笔记本上就能复现这台设备的桌面形态（布局、插件、设置；登录态/密钥除外）。

## 结构

```
electron/            Electron 壳（主进程）+ 副窗（chat-window） + webview 安全栅栏 + 回归验证器
packages/            工作区包：
  dsh-desktop-app     桌面 profile 聚合（dsh-desktop-core bundle）
  dsh-desktop-bridge  （占位桥）
  dsh-desktop-core    desktop profile bundle：supervisor + window 服务
  dsh-deepseek-chat   DeepSeek 快问插件（可选安装，独立发布为 Vingie1/dsh-deepseek-chat）
app/                 @deepseek-ai/dsh 运行时安装点（package.json + lockfile）
assets/              deepseek.ico（窗口/任务栏图标）等
scaffolds/           ~/.dsh 的脱敏脚手架（空壳：只含官方基础 bundles，无任何插件、无密钥）
setup.js             一键初始化：装依赖 → 搭 ~/.dsh 空壳
```

## 快速开始（新机器）

```sh
git clone https://github.com/Vingie1/dsh-app-electron.git
cd dsh-app-electron
node setup.js
```

`setup.js` 会：
1. `pnpm install`（根 workspace + app/ + electron/）
2. 从 `scaffolds/` 生成 `~/.dsh`（settings + web/desktop profiles，**只含官方基础 bundles，空壳**）
3. 提示你要配置的环境变量

然后启动：

```sh
npm start
```

**这是空壳架构，插件自行安装**，例如：

```sh
dsh plugin --profile web add dshmarket                    # 插件市场
dsh plugin --profile web add github:Vingie1/dsh-deepseek-chat  # DeepSeek 快问副窗
```

首次使用在设置里配置模型 API Key（如 `OPENCODE_GO_API_KEY`）。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_HOME` | `~/.dsh` | DSH 主目录 |
| `DSH_PORT` | `3080` | dsh web 服务端口 |
| `DSH_NODE` | `node`（PATH） | dsh 运行时用的 Node 可执行文件 |

## 桌面壳行为

- 单实例；启动/复用 dsh web 服务（dsh 子进程提前退出时快速失败并提示）
- 无边框外链拦截：`https?` 一律系统浏览器
- 副窗（dsh-deepseek-chat）：右上角蓝色鲸鱼按钮 → 无边框副窗贴主窗内容区右缘（顶=窗口顶、底=内容底、DPI 自适应对齐），主窗左移避让；guest 锁死 chat.deepseek.com、无弹窗、无权限
- 窗口位置/大小记忆（`electron/window-state.json`，不提交）

## 验证

```sh
# 起 dsh web（若未随应用启动）
cd ~/.dsh && node ../app/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 3080
# 跑壳 + 插件回归
cd electron && ./node_modules/electron/dist/electron.exe verify-plugin.js
```

## 隐私边界

- **不提交**：`.mcp.json`（含视觉 API Key）、`.credentials.yaml`、`~/.dsh` 原目录、日志、窗口状态、会话数据
- `scaffolds/settings.yaml` 只含环境变量**名**，密钥一律由各设备在 DSH UI 里配置
- 登录态（chat.deepseek.com / DSH 会话）按设备各自登录，不同步
