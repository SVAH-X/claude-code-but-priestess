const { contextBridge, ipcRenderer } = require("electron");

function onChannel(channel) {
  return (callback) => {
    const handler = (_, payload) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.off(channel, handler);
  };
}

contextBridge.exposeInMainWorld("petApi", {
  hidePopover: () => ipcRenderer.invoke("popover:hide"),
  pickChatCwd: () => ipcRenderer.invoke("settings:pick-cwd"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  onOpened: onChannel("popover:opened"),
  onSettings: onChannel("settings:state")
});

contextBridge.exposeInMainWorld("chatApi", {
  send: (text) => ipcRenderer.invoke("chat:send", text),
  cancel: () => ipcRenderer.invoke("chat:cancel"),
  clear: () => ipcRenderer.invoke("chat:clear"),
  getHistory: () => ipcRenderer.invoke("chat:get-history"),
  onChunk: onChannel("chat:chunk"),
  onStatus: onChannel("chat:status"),
  onHistory: onChannel("chat:history"),
  onTool: onChannel("chat:tool")
});
