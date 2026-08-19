/**
 * dsh-desktop-app — Electron main entry.
 *
 * The desktop shell is not a shell: it is the second, isomorphic Cordis
 * host. This file only owns the launch sequence —
 *
 *   single-instance lock
 *     → ensure runtime dirs + icon under $DSH_HOME/desktop
 *     → heal the shared module fallback (profiles/node_modules)
 *     → seed the desktop profile (idempotent) and rewrite the empty root
 *     → boot("dsh-desktop-app", profiles/desktop/cordis.yml, patches)
 *     → watch the user patch layers (HMR hot reload)
 *     → wire process lifetime (fail-loud, window-all-closed, before-quit)
 *
 * Everything the user can change — window, spawn behavior, bridge — is a
 * row in the desktop tree, patchable from profiles/desktop/cordis.patch.yml
 * with the same dialect web plugins use. If the tree fails to boot, the
 * recovery path retries with bundle rows only.
 *
 * @module dsh-desktop-app
 */

import { app, BrowserWindow, dialog } from 'electron'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PROFILE_PATCH_FILENAME,
  boot,
  healProfilesModuleFallback,
  initProfile,
  installFailLoud,
  loadOptionalPatches,
  loadProfile,
  resolveProfileDir,
  watchUserPatches,
} from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

const BIN = 'dsh-desktop-app'

/** The desktop tree's bundle layer — the app's own core, like dsh-base for web. */
const DESKTOP_BUNDLES = ['dsh-desktop-core']

/** Anchor for bundle resolution and module fallback healing: this app's manifest. */
const INSTALL_ANCHOR = fileURLToPath(new URL('./package.json', import.meta.url))

/** App-owned icon staged into the desktop runtime dir. */
const ICON_SOURCE = fileURLToPath(new URL('../../assets/deepseek.ico', import.meta.url))

/** The empty root every profile tree patches over (same text as the CLI's). */
const PROFILE_ROOT_CONFIG = `# dsh desktop profile root — an empty entry list. The tree is composed as
# patches: each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml,
# then any --patch overlays. Edit cordis.patch.yml, not this file.
[]
`

let tree = null
let treeDisposed = false

/** Append a line to the app log (best effort). */
function log(line) {
  try {
    const file = join(resolveDshHome(), 'desktop', 'app.log')
    writeFileSync(file, `[${new Date().toISOString()}] main: ${line}\n`, { flag: 'a' })
  } catch {}
}

function homePatchPath(home) {
  return join(home, PROFILE_PATCH_FILENAME)
}

function ensureRuntimeDir(home) {
  mkdirSync(join(home, 'desktop'), { recursive: true })
  const iconTarget = join(home, 'desktop', 'icon.ico')
  try {
    if (!existsSync(iconTarget) && existsSync(ICON_SOURCE)) copyFileSync(ICON_SOURCE, iconTarget)
  } catch {}
}

/** Junction-or-symlink helper, same semantics as the booter's ensureSymlink. */
function ensureLink(link, target) {
  let stat
  try { stat = lstatSync(link) } catch { stat = undefined }
  if (stat !== undefined) {
    if (!stat.isSymbolicLink()) throw new Error(`dsh-desktop-app: ${link} exists and is not a symlink; remove it so the app can manage the module fallback`)
    if (readlinkSync(link) === target) return
    unlinkSync(link)
  }
  try {
    symlinkSync(target, link, 'junction')
  } catch (error) {
    if (error.code !== 'EEXIST' || !lstatSync(link).isSymbolicLink() || readlinkSync(link) !== target) throw error
  }
}

/**
 * Extend the shared module fallback ($DSH_HOME/profiles/node_modules) with
 * every profile's top-level user packages. The DSH child runs as
 * ELECTRON_RUN_AS_NODE, where the loader's internal-import helper cannot work
 * (the node-addon-require-builtin native module refuses Electron's embedder),
 * so the loader falls back to plain import() anchored at its own file and
 * resolves upward through the flat fallback. healProfilesModuleFallback only
 * links the app manifest's closure (@deepseek-ai/*); profile-installed user
 * plugins (e.g. dsh-v-customize in the web profile) would otherwise be
 * invisible to the child and the web tree would fail to load.
 */
