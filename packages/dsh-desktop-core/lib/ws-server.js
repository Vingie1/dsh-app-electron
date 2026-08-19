/**
 * Minimal RFC 6455 WebSocket server for the desktop bridge.
 *
 * Deliberately dependency-free: the DSH child connects with Node's built-in
 * WebSocket client (Node 24), and this server implements just enough of the
 * protocol for JSON text frames + ping/pong + close — no extensions, no
 * compression, no permessage-deflate. Messages are capped at MAX_FRAME_BYTES.
 *
 * @module dsh-desktop-core/ws-server
 */

import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { MAX_FRAME_BYTES } from './protocol.js'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

// opcodes
const OP_CONT = 0x0
const OP_TEXT = 0x1
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xA

const CONTROL_LIMIT = 125

/**
 * Send one JSON value as a text frame on an established server-side socket.
 * @param socket - the upgraded TCP socket (a `BridgeSocket`).
 * @param value - the JSON-serializable frame to send.
 */
export function sendJson(socket, value) {
  socket.write(buildFrame(OP_TEXT, Buffer.from(JSON.stringify(value))))
}

/** One parsed frame: opcode, un-masked payload, and its FIN bit. */
class Frame {
  constructor(opcode, payload, fin) {
    this.opcode = opcode
    this.payload = payload
    this.fin = fin
  }
}

/**
 * Consume one frame from the front of a buffer.
 * @param buffer - accumulated bytes.
 * @returns {{frame: Frame, consumed: number}} the parsed frame and the byte
 * span it occupied, or null when more bytes are needed.
 * @throws on protocol violations (invalid lengths, control-frame size).
 */
function parseFrame(buffer) {
  if (buffer.length < 2) return null
  const b0 = buffer[0]
  const b1 = buffer[1]
  const fin = (b0 & 0x80) !== 0
  const opcode = b0 & 0x0F
  const masked = (b1 & 0x80) !== 0
  let len = b1 & 0x7F
  let offset = 2
  if (len === 126) {
    if (buffer.length < 4) return null
    len = buffer.readUInt16BE(2)
    offset = 4
  } else if (len === 127) {
    if (buffer.length < 10) return null
    const high = buffer.readUInt32BE(2)
    const low = buffer.readUInt32BE(6)
    if (high !== 0) throw new Error('websocket frame length exceeds 2^32')
    len = low
    offset = 10
  }
  if (!masked) throw new Error('websocket client frames must be masked')
  if (buffer.length < offset + 4 + len) return null
  const key = buffer.subarray(offset, offset + 4)
  offset += 4
  const payload = Buffer.allocUnsafe(len)
  for (let i = 0; i < len; i++) payload[i] = buffer[offset + i] ^ key[i & 3]
  if (opcode >= 0x8) {
    if (!fin) throw new Error('websocket control frames must not be fragmented')
    if (len > CONTROL_LIMIT) throw new Error('websocket control frame too large')
  }
  if (opcode !== OP_CONT && opcode !== OP_TEXT && opcode < 0x8) throw new Error(`websocket frame opcode ${opcode} not supported (no binary frames)`)
  return { frame: new Frame(opcode, payload, fin), consumed: offset + len }
}

/** Build one outbound frame (server → client: never masked). */
function buildFrame(opcode, payload) {
  const len = payload.length
  const header = Buffer.alloc(len < 126 ? 2 : len < 65536 ? 4 : 10)
  header[0] = 0x80 | opcode
  if (len < 126) {
    header[1] = len
  } else if (len < 65536) {
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header[1] = 127
    header.writeUInt32BE(0, 2)
    header.writeUInt32BE(len, 6)
  }
  return Buffer.concat([header, payload])
}

/**
 * Create the bridge WS server.
 * @param options - {@link BridgeServerOptions}.
 * @returns a promise of the bridge server handle ({@link BridgeServer}).
 */
