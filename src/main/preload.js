const { contextBridge, ipcRenderer } = require("electron");

function onChannel(channel) {
  return (callback) => {
    const handler = (_, payload) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.off(channel, handler);
  };
}

contextBridge.exposeInMainWorld("petApi", {
  isWindows: process.platform === 'win32',
  hidePopover: () => ipcRenderer.invoke("popover:hide"),
  getPopoverBounds: (options) => ipcRenderer.invoke("popover:get-bounds", options),
  resizePopoverDrag: (payload) => ipcRenderer.invoke("popover:resize-drag", payload),
  movePopover: (point) => ipcRenderer.invoke("popover:move", point),
  endMovePopover: () => ipcRenderer.invoke("popover:move-end"),
  notePopoverActivity: () => ipcRenderer.invoke("popover:activity"),
  openChatFromDesktopPet: () => ipcRenderer.invoke("desktop-pet:open-chat"),
  moveDesktopPet: (point) => ipcRenderer.invoke("desktop-pet:move", point),
  pickChatCwd: () => ipcRenderer.invoke("settings:pick-cwd"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  onOpened: onChannel("popover:opened"),
  onSettings: onChannel("settings:state")
});

contextBridge.exposeInMainWorld("previewApi", {
  open: (payload) => ipcRenderer.invoke("popover:preview-open", payload),
  close: () => ipcRenderer.invoke("popover:preview-close"),
  openInBrowser: (payload) => ipcRenderer.invoke("html:open-in-browser", payload)
});

contextBridge.exposeInMainWorld("chatApi", {
  send: (text) => ipcRenderer.invoke("chat:send", text),
  cancel: () => ipcRenderer.invoke("chat:cancel"),
  clear: () => ipcRenderer.invoke("chat:clear"),
  getHistory: () => ipcRenderer.invoke("chat:get-history"),
  onChunk: onChannel("chat:chunk"),
  onStatus: onChannel("chat:status"),
  onHistory: onChannel("chat:history"),
  onTool: onChannel("chat:tool"),
  onMood: onChannel("chat:mood"),
  onQueue: onChannel("chat:queue")
});
