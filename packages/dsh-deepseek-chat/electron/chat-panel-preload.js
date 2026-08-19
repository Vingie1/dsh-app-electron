// Chat panel preload: exposes only a close action (used by the panel's own
// close bar; the panel itself is sandboxed with no other privileges).

'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__dshChatPanel', {
  close: () => ipcRenderer.send('dsh-chat:close'),
})
