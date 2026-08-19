/**
 * dsh-desktop-core: the desktop profile's bundle entry — re-exports the
 * service rows so out-of-tree plugins can import types and helpers from one
 * place. The rows themselves mount through the bundle patch
 * (cordis.patch.yml) and the subpath exports.
 *
 * @module dsh-desktop-core
 */

export * as protocol from './protocol.js'
export * as supervisor from './supervisor.js'
export * as window from './window.js'
export * as wsServer from './ws-server.js'
