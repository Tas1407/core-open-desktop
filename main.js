/**
 * main.js — Electron-Hauptprozess für MVM Core Open Desktop.
 *
 * Schlanke Hülle, die https://www.mvm.school/web2app-ii/ in einem
 * eigenständigen Fenster lädt. Genau wie Slack/Discord/Spotify Desktop.
 *
 * #243: Auto-Update via electron-updater. Prüft beim Start im Hintergrund,
 * lädt herunter, zeigt Badge, installiert beim Klick oder beim nächsten Start.
 * #243 Diagnose: Alle Updater-Events werden in update-log.txt geschrieben.
 */
const { app, BrowserWindow, Menu, shell, Notification, ipcMain, dialog, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');
const offlineCache = require('./cache');
const offlineSync = require('./sync');

const APP_URL = 'https://www.mvm.school/web2app-ii/';
const API_PREFIX = '/web2app-ii/api/';
const WINDOW_TITLE = 'MVM - Academy Modul by CORE OPEN';

let mainWindow = null;
let updateOverlay = null;
let updateDownloaded = false;
let userRole = null; // vom Renderer nach Login gesetzt ('admin', 'teacher', etc.)

// ── Offline-Lesecache (Pilot: Kurse & Schüler) ──
let syncRunning = false;
let forceOffline = false;      // Test-Schalter (Menü/IPC): tut so, als gäbe es kein Netz
let onOfflinePage = false;     // true, solange offline.html statt der App geladen ist
let offlineRetryTimer = null;

// ── Update-Log in Datei (#243 Diagnose) ──
// Schreibt alle [updater]-Events in eine Textdatei neben den App-Daten,
// damit Tas die Logs ohne DevTools mit Notepad lesen kann.
// Pfad: %APPDATA%\<productName>\update-log.txt
//   bei installierter App: C:\Users\<User>\AppData\Roaming\MVM Core Open\update-log.txt
function logUpdate(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  console.log(line.trim());
  try {
    const logFile = path.join(app.getPath('userData'), 'update-log.txt');
    const logDir = path.dirname(logFile);
    if (!fs.existsSync(logDir)) { fs.mkdirSync(logDir, { recursive: true }); }
    fs.appendFileSync(logFile, line, 'utf8');
  } catch (e) { /* Logging darf nie blockieren */ }
}

// Globaler Error-Handler — faengt unabgefangene Fehler ab und schreibt sie ins Log
process.on('uncaughtException', (err) => {
  logUpdate('[FATAL] Uncaught Exception: ' + (err && err.stack ? err.stack : String(err)));
});

// ── Auto-Update (#243) ──
function setupAutoUpdater() {
  autoUpdater.autoDownload = true;      // Im Hintergrund herunterladen
  autoUpdater.autoInstallOnAppQuit = true; // Beim Schließen installieren wenn nicht geklickt

  logUpdate('=== Auto-Updater gestartet — Log-Datei: ' + path.join(app.getPath('userData'), 'update-log.txt') + ' ===');
  logUpdate('[updater] App-Version: ' + app.getVersion());

  autoUpdater.on('checking-for-update', () => {
    logUpdate('[updater] Prüfe auf Update…');
  });

  autoUpdater.on('update-available', (info) => {
    logUpdate('[updater] Update verfügbar: ' + info.version);
    if (Notification.isSupported()) {
      new Notification({
        title: 'Update wird heruntergeladen',
        body: `Version ${info.version} wird im Hintergrund geladen…`,
        silent: true,
      }).show();
    }
  });

  autoUpdater.on('update-not-available', (info) => {
    logUpdate('[updater] Kein Update verfügbar. Aktuelle Version: ' + (info && info.version ? info.version : '?'));
  });

  autoUpdater.on('update-downloaded', (info) => {
    logUpdate('[updater] Update heruntergeladen: ' + info.version);
    updateDownloaded = true;
    showUpdateOverlay(info.version);
    if (Notification.isSupported()) {
      new Notification({
        title: 'Update bereit',
        body: `Version ${info.version} — Klicke zum Installieren und Neustarten.`,
      }).show();
    }
  });

  autoUpdater.on('error', (err) => {
    logUpdate('[updater] FEHLER: ' + (err && err.message ? err.message : String(err)));
  });

  autoUpdater.on('download-progress', (progress) => {
    logUpdate('[updater] Download: ' + Math.round(progress.percent) + '% (' + Math.round(progress.transferred / 1024) + ' KB / ' + Math.round(progress.total / 1024) + ' KB)');
  });

  // Hintergrund-Check alle 4 Stunden (solange App offen)
  setInterval(() => {
    if (!updateDownloaded) {
      autoUpdater.checkForUpdates().catch(() => {});
    }
  }, 4 * 60 * 60 * 1000);

  // Erster Check beim Start (nicht blockierend)
  logUpdate('[updater] Erster Update-Check beim Start…');
  autoUpdater.checkForUpdates().catch((e) => {
    logUpdate('[updater] Erster Check fehlgeschlagen: ' + (e && e.message ? e.message : String(e)));
  });
}

// ── Update-Overlay (kleines Fenster oben rechts) ──
function showUpdateOverlay(version) {
  if (updateOverlay && !updateOverlay.isDestroyed()) return;

  const screen = require('electron').screen;
  const display = screen.getPrimaryDisplay();
  const OW = 260, OH = 56;
  const x = display.bounds.x + display.bounds.width - OW - 16;
  const y = display.bounds.y + 16;

  updateOverlay = new BrowserWindow({
    width: OW,
    height: OH,
    x, y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'update-preload.js'),
    },
  });

  updateOverlay.loadURL('data:text/html,' + encodeURIComponent(
    '<html><head><meta charset="utf-8"><style>' +
    '* { margin: 0; padding: 0; box-sizing: border-box; }' +
    'body { background: linear-gradient(135deg, #2FE3D0, #1ca79c); color: #fff; ' +
    'font-family: -apple-system, "Segoe UI", sans-serif; font-size: 13px; ' +
    'height: 100vh; display: flex; align-items: center; justify-content: center; ' +
    'cursor: pointer; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.3); ' +
    'padding: 8px 14px; gap: 8px; user-select: none; }' +
    '.badge { background: rgba(255,255,255,0.25); border-radius: 10px; ' +
    'padding: 2px 8px; font-weight: 700; font-size: 11px; }' +
    '.text { flex: 1; }' +
    '</style></head><body>' +
    '<div class="text">Update v' + version + ' — Klick zum Installieren</div>' +
    '<div class="badge">NEU</div>' +
    '</body></html>'
  ));

  updateOverlay.on('closed', () => {
    updateOverlay = null;
  });
}

