/**
 * sync.js — Hintergrund-Sync des Offline-Lesecaches (Pilot: Kurse & Schüler).
 *
 * Lädt den kompletten Datensatz des eingeloggten Lehrers für das Modul
 * „Kurse & Schüler" neu und ersetzt die lokale Kopie vollständig
 * (kein Diffing — die Datenmenge ist klein genug).
 *
 * Die Requests laufen über Electron net.fetch in der defaultSession —
 * die teilt den Cookie-Store mit dem App-Fenster, also greift die
 * normale Login-Session und damit die serverseitige Rechte-Logik
 * (#479: Lehrer sehen nur eigene Kurse/Schüler) automatisch.
 */
const { net } = require('electron');
const cache = require('./cache');

const APP_BASE = 'https://www.mvm.school/web2app-ii/';

/** Key-Format des Caches: Pfad+Query relativ zu /web2app-ii/. */
function keyOf(rel) { return rel; }

function urlOf(rel) { return APP_BASE + rel; }

async function fetchJson(rel, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await net.fetch(urlOf(rel), {
      credentials: 'include',
      signal: ctrl.signal,
      // Wichtig: NICHT durch den Offline-Interceptor in main.js laufen —
      // der Sync muss ans echte Netz, sonst "synchronisiert" er den
      // Cache aus dem Cache heraus (sah aus wie Erfolg in 0,4 s).
      bypassCustomProtocolHandlers: true,
    });
    if (!res.ok) return { ok: false, status: res.status };
    const text = await res.text();
    return { ok: true, status: res.status, text };
  } catch (e) {
    return { ok: false, status: 0, error: e && e.message ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Kleiner Parallel-Pool — der Shared-Host mag keine Request-Flut. */
async function pool(items, concurrency, fn, onEach) {
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i], i);
      if (onEach) onEach(i + 1);
    }
  });
  await Promise.all(workers);
}

/**
 * Ein kompletter Sync-Lauf.
 * onProgress({phase, done, total, label}) wird bei jedem Schritt gerufen.
 * Gibt { ok, entries, ms, note } zurück — bei ok=false ist entries leer.
 */
async function syncKurseSchueler(onProgress) {
  const t0 = Date.now();
  if (!net.isOnline()) {
    return { ok: false, ms: 0, note: 'offline' };
  }
  const entries = {};      // lokale Bühne — erst bei Erfolg in den Cache
  const prog = (phase, done, total, label) => {
    try { onProgress && onProgress({ phase, done, total, label }); } catch (_) {}
  };

  // ── Stufe 1: Basis-Endpunkte ──
  const basis = [
    'api/courses.php?action=list',
    'api/students.php?action=list',
    'api/students.php?action=statuses',
    'api/students.php?action=customers',
    'api/students.php?action=courses',
    'api/customers.php?action=list&includeArchived=1',
    'api/personal.php?action=list',
    'api/preferences.php?action=get&key=mvm_test_threshold_pct',
  ];

  let authed = false;
  let done = 0;
  const studentIds = new Set();
  const kursNamen = new Set();

  await pool(basis, 3, async (rel) => {
    const r = await fetchJson(rel);
    if (r.ok) {
      entries[keyOf(rel)] = { body: r.text, fetchedAt: new Date().toISOString() };
      try {
        const j = JSON.parse(r.text);
        if (j && j.success === true) authed = true; // irgendein echter Erfolg = Session lebt
        if (rel === 'api/courses.php?action=list' && Array.isArray(j.courses)) {
          for (const c of j.courses) {
            if (c && c.name) kursNamen.add(String(c.name));
          }
        }
        if (rel === 'api/students.php?action=list' && Array.isArray(j.students)) {
          // students.php aliasiert unique_id als "studentId" (Z. ~488)
          for (const s of j.students) {
            const id = s && (s.uniqueId || s.unique_id || s.studentId);
            if (id) studentIds.add(String(id));
          }
        }
      } catch (_) {}
    }
    prog('basis', ++done, basis.length, rel);
  });

  if (!authed) {
    return { ok: false, ms: Date.now() - t0, note: 'keine-session' };
  }

  // ── Stufe 2: pro Kurs — Teilnehmer + Info ──
  const kurse = [...kursNamen];
  let kDone = 0;
  await pool(kurse, 3, async (name) => {
    for (const rel of [
      `api/courses.php?action=students&kurs=${encodeURIComponent(name)}`,
      `api/courses.php?kurs=${encodeURIComponent(name)}&action=info`,
    ]) {
      const r = await fetchJson(rel);
      if (r.ok) {
        entries[keyOf(rel)] = { body: r.text, fetchedAt: new Date().toISOString() };
        try {
          const j = JSON.parse(r.text);
          // action=students liefert Zeilen mit uniqueId — für Stufe 3 sammeln
          const list = j.students || j.data || [];
          if (Array.isArray(list)) {
            for (const s of list) {
              if (s && (s.uniqueId || s.unique_id)) studentIds.add(String(s.uniqueId || s.unique_id));
            }
          }
        } catch (_) {}
      }
    }
    prog('kurse', ++kDone, kurse.length, name);
  });

  // ── Stufe 3: pro Schüler — Profil + Kursverlauf ──
  const schueler = [...studentIds];
  let sDone = 0;
  await pool(schueler, 4, async (uid) => {
    for (const rel of [
      `api/students.php?action=get&studentId=${encodeURIComponent(uid)}`,
      `api/enrollments.php?action=list-for-student&studentId=${encodeURIComponent(uid)}`,
    ]) {
      const r = await fetchJson(rel);
      if (r.ok) {
        entries[keyOf(rel)] = { body: r.text, fetchedAt: new Date().toISOString() };
      }
    }
    prog('schueler', ++sDone, schueler.length, uid);
  });

  // Volle Ersetzung — erst hier wird der Cache atomar getauscht.
  cache.replaceAll(entries, { userLabel: null });
  return {
    ok: true,
    ms: Date.now() - t0,
    entries: Object.keys(entries).length,
    kurse: kurse.length,
    schueler: schueler.length,
    bytes: Object.values(entries).reduce((s, e) => s + e.body.length, 0),
  };
}

module.exports = { syncKurseSchueler, fetchJson, keyOf };
