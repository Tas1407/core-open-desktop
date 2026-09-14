# MVM Core Open — Desktop-App

Electron-Hülle für `https://www.mvm.school/web2app-ii/`. Schlanke Wrapper-App
wie Slack/Discord/Spotify Desktop — eigenes Fenster, eigenes Icon, eigener
Taskleisten-Eintrag. Lädt die gehostete Web-App, braucht Internet.

## Build

### Voraussetzungen

- Node.js 18+ und npm
- Windows (für Windows-Build)

### Schritte

```bash
# 1. Dependencies installieren
npm install

# 2. App starten (zum Testen, ohne Installer)
npm start

# 3. NSIS-Installer bauen (.exe)
npm run build

# 4. Nur entpackte App (ohne Installer, schneller)
npm run build:dir
```

Der Installer liegt danach in `dist/MVM Core Open Setup 1.0.0.exe`.

### Bekanntes Problem: Windows ohne Admin-Rechte

`electron-builder` lädt `winCodeSign` herunter, das macOS-Symlinks enthält.
7-Zip kann diese ohne Admin-Rechte nicht extrahieren → Build schlägt fehl mit
`Cannot create symbolic link : A required privilege is not held by the client`.

**Lösung:** In `node_modules/7zip-bin/win/x64/` ist `7za.exe` durch einen
C#-Wrapper ersetzt, der `7za_real.exe` aufruft und Exit-Code 2 (Symlink-Fehler)
als Erfolg behandelt. Die macOS-Dateien werden nicht gebraucht (Windows-Build).

Falls `npm install` den Wrapper überschreibt: Neu kompilieren mit
`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`.

## Konfiguration ändern

### URL ändern

In `main.js` Zeile 8:
```js
const APP_URL = 'https://www.mvm.school/web2app-ii/';
```

### Fenstertitel ändern

In `main.js` Zeile 9:
```js
const WINDOW_TITLE = 'MVM - Academy Modul by CORE OPEN';
```

### Icon ändern

1. PNG-Quelldatei nach `build/icon-512.png` kopieren (512×512 PNG)
2. `.ico` generieren:
   ```bash
   node -e "const fs=require('fs'); const {default: pngToIco}=require('png-to-ico'); pngToIco(fs.readFileSync('build/icon-512.png')).then(b=>fs.writeFileSync('build/icon.ico',b))"
   ```
3. Neu bauen: `npm run build`

### Code-Signing (später)

Aktuell kein Code-Signing → Windows-Warnung "Unbekannter Herausgeber" beim
ersten Start. Um das zu beheben: Zertifikat besorgen und in `package.json`
unter `build.win` eintragen:
```json
"certificateFile": "cert.pfx",
"certificatePassword": "..."
```

## Dateien

| Datei | Zweck |
|-------|-------|
| `main.js` | Electron-Hauptprozess (Fenster, Menü, URL) |
| `preload.js` | Minimaler Preload (keine Node-APIs für Renderer) |
| `build/icon.ico` | Windows-App-Icon (aus web2App II `icon-512.png`) |
| `package.json` | Dependencies + electron-builder Konfiguration |

## Menü

- **Datei:** Neu laden, Vollbild, Beenden
- **Hilfe:** Über CORE OPEN (öffnet Web-URL im Browser)

Externe Links werden im Standard-Browser geöffnet, nicht im App-Fenster.