// ── Update installieren (vom Overlay ausgelöst) ──
ipcMain.on('install-update', () => {
  logUpdate('[updater] Installiere Update und starte neu…');
  if (updateOverlay && !updateOverlay.isDestroyed()) {
    updateOverlay.close();
  }
  autoUpdater.quitAndInstall();
});

// ── IPC: Renderer meldet Rolle nach Login ──
ipcMain.on('set-user-role', (_event, role) => {
  logUpdate('[app] Rolle vom Renderer gemeldet: ' + (role || '(leer)'));
  userRole = role || null;
  buildMenu(); // Menü neu aufbauen — DevTools nur für Admins
  startOfflineSync('login');   // Frischer Login → Datenbestand ziehen
});

// ── IPC: Renderer löst manuellen Update-Check aus ──
ipcMain.on('check-for-updates', () => {
  logUpdate('[updater] Update-Check durch Renderer ausgelöst…');
  autoUpdater.checkForUpdates().catch((e) => {
    logUpdate('[updater] Renderer-Check fehlgeschlagen: ' + (e && e.message ? e.message : String(e)));
  });
});

// ── Manueller Update-Check mit sichtbarem Feedback ──
let manualCheckInProgress = false;
function manualUpdateCheck() {
  if (manualCheckInProgress) return;
  manualCheckInProgress = true;
  logUpdate('[updater] Manueller Update-Check durch Menü…');

  // Sofort-Feedback: "Suche nach Updates..."
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.executeJavaScript(
      `window.cora && window.cora.say ? window.cora.say('Suche nach Updates…', { showBar: false }) : null`
    ).catch(() => {});
  }

  // Einmalige Listener für dieses Check-Ergebnis
  const onAvailable = (info) => {
    autoUpdater.removeListener('update-available', onAvailable);
    autoUpdater.removeListener('update-not-available', onNotAvailable);
    autoUpdater.removeListener('error', onError);
    manualCheckInProgress = false;
    logUpdate('[updater] Manuelles Check: Update verfügbar ' + info.version);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.executeJavaScript(
        `window.cora && window.cora.say ? window.cora.say('Update v${info.version} verfügbar — wird heruntergeladen…', { showBar: false }) : null`
      ).catch(() => {});
    }
  };
  const onNotAvailable = (info) => {
    autoUpdater.removeListener('update-available', onAvailable);
    autoUpdater.removeListener('update-not-available', onNotAvailable);
    autoUpdater.removeListener('error', onError);
    manualCheckInProgress = false;
    const ver = (info && info.version) ? info.version : app.getVersion();
    logUpdate('[updater] Manuelles Check: Kein Update (aktuell ' + ver + ')');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.executeJavaScript(
        `window.cora && window.cora.say ? window.cora.say('Du hast bereits die neueste Version (${ver}).', { showBar: false }) : null`
      ).catch(() => {});
    }
  };
  const onError = (err) => {
    autoUpdater.removeListener('update-available', onAvailable);
    autoUpdater.removeListener('update-not-available', onNotAvailable);
    autoUpdater.removeListener('error', onError);
    manualCheckInProgress = false;
    logUpdate('[updater] Manuelles Check: Fehler ' + (err && err.message ? err.message : String(err)));
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.executeJavaScript(
        `window.cora && window.cora.say ? window.cora.say('Update-Check fehlgeschlagen: ${err && err.message ? err.message.replace(/'/g, "\\'") : 'Unbekannt'}', { showBar: false }) : null`
      ).catch(() => {});
    }
  };
  autoUpdater.on('update-available', onAvailable);
  autoUpdater.on('update-not-available', onNotAvailable);
  autoUpdater.on('error', onError);

  autoUpdater.checkForUpdates().catch((e) => {
    manualCheckInProgress = false;
    autoUpdater.removeListener('update-available', onAvailable);
    autoUpdater.removeListener('update-not-available', onNotAvailable);
    autoUpdater.removeListener('error', onError);
    logUpdate('[updater] Manuelles Check: catch ' + (e && e.message ? e.message : String(e)));
  });
}

