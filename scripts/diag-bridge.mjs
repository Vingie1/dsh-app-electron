/**
 * Diagnostic: reproduce the supervisor spawn + hello handshake under plain
 * Node, with the child's stdout/stderr passed through untouched, so a crash
 * inside the web tree is visible in full.
 *
 * Usage: node scripts/diag-bridge.mjs
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createBridgeServer, sendJson } from '../packages/dsh-desktop-core/lib/ws-server.js'
import { BRIDGE_PATH } from '../packages/dsh-desktop-core/lib/protocol.js'

const home = resolveDshHome()
const bin = join(home, 'profiles', 'desktop', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const token = 'diag-token-1234567890'

const bridge = await createBridgeServer({
  path: BRIDGE_PATH,
  log: (line) => console.log(`[bridge] ${line}`),
  onFrame: (frame, socket) => {
    console.log(`[diag] frame from child: kind=${frame.kind} ns=${frame.ns} method=${frame.method} id=${frame.id} payload=${JSON.stringify(frame.payload)}`)
    if (frame.kind === 'client-request' && frame.ns === 'dsh.desktop' && frame.method === 'hello') {
      console.log(`[diag] sending ack for ${frame.id}`)
      sendJson(socket, { kind: 'server-response', id: frame.id, ok: true, payload: { protocolVersion: 1, api: ['dsh.ping', 'dsh.health', 'dsh.restart'] } })
    }
  },
})
console.log(`[diag] bridge at ${bridge.url}`)

const bridgeYml = join(home, 'desktop', 'bridge.yml')
mkdirSync(join(home, 'desktop'), { recursive: true })
writeFileSync(bridgeYml, [
  '- insert:',
  '    - id: desktop-bridge',
  "      name: 'dsh-desktop-bridge'",
  '      config:',
  '        url: !!js process.env.DSH_DESKTOP_BRIDGE_URL',
  '        token: !!js process.env.DSH_DESKTOP_TOKEN',
  '',
].join('\n'))

console.log(`[diag] spawning ${bin}`)
const child = spawn(process.execPath, [bin, 'web', '--patch', bridgeYml, '--port', '0'], {
  cwd: home,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME: home,
    DSH_DESKTOP_BRIDGE_URL: bridge.url,
    DSH_DESKTOP_TOKEN: token,
  },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', (chunk) => process.stdout.write(`[dsh:out] ${chunk}`))
child.stderr.on('data', (chunk) => process.stdout.write(`[dsh:err] ${chunk}`))
child.on('exit', (code, signal) => {
  console.log(`[diag] child exited code=${code} signal=${signal}`)
  bridge.close().then(() => process.exit(0))
})

// Give the child 40s to crash or handshake; then tear down.
setTimeout(async () => {
  console.log('[diag] 40s elapsed; child still running')
  child.kill('SIGTERM')
}, 40_000)
