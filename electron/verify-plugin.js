// Plugin verification harness (side-window architecture): loads the real dsh
// web GUI (port 3080) in a BrowserWindow with the shipped gates + chat
// side-window registration, drives the top-right corner button, asserts the
// chat side window opens (glued to the right edge), the main window shifts
// left, close paths work, and the guest navigation lock holds.

'use strict'

const { app, BrowserWindow, shell } = require('electron')
const fs = require('fs')
const path = require('path')
const { installWebviewGuestHardeners, installAttachGate } = require('./webview-gate.js')
const { registerChatWindow } = require('./chat-window.js')

const OUT = path.join(__dirname, '..', 'assets', 'verify-out')
fs.mkdirSync(OUT, { recursive: true })
const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
  fs.appendFileSync(path.join(OUT, 'log.txt'), line + '\n')
}

// Same gates the shipped shell installs — the tested path is the real path.
installWebviewGuestHardeners(app, shell, log)

let guestEvents = []
let guestContents = null
app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return
  guestContents = contents
  guestEvents.push('created: ' + contents.getURL())
  contents.on('did-finish-load', () => guestEvents.push('finish: ' + contents.getURL()))
  contents.on('did-fail-load', (_e, code, desc, url) => guestEvents.push(`fail(${code} ${desc}): ${url}`))
  contents.on('page-title-updated', (_e, title) => guestEvents.push('title: ' + title))
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const js = (win, code) => win.webContents.executeJavaScript(code)