// ── Offline-Lesecache: Sync + Interceptor ────────────────────────────
// Phase 1 (nur Lesen): Beim Start/Login wird der Kurse-&-Schüler-
// Datensatz des eingeloggten Lehrers komplett gezogen und der lokale
// JSON-Cache ersetzt. Läuft die App ohne Netz, werden API-GETs aus dem
// Cache beantwortet; die Seite sieht ein "Offline — Stand vom"-Banner.

function sendToPage(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send(channel, data); } catch (_) {}
  }
}

function startOfflineSync(reason) {
  if (syncRunning) return;
  syncRunning = true;
  logUpdate('[sync] Start (' + reason + ')');
  sendToPage('mvm-sync', { state: 'start' });
  const t0 = Date.now();
  offlineSync.syncKurseSchueler((p) => {
    sendToPage('mvm-sync', Object.assign({ state: 'progress' }, p));
  }).then((r) => {
    if (r.ok) {
      logUpdate(`[sync] Fertig in ${r.ms} ms — ${r.entries} Endpunkte, ${r.kurse} Kurse, ${r.schueler} Schueler, ~${Math.round(r.bytes / 1024)} KB`);
      sendToPage('mvm-sync', { state: 'done', ms: r.ms, entries: r.entries });
    } else {
      logUpdate('[sync] Abgebrochen: ' + (r.note || '?') + ' nach ' + r.ms + ' ms');
      sendToPage('mvm-sync', { state: 'skipped', note: r.note });
    }
  }).catch((e) => {
    logUpdate('[sync] FEHLER: ' + (e && e.message ? e.message : String(e)));
    sendToPage('mvm-sync', { state: 'error' });
  }).finally(() => { syncRunning = false; });
}

