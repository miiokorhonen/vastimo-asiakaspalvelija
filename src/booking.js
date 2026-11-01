import { normalize, tokens } from "./text.js";
import { checkWish } from "./hours.js";

// Ajanvarausapu: kerää tarpeen ja yhteystiedot. EI varaa aikaa mihinkään järjestelmään.
// Lopputulos on aina "ajanvarauspyyntö", jonka ihminen vahvistaa.
export const BOOKING_NOTICE = "Huomaa: en voi varata aikaa itse. Tämä on vain ajanvarauspyyntö, ja yritys vahvistaa ajan sinulle erikseen.";
const FIELDS = ["palvelu", "aika", "nimi", "yhteys"];
const FIELD_ALIAS = { palvelu: /palvelu/, aika: /(aika|päivä|kello|toive)/, nimi: /nimi/, yhteys: /(yhteys|sähköposti|puhelin|numero|email)/ };
const SKIP = new Set(["varat", "varaa", "varau", "ajanv", "ajan", "aikaa", "aika", "tarvi", "pääsi", "saisi"]);

const list = (kb) => kb.business.palvelut ?? [];
const QUESTIONS = {
  palvelu: (kb) => `Mihin palveluun haluat aikaa?${list(kb).length ? " Vaihtoehtoja: " + list(kb).join(", ") + "." : ""}`,
  aika: () => "Mikä päivä ja kellonaika sopisi sinulle? Kerro toive omin sanoin.",
  nimi: () => "Millä nimellä pyyntö kirjataan?",
  yhteys: () => "Mihin sähköpostiin tai puhelinnumeroon yritys voi vastata?",
  korjaus: () => "Minkä tiedon haluat muuttaa? Kirjoita: palvelu, aika, nimi tai yhteys. Voit myös kirjoittaa peruuta.",
  vahvista: (kb, s) => `Tarkista pyyntö:\n• Palvelu: ${s.data.palvelu}\n• Aikatoive: ${s.data.aika}\n• Nimi: ${s.data.nimi}\n• Yhteys: ${s.data.yhteys}\nLähetetäänkö pyyntö yritykselle? Vastaa kyllä tai muuta. Aikaa ei varata vielä; yritys vahvistaa sen erikseen.`,
};
export const prompt = (kb, state) => QUESTIONS[state.step](kb, state);

const stemOf = (w) => w.slice(0, 5);
export function matchService(kb, text) {
  const words = tokens(text).filter((w) => w.length >= 4 && !SKIP.has(w));
  if (!words.length || !list(kb).length) return { kind: "none" };
  const scored = list(kb).map((s) => {
    const ns = normalize(s), ss = new Set(tokens(s));
    return { s, n: words.filter((w) => ss.has(w) || ns.includes(w)).length };
  }).filter((x) => x.n > 0);
  if (!scored.length) return { kind: "none" };
  const best = Math.max(...scored.map((x) => x.n));
  const top = scored.filter((x) => x.n === best).map((x) => x.s);
  return top.length === 1 ? { kind: "one", value: top[0] } : { kind: "many", values: top };
}

export function startBooking(kb, text = "") {
  const m = matchService(kb, text);
  if (m.kind === "one") return { step: "aika", data: { palvelu: m.value }, reply: `${BOOKING_NOTICE}\nValitsin palveluksi: ${m.value}.\n${QUESTIONS.aika()}` };
  return { step: "palvelu", data: {}, reply: `${BOOKING_NOTICE}\n${QUESTIONS.palvelu(kb)}` };
}

const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const PHONE = /(\+?\d[\d\s-]{6,}\d)/;
export const extractContact = (t) => t.match(EMAIL)?.[0] || t.match(PHONE)?.[0]?.trim() || null;

export const isCancel = (t) => /(?<![a-zäöå])(peruuta|keskeytä|lopeta|ei kiitos)(?![a-zäöå])/.test(normalize(t));

function validate(kb, state, text) {
  const t = text.trim();
  if (!t) return { ok: false, error: "En saanut vastausta. Voisitko kirjoittaa sen uudelleen?" };
  if (t.length > 300) return { ok: false, error: "Vastaus on liian pitkä. Voisitko tiivistää sen?" };
  switch (state.step) {
    case "palvelu": {
      if (!list(kb).length) return { ok: true, value: t };
      const m = matchService(kb, t);
      if (m.kind === "one") return { ok: true, value: m.value };
      if (m.kind === "many") return { ok: false, error: `Tarkoitatko jotakin näistä: ${m.values.join(", ")}? Kirjoita tarkemmin.` };
      if ((state.tries ?? 0) >= 1) return { ok: true, value: `Muu: ${t}` };
      return { ok: false, error: `En tunnistanut palvelua. Vaihtoehdot: ${list(kb).join(", ")}.`, tried: true };
    }
    case "aika": { const c = checkWish(kb, t); return c.ok ? { ok: true, value: t } : { ok: false, error: c.msg }; }
    case "nimi":
      if (t.length < 2 || EMAIL.test(t) || /^\+?[\d\s-]+$/.test(t)) return { ok: false, error: "Kirjoita nimi, jolla pyyntö kirjataan." };
      return { ok: true, value: t };
    case "yhteys": {
      const m = extractContact(t);
      return m ? { ok: true, value: m } : { ok: false, error: "En tunnistanut sähköpostia tai puhelinnumeroa. Voisitko kirjoittaa toisen niistä?" };
    }
  }
}

// Etenee yhden vaiheen. Palauttaa { state, reply, done?, cancelled?, request? }.
export function advance(kb, state, text) {
  if (isCancel(text)) return { state: null, reply: "Selvä, keskeytin ajanvarauspyynnön. Mitään ei ole kirjattu.", cancelled: true };
  const n = normalize(text);
  if (state.step === "vahvista") {
    if (/^(kyllä|kyl|joo|jep|jees|ok|okei|lähetä|kirjaa|sopii)(?![a-zäöå])/.test(n)) {
      const request = { palvelu: state.data.palvelu, aikatoive: state.data.aika, nimi: state.data.nimi, yhteystieto: state.data.yhteys };
      return { state: null, done: true, request, reply: `Kiitos! Kirjasin ajanvarauspyynnön yrityksen saapuneisiin: ${request.palvelu}, toive: ${request.aikatoive}, nimi: ${request.nimi}, yhteys: ${request.yhteystieto}.\nAikaa ei ole vielä varattu. Yritys ottaa sinuun yhteyttä ja vahvistaa ajan.` };
    }
    if (/^(ei|muuta|korjaa|väärin|vaihda)(?![a-zäöå])/.test(n)) { const s = { ...state, step: "korjaus" }; return { state: s, reply: QUESTIONS.korjaus() }; }
    return { state, reply: "Vastaa kyllä, jos pyyntö lähetetään, tai muuta, jos haluat korjata jotain." };
  }
  if (state.step === "korjaus") {
    const f = FIELDS.find((k) => FIELD_ALIAS[k].test(n));
    if (!f) return { state, reply: QUESTIONS.korjaus() };
    const s = { ...state, step: f, fix: true, tries: 0 };
    return { state: s, reply: QUESTIONS[f](kb, s) };
  }
  const v = validate(kb, state, text);
  if (!v.ok) return { state: { ...state, tries: (state.tries ?? 0) + (v.tried ? 1 : 0) }, reply: v.error };
  const data = { ...state.data, [state.step]: v.value };
  const next = state.fix ? "vahvista" : FIELDS[FIELDS.indexOf(state.step) + 1] ?? "vahvista";
  const s = { step: next, data, tries: 0 };
  return { state: s, reply: QUESTIONS[next](kb, s) };
}
