/**
 * cache.js — Offline-Lesecache für die Desktop-App (#562-Phase/Offline-Cache).
 *
 * Speicher: EINE JSON-Datei in userData. Kein SQLite — better-sqlite3
 * braeuchte einen Native-Rebuild (node-gyp/MSVC), der auf dieser
 * Maschine nicht verfuegbar ist, und der Cache ist bewusst ein simpler
 * Key→Body-Store (volle Ersetzung, keine Queries). Falls Phase 2
 * Suchen/Filter im Cache braucht, kann hier eine SQLite-Variante
 * hinter dasselbe Interface.
 *
 * Aufbau der Datei:
 *   {
 *     meta: { savedAt, userLabel },
 *     entries: { 'api/courses.php?action=list': { body, fetchedAt }, ... }
 *   }
 * Keys sind Request-Pfad + Query relativ zu /web2app-ii/.
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let cacheFile = null;
let mem = null; // { meta, entries }

function filePath() {
  if (!cacheFile) {
    cacheFile = path.join(app.getPath('userData'), 'offline-cache.json');
  }
  return cacheFile;
}

function load() {
  if (mem) return mem;
  try {
    const raw = fs.readFileSync(filePath(), 'utf8');
    const parsed = JSON.parse(raw);
    mem = {
      meta: parsed && parsed.meta ? parsed.meta : {},
      entries: parsed && parsed.entries ? parsed.entries : {},
    };
  } catch (e) {
    mem = { meta: {}, entries: {} };
  }
  return mem;
}

function persist() {
  const tmp = filePath() + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(mem), 'utf8');
    fs.renameSync(tmp, filePath());
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    console.error('[offline-cache] persist failed:', e.message);
  }
}

/** Volle Ersetzung: alle Einträge eines Sync-Laufs auf einmal schreiben. */
function replaceAll(entries, meta) {
  mem = {
    meta: Object.assign({ savedAt: new Date().toISOString() }, meta || {}),
    entries: entries || {},
  };
  persist();
}

/** Einzelnen Eintrag aktualisieren (read-through beim Online-Betrieb). */
function put(key, body) {
  load();
  mem.entries[key] = { body: String(body), fetchedAt: new Date().toISOString() };
  // Nicht bei jedem Request auf Platte schreiben — billiges Debounce.
  schedulePersist();
}

function get(key) {
  const e = load().entries[key];
  return e ? e.body : null;
}

function has(key) {
  return Object.prototype.hasOwnProperty.call(load().entries, key);
}

function stand() {
  const m = load().meta;
  return m.savedAt || null;
}

function stats() {
  const m = load();
  return {
    entries: Object.keys(m.entries).length,
    savedAt: m.meta.savedAt || null,
    userLabel: m.meta.userLabel || null,
  };
}

let persistTimer = null;
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persist();
  }, 800);
}

module.exports = { get, put, has, replaceAll, stand, stats, load };