// ── Stale-while-revalidate (#578) ──
// Bereiche, deren Daten schon im Cache liegen, werden auch ONLINE
// sofort aus dem Cache beantwortet — ohne auf den langsamen Host zu
// warten. Parallel laeuft ein frischer Fetch im Hintergrund, der den
// Cache-Eintrag auffrischt; hat sich der Inhalt wirklich geaendert,
// bekommt der Renderer ein 'mvm-swr'-Event und rendert den Bereich
// weich nach (appShell.refreshCurrentModule()).
const revalidateStamp = new Map(); // key -> Zeitpunkt des letzten Hintergrund-Fetchs
const REVALIDATE_MIN_MS = 1500;    // denselben Key nicht im Sekundentakt neu holen

function swrRevalidate(req, key, oldBody) {
  const last = revalidateStamp.get(key) || 0;
  if (Date.now() - last < REVALIDATE_MIN_MS) return;
  revalidateStamp.set(key, Date.now());
  const bgReq = typeof req.clone === 'function' ? req.clone() : req;
  net.fetch(bgReq, { bypassCustomProtocolHandlers: true })
    .then(async (res) => {
      if (!res.ok) return;
      const text = await res.text();
      if (text !== oldBody) {
        offlineCache.put(key, text);
        logUpdate('[swr] Daten geaendert: ' + key + ' — melde Renderer');
        sendToPage('mvm-swr', { key: key, changed: true });
      }
    })
    .catch(() => { /* Hintergrund-Fetch darf still scheitern */ });
}

/**
 * API-GETs der Web-App abfangen: gecachte Eintraege → sofort aus dem
 * Cache liefern + im Hintergrund auffrischen (SWR, #578); unbekannte
 * Endpunkte online → normal durchreichen; offline/fehlgeschlagen →
 * aus dem Cache beantworten. Nur Lesen — andere Requests und alles
 * ausserhalb von /web2app-ii/api/ gehen unangetastet durch.
 */
function setupOfflineInterceptor() {
  protocol.handle('https', async (req) => {
    let u;
    try { u = new URL(req.url); } catch (_) { return net.fetch(req, { bypassCustomProtocolHandlers: true }); }

    const isApiGet = req.method === 'GET'
      && u.hostname === 'www.mvm.school'
      && u.pathname.startsWith(API_PREFIX);

    if (!isApiGet) {
      if (forceOffline) {
        // Bei simulierter Offline-Navigation direkt die lokale Seite zeigen.
        // Requests in protocol.handle tragen keine fetch()-mode/destination —
        // zuverlaessigste Erkennung: sec-fetch-dest-Header oder der App-Pfad.
        const nav = req.mode === 'navigate' || req.destination === 'document'
          || req.headers.get('sec-fetch-mode') === 'navigate'
          || req.headers.get('sec-fetch-dest') === 'document'
          || u.pathname === '/web2app-ii/' || u.pathname === '/web2app-ii/index.php';
        if (nav) setTimeout(showOfflinePage, 0);
        return new Response('offline (simuliert)', { status: 503 });
      }
      return net.fetch(req, { bypassCustomProtocolHandlers: true });
    }

    const key = u.pathname.slice(API_PREFIX.length - 'api/'.length) + u.search;

    if (!forceOffline) {
      // SWR: schon im Cache → sofort antworten, frische Daten holt der
      // Hintergrund-Fetch (siehe swrRevalidate). Kein Warten auf den Host.
      const cached = offlineCache.get(key);
      if (cached !== null) {
        swrRevalidate(req, key, cached);
        return new Response(cached, {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'x-mvm-cache': 'stale' },
        });
      }
      try {
        const res = await net.fetch(req, { bypassCustomProtocolHandlers: true });
        // Read-through: schon gecachte Endpunkte online auffrischen
        if (res.ok && offlineCache.has(key)) {
          res.clone().text()
            .then((t) => offlineCache.put(key, t))
            .catch(() => {});
        }
        return res;
      } catch (e) {
        logUpdate('[offline] Netzfehler bei ' + key + ' — versuche Cache');
      }
    }

    let body = offlineCache.get(key);
    // Gefilterte Schuelerliste offline: ungefilterte Liste ausliefern
    // (lieber alle Schueler als keine — Client zeigt dann alles).
    if (body === null && /^api\/students\.php\?.*action=list/.test(key)) {
      body = offlineCache.get('api/students.php?action=list');
    }
    if (body !== null) {
      sendToPage('mvm-offline', { stand: offlineCache.stand() });
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'x-mvm-cache': '1' },
      });
    }
    sendToPage('mvm-offline', { stand: offlineCache.stand() });
    return new Response(JSON.stringify({ success: false, error: 'Offline — nicht im Lesecache', _offline: true }), {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  });
}

