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
const { app, BrowserWindow, Menu, shell, Notification, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

const APP_URL = 'https://www.mvm.school/web2app-ii/';
const WINDOW_TITLE = 'MVM - Academy Modul by CORE OPEN';

let mainWindow = null;
let updateOverlay = null;
let updateDownloaded = false;
let userRole = null; // vom Renderer nach Login gesetzt ('admin', 'teacher', etc.)

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
        detail: 'Version ' + version + '\n\nMVM — Academy Modul by CORE OPEN\nhttps://www.mvm.school/web2app-ii/',
        buttons: ['OK'],
        icon: path.join(__dirname, 'build', 'icon.ico'),
      });
    },
  });

  const template = [
    {
      label: 'Datei',
      submenu: [
        { role: 'reload', label: 'Neu laden' },
        { role: 'togglefullscreen', label: 'Vollbild' },
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
