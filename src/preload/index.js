// The popover's bridge (window.ivsb). The main process accepts these calls only from the popover.
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('ivsb', {
  getSnapshot: () => ipcRenderer.invoke('ivsb:snapshot'),
  getState: () => ipcRenderer.invoke('ivsb:state'),
  onSnapshot: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot)
    ipcRenderer.on('ivsb:snapshot-changed', listener)
    return () => ipcRenderer.removeListener('ivsb:snapshot-changed', listener)
  },
  scanNow: () => ipcRenderer.invoke('ivsb:scan-now'),
  hide: () => ipcRenderer.invoke('ivsb:hide'),
  setSetting: (key, value) => ipcRenderer.invoke('ivsb:set-setting', key, value),
  checkUpdate: () => ipcRenderer.invoke('ivsb:check-update'),
  installUpdate: () => ipcRenderer.invoke('ivsb:install-update'),
  onUpdate: (callback) => {
    const listener = (_event, update) => callback(update)
    ipcRenderer.on('ivsb:update-changed', listener)
    return () => ipcRenderer.removeListener('ivsb:update-changed', listener)
  },
  connectClaude: () => ipcRenderer.invoke('ivsb:connect-claude'),
  disconnectClaude: () => ipcRenderer.invoke('ivsb:disconnect-claude')
})
