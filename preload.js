"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexStatusbar", {
  onData: (cb) => ipcRenderer.on("statusbar-data", (_e, data) => cb(data)),
  resize: (w, h) => ipcRenderer.send("statusbar-resize", { width: w, height: h }),
  moveTo: (x, y) => ipcRenderer.send("statusbar-move-to", { x, y }),
  getBounds: () => ipcRenderer.invoke("statusbar-get-bounds"),
  setFree: () => ipcRenderer.send("statusbar-set-free"),
});
