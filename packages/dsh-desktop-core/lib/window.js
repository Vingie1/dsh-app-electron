/**
 * The desktop window row: the native BrowserWindow life cycle.
 *
 * Watches the supervisor's 'desktop/bridge-ready' event and opens the DSH
 * GUI at the real (OS-assigned) web port. Behavior carried over from the
 * old dumb shell: bounds memory, external-link policy, taskbar identity.
 *
 * This row is a plain Cordis plugin like any other: disable it in the
 * desktop profile's cordis.patch.yml and the tree runs headless; override
 * its config to change size, title, or the URL entirely. There is no
 * Electron code anywhere except this package.
 *
 * @module dsh-desktop-core/window
 */

import { BrowserWindow, app, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

export const name = 'desktop-window'

export default class WindowService extends Service {
  /** Service-row config, validated by the Loader at activation. */
  static Config = z.object({
    /** Window title. */
    title: z.string().default('DeepSeek Harness'),
    /** Hard floor, matching the old shell. */
    minWidth: z.number().default(900),
    minHeight: z.number().default(600),
    backgroundColor: z.string().default('#ffffff'),
    autoHideMenuBar: z.boolean().default(true),
    /** Bounds memory file; defaults to $DSH_HOME/desktop/window-state.json. */
    stateFile: z.string().default(''),
    /** Optional window icon path. */
    icon: z.string().default(''),
    /** Optional absolute URL override; defaults to the bridge-reported port. */
    url: z.string().default(''),
    /** The DSH home; defaults to resolveDshHome(). */
    dshHome: z.string().default(''),
  })

  constructor(ctx, config) {
    super(ctx, 'desktopWindow')
    this.config = config
    this.logger = ctx.logger('desktop-window')
    this.dshHome = config.dshHome || resolveDshHome()
    this.stateFile = config.stateFile || join(this.dshHome, 'desktop', 'window-state.json')
    this.window = null
    this.readyUrl = null
    ctx.on('desktop/bridge-ready', ({ port }) => this.open(port))
    // Deterministic teardown on HMR reload and on app quit (Service has no
    // dispose hook; ctx effects are how Cordis rows clean up).
    ctx.effect(() => () => this._dispose())
  }

  log(line) {
    this.logger.info(line)
  }

  open(port) {
    const url = this.config.url || `http://127.0.0.1:${String(port)}`
    if (this.window && !this.window.isDestroyed()) {
      this.log(`bridge-ready already handled; focusing ${url}`)
      this.window.focus()
      return
    }
    const state = this.loadState()
    const icon = this.config.icon || join(this.dshHome, 'desktop', 'icon.ico')
    this.window = new BrowserWindow({
      width: state.width,
      height: state.height,
      ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
      minWidth: this.config.minWidth,
      minHeight: this.config.minHeight,
      title: this.config.title,
      ...(icon && existsSync(icon) ? { icon } : {}),
      autoHideMenuBar: this.config.autoHideMenuBar,
      backgroundColor: this.config.backgroundColor,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    })

    // Taskbar identity (Windows derives the icon from the window; the
    // AppUserModelId keeps the grouping stable and the pinned icon).
    try { app.setAppUserModelId('deepseek.harness') } catch {}

    this.window.once('ready-to-show', () => this.window?.show())

    // External links / new windows -> default browser, never inside the shell.
    this.window.webContents.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:\/\//.test(target)) shell.openExternal(target)
      return { action: 'deny' }
    })
    this.window.webContents.on('will-navigate', (event, target) => {
      if (!target.startsWith(url)) {
        event.preventDefault()
        if (/^https?:\/\//.test(target)) shell.openExternal(target)
      }
    })

    this.window.on('close', () => this.saveState())
    this.window.on('closed', () => {
      this.window = null
    })

    this.readyUrl = url
    this.log(`opening ${url}`)
    this.window.loadURL(url)
    this.ctx.emit('desktop/window-created', { url })
  }

  /** Restore the last bounds, tolerating a missing/corrupt file. */
  loadState() {
    try {
      const parsed = JSON.parse(readFileSync(this.stateFile, 'utf8'))
      if (parsed && typeof parsed === 'object') return parsed
    } catch {}
    return { width: 1440, height: 900 }
  }

  saveState() {
    const win = this.window
    if (!win || win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return
    try {
      const bounds = win.getBounds()
      mkdirSync(dirname(this.stateFile), { recursive: true })
      const tmp = `${this.stateFile}.tmp`
      writeFileSync(tmp, JSON.stringify({ width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y }))
      renameSync(tmp, this.stateFile)
    } catch {}
  }

  async _dispose() {
    if (this.window && !this.window.isDestroyed()) {
      this.saveState()
      this.window.destroy()
      this.window = null
    }
  }
}

