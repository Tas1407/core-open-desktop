/**
 * preload.js — Preload-Script für IPC-Kommunikation.
 *
 * contextIsolation: true, nodeIntegration: false → sicher.
 * Exponiert nur explizit freigegebene IPC-Channel via contextBridge.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Renderer → Main: Rolle nach Login melden (für Admin-Menüpunkt DevTools)
  setRole: (role) => ipcRenderer.send('set-user-role', role),
  // Renderer → Main: Update-Check manuell auslösen
  checkForUpdates: () => ipcRenderer.send('check-for-updates'),
});
