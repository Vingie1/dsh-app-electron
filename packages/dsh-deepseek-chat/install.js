#!/usr/bin/env node
/**
 * dsh-deepseek-chat — desktop shell installer.
 *
 * The web plugin only renders the corner button; the side window itself is
 * owned by the Electron shell. This script integrates the shipped shell
 * pieces into an existing DeepSeek Harness desktop app:
 *
 *   1. copies electron/* into <app>/electron/
 *   2. patches <app>/electron/main.js (idempotent):
 *        - webviewTag: true + preload in the main window webPreferences
 *        - require('./chat-window.js') + registerChatWindow() at boot
 *
 * Usage:
 *   node install.js --app-dir D:/path/to/harness-desktop
 *   (defaults to ../.. relative to this file, i.e. a repo layout like
 *    <repo>/packages/dsh-deepseek-chat)
 */

'use strict'

const fs = require('fs')
const path = require('path')

const HERE = __dirname
const ELECTRON_SRC = path.join(HERE, 'electron')
const FILES = ['chat-window.js', 'chat-bridge-preload.js', 'chat-panel-preload.js', 'chat-panel.html', 'webview-gate.js']

const MARK = 'dsh-deepseek-chat'

function main() {
  const args = process.argv.slice(2)
  let appDir = null
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--app-dir') appDir = args[i + 1]
  }
  appDir = appDir ? path.resolve(appDir) : path.resolve(HERE, '..', '..')
  const electronDir = path.join(appDir, 'electron')
  const mainJs = path.join(electronDir, 'main.js')

  if (!fs.existsSync(mainJs)) {
    console.error(`✗ no electron/main.js found under ${appDir} — pass --app-dir`)
    process.exit(1)
  }

  // 1. copy shell pieces
  for (const f of FILES) {
    fs.copyFileSync(path.join(ELECTRON_SRC, f), path.join(electronDir, f))
    console.log(`✓ copied electron/${f}`)
  }

  // 2. patch main.js (idempotent)
  let main = fs.readFileSync(mainJs, 'utf8')
  if (main.includes(MARK)) {
    console.log('✓ main.js already integrated, skipping')
    return
  }

  // require + registration
  const requireLine = `const { registerChatWindow } = require('./chat-window.js') // ${MARK}`
  if (!/registerChatWindow/.test(main)) {
    const anchor = /const net = require\('net'\)/
    if (!anchor.test(main)) {
      console.error('✗ cannot find require anchor in main.js (net require)')
      process.exit(1)
    }
    main = main.replace(anchor, `$&\n${requireLine}`)
  }

  // webPreferences: webviewTag + preload
  const webPrefs = /webPreferences: \{[\s\S]*?\n    \},/
  if (!/webviewTag/.test(main)) {
    const wm = main.match(/webPreferences: \{([\s\S]*?)\n    \},/)
    if (!wm) {
      console.error('✗ cannot find webPreferences block in main.js')
      process.exit(1)
    }
    main = main.replace(
      /(webPreferences: \{)([\s\S]*?)(\n    \},)/,
      `$1$2      webviewTag: true, // ${MARK}\n      preload: path.join(__dirname, 'chat-bridge-preload.js'), // ${MARK}$3`
    )
  }

  // register at boot (after createWindow())
  if (!/registerChatWindow/.test(main)) {
    main = main.replace(
      /(createWindow\(\))/,
      `$1\n    // ${MARK}: chat side window (frameless dock + main-window shift)\n    registerChatWindow({ getMainWindow: () => mainWindow, log })`
    )
  }

  fs.writeFileSync(mainJs, main)
  console.log('✓ main.js patched (webviewTag, preload, registerChatWindow)')
  console.log('\nDone. Restart the desktop app; add the plugin to the web profile:')
  console.log('  dsh plugin --profile web add dsh-deepseek-chat')
}

main()
