/**
 * dsh-deepseek-chat — host half.
 *
 * No host-side behavior: everything (sidebar entry, panel, webview) lives in
 * the browser half, and the Electron-shell hardening (webviewTag + guest
 * navigation fence) lives in the desktop shell's main process. This entry
 * exists so the bundle row mounts cleanly, mirroring the official
 * browser-only layout plugin.
 */

/** Stable cordis plugin name. */
const name = 'dsh-deepseek-chat'

/** Provides no host-side behavior. */
function apply() {}

export { name, apply }
