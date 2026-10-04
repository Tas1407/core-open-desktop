/**
 * preload.js — Preload-Script für IPC-Kommunikation.
 *
 * contextIsolation: true, nodeIntegration: false → sicher.
 * Exponiert nur explizit freigegebene IPC-Channel via contextBridge.
 *
 * Zusatz (Offline-Lesecache, Phase 1):
 *  - onSync/onOffline: Status-Events vom Main-Prozess
 *  - getOfflineData/retryNow: API für die lokale offline.html
 *  - DOM-Badge + Offline-Banner werden hier direkt in die App-Seite
 *    injiziert (Preload läuft isoliert, teilt aber das DOM).
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Renderer → Main: Rolle nach Login melden (für Admin-Menüpunkt DevTools)
  setRole: (role) => ipcRenderer.send('set-user-role', role),
  // Renderer → Main: Update-Check manuell auslösen
  checkForUpdates: () => ipcRenderer.send('check-for-updates'),
  // Offline-Lesecache
  onSync: (cb) => ipcRenderer.on('mvm-sync', (_e, d) => cb(d)),
  onOffline: (cb) => ipcRenderer.on('mvm-offline', (_e, d) => cb(d)),
  // Nur für offline.html relevant
  getOfflineData: () => ipcRenderer.invoke('offline-data'),
  retryNow: () => ipcRenderer.send('offline-retry'),
  // Test-Haken: simuliert Netz-Ausfall im Main-Prozess
  forceOffline: (v) => ipcRenderer.send('debug-force-offline', !!v),
});

// ── Sync-Badge + Offline-Banner (nur auf der echten App-Seite) ──
const APP_PREFIX = 'https://www.mvm.school/web2app-ii/';

function fmtStand(iso) {
  try {
    return new Date(iso).toLocaleString('de-AT', { dateStyle: 'short', timeStyle: 'short' });
  } catch (_) { return iso; }
}

function injectStyles() {
  if (document.getElementById('mvm-offline-css')) return;
  const st = document.createElement('style');
  st.id = 'mvm-offline-css';
  st.textContent = `
    #mvm-sync-badge {
      position: fixed; right: 12px; bottom: 12px; z-index: 999990;
      background: rgba(20,24,33,.92); color: #cfe0ff; font: 12px/1.4 system-ui, sans-serif;
      padding: 6px 12px; border-radius: 16px; border: 1px solid rgba(120,160,255,.35);
      box-shadow: 0 2px 8px rgba(0,0,0,.35); pointer-events: none;
      transition: opacity .4s; opacity: 0;
    }
    #mvm-sync-badge.on { opacity: 1; }
    #mvm-offline-banner {
      position: fixed; left: 0; right: 0; top: 0; z-index: 999991;
      background: #7a4b00; color: #ffe9c4; font: 13px/1.5 system-ui, sans-serif;
      text-align: center; padding: 5px 10px;
    }
  `;
  document.head.appendChild(st);
}

function badge() {
  let b = document.getElementById('mvm-sync-badge');
  if (!b) {
    b = document.createElement('div');
    b.id = 'mvm-sync-badge';
    document.body.appendChild(b);
  }
  return b;
}

function showBadge(text) {
  const b = badge();
  b.textContent = text;
  b.classList.add('on');
}

function hideBadgeSoon(ms) {
  const b = badge();
  setTimeout(() => { b.classList.remove('on'); }, ms);
}

function showOfflineBanner(stand) {
  let el = document.getElementById('mvm-offline-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'mvm-offline-banner';
    document.body.prepend(el);
  }
  el.textContent = 'Offline — Stand vom ' + (stand ? fmtStand(stand) : 'unbekannt');
}

// #668: wieder online → Banner weg, ohne Reload
function hideOfflineBanner() {
  const el = document.getElementById('mvm-offline-banner');
  if (el) el.remove();
}

if (window.location.href.startsWith(APP_PREFIX)) {
  window.addEventListener('DOMContentLoaded', injectStyles);

  ipcRenderer.on('mvm-sync', (_e, d) => {
    if (!document.body) return;
    if (d.state === 'start') showBadge('Sync läuft …');
    else if (d.state === 'progress') {
      const lbl = { basis: 'Listen', kurse: 'Kurse', schueler: 'Schüler' }[d.phase] || d.phase;
      showBadge(`Sync: ${lbl} ${d.done}/${d.total}`);
    }
    else if (d.state === 'done') { showBadge(`Sync fertig (${(d.ms / 1000).toFixed(1)} s)`); hideBadgeSoon(4000); }
    else if (d.state === 'error') { showBadge('Sync fehlgeschlagen — lokaler Stand bleibt'); hideBadgeSoon(5000); }
    else if (d.state === 'skipped') { /* kein Login o.ä. — Badge bleibt aus */ }
  });

  ipcRenderer.on('mvm-offline', (_e, d) => {
    if (!document.body) return;
    if (d && d.online) { hideOfflineBanner(); return; }  // #668
    showOfflineBanner(d && d.stand);
  });

  // #578 SWR: Main hat einen gecachten Bereich im Hintergrund
  // aufgefrischt und die Daten unterscheiden sich — als DOM-Event in
  // die Hauptwelt reichen (contextIsolation: kein direkter Zugriff auf
  // window.appShell, aber DOM-Events werden geteilt). Die App-Seite
  // hoert darauf und rendert das aktive Modul weich nach.
  ipcRenderer.on('mvm-swr', (_e, d) => {
    try {
      window.dispatchEvent(new CustomEvent('mvm-swr', { detail: d || {} }));
    } catch (_) {}
  });
}
