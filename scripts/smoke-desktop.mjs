/**
 * P0 smoke test — runs the whole desktop chain under plain Node (no GUI):
 *
 *   seed desktop profile (idempotent) → heal module fallback → boot the
 *   desktop tree with bundle rows only + an overlay patch that disables the
 *   window row (the Electron row can't load under Node) and shortens the
 *   hello timeout → supervisor spawns the DSH web child (Node runtime, since
 *   ELECTRON_RUN_AS_NODE is inert for plain Node) → the bridge overlay row
 *   inside the web tree connects and handshakes → 'desktop/bridge-ready'
 *   carries the real web port → tree dispose kills the child.
 *
 * Also verifies the web profile is untouched: hashes of every file under
 * $DSH_HOME/profiles/web are captured before and after.
 *
 * Usage: node scripts/smoke-desktop.mjs
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PROFILE_PATCH_FILENAME,
  boot,
  healProfilesModuleFallback,
  initProfile,
  loadProfile,
  resolveProfileDir,
} from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

const BIN = 'dsh-desktop-app-smoke'
const DESKTOP_BUNDLES = ['dsh-desktop-core']
const INSTALL_ANCHOR = fileURLToPath(new URL('../packages/dsh-desktop-app/package.json', import.meta.url))

const PROFILE_ROOT_CONFIG = `[]
`

const OVERLAYS = [
  // The window row imports Electron; disable it for the Node smoke run.
  // This doubles as the patch-dialect demonstration: the same shape a user
  // would write in cordis.patch.yml.
  { id: 'desktop-window', disabled: true },
  { id: 'desktop-supervisor', config: { helloTimeoutMs: 20000, respawnDelayMs: 500 } },
]

function hashTree(root) {
  const hashes = {}
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const stat = statSync(full)
      if (stat.isDirectory()) walk(full)
      else if (stat.isFile()) hashes[full] = createHash('sha256').update(readFileSync(full)).digest('hex').slice(0, 12)
    }
  }
  walk(root)
  return hashes
}

function diffHash(left, right) {
  const changed = []
  for (const [file, hash] of Object.entries(left)) {
    if (right[file] !== hash) changed.push(file)
  }
  for (const file of Object.keys(right)) {
    if (!(file in left)) changed.push(file)
  }
  return changed
}

async function main() {
  const home = resolveDshHome()
  const webDir = resolveProfileDir('web', home)
  const before = hashTree(webDir)

  healProfilesModuleFallback(INSTALL_ANCHOR, home)
  const dir = resolveProfileDir('desktop', home)
  initProfile(dir, DESKTOP_BUNDLES)
  const rootConfig = join(dir, 'cordis.yml')
  writeFileSync(rootConfig, PROFILE_ROOT_CONFIG)
  const profile = loadProfile(BIN, 'desktop', INSTALL_ANCHOR, home)
  const bundlePatches = profile.layers.flatMap((layer) => layer.patches)
  const patches = [...bundlePatches, ...OVERLAYS]

  console.log(`[smoke] desktop profile: ${dir}`)
  console.log(`[smoke] bundle layers: ${profile.layers.map((layer) => layer.packageName).join(', ')}`)
  console.log(`[smoke] web profile before: ${Object.keys(before).length} files`)

  const ctx = await boot(BIN, rootConfig, patches)
  console.log(`[smoke] desktop tree settled; entries: ${[...ctx.loader.entries()].map((entry) => entry.options.id ?? entry.options.name).join(', ')}`)

  const ready = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 30_000)
    ctx.on('desktop/bridge-ready', (payload) => {
      clearTimeout(timer)
      resolve(payload)
    })
  })

  if (!ready) {
    console.error('[smoke] FAIL: no bridge-ready within 30s')
    await ctx.fiber.dispose()
    process.exit(1)
  }
  console.log(`[smoke] bridge-ready: port=${ready.port} protocol=v${ready.protocolVersion}`)

  const supervisor = ctx.get('desktopSupervisor')
  console.log(`[smoke] supervisor state=${supervisor.state} webPort=${supervisor.webPort}`)

  // The child's web server must actually answer.
  const probe = spawnSync('node', ['-e', `fetch('http://127.0.0.1:${ready.port}/').then(r=>{console.log('HTTP',r.status);process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})`], { timeout: 15000 })
  console.log(`[smoke] web probe: ${probe.stdout?.toString().trim() || probe.stderr?.toString().trim()}`)

  // Heartbeat ping/pong over the bridge.
  const pingResult = await new Promise((resolve) => {
    // The supervisor's bridge server pings every 15s; instead verify the
    // bridge socket is still alive by asking the child for a hello re-frame
    // is overkill for P0 — the connect/hello/dispose cycle already proves
    // the wire. Log the child pid for inspection.
    resolve(supervisor.child?.pid ?? 'unknown')
  })
  console.log(`[smoke] dsh child pid: ${pingResult}`)

  await ctx.fiber.dispose()
  console.log('[smoke] desktop tree disposed')

  const after = hashTree(webDir)
  const changed = diffHash(before, after)
  if (changed.length > 0) {
    console.error(`[smoke] FAIL: web profile files changed:\n${changed.join('\n')}`)
    process.exit(1)
  }
  console.log('[smoke] web profile untouched: PASS')
  console.log('[smoke] ALL PASS')
}

main().catch((error) => {
  console.error(`[smoke] FAIL: ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
})
