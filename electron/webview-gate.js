// Webview guest hardening, shared by main.js (the real shell) and the
// plugin verification harness so the tested path is the shipped path.
//
// Policy: the only sanctioned webview is the dsh-deepseek-chat panel
// embedding chat.deepseek.com. Guests are locked to that origin — no
// navigation elsewhere, no popups (external http(s) links open in the
// default browser), no permission grants.

'use strict'

const CHAT_ORIGIN = 'https://chat.deepseek.com'

/**
 * Harden every webview guest created by the process.
 * @param {Electron.App} app - the Electron app instance (for events).
 * @param {Electron.Shell} shell - shell service (openExternal).
 * @param {(msg: string) => void} log - log sink.
 */
function installWebviewGuestHardeners(app, shell, log) {
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return
    contents.on('will-navigate', (event, url) => {
      if (!url.startsWith(CHAT_ORIGIN)) {
        log(`webview blocked navigation: ${url}`)
        event.preventDefault()
        if (/^https?:\/\//.test(url)) shell.openExternal(url)
      }
    })
    contents.setWindowOpenHandler(({ url }) => {
      log(`webview blocked popup: ${url}`)
      if (/^https?:\/\//.test(url)) shell.openExternal(url)
      return { action: 'deny' }
    })
    const ses = contents.session
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    ses.setPermissionCheckHandler(() => false)
  })
}

/**
 * Gate for the embedder's will-attach-webview: only chat.deepseek.com guests
 * may attach, and guests never get preload/node access (keep the sandboxed
 * defaults, set them explicitly anyway).
 * @param {Electron.WebContents} embedder - the window's webContents.
 * @param {(msg: string) => void} log - log sink.
 */
function installAttachGate(embedder, log) {
  embedder.on('will-attach-webview', (event, webPreferences, params) => {
    const ok = typeof params.src === 'string' && params.src.startsWith(CHAT_ORIGIN)
    if (!ok) {
      log(`blocked webview attach: ${params.src}`)
      event.preventDefault()
      return
    }
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
  })
}

module.exports = { installWebviewGuestHardeners, installAttachGate, CHAT_ORIGIN }
