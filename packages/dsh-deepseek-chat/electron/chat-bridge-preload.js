// Main-window preload: exposes the minimal chat side-window bridge to the
// dsh-deepseek-chat plugin (sandbox-safe: contextBridge + ipcRenderer only).

'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshChat', {
  toggle: () => ipcRenderer.invoke('dsh-chat:toggle'),
  getState: () => ipcRenderer.invoke('dsh-chat:get-state'),
  onStateChange: (callback) => {
    const listener = (_event, open) => callback(open)
    ipcRenderer.on('dsh-chat:state-changed', listener)
    return () => { ipcRenderer.removeListener('dsh-chat:state-changed', listener) }
  },
})
