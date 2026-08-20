// DeepSeek Harness Electron desktop shell — main process.
// Responsibilities:
//   1) single-instance enforcement
//   2) start/reuse the dsh web service (background)
//   3) open a chrome-less window loading the GUI
//   4) whale icon on both the title bar and the Windows taskbar
//   5) close window (X) -> side window closes with it -> stop dsh service -> quit
//   6) remember window size/position across launches
//   7) external links open in the default browser, never in the shell

'use strict'

const { app, BrowserWindow, Menu, shell, dialog } = require('electron')
const { spawn, exec } = require('child_process')
const path = require('path')
const fs = require('fs')
const net = require('net')
const { registerChatWindow } = require('./chat-window.js')

// ---------------- config ----------------
// All paths resolve relative to the repo root (portable across machines);
// DSH_HOME / DSH_PORT / DSH_NODE can be overridden via environment.
const os = require('os')
const APP_ROOT = path.resolve(__dirname, '..')
const NODE    = process.env.DSH_NODE || 'node'
const DSH_CLI = path.join(APP_ROOT, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PORT    = Number(process.env.DSH_PORT || 3080)
const GUI_URL = `http://127.0.0.1:${PORT}`
const ICON    = path.join(APP_ROOT, 'assets', 'deepseek.ico')
const LOG     = path.join(APP_ROOT, 'electron.log')
const STATE   = path.join(__dirname, 'window-state.json')

let dshProcess = null
let mainWindow = null
let chatSide = null // chat side-window controller (closed with the main window)

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  try { fs.appendFileSync(LOG, line + '\n') } catch {}
}

// ---------------- webview guest hardening ----------------
// The dsh-deepseek-chat plugin embeds chat.deepseek.com in a <webview>.
// Guests are locked to that origin: no navigation elsewhere, no popups
// (external http(s) links go to the default browser), no permissions.
// Shared with the verification harness: electron/webview-gate.js
const { installWebviewGuestHardeners, installAttachGate } = require('./webview-gate.js')
installWebviewGuestHardeners(app, shell, log)

function isListening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' })
    let settled = false
    const done = (v) => { if (!settled) { settled = true; s.destroy(); resolve(v) } }
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
    s.setTimeout(800, () => done(false))
  })
}

async function startDsh() {
  if (await isListening(PORT)) {
    log(`dsh already running on port ${PORT}, reusing it`)
    return true
  }
  log('starting dsh web service...')
  let exitedEarly = false
  try {
    // --no-open: the web command would pop the default browser otherwise.
    dshProcess = spawn(NODE, [DSH_CLI, 'web', '--port', String(PORT), '--no-open'], {
      cwd: DSH_HOME,
      env: Object.assign({}, process.env, { DSH_HOME }),
      windowsHide: true,
      stdio: 'ignore',
      detached: false,
    })
    dshProcess.on('exit', (code) => {
      log(`dsh process exited (code ${code})`)
      // Dying before the port comes up (e.g. EADDRINUSE from a leftover
      // service) means a wait is pointless — fail fast instead of 45s.
      exitedEarly = true
    })
    dshProcess.on('error', (err) => log(`dsh process error: ${err.message}`))
  } catch (err) {
    log(`dsh spawn failed: ${err.message}`)
    return false
  }
  for (let i = 0; i < 45; i++) {
    if (await isListening(PORT)) {
      log(`dsh ready on port ${PORT} (after ${i + 1}s)`)
      return true
    }
    if (exitedEarly) {
      log('dsh process exited before becoming ready — failing fast')
      return false
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  log('dsh did not become ready within 45s')
  return false
}

// Stop the dsh service: kill the process tree of whoever listens on PORT.
function stopDsh() {
  return new Promise((resolve) => {
    const killPid = (pid) => {
      exec(`taskkill /pid ${pid} /T /F`, () => resolve())
    }
    if (dshProcess && dshProcess.pid) {
      log(`stopping dsh (pid ${dshProcess.pid})`)
      return killPid(dshProcess.pid)
    }
    exec(`netstat -ano | findstr :${PORT} | findstr LISTENING`, (err, stdout) => {
      const m = stdout && stdout.match(/[^\s]+\s+[^\s]+\s+[^\s]+\s+[^\s]+\s+(\d+)/)
      if (m && m[1]) {
        log(`stopping dsh on port ${PORT} (pid ${m[1]})`)
        return killPid(m[1])
      }
      log('no dsh process found to stop')
      resolve()
    })
  })
}

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'))
  } catch {
    return { width: 1440, height: 900 }
  }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isMaximized() || mainWindow.isFullScreen()) return
  try {
    const b = mainWindow.getBounds()
    fs.writeFileSync(STATE, JSON.stringify({ width: b.width, height: b.height, x: b.x, y: b.y }))
  } catch {}
}

function createWindow() {
  const state = loadWindowState()
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
    minWidth: 900,
    minHeight: 600,
    title: 'DeepSeek Harness',
    icon: ICON,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: true, // dsh-deepseek-chat plugin embeds chat.deepseek.com
      preload: path.join(__dirname, 'chat-bridge-preload.js'),
    },
  })

  // Security gate for <webview> attachment: only chat.deepseek.com guests
  // may attach, and they never get preload/node access.
  installAttachGate(mainWindow.webContents, log)

  // Whale icon on the taskbar too (Windows derives it from the window icon,
  // but AppUserModelId keeps the grouping stable and the icon pinned).
  try { app.setAppUserModelId('deepseek.harness') } catch {}

  // Ready -> show without a white flash.
  mainWindow.once('ready-to-show', () => mainWindow.show())

  // External links / new windows -> default browser, never inside the shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  // User explicitly navigates to an external site -> open externally, stay put.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(GUI_URL)) {
      event.preventDefault()
      if (/^https?:\/\//.test(url)) shell.openExternal(url)
    }
  })

  mainWindow.on('close', saveWindowState)
  mainWindow.on('closed', () => {
    chatSide.close() // the side window must not outlive the main window
    mainWindow = null
  })

  mainWindow.loadURL(GUI_URL)
}

// ---------------- single instance ----------------
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    log('=== DeepSeek Harness (Electron) start ===')
    Menu.setApplicationMenu(null) // no menu bar: native-app feel
    const ready = await startDsh()
    if (!ready) {
      log('dsh failed to start; showing error dialog')
      dialog.showErrorBox('DeepSeek Harness', `无法启动 DeepSeek Harness 服务（端口 ${PORT} 未能就绪）。\n请查看 ${LOG}`)
      app.quit()
      return
    }
    createWindow()
    // Chat side window (dsh-deepseek-chat): frameless dock + shift main left.
    chatSide = registerChatWindow({ getMainWindow: () => mainWindow, log })
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // Closing the last window = closing the whole app (X button semantics).
  app.on('window-all-closed', async () => {
    log('window closed, stopping dsh service')
    await stopDsh()
    log('=== DeepSeek Harness (Electron) exited ===')
    app.quit()
  })

  // Extra safety: on quit, always try to stop the service we own.
  app.on('before-quit', () => { saveWindowState() })
}
