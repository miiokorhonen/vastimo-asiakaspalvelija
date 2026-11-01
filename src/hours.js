import { normalize } from "./text.js";
import { DAYS } from "./kb.js";

const NAMES = { ma: "maanantaina", ti: "tiistaina", ke: "keskiviikkona", to: "torstaina", pe: "perjantaina", la: "lauantaina", su: "sunnuntaina" };
const STEMS = { ma: /\bmaanant/, ti: /\btiista/, ke: /\bkeskivii/, to: /\btorsta/, pe: /\bperjant/, la: /\blauant/, su: /\bsunnunt/ };
const NOM = { ma: "maanantai", ti: "tiistai", ke: "keskiviikko", to: "torstai", pe: "perjantai", la: "lauantai", su: "sunnuntai" };
const EN = { Mon: "ma", Tue: "ti", Wed: "ke", Thu: "to", Fri: "pe", Sat: "la", Sun: "su" };

export const hasHours = (kb) => DAYS.some((d) => kb.business.aukiolo?.[d]);
const mins = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const range = (kb, d) => { const r = kb.business.aukiolo?.[d]; if (!r) return null; const [a, b] = r.split("-"); return [mins(a), mins(b)]; };
const fmt = (m) => (m % 60 ? `${Math.floor(m / 60)}.${String(m % 60).padStart(2, "0")}` : String(Math.floor(m / 60)));
const show = (r) => `klo ${fmt(r[0])}–${fmt(r[1])}`;

// Suomen aika (Europe/Helsinki) annetusta hetkestä.
export function localNow(date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Helsinki", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date).map((x) => [x.type, x.value]));
  return { day: EN[p.weekday], min: Number(p.hour) * 60 + Number(p.minute) };
}

export function namedDays(n) {
  const out = DAYS.filter((d) => STEMS[d].test(n));
  if (/viikonlop/.test(n)) out.push("la", "su");
  if (/\barki/.test(n)) out.push("ma", "ti", "ke", "to", "pe");
  return [...new Set(out)];
}

export const isHoursQuestion = (n) => /(auki|avoinna|aukiol|suljettu|suljetaan|sulkeu|avataan|avaatte|sulette)/.test(n);

function nextOpen(kb, now) {
  const i = DAYS.indexOf(now.day);
  for (let k = 0; k < 8; k++) {
    const d = DAYS[(i + k) % 7], r = range(kb, d);
    if (r && (k > 0 || r[0] > now.min)) return { d, r, k };
  }
  return null;
}

export function isOpenNow(kb, now) {
  const r = range(kb, now.day);
  return !!r && now.min >= r[0] && now.min < r[1];
}

const dayLine = (kb, d, label = NAMES[d]) => { const r = range(kb, d); return r ? `${cap(label)} ollaan auki ${show(r)}.` : `${cap(label)} yritys on suljettu.`; };
const cap = (s) => s[0].toUpperCase() + s.slice(1);

// Vastaa aukiolokysymyksiin rakenteisista aukioloajoista (ei arvaa). Palauttaa tekstin tai null.
export function answerHours(kb, text, now = localNow()) {
  if (!hasHours(kb)) return null;
  const n = normalize(text);
  const days = namedDays(n);
  const idx = DAYS.indexOf(now.day);
  if (days.length) return days.map((d) => dayLine(kb, d)).join("\n");
  if (/\bhuomen/.test(n)) return dayLine(kb, DAYS[(idx + 1) % 7], "huomenna");
  if (/\bnyt\b|tällä hetkellä|vielä/.test(n)) return nowStatus(kb, now);
  if (/\btänä/.test(n)) return dayLine(kb, now.day, "tänään");
  return DAYS.map((d) => { const r = range(kb, d); return `${cap(NOM[d])}: ${r ? show(r) : "suljettu"}`; }).join("\n");
}

export function nowStatus(kb, now = localNow()) {
  const r = range(kb, now.day);
  if (isOpenNow(kb, now)) return `Yritys on tällä hetkellä auki ja sulkeutuu klo ${fmt(r[1])}.`;
  const nx = nextOpen(kb, now);
  return `Yritys on tällä hetkellä suljettu.${nx ? ` Seuraavaksi se aukeaa ${nx.k === 0 ? "tänään" : NAMES[nx.d]} klo ${fmt(nx.r[0])}.` : ""}`;
}

// Tarkistaa ajanvaraustoiveen aukioloaikoja vasten. { ok:true } tai { ok:false, msg }.
export function checkWish(kb, text) {
  if (!hasHours(kb)) return { ok: true };
  const n = normalize(text);
  const days = DAYS.filter((d) => STEMS[d].test(n));
  const list = () => DAYS.filter((d) => range(kb, d)).map((d) => `${d}: ${show(range(kb, d))}`).join(", ");
  if (days.length && days.every((d) => !range(kb, d))) {
    return { ok: false, msg: `Yritys on suljettu ${days.map((d) => NAMES[d]).join(" ja ")}. Aukioloajat: ${list()}. Ehdota toista päivää.` };
  }
  const m = text.toLowerCase().match(/klo\.?\s*(\d{1,2})(?:[.:](\d{2}))?|\b(\d{1,2}):(\d{2})\b/);
  if (m && days.length === 1) {
    const t = Number(m[1] ?? m[3]) * 60 + Number(m[2] ?? m[4] ?? 0);
    const r = range(kb, days[0]);
    if (t < r[0] || t >= r[1]) return { ok: false, msg: `${cap(NAMES[days[0]])} yritys on auki ${show(r)}, joten kello ${fmt(t)} ei sovi. Ehdota aikaa aukioloaikana.` };
  }
  return { ok: true };
}

export function closedNote(kb, now = localNow()) {
  return hasHours(kb) && !isOpenNow(kb, now) ? " Yritys on nyt suljettu, joten vastaus voi tulla vasta aukioloaikana." : "";
}
