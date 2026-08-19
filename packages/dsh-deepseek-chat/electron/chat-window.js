// Chat side window (dsh-deepseek-chat): a frameless BrowserWindow docked to
// the main window's right edge, holding a <webview> of chat.deepseek.com.
//
// Behavior:
//  - toggling opens/closes the window via IPC from the main window
//    ('dsh-chat:toggle' / 'dsh-chat:get-state'); the panel's own close bar
//    closes it too ('dsh-chat:close').
//  - when open, the MAIN window shifts left by CHAT_WIDTH+GAP so the chat
//    never covers the conversation or the top-right corner button; when the
//    screen has no room to shift, the panel overlays the right edge (its
//    close bar still lets the user out).
//  - the panel tracks the main window (move/resize) while open.
//  - only chat.deepseek.com guests may attach inside the panel (same gate as
//    the main window).

'use strict'

const { BrowserWindow, ipcMain, screen } = require('electron')
const path = require('path')

const CHAT_WIDTH = 480
const SHIFT = CHAT_WIDTH

/**
 * Register the chat side-window surface on the app.
 * @param {object} deps
 * @param {() => Electron.BrowserWindow | null} deps.getMainWindow - main window accessor.
 * @param {(msg: string) => void} deps.log - log sink.
 */
function registerChatWindow({ getMainWindow, log }) {
  let chatWin = null
  let open = false
  let shifted = 0

  const stateChanged = () => {
    const main = getMainWindow()
    if (main && !main.isDestroyed()) main.webContents.send('dsh-chat:state-changed', open)
  }

  /**
   * Keep the panel glued to the main window: top aligned with the WINDOW top
   * (title bar included — the frameless panel starts at the same height),
   * height matching the window height (bottom flush with the main window),
   * left edge flush against the content area's right edge (seamless).
   */
  /**
   * Glue the panel to the main window: top = main window top (title bar
   * included), bottom = main window bottom MINUS 2px (the user-tuned inset),
   * left flush against the content area's right edge (seamless).
   *
   * Windows gives frameless windows an invisible resize border:
   * setBounds(H) comes back as H+1. Measure the actual delta once, then
   * PRE-subtract it from the target height so the bottom lands exactly on
   * the target.
   */
  const BOTTOM_INSET = 7
  const layout = () => {
    if (chatWin === null || chatWin.isDestroyed()) return
    const main = getMainWindow()
    if (main === null || main.isDestroyed()) return
    const mb = main.getBounds()
    const cb = main.getContentBounds()
    const work = screen.getDisplayMatching(mb).workArea
    let x = cb.x + cb.width // flush against the content area's right edge
    if (x + CHAT_WIDTH > work.x + work.width) x = work.x + work.width - CHAT_WIDTH
    // Frameless windows on Windows round setBounds to physical pixels (DPI):
    // on this machine (125%) the returned height is H for H≡1 (mod 4), H+1
    // otherwise, so some target heights are unreachable. Strategy: try the
    // target and 4 values below it, keep the largest ACTUAL height that does
    // not exceed the target (the panel must never extend past mb.bottom).
    const targetH = mb.height - BOTTOM_INSET
    let bestH = null
    for (let k = 0; k <= 4; k++) {
      chatWin.setBounds({ x, y: mb.y, width: CHAT_WIDTH, height: targetH - k })
      const h = chatWin.getBounds().height
      if (h === targetH) { bestH = h; break }
      if (h <= targetH && (bestH === null || h > bestH)) bestH = h
    }
    if (bestH !== null && bestH !== targetH) {
      chatWin.setBounds({ x, y: mb.y, width: CHAT_WIDTH, height: bestH })
    }
  }

  const openChat = () => {
    if (open) return
    const main = getMainWindow()
    if (main === null || main.isDestroyed()) return
    const mb = main.getBounds()
    const work = screen.getDisplayMatching(mb).workArea
    // Shift the main window left to make room (clamped to the work area).
    shifted = Math.min(SHIFT, Math.max(0, mb.x - work.x))
    if (shifted > 0) main.setBounds({ x: mb.x - shifted, y: mb.y, width: mb.width, height: mb.height })

    const cb = main.getContentBounds()
    chatWin = new BrowserWindow({
      width: CHAT_WIDTH,
      height: mb.height,
      x: cb.x + cb.width,
      y: mb.y,
      frame: false,
      resizable: true,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        webviewTag: true,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, 'chat-panel-preload.js'),
      },
    })
    chatWin.loadFile(path.join(__dirname, 'chat-panel.html'))
    chatWin.once('ready-to-show', () => {
      chatWin.show()
      layout() // re-align now that the window is visible (real border geometry)
    })
    chatWin.webContents.on('will-attach-webview', (_event, prefs, params) => {
      const ok = typeof params.src === 'string' && params.src.startsWith('https://chat.deepseek.com')
      if (!ok) {
        log(`chat window blocked webview attach: ${params.src}`)
        _event.preventDefault()
        return
      }
      delete prefs.preload
      prefs.nodeIntegration = false
      prefs.contextIsolation = true
      prefs.sandbox = true
    })

    open = true
    const onMainMove = () => layout()
    main.on('move', onMainMove)
    main.on('resize', onMainMove)
    chatWin.on('closed', () => {
      main.removeListener('move', onMainMove)
      main.removeListener('resize', onMainMove)
      chatWin = null
      if (open) closeChat() // user closed the panel (or it crashed) — restore
    })
    layout()
    stateChanged()
  }

  const closeChat = () => {
    if (!open) return
    open = false
    const main = getMainWindow()
    if (main !== null && !main.isDestroyed()) {
      if (shifted > 0) {
        const mb = main.getBounds()
        main.setBounds({ x: mb.x + shifted, y: mb.y, width: mb.width, height: mb.height })
        shifted = 0
      }
      stateChanged()
    }
    if (chatWin !== null && !chatWin.isDestroyed()) chatWin.close()
    chatWin = null
  }

  const toggle = () => (open ? closeChat() : openChat())

  // IPC: main-window preload bridge (dshChat) and the panel's own close bar.
  ipcMain.handle('dsh-chat:toggle', () => toggle())
  ipcMain.handle('dsh-chat:get-state', () => open)
  ipcMain.on('dsh-chat:close', () => closeChat())

  return { open, toggle, close: closeChat, isOpen: () => open }
}

module.exports = { registerChatWindow, CHAT_WIDTH }