function healProfilePlugins(home) {
  const profilesDir = join(home, 'profiles')
  const modulesDir = join(profilesDir, 'node_modules')
  let profiles
  try {
    profiles = readdirSync(profilesDir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'node_modules')
  } catch { return }
  for (const profile of profiles) {
    const nm = join(profilesDir, profile.name, 'node_modules')
    if (!existsSync(nm)) continue
    for (const entry of readdirSync(nm, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      // The @deepseek-ai closure is the upstream heal's domain; mixing
      // profile-local versions into it would be nondeterministic.
      if (entry.name === '@deepseek-ai') continue
      const names = entry.name.startsWith('@')
        ? readdirSync(join(nm, entry.name)).map((sub) => `${entry.name}/${sub}`)
        : [entry.name]
      for (const name of names) {
        const link = join(modulesDir, ...name.split('/'))
        const target = join(nm, ...name.split('/'))
        // Keep the first profile that provides a name (profiles are iterated
        // in directory order). lstat, not existsSync: a stale broken link is
        // still an existing link.
        if (lstatSync(link, { throwIfNoEntry: false })) continue
        try { ensureLink(link, target) } catch {}
      }
    }
  }
}

/**
 * Compose the desktop tree's patch stack on every boot and on HMR refreshes:
 * bundle layers (in dsh.profile.bundles order) → profile user layer → home
 * user layer. Recovery mode keeps only the bundle layers.
 */
function composeLive(bundlePatches, profilePath, homePath, recovery) {
  return structuredClone([
    ...bundlePatches,
    ...(recovery ? [] : (loadOptionalPatches(BIN, profilePath) ?? [])),
    ...(recovery ? [] : (loadOptionalPatches(BIN, homePath) ?? [])),
  ])
}

/**
 * Seed + boot the desktop tree. Mirrors the CLI's runProfile, minus the
 * telemetry/agent-presets overlays (the desktop tree carries no dsh-base).
 * @param mode - 'normal' or 'recovery' (bundle rows only).
 * @returns the settled root context.
 */
async function bootDesktop(mode) {
  const home = resolveDshHome()
  ensureRuntimeDir(home)
  // The module fallback must be healed before loadProfile resolves bundles.
  healProfilesModuleFallback(INSTALL_ANCHOR, home)
  healProfilePlugins(home)
  const dir = resolveProfileDir('desktop', home)
  initProfile(dir, DESKTOP_BUNDLES)
  const rootConfig = join(dir, 'cordis.yml')
  // The Loader's tree write-back bakes composed rows into this file; always
  // rewrite the empty root so bundle inserts never duplicate.
  writeFileSync(rootConfig, PROFILE_ROOT_CONFIG)
  const profile = loadProfile(BIN, 'desktop', INSTALL_ANCHOR, home, {
    userLayer: mode !== 'recovery',
  })
  const bundlePatches = profile.layers.flatMap((layer) => layer.patches)
  const homePath = homePatchPath(home)
  const patches = composeLive(bundlePatches, profile.patchPath, homePath, mode === 'recovery')
  const ctx = await boot(BIN, rootConfig, patches)
  // HMR is disabled in the desktop tree on purpose (cordis-plugin-hmr's
  // service needs --expose-internals, which Electron's main process cannot
  // turn on), and watchUserPatches attaches to the HMR service — it throws
  // when the service is absent. So the user-patch hot reload only engages
  // when a desktop-profile patch layer actually enables the hmr row; the
  // default desktop tree applies user patches on restart, like the web
  // profile's --patch overlays. P2 replaces this with a restart-based
  // watcher (dispose + composeLive re-boot), the same shape the CLI uses
  // for bundle changes.
  if (ctx.get('hmr')) {
    await watchUserPatches(ctx, {
      binName: BIN,
      filename: profile.patchPath,
      compose: (base) => composeLive(bundlePatches, profile.patchPath, homePath, false),
    })
    await watchUserPatches(ctx, {
      binName: BIN,
      filename: homePath,
      compose: (base) => composeLive(bundlePatches, profile.patchPath, homePath, false),
    })
  }
  log(`desktop tree booted (mode ${mode})`)
  return ctx
}

async function startTree() {
  try {
    return await bootDesktop('normal')
  } catch (error) {
    const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
    log(`boot failed: ${detail}`)
    const choice = dialog.showMessageBoxSync({
      type: 'error',
      title: 'DeepSeek Harness',
      message: '桌面层插件树启动失败。\n可在恢复模式下仅加载内置行重试（用户补丁层将被跳过）。',
      detail,
      buttons: ['恢复模式重试', '退出'],
      defaultId: 0,
      cancelId: 1,
    })
    if (choice !== 0) return null
    try {
      return await bootDesktop('recovery')
    } catch (error2) {
      const detail2 = error2 instanceof Error ? error2.message : String(error2)
      log(`recovery boot failed: ${detail2}`)
      dialog.showErrorBox('DeepSeek Harness', `恢复模式启动也失败：\n${detail2}\n\n请查看 ${join(resolveDshHome(), 'desktop', 'app.log')}`)
      return null
    }
  }
}

async function disposeTree() {
  if (!tree) return
  const ctx = tree
  tree = null
  try {
    await ctx.fiber.dispose()
    log('desktop tree disposed')
  } catch (error) {
    log(`tree dispose failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ---------------- single instance ----------------
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // P2 routes deep links here; P0 only refocuses the window.
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    log('=== DeepSeek Harness (desktop tree) start ===')
    // After the tree settles, any late unhandled plugin rejection is a fatal
    // load failure with a labelled diagnostic.
    installFailLoud(BIN, process, async () => {
      await disposeTree()
    })
    tree = await startTree()
    if (!tree) {
      app.quit()
      return
    }
    // Closing the last window = closing the whole app (X button semantics,
    // carried over from the old shell).
    app.on('window-all-closed', () => app.quit())
    app.on('before-quit', (event) => {
      if (treeDisposed) return
      event.preventDefault()
      disposeTree().finally(() => {
        treeDisposed = true
        log('=== DeepSeek Harness exited ===')
        app.quit()
      })
    })
  })

  app.on('activate', () => {
    // win32 has no dock-activate; kept for parity with the old shell.
  })
}