// ── Lokale Offline-Seite (ganz ohne Netz beim Start) ──
function showOfflinePage() {
  if (!mainWindow || mainWindow.isDestroyed() || onOfflinePage) return;
  if (!offlineCache.stand()) return; // ohne Cache gibt's nichts anzuzeigen → Chrome-Fehlerseite stehen lassen
  onOfflinePage = true;
  logUpdate('[offline] Kein Netz — zeige offline.html (Stand ' + offlineCache.stand() + ')');
  mainWindow.loadFile(path.join(__dirname, 'offline.html'));
  if (!offlineRetryTimer) {
    offlineRetryTimer = setInterval(() => {
      if (net.isOnline() && onOfflinePage) maybeLeaveOfflinePage();
    }, 15000);
  }
}

function maybeLeaveOfflinePage(force) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const onFile = mainWindow.webContents.getURL().startsWith('file://');
  if (!force && !onOfflinePage && !onFile) return;
  onOfflinePage = false;
  if (offlineRetryTimer) { clearInterval(offlineRetryTimer); offlineRetryTimer = null; }
  mainWindow.loadURL(APP_URL);
}

// IPC: offline.html holt den gecachten Datenstand
ipcMain.handle('offline-data', () => {
  const c = offlineCache.load();
  const out = { stand: c.meta.savedAt || null, kurse: [] };
  const listEntry = c.entries['api/courses.php?action=list'];
  if (listEntry) {
    try {
      const j = JSON.parse(listEntry.body);
      for (const k of (j.courses || [])) {
        const name = k.name || k.KURS || '?';
        const stKey = `api/courses.php?action=students&kurs=${encodeURIComponent(name)}`;
        const stE = c.entries[stKey];
        let schueler = [];
        if (stE) {
          try {
            const sj = JSON.parse(stE.body);
            schueler = (sj.students || sj.data || []).map((s) =>
              ((s.firstName || s.vorname || '') + ' ' + (s.lastName || s.nachname || '')).trim());
          } catch (_) {}
        }
        out.kurse.push({ name, schueler });
      }
    } catch (_) {}
  }
  return out;
});

ipcMain.on('offline-retry', () => { maybeLeaveOfflinePage(true); });

