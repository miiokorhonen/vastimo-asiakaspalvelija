import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tokens } from "./text.js";

export const ID_RE = /^[a-z0-9-]{1,60}$/;
export const DAYS = ["ma", "ti", "ke", "to", "pe", "la", "su"];
export const dataRoot = () => process.env.VASTIMO_DATA_DIR || join(import.meta.dirname, "..", "data", "businesses");

const RANGE = /^(\d{1,2})(?:[.:](\d{2}))?\s*[-–—]\s*(\d{1,2})(?:[.:](\d{2}))?$/;
const pad = (n) => String(n).padStart(2, "0");

// Palauttaa "HH:MM-HH:MM", "" (suljettu) tai null (virheellinen).
export function normalizeRange(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s || s === "suljettu" || s === "-") return "";
  const m = s.match(RANGE);
  if (!m) return null;
  const a = [Number(m[1]), Number(m[2] ?? 0)], b = [Number(m[3]), Number(m[4] ?? 0)];
  if (a[0] > 23 || b[0] > 24 || a[1] > 59 || b[1] > 59) return null;
  if (a[0] * 60 + a[1] >= b[0] * 60 + b[1]) return null;
  return `${pad(a[0])}:${pad(a[1])}-${pad(b[0])}:${pad(b[1])}`;
}

const slug = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "tieto";

function buildIndex(kb) {
  kb.index = kb.entries.map((e) => ({
    entry: e,
    title: new Set(tokens(e.otsikko)),
    keys: new Set(tokens((e.avainsanat || []).join(" "))),
    body: new Set(tokens(e.teksti)),
  }));
  return kb;
}

export const MIN_RETENTION = 7, MAX_RETENTION = 365, DEFAULT_RETENTION = 90;
function retention(v) {
  if (v === undefined || v === null || v === "") return DEFAULT_RETENTION;
  const n = Number(v);
  if (!Number.isInteger(n) || n < MIN_RETENTION || n > MAX_RETENTION) throw new Error(`Säilytysaika on ${MIN_RETENTION}–${MAX_RETENTION} päivää`);
  return n;
}

// Tarkistaa ja siistii tietopohjan (käytetään ylläpitotallennuksessa). Heittää suomenkielisen virheen.
export function validateKb(raw, id) {
  const fail = (m) => { throw new Error(m); };
  if (!raw || typeof raw !== "object") fail("Virheellinen tietopohja");
  const str = (v, max, name) => {
    const s = String(v ?? "").trim();
    if (s.length > max) fail(`${name} on liian pitkä (enintään ${max} merkkiä)`);
    return s;
  };
  const b = raw.business ?? {};
  const nimi = str(b.nimi, 100, "Yrityksen nimi");
  if (!nimi) fail("Yrityksen nimi puuttuu");
  const palvelut = (Array.isArray(b.palvelut) ? b.palvelut : []).map((p) => str(p, 80, "Palvelun nimi")).filter(Boolean);
  if (palvelut.length > 40) fail("Palveluita saa olla enintään 40");
  const aukiolo = {};
  for (const d of DAYS) {
    const r = normalizeRange(b.aukiolo?.[d]);
    if (r === null) fail(`Aukioloaika ei kelpaa (${d}). Kirjoita muodossa 9-17 tai jätä tyhjäksi, jos suljettu`);
    aukiolo[d] = r;
  }
  const email = str(b.yhteys?.sahkoposti, 120, "Sähköposti");
  if (email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) fail("Sähköpostiosoite ei kelpaa");
  const entriesIn = Array.isArray(raw.entries) ? raw.entries : [];
  if (entriesIn.length > 150) fail("Tietoja saa olla enintään 150");
  const used = new Set();
  const entries = entriesIn.map((e) => {
    const otsikko = str(e.otsikko, 120, "Otsikko");
    const teksti = str(e.teksti, 1200, "Vastausteksti");
    if (!otsikko || !teksti) fail("Jokaisella tiedolla pitää olla otsikko ja vastausteksti");
    let eid = ID_RE.test(String(e.id ?? "")) ? e.id : slug(otsikko);
    for (let i = 2; used.has(eid); i++) eid = `${slug(otsikko)}-${i}`;
    used.add(eid);
    const avainsanat = (Array.isArray(e.avainsanat) ? e.avainsanat : String(e.avainsanat ?? "").split(",")).map((k) => str(k, 40, "Avainsana")).filter(Boolean).slice(0, 30);
    const out = { id: eid, otsikko, avainsanat, teksti };
    const kysymys = str(e.kysymys, 120, "Esimerkkikysymys");
    if (kysymys) out.kysymys = kysymys;
    return out;
  });
  return {
    business: {
      id,
      nimi,
      kuvaus: str(b.kuvaus, 400, "Kuvaus"),
      palvelut,
      aukiolo,
      yhteys: { puhelin: str(b.yhteys?.puhelin, 40, "Puhelin"), sahkoposti: email },
      demo: b.demo === true,
      sailytysPaivat: retention(b.sailytysPaivat),
    },
    entries,
    handoff: { ohje: str(raw.handoff?.ohje ?? raw.handoff?.kanava, 400, "Ohje ihmiselle siirtoon") },
  };
}