export function createBridgeServer(options) {
  const { path, log = () => {}, onFrame, pingIntervalMs = 15_000, idleTimeoutMs = 45_000 } = options
  const server = createServer()
  const sockets = new Set()
  const state = { ready: false, error: null }

  server.on('upgrade', (req, socket) => {
    const pathname = req.url === undefined ? '/' : new URL(req.url, 'http://127.0.0.1').pathname
    if (pathname !== path) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    const key = req.headers['sec-websocket-key']
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || typeof key !== 'string') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    )
    attach(socket)
  })

  function attach(socket) {
    let buffer = Buffer.alloc(0)
    let pendingOpcode = null
    let pendingParts = []
    let pendingLength = 0
    let lastPongAt = Date.now()
    let closed = false

    const heartbeat = setInterval(() => {
      if (closed) return
      // P0: log misses, keep the connection (reconnect handling lands in P1).
      if (Date.now() - lastPongAt > idleTimeoutMs) log('bridge: client heartbeat missed; keeping connection for now')
      try {
        socket.write(buildFrame(OP_PING, Buffer.alloc(0)))
      } catch (error) {
        log(`bridge: ping write failed: ${error.message}`)
      }
    }, pingIntervalMs)
    heartbeat.unref?.()

    sockets.add(socket)

    const teardown = () => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      sockets.delete(socket)
      try { socket.destroy() } catch {}
      log('bridge: connection closed')
    }

    socket.on('data', (chunk) => {
      if (closed) return
      buffer = Buffer.concat([buffer, chunk])
      try {
        for (;;) {
          const parsed = parseFrame(buffer)
          if (parsed === null) break
          buffer = buffer.subarray(parsed.consumed)
          handleFrame(parsed.frame)
        }
      } catch (error) {
        log(`bridge: protocol error: ${error.message}`)
        try { socket.write(buildFrame(OP_CLOSE, Buffer.from([0x03, 0xEA]))) } catch {}
        teardown()
      }
    })
    socket.on('error', (error) => log(`bridge: socket error: ${error.message}`))
    socket.on('close', teardown)
    socket.on('end', teardown)

    function handleFrame(frame) {
      switch (frame.opcode) {
        case OP_PONG:
          lastPongAt = Date.now()
          return
        case OP_PING: {
          try { socket.write(buildFrame(OP_PONG, frame.payload)) } catch {}
          return
        }
        case OP_CLOSE: {
          try { socket.write(buildFrame(OP_CLOSE, frame.payload)) } catch {}
          teardown()
          return
        }
        case OP_TEXT:
          if (frame.fin) {
            dispatch(frame.payload)
          } else {
            beginMessage(frame)
          }
          return
        case OP_CONT: {
          if (pendingOpcode === null) throw new Error('unexpected continuation frame')
          pendingParts.push(frame.payload)
          pendingLength += frame.payload.length
          if (pendingLength > MAX_FRAME_BYTES) throw new Error('websocket message too large')
          if (frame.fin) {
            dispatch(Buffer.concat(pendingParts, pendingLength))
            resetMessage()
          }
          return
        }
        default:
          throw new Error(`unsupported opcode ${frame.opcode}`)
      }
    }

    function beginMessage(frame) {
      pendingOpcode = OP_TEXT
      pendingParts = [frame.payload]
      pendingLength = frame.payload.length
      if (pendingLength > MAX_FRAME_BYTES) throw new Error('websocket message too large')
    }

    function resetMessage() {
      pendingOpcode = null
      pendingParts = []
      pendingLength = 0
    }

    function dispatch(payload) {
      let decoded
      try {
        decoded = JSON.parse(payload.toString('utf8'))
      } catch (error) {
        log(`bridge: malformed JSON frame: ${error.message}`)
        return
      }
      Promise.resolve(onFrame(decoded, socket)).catch((error) => log(`bridge: frame handler failed: ${error.message}`))
    }
  }

  return new Promise((resolve, reject) => {
    server.once('error', (error) => {
      state.error = error
      reject(error)
    })
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      server.on('error', (error) => log(`bridge: server error: ${error.message}`))
      const port = server.address().port
      state.ready = true
      resolve({
        url: `ws://127.0.0.1:${port}${path}`,
        port,
        close: async () => {
          for (const socket of [...sockets]) {
            try { socket.write(buildFrame(OP_CLOSE, Buffer.from([0x03, 0xE8]))) } catch {}
            socket.destroy()
          }
          await new Promise((done) => server.close(() => done()))
        },
      })
    })
  })
}
