/**
 * Bridge protocol between the desktop tree (Electron main, WS server) and the
 * DSH web tree (spawned child, WS client).
 *
 * The envelope reuses DSH's four-frame wire names — client-request /
 * server-request / client-response / server-response — so the protocol
 * vocabulary stays the one the web tree already speaks. P0 only uses
 * client-request (hello from the DSH tree) and server-response (ack); the
 * full RPC surface lands in P1.
 *
 * Frames are single JSON text messages on a WS connection bound to
 * 127.0.0.1:<random-port>/bridge, token-authenticated via environment.
 */

/** Wire protocol version. Bump on any breaking frame/envelope change. */
export const PROTOCOL_VERSION = 1

/** Services the main side advertises after a successful hello. */
export const MAIN_API = ['dsh.ping', 'dsh.health', 'dsh.restart']

/** Services the DSH side advertises after a successful hello. */
export const CHILD_API = ['desktop.call']

/** The main-side namespace the child addresses for handshake and health. */
export const HANDSHAKE_NS = 'dsh.desktop'

/** Handshake method names. */
export const HELLO = 'hello'

/** WS path the bridge server accepts. */
export const BRIDGE_PATH = '/bridge'

/** Message-size guard on inbound frames. */
export const MAX_FRAME_BYTES = 1 << 20

/** Heartbeat interval once connected; P0 sends pings, P1 acts on misses. */
export const PING_INTERVAL_MS = 15_000

/**
 * Build a client-request frame: the DSH tree → main.
 * @param id - correlation id.
 * @param ns - service namespace.
 * @param method - method within the namespace.
 * @param payload - method arguments.
 */
export function clientRequest(id, ns, method, payload) {
  return { kind: 'client-request', id, ns, method, payload }
}

/**
 * Build a server-response frame: main → DSH tree.
 * @param id - echoes the correlated request id.
 * @param ok - success flag.
 * @param payload - result payload on success.
 * @param error - message when not ok.
 */
export function serverResponse(id, ok, payload, error) {
  return { kind: 'server-response', id, ok, ...(payload !== undefined ? { payload } : {}), ...(error !== undefined ? { error } : {}) }
}

/**
 * Validate the envelope of one decoded frame.
 * @param frame - decoded JSON value.
 * @returns the frame when it satisfies the envelope shape.
 * @throws with a human-readable reason otherwise.
 */
export function checkFrame(frame) {
  if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) throw new Error('frame is not an object')
  const { kind, id } = frame
  if (kind !== 'client-request' && kind !== 'server-request' && kind !== 'client-response' && kind !== 'server-response') throw new Error(`frame has unknown kind ${JSON.stringify(kind)}`)
  if (typeof id !== 'string') throw new Error('frame id must be a string')
  return frame
}
