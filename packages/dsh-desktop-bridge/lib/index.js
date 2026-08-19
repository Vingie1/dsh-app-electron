/**
 * The desktop bridge host row, running inside the DSH web tree.
 *
 * Mounted by the generated bridge.yml overlay (`--patch`), so the user's web
 * profile is never touched: delete the overlay (or the app) and the web tree
 * is byte-identical to before. The overlay inserts this row with config
 * resolved from the child environment (DSH_DESKTOP_BRIDGE_URL / TOKEN).
 *
 * On connect it performs the hello handshake: token + protocol version +
 * the real web port (from ctx.webServer.port, which reflects the
 * OS-assigned bind for `--port 0`). The main side answers with its protocol
 * version and API list, then emits 'desktop/bridge-ready' in the desktop
 * tree, which opens the window.
 *
 * The bridge service (`ctx.desktop`, P1) and the browser-side client bundle
 * (`exports["./client"]`, `dsh.client`, P1) extend this same row.
 *
 * @module dsh-desktop-bridge
 */

import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CHILD_API, PROTOCOL_VERSION, checkFrame, clientRequest } from 'dsh-desktop-core/protocol'

export const name = 'dsh-desktop-bridge'

/** The main side's bridge server URL, e.g. ws://127.0.0.1:49321/bridge. */
export const BRIDGE_URL_ENV = 'DSH_DESKTOP_BRIDGE_URL'
/** The shared secret for the hello handshake. */
export const BRIDGE_TOKEN_ENV = 'DSH_DESKTOP_TOKEN'

export default class BridgeService extends Service {
  /** Service-row config, validated by the Loader at activation. */
  static Config = z.object({
    url: z.string(),
    token: z.string(),
  })

  static RECONNECT_MIN_MS = 1000
  static RECONNECT_MAX_MS = 30_000

  constructor(ctx, config) {
    super(ctx, 'desktopBridge')
    this.config = config
    this.logger = ctx.logger('desktop-bridge')
    this.state = 'connecting'
    this.ws = null
    this.reconnectDelay = BridgeService.RECONNECT_MIN_MS
    this.reconnectTimer = null
    this.handshook = false
  }

  log(line) {
    this.logger.info(`[bridge] ${line}`)
  }

  async [Service.init]() {
    // Fire-and-forget: the Loader must not await the connection lifetime.
    this._connect()
  }

  _connect() {
    if (this.state === 'disposed') return
    if (typeof WebSocket !== 'function') {
      this.log('global WebSocket unavailable (Node >= 22 required)')
      this._scheduleReconnect()
      return
    }
    let ws
    try {
      ws = new WebSocket(this.config.url)
    } catch (error) {
      this.log(`connect failed: ${error.message}`)
      this._scheduleReconnect()
      return
    }
    this.ws = ws
    this.state = 'connecting'
    ws.addEventListener('open', () => {
      this.log(`connected to ${this.config.url}`)
      this.reconnectDelay = BridgeService.RECONNECT_MIN_MS
      this._sendHello()
    })
    ws.addEventListener('message', (event) => this._onMessage(event.data))
    ws.addEventListener('close', () => {
      this.log('connection closed')
      this._scheduleReconnect()
    })
    ws.addEventListener('error', (error) => {
      this.log(`connection error: ${error.message ?? String(error)}`)
    })
  }

  _sendHello() {
    // ctx.webServer.port is the actually-bound port (OS-assigned for 0).
    const webPort = this.ctx.get('webServer')?.port
    if (typeof webPort !== 'number') {
      this.log(`webServer not ready (port ${String(webPort)}); retrying hello on reconnect`)
      this.ws?.close()
      return
    }
    this.send(clientRequest(`hello-${Math.random().toString(36).slice(2)}`, 'dsh.desktop', 'hello', {
      token: this.config.token,
      protocolVersion: PROTOCOL_VERSION,
      api: CHILD_API,
      webPort,
    }))
  }

  _onMessage(data) {
    let frame
    try {
      frame = JSON.parse(String(data))
      checkFrame(frame)
    } catch (error) {
      this.log(`bad frame: ${error.message}`)
      return
    }
    if (frame.kind === 'server-response' && frame.id?.startsWith('hello-')) {
      if (frame.ok) {
        this.state = 'ready'
        this.handshook = true
        this.log(`handshake ok: protocol v${frame.payload?.protocolVersion ?? '?'}, main api [${(frame.payload?.api ?? []).join(', ')}]`)
        this.ctx.emit('desktop/bridge-up', {
          protocolVersion: frame.payload?.protocolVersion,
          api: frame.payload?.api ?? [],
        })
      } else {
        this.state = 'rejected'
        this.log(`handshake rejected: ${frame.error ?? 'unknown'}`)
        this.ws?.close()
      }
      return
    }
    // P1 routes desktop.call and the event whitelist here.
    this.log(`unhandled frame kind=${frame.kind} ns=${frame.ns} method=${frame.method}`)
  }

  send(frame) {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    try {
      ws.send(JSON.stringify(frame))
      return true
    } catch (error) {
      this.log(`send failed: ${error.message}`)
      return false
    }
  }

  _scheduleReconnect() {
    if (this.state === 'disposed' || this.reconnectTimer) return
    if (this.handshook) {
      // The main side respawns us through its own cycle; keep trying so a
      // window-reopen handshake can re-announce the port.
      this.state = 'connecting'
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this._connect()
    }, this.reconnectDelay)
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, BridgeService.RECONNECT_MAX_MS)
  }

  _dispose() {
    this.state = 'disposed'
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    try { this.ws?.close() } catch {}
    this.ws = null
  }
}
