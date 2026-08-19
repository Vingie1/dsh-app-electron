/**
 * Probe: boot the desktop tree inside the real Electron main process (window
 * row enabled) and dump the full failure — including AggregateError inner
 * errors, which main.js's dialog truncates to the outer message.
 *
 * Usage (from packages/dsh-desktop-app):
 *   env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron ../../scripts/probe-window-boot.mjs
 *
 * Writes to $DSH_HOME/desktop/probe.log.
 */

import { app } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  boot,
  healProfilesModuleFallback,
  initProfile,
  loadProfile,
  resolveProfileDir,
} from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

const BIN = 'dsh-desktop-app-probe'
const INSTALL_ANCHOR = fileURLToPath(new URL('../packages/dsh-desktop-app/package.json', import.meta.url))

const out = join(resolveDshHome(), 'desktop', 'probe.log')
const say = (line) => {
  try { writeFileSync(out, `${line}\n`, { flag: 'a' }) } catch {}
}

function dumpError(error, depth = 0) {
  if (!error) return
  say(`${'  '.repeat(depth)}${error instanceof Error ? error.stack : String(error)}`)
  if (error instanceof AggregateError && error.errors?.length) {
    for (const inner of error.errors) dumpError(inner, depth + 1)
  }
  if (error.cause && error.cause !== error) dumpError(error.cause, depth + 1)
}

app.whenReady().then(async () => {
  say(`=== probe start ${process.versions.electron} node=${process.versions.node} ===`)
  try {
    const home = resolveDshHome()
    healProfilesModuleFallback(INSTALL_ANCHOR, home)
    const dir = resolveProfileDir('desktop', home)
    initProfile(dir, ['dsh-desktop-core'])
    const rootConfig = join(dir, 'cordis.yml')
    writeFileSync(rootConfig, `[]
`)
    const profile = loadProfile(BIN, 'desktop', INSTALL_ANCHOR, home)
    const bundlePatches = profile.layers.flatMap((layer) => layer.patches)
    const ctx = await boot(BIN, rootConfig, [...bundlePatches])
    say(`BOOT OK: ${[...ctx.loader.entries()].map((e) => e.options.id ?? e.options.name).join(', ')}`)
    await ctx.fiber.dispose()
    say('PROBE DONE')
  } catch (error) {
    say('BOOT FAILED:')
    dumpError(error)
    say('PROBE DONE (failed)')
  }
  app.exit(0)
})
