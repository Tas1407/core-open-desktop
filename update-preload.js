/**
 * update-preload.js — Preload für das Update-Overlay-Fenster (#243).
 * Sendet Klick-Events an den Main-Prozess um das Update zu installieren.
 */
const { ipcRenderer } = require('electron');

window.addEventListener('DOMContentLoaded', () => {
  document.body.addEventListener('click', () => {
    ipcRenderer.send('install-update');
  });
});