export function loadKnowledgeBase(businessId, root = dataRoot()) {
  if (!ID_RE.test(String(businessId))) throw new Error("Virheellinen yritystunniste");
  const file = join(root, businessId, "kb.json");
  if (!existsSync(file)) throw new Error("Tuntematon yritys");
  const kb = JSON.parse(readFileSync(file, "utf8"));
  if (kb.business?.id !== businessId) throw new Error("Tietopohjan yritystunniste ei täsmää");
  kb.business.aukiolo ??= {};
  kb.business.yhteys ??= {};
  kb.entries ??= [];
  return buildIndex(kb);
}

export function saveKnowledgeBase(businessId, raw, root = dataRoot()) {
  if (!ID_RE.test(String(businessId))) throw new Error("Virheellinen yritystunniste");
  const kb = validateKb(raw, businessId);
  const dir = join(root, businessId);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `kb.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(kb, null, 2) + "\n");
  renameSync(tmp, join(dir, "kb.json"));
  return loadKnowledgeBase(businessId, root);
}

export function createBusiness(id, nimi, root = dataRoot()) {
  if (!ID_RE.test(String(id))) throw new Error("Tunnuksessa saa olla vain a–z, 0–9 ja viiva (enintään 60 merkkiä)");
  if (existsSync(join(root, id, "kb.json"))) throw new Error("Tunnus on jo käytössä");
  return saveKnowledgeBase(id, { business: { nimi, palvelut: [], aukiolo: {}, yhteys: {} }, entries: [] }, root);
}

export function deleteBusinessData(businessId, root = dataRoot()) {
  if (!ID_RE.test(String(businessId))) throw new Error("Virheellinen yritystunniste");
  rmSync(join(root, businessId), { recursive: true, force: true });
}

export function listBusinesses(root = dataRoot()) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && ID_RE.test(d.name) && existsSync(join(root, d.name, "kb.json")))
    .map((d) => { const kb = loadKnowledgeBase(d.name, root); return { id: d.name, nimi: kb.business.nimi, demo: kb.business.demo === true }; });
}

// Pisteytys: avainsana 3, otsikko 2, leipäteksti 1. Hakua ei koskaan tehdä yli yritysrajojen (kb on yrityskohtainen).
export function search(kb, query, limit = 2) {
  const q = [...new Set(tokens(query))];
  if (!q.length) return [];
  return kb.index
    .map(({ entry, title, keys, body }) => {
      let score = 0;
      const hits = [];
      for (const t of q) {
        const s = (keys.has(t) ? 3 : 0) + (title.has(t) ? 2 : 0) + (body.has(t) ? 1 : 0);
        if (s) hits.push(t);
        score += s;
      }
      return { entry, score, coverage: hits.length / q.length };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