// Test-Haken: "Offline simulieren" (Menue Hilfe — nur sichtbar wenn aktiv)
ipcMain.on('debug-force-offline', (_e, val) => {
  forceOffline = !!val;
  logUpdate('[offline] forceOffline = ' + forceOffline);
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: WINDOW_TITLE,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  mainWindow.loadURL(APP_URL);

  // Fenster erst zeigen wenn Inhalt geladen ist (vermeidet weißen Flash)
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Offline-Cache: nach jedem erfolgreichen App-Load Sync anstossen
  // (Sync selbst prueft die Session — ohne Login bricht er sofort ab).
  let syncTimer = null;
  mainWindow.webContents.on('did-finish-load', () => {
    const url = mainWindow.webContents.getURL();
    if (!url.startsWith(APP_URL)) return;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => startOfflineSync('app-load'), 1500);
  });

  // Ganz ohne Netz beim Start: lokale Offline-Seite mit dem letzten
  // Cache-Stand zeigen statt Chromes Fehlerseite.
  mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDesc, url) => {
    const netzFehler = ['ERR_INTERNET_DISCONNECTED', 'ERR_NAME_NOT_RESOLVED',
      'ERR_CONNECTION_FAILED', 'ERR_CONNECTION_TIMED_OUT', 'ERR_ADDRESS_UNREACHABLE'];
    if (netzFehler.includes(errorDesc) || netzFehler.includes(String(errorCode))) {
      showOfflinePage();
    }
  });

  // Externe Links im Standard-Browser öffnen, nicht im App-Fenster
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url !== APP_URL && !url.startsWith(APP_URL)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── Minimales Menü ──
function buildMenu() {
  const isAdmin = userRole === 'admin' || userRole === 'owner';

  const helpSubmenu = [
    {
      label: 'Auf Update prüfen',
      click: () => { manualUpdateCheck(); },
    },
    {
      label: 'Update-Log öffnen',
      click: () => {
        const logFile = path.join(app.getPath('userData'), 'update-log.txt');
        if (fs.existsSync(logFile)) {
          shell.openPath(logFile);
        } else {
          shell.openPath(app.getPath('userData'));
        }
      },
    },
  ];

  // DevTools nur für Admins
  if (isAdmin) {
    helpSubmenu.push({
      label: 'Entwicklertools öffnen',
      accelerator: 'F12',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.openDevTools({ mode: 'detach' });
        }
      },
    });
  }

  helpSubmenu.push({ type: 'separator' });

  // Über CORE OPEN — About-Dialog mit Versionsnummer
  helpSubmenu.push({
    label: 'Über CORE OPEN',
    click: () => {
      const version = app.getVersion();
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Über MVM Core Open',
        message: 'MVM Core Open',
        detail: 'Version ' + version + '\n\nMVM — Academy Modul by CORE OPEN',
        buttons: ['OK'],
        icon: path.join(__dirname, 'build', 'icon.ico'),
      });
    },
  });

  const template = [
    {
      label: 'Datei',
      submenu: [
        {
          label: 'Neu laden',
          accelerator: 'CmdOrCtrl+R',
          click: (menuItem, browserWindow, event) => {
            const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : browserWindow;
            if (!win) return;
            if (event && event.shiftKey) {
              win.webContents.reloadIgnoringCache();
            } else {
              win.webContents.reload();
            }
          },
        },
        {
          label: 'Hart neu laden (Cache leeren)',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: (menuItem, browserWindow) => {
            const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : browserWindow;
            if (win) win.webContents.reloadIgnoringCache();
          },
        },
        { role: 'togglefullscreen', label: 'Vollbild' },
        { type: 'separator' },
        {
          label: 'Offline-Daten neu laden',
          accelerator: 'CmdOrCtrl+D',
          click: () => { startOfflineSync('manuell'); },
        },
        {
          label: 'Offline simulieren',
          type: 'checkbox',
          checked: forceOffline,
          click: (item) => {
            forceOffline = item.checked;
            logUpdate('[offline] forceOffline = ' + forceOffline + ' (Menue)');
          },
        },
        { type: 'separator' },
        { role: 'quit', label: 'Beenden' },
      ],
    },
    {
      label: 'Hilfe',
      submenu: helpSubmenu,
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── App-Lifecycle ──
app.whenReady().then(() => {
  // Offline-Lesecache: API-Interceptor muss vor dem ersten Request stehen
  setupOfflineInterceptor();

  buildMenu();
  createWindow();
  setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