async function run() {
  const win = new BrowserWindow({
    width: 1440, height: 900, show: true,
    webPreferences: {
      webviewTag: true, contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(__dirname, 'chat-bridge-preload.js'),
    },
  })
  installAttachGate(win.webContents, log)
  // Pin the main window somewhere with room to shift left.
  win.setBounds({ x: 120, y: 40, width: 1440, height: 900 })
  registerChatWindow({ getMainWindow: () => win, log })
  win.webContents.on('console-message', (_e, level, message) => {
    if (/error|Error|warn|chat/i.test(message)) log(`console[${level}]: ${message.slice(0, 300)}`)
  })
  await win.loadURL('http://127.0.0.1:3080')
  log('GUI loaded')

  for (let i = 0; i < 90; i++) {
    if (await js(win, `!!document.querySelector('[data-dsh-chat-corner]')`)) break
    await sleep(1000)
  }
  log('corner present: ' + await js(win, `!!document.querySelector('[data-dsh-chat-corner]')`))
  log('corner rect: ' + await js(win, `(()=>{const r=document.querySelector('[data-dsh-chat-corner]')?.getBoundingClientRect();return r?Math.round(r.x)+','+Math.round(r.y)+' '+Math.round(r.width)+'x'+Math.round(r.height):'none'})()`))
  log('corner count: ' + await js(win, `document.querySelectorAll('[data-dsh-chat-corner]').length`))
  log('sidebar entry gone: ' + await js(win, `!document.querySelector('[data-dsh-chat-entry]')`))

  // ---- full-page plugin panels must not collide with the corner button ----
  // The panel convention is html[data-<panel>-active] while open (memoir,
  // ssh, taskboard). Toggle the attribute in the live page and assert the
  // whale hides under it and comes back after it is removed.
  log('corner under memoir panel: ' + await js(win, `(() => {
    const btn = document.querySelector('[data-dsh-chat-corner]');
    if (btn === null) return 'no-btn';
    const doc = document.documentElement;
    doc.setAttribute('data-dsh-memoir-active', '');
    const hidden = getComputedStyle(btn).display === 'none';
    doc.removeAttribute('data-dsh-memoir-active');
    const restored = getComputedStyle(btn).display !== 'none';
    return (hidden ? 'hidden' : 'VISIBLE-OVER-PANEL') + '/' + (restored ? 'restored' : 'GONE-AFTER-CLOSE');
  })()`))

  // ---- memoir v0.4+ observability strip hidden (bottom of the panel) ----
  // dsh-memoir may not be installed on every machine — only assert when the
  // strip element actually exists in the live GUI.
  log('memoir strip hidden: ' + await js(win, `(() => {
    const strip = document.querySelector('.memoir-panel .memoir-inspector');
    if (strip === null) return 'no-memoir (skip)';
    return getComputedStyle(strip).display === 'none' ? 'hidden' : 'VISIBLE';
  })()`))

  // ---- memoir boot-race repair (stale partial CSS) ----
  // Simulate the broken boot: drop memoir's own stylesheet, then open the
  // panel. The repair rules in our stylesheet must still lay the panel out
  // as a full-page overlay and hide the center-column content, and hide
  // the view again once the panel closes.
  log('memoir repair: ' + await js(win, `(() => {
    const view = document.querySelector('[data-dsh-memoir-view]');
    if (view === null) return 'no-memoir (skip)';
    document.querySelectorAll('style[data-plugin="dsh-memoir"]').forEach((s) => s.remove());
    const doc = document.documentElement;
    doc.setAttribute('data-dsh-memoir-active', '');
    const vcs = getComputedStyle(view);
    const childrenHidden = [...document.querySelectorAll('[class*="centerCol"] > *:not([data-dsh-memoir-view])')]
      .every((c) => getComputedStyle(c).display === 'none');
    const ok = vcs.position === 'absolute' && vcs.display === 'flex' &&
      view.getBoundingClientRect().width > 1000;
    doc.removeAttribute('data-dsh-memoir-active');
    const closed = getComputedStyle(view).display === 'none';
    return (ok ? 'panel-ok' : 'PANEL-BROKEN') + '/' + (childrenHidden ? 'children-hidden' : 'children-VISIBLE') + '/' + (closed ? 'closed-hidden' : 'closed-VISIBLE');
  })()`))

  // ---- open via corner button ----
  const boundsBefore = win.getBounds()
  await js(win, `document.querySelector('[data-dsh-chat-corner]').click()`)
  await sleep(4000)

  const wins = BrowserWindow.getAllWindows()
  const chatWin = wins.find((w) => w !== win && !w.isDestroyed())
  log('windows after open: ' + wins.length)
  log('chat window created: ' + (chatWin !== undefined))
  if (chatWin !== undefined) {
    log('chat win url: ' + chatWin.getURL())
    log('chat win bounds: ' + JSON.stringify(chatWin.getBounds()))
    const mb = win.getBounds()
    const cb = win.getContentBounds()
    const cw = chatWin.getBounds()
    log('aligned: ' + (cw.x === cb.x + cb.width && cw.y === mb.y && cw.y + cw.height <= mb.y + mb.height - 7 && cw.y + cw.height >= mb.y + mb.height - 8) +
      ' (panel x=' + cw.x + ' vs content right=' + (cb.x + cb.width) + ', top=' + cw.y + ' vs window top ' + mb.y + ', bottom=' + (cw.y + cw.height) + ' vs window bottom-7 target ' + (mb.y + mb.height - 7) + ')')
  }
  const boundsAfter = win.getBounds()
  log('main x before/after: ' + boundsBefore.x + ' -> ' + boundsAfter.x + ' (shift ' + (boundsBefore.x - boundsAfter.x) + ')')
  log('corner data-active: ' + await js(win, `document.querySelector('[data-dsh-chat-corner]')?.getAttribute('data-active')`))

  await sleep(15000)
  log('--- guest events ---')
  for (const line of guestEvents) log('  ' + line)
  log('guest loaded sign_in: ' + guestEvents.some((l) => l.includes('sign_in')))

  // ---- probe: what does setBounds(H) actually return? ----
  if (chatWin !== undefined) {
    const curve = []
    for (let h = 893; h <= 905; h++) {
      chatWin.setBounds({ x: chatWin.getBounds().x, y: 40, width: 480, height: h })
      curve.push(h + '->' + chatWin.getBounds().height)
    }
    log('bounds curve: ' + curve.join(' '))
  }

  // ---- close via corner button ----
  await js(win, `document.querySelector('[data-dsh-chat-corner]').click()`)
  await sleep(2000)
  log('windows after close: ' + BrowserWindow.getAllWindows().length)
  const afterClose = win.getBounds()
  log('main x restored: ' + afterClose.x + ' (was ' + boundsBefore.x + ')')
  log('corner data-active after close: ' + await js(win, `document.querySelector('[data-dsh-chat-corner]')?.getAttribute('data-active')`))

  // ---- reopen, close via the panel's own close bar ----
  await js(win, `document.querySelector('[data-dsh-chat-corner]').click()`)
  await sleep(3000)
  const chatWin2 = BrowserWindow.getAllWindows().find((w) => w !== win && !w.isDestroyed())
  log('reopened: ' + (chatWin2 !== undefined))
  if (chatWin2 !== undefined) {
    await chatWin2.webContents.executeJavaScript(`document.getElementById('close').click()`)
    await sleep(2000)
    log('windows after panel close bar: ' + BrowserWindow.getAllWindows().length)
    log('main x restored after panel close: ' + win.getBounds().x + ' (was ' + boundsBefore.x + ')')
  }

  // ---- navigation lock (real anchor click in guest) ----
  log('--- navigation lock test (anchor click in guest) ---')
  await js(win, `document.querySelector('[data-dsh-chat-corner]').click()`)
  await sleep(3000)
  const urlBefore = guestContents ? guestContents.getURL() : 'no-guest'
  if (guestContents !== null) {
    try {
      await guestContents.executeJavaScript(
        `(() => { const a = document.createElement('a'); a.href = 'https://example.com/'; a.textContent = 'x'; document.body.appendChild(a); a.click(); })()`
      )
    } catch {}
  }
  await sleep(4000)
  log('guest url before: ' + urlBefore)
  log('guest url after: ' + (guestContents ? guestContents.getURL() : 'no-guest'))

  app.exit(0)
}

app.whenReady().then(() => {
  run().catch((err) => { log('VERIFIER ERROR: ' + (err && err.stack || err)); app.exit(1) })
})
setTimeout(() => { log('HARD TIMEOUT'); app.exit(2) }, 240000)
