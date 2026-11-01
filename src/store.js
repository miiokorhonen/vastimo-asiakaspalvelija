import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { normalize } from "./text.js";

const ID_RE = /^[a-z0-9-]{1,60}$/;
export const TILAT = ["uusi", "hoidossa", "hoidettu", "hylätty"];
export const TYYPIT = ["ajanvarauspyyntö", "yhteydenotto", "vastaamaton"];
const MAX_ROWS = 2000;
const outDir = () => process.env.VASTIMO_OUT_DIR || join(import.meta.dirname, "..", "data", "out");

function file(bid) {
  if (!ID_RE.test(String(bid))) throw new Error("Virheellinen yritystunniste");
  return join(outDir(), bid, "inbox.json");
}
function read(bid) {
  const f = file(bid);
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : [];
}
function write(bid, rows) {
  const f = file(bid);
  mkdirSync(join(outDir(), bid), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rows, null, 1));
  renameSync(tmp, f);
}

// Valinnainen ilmoitus: jos VASTIMO_WEBHOOK_URL on asetettu, uusi saapunut lähetetään sinne (ei provideria sidottu).
function notify(bid, item) {
  const url = process.env.VASTIMO_WEBHOOK_URL;
  if (!url || item.tyyppi === "vastaamaton") return;
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ yritys: bid, ...item }), signal: AbortSignal.timeout(3000) }).catch(() => {});
}

export function add(bid, tyyppi, payload) {
  if (!TYYPIT.includes(tyyppi)) throw new Error("Tuntematon tyyppi");
  const rows = read(bid);
  if (tyyppi === "vastaamaton") {
    const key = normalize(payload.kysymys);
    const ex = rows.find((r) => r.tyyppi === tyyppi && r.tila === "uusi" && normalize(r.kysymys) === key);
    if (ex) { ex.kertaa = (ex.kertaa ?? 1) + 1; ex.paivitetty = new Date().toISOString(); write(bid, rows); return ex; }
  }
  const item = { id: randomUUID().slice(0, 8), tyyppi, tila: "uusi", luotu: new Date().toISOString(), ...payload };
  rows.push(item);
  write(bid, rows.slice(-MAX_ROWS)); // yläraja estää saapuneiden täyttämisen roskalla
  notify(bid, item);
  return item;
}

export function update(bid, id, patch) {
  const rows = read(bid);
  const it = rows.find((r) => r.id === id);
  if (!it) return null;
  if (patch.tila !== undefined) { if (!TILAT.includes(patch.tila)) throw new Error("Virheellinen tila"); it.tila = patch.tila; }
  if (patch.muistiinpano !== undefined) it.muistiinpano = String(patch.muistiinpano).slice(0, 1000);
  if (patch.yhteystieto !== undefined) it.yhteystieto = String(patch.yhteystieto).slice(0, 200);
  it.paivitetty = new Date().toISOString();
  write(bid, rows);
  return it;
}

export function list(bid, { tila, tyyppi, haku } = {}) {
  const q = haku ? normalize(haku) : "";
  return read(bid).filter((r) => (!tila || r.tila === tila) && (!tyyppi || r.tyyppi === tyyppi) && (!q || matches(r, q))).reverse();
}

const matches = (r, q) => normalize(JSON.stringify(r)).includes(q);

// --- Säilytys ja poisto (tietosuoja) ---
export const DEFAULT_RETENTION_DAYS = 90;

/** Poistaa yksittäisen kirjauksen. */
export function remove(bid, id) {
  const rows = read(bid), left = rows.filter((r) => r.id !== id);
  if (left.length === rows.length) return false;
  write(bid, left);
  return true;
}

/** Poistaa kaikki kirjaukset, joissa hakusana esiintyy (esim. asiakkaan sähköposti tai puhelinnumero). */
export function erase(bid, haku) {
  const q = normalize(String(haku ?? ""));
  if (q.length < 3) throw new Error("Hakusanan pitää olla vähintään 3 merkkiä");
  const rows = read(bid), left = rows.filter((r) => !matches(r, q));
  if (left.length !== rows.length) write(bid, left);
  return rows.length - left.length;
}

/** Poistaa kirjaukset, joita ei ole päivitetty säilytysaikaan (päivää) mennessä. */
export function purgeOlderThan(bid, days, now = Date.now()) {
  const limit = now - days * 86_400_000;
  const rows = read(bid), left = rows.filter((r) => Date.parse(r.paivitetty || r.luotu) > limit);
  if (left.length !== rows.length) write(bid, left);
  return rows.length - left.length;
}

/** Poistaa yrityksen kaikki saapuneet. */
export function wipe(bid) {
  file(bid);
  rmSync(join(outDir(), bid), { recursive: true, force: true });
}

const COLS = ["id", "luotu", "tyyppi", "tila", "palvelu", "aikatoive", "nimi", "yhteystieto", "syy", "kysymys", "muistiinpano"];
const cell = (v) => { let s = String(v ?? ""); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
export function csv(bid) {
  return "﻿" + [COLS.join(","), ...list(bid).map((r) => COLS.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n";
}
