/**
 * main.js — Electron-Hauptprozess für MVM Core Open Desktop.
 *
 * Schlanke Hülle, die https://www.mvm.school/web2app-ii/ in einem
 * eigenständigen Fenster lädt. Genau wie Slack/Discord/Spotify Desktop.
 *
 * #243: Auto-Update via electron-updater. Prüft beim Start im Hintergrund,
 * lädt herunter, zeigt Badge, installiert beim Klick oder beim nächsten Start.
 */
const { app, BrowserWindow, Menu, shell, Notification, ipcMain } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');

const APP_URL = 'https://www.mvm.school/web2app-ii/';
const WINDOW_TITLE = 'MVM - Academy Modul by CORE OPEN';

let mainWindow = null;
let updateOverlay = null;
let updateDownloaded = false;

// ── Auto-Update (#243) ──
function setupAutoUpdater() {
  autoUpdater.autoDownload = true;      // Im Hintergrund herunterladen
  autoUpdater.autoInstallOnAppQuit = true; // Beim Schließen installieren wenn nicht geklickt

  autoUpdater.on('update-available', (info) => {
    console.log('[updater] Update verfügbar:', info.version);
    if (Notification.isSupported()) {
      new Notification({
        title: 'Update wird heruntergeladen',
        body: `Version ${info.version} wird im Hintergrund geladen…`,
        silent: true,
      }).show();
    }
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[updater] Kein Update verfügbar.');
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[updater] Update heruntergeladen:', info.version);
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
    console.error('[updater] Fehler:', err.message);
  });

  autoUpdater.on('download-progress', (progress) => {
    console.log(`[updater] Download: ${Math.round(progress.percent)}%`);
  });

  // Hintergrund-Check alle 4 Stunden (solange App offen)
  setInterval(() => {
    if (!updateDownloaded) {
      autoUpdater.checkForUpdates().catch(() => {});
    }
  }, 4 * 60 * 60 * 1000);

  // Erster Check beim Start (nicht blockierend)
  autoUpdater.checkForUpdates().catch(() => {});
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
  console.log('[updater] Installiere Update und starte neu…');
  if (updateOverlay && !updateOverlay.isDestroyed()) {
    updateOverlay.close();
  }
  autoUpdater.quitAndInstall();
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
      submenu: [
        {
          label: 'Auf Update prüfen',
          click: () => {
            autoUpdater.checkForUpdates().catch(() => {});
          },
        },
        {
          label: 'Über CORE OPEN',
          click: () => {
            shell.openExternal('https://www.mvm.school/web2app-ii/');
          },
        },
      ],
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
