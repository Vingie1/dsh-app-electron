# dsh-deepseek-chat

DeepSeek 快问：DSH 桌面应用右上角的蓝色鲸鱼按钮，呼出一个**贴主窗右侧的无边框副窗口**，内嵌 [chat.deepseek.com](https://chat.deepseek.com/)（登录后可直接对话）。只有这一个站点、无任何浏览器功能。

## 是什么

- **Web 插件**（cordis bundle）：右上角按钮 + `Ctrl+Shift+D` 快捷键，经 sandbox 安全的 preload 桥（`window.dshChat`）开关副窗
- **Electron 壳件**（`electron/`）：副窗管理（无边框、贴主窗内容区右缘、主窗左移避让、DPI 自适应对齐）+ webview 安全栅栏（guest 锁死 chat.deepseek.com、弹窗/权限全拒、外链转系统浏览器）
- **一键安装**（`install.js`）：把壳件复制进现有桌面应用并幂等地 patch `main.js`

## 安装

### 1. 安装到 web profile

```sh
dsh plugin --profile web add dsh-deepseek-chat
# 或 git 安装：dsh plugin --profile web add github:<org>/dsh-deepseek-chat
```

### 2. 集成桌面壳（在 DeepSeek Harness 桌面应用目录）

```sh
node <路径>/dsh-deepseek-chat/install.js --app-dir <桌面应用目录>
# 例如：node node_modules/dsh-deepseek-chat/install.js --app-dir D:/harness-desktop
```

脚本会：
1. 复制 `electron/*` 到 `<app>/electron/`
2. patch `main.js`（幂等，可重复执行）：主窗 `webviewTag: true` + `chat-bridge-preload.js`；启动时 `registerChatWindow(...)`

### 3. 重启桌面应用

重启后右上角出现蓝色鲸鱼按钮 → 点击打开副窗 → 首次登录一次（手机验证码），之后重启免登录（`persist:deepseek-chat` 独立会话）。

## 行为

- **入口**：右上角蓝色鲸鱼按钮（唯一入口，透明背景融入窗口，悬停有浅色反馈）+ `Ctrl+Shift+D`
- **副窗**：无边框 480px、可拖动/调宽；顶边与主窗窗口顶平齐、底边与主窗内容区底平齐（DPI 舍入自动收敛到可达最优值）；主窗左移避让，拖动/缩放主窗自动跟随
- **状态保持**：副窗 webview 常驻，登录态/半截输入不丢
- **安全**：guest 无法导航出 chat.deepseek.com；无弹窗、无权限（摄像头/麦克风/地理位置）；外部 http(s) 链接转系统浏览器
- **降级**：普通浏览器打开 `dsh web`（无 Electron/preload 桥）时，按钮改为直接打开官网新标签

## 验证

`electron/verify-plugin.js` 是对应桌面壳的回归验证器（共用 `webview-gate.js` / `chat-window.js`）：加载真实 GUI → 断言按钮、副窗对齐（顶=窗口顶、底=内容底、右=内容区右缘）、开/关/关闭条、guest 导航锁。运行前先起服务：

```sh
cd ~/.dsh && node <app>/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 3080
cd <app>/electron && ./node_modules/electron/dist/electron.exe verify-plugin.js
```

> 注意：部分环境 shell 设置了 `ELECTRON_RUN_AS_NODE=1`，直接运行 electron.exe 前需 `unset ELECTRON_RUN_AS_NODE`。

## 已知限制

- 副窗宽度固定 480px（无记忆）；关闭后下次重开回默认
- 屏幕过窄时主窗无法左移避让，副窗叠放于右缘（此时主窗右上角按钮被遮，靠副窗顶部关闭钮关闭）
- 若 DeepSeek 登录流程引入 SSO 弹窗/外部域跳转，需按实际流量扩 `electron/webview-gate.js` 白名单
