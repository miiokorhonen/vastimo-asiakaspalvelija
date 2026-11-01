import { normalize } from "./text.js";
import { search } from "./kb.js";
import { startBooking, advance, prompt, extractContact, BOOKING_NOTICE } from "./booking.js";
import * as store from "./store.js";
import { answerHours, isHoursQuestion, hasHours, closedNote, localNow } from "./hours.js";

const HANDOFF = /(ihmi(nen|sen|selle|stä|seen)|oikea(n|lle)?\s+henkil|henkilökunta|puhua\s+(jonkun|jollekin|yrittäjä|omistaja)|yhteydenottopyyn|soittopyyn|soittakaa|reklamaatio|valitus|valittaa|huijaus|hätä)/;
const NO_HANDOFF = /(?<![a-zäöå])(en|ei)(?![a-zäöå]).{0,15}(halua|tarvitse|tarvi).{0,25}(ihmi|henkil)/;
const BOOKING = /(varaa|varata|varaus|varauks|ajanvara|saisinko\s+(ajan|aikaa)|pääsisikö|pääsenkö|tarvitsen\s+(ajan|aikaa)|haluan\s+ajan|haluaisin\s+ajan|vapaita\s+aikoja|vapaa\s+aika)/;
const GREETING = /^(hei|moi|moikka|terve|hej|päivää|huomenta|iltaa)(?![a-zäöå])/;
const THANKS = /^(kiitos|kiitti|näkemiin|heippa|hei hei)(?![a-zäöå])/;

const THRESHOLD = 2;      // vähimmäispisteet vastaamiseen
const MIN_COVERAGE = 0.4; // osuus kysymyksen sisältösanoista, jotka löytyvät lähteestä
const SESSION_TTL = 60 * 60 * 1000;

/** kb: tietopohja tai funktio, joka palauttaa ajantasaisen tietopohjan (ylläpitomuutokset näkyvät heti). */
export function createAssistant(kbOrGetter, { persist = true, now = () => new Date() } = {}) {
  const getKb = typeof kbOrGetter === "function" ? kbOrGetter : () => kbOrGetter;
  const sessions = new Map();

  function session(id) {
    const t = now().getTime();
    if (sessions.size > 500) for (const [k, s] of sessions) if (t - s.seen > SESSION_TTL) sessions.delete(k);
    const s = sessions.get(id) ?? { log: [], booking: null, misses: 0, awaitingContact: null };
    s.seen = t;
    sessions.set(id, s);
    return s;
  }
  const bid = () => getKb().business.id;
  const save = (tyyppi, p) => (persist ? store.add(bid(), tyyppi, p) : { tyyppi, ...p });

  function handoff(s, reason, text) {
    const kb = getKb();
    const contact = extractContact(text);
    const row = save("yhteydenotto", { syy: reason, keskustelu: s.log.slice(-12), ...(contact ? { yhteystieto: contact } : {}), ...(s.booking ? { keskenerainen_ajanvaraus: s.booking.data } : {}) });
    s.booking = null;
    s.awaitingContact = contact ? null : row.id ?? "ei-tallennettu";
    const y = kb.business.yhteys ?? {};
    const direct = [y.puhelin && `puhelin ${y.puhelin}`, y.sahkoposti && `sähköposti ${y.sahkoposti}`].filter(Boolean).join(", ");
    const reply = `Selvä, ohjaan asian yrityksen väelle. Kirjasin yhteydenottopyynnön ja keskustelun tiedot yrityksen saapuneisiin, jotta sinun ei tarvitse toistaa asiaa.${closedNote(kb, localNow(now()))}`
      + (contact ? " Kiitos yhteystiedoistasi, yritys vastaa niihin." : " Kirjoita vielä sähköpostisi tai puhelinnumerosi, niin yritys tietää mihin vastata.")
      + (direct ? ` Voit myös ottaa yhteyttä suoraan: ${direct}.` : "");
    return { reply, kind: "handoff", row };
  }

  function answerQuestion(kb, text, n) {
    if (hasHours(kb) && isHoursQuestion(n)) {
      const reply = answerHours(kb, text, localNow(now()));
      if (reply) return { reply: `${reply}\n(Lähde: Aukioloajat)`, kind: "answer", sources: ["aukioloajat"] };
    }
    const hits = search(kb, text);
    const top = hits[0];
    if (top && top.score >= THRESHOLD && top.coverage >= MIN_COVERAGE) {
      return { reply: `${top.entry.teksti}\n(Lähde: ${top.entry.otsikko})`, kind: "answer", sources: hits.filter((h) => h.score >= THRESHOLD).map((h) => h.entry.id) };
    }
    return null;
  }

  function respond(sessionId, message) {
    const text = String(message ?? "").slice(0, 1000).trim();
    if (!text) return { reply: "Kirjoita kysymyksesi, niin autan.", kind: "empty" };
    const s = session(sessionId);
    s.log.push({ rooli: "asiakas", teksti: text });
    const out = decide(s, text);
    s.log.push({ rooli: "avustaja", teksti: out.reply });
    return out;
  }

  function decide(s, text) {
    const kb = getKb();
    const n = normalize(text);
    if (s.awaitingContact) {
      const id = s.awaitingContact;
      s.awaitingContact = null;
      const c = extractContact(text);
      if (c) {
        if (persist && id !== "ei-tallennettu") store.update(bid(), id, { yhteystieto: c });
        return { reply: "Kiitos, lisäsin yhteystiedot yhteydenottopyyntöön. Yritys vastaa niihin.", kind: "handoff_contact" };
      }
    }
    if (HANDOFF.test(n) && !NO_HANDOFF.test(n)) return handoff(s, s.booking ? "asiakas pyysi ihmistä kesken ajanvarauksen" : "asiakas pyysi ihmistä tai valitti", text);

    if (s.booking) {
      if (s.booking.step !== "vahvista" && s.booking.step !== "korjaus" && text.includes("?")) {
        const a = answerQuestion(kb, text, n);
        if (a) return { ...a, reply: `${a.reply}\n\nJatketaan ajanvarausta. ${prompt(kb, s.booking)}` };
      }
      const r = advance(kb, s.booking, text);
      s.booking = r.state;
      if (r.done) { const row = save("ajanvarauspyyntö", r.request); return { reply: r.reply, kind: "booking_done", request: row }; }
      return { reply: r.reply, kind: r.cancelled ? "booking_cancelled" : "booking_step" };
    }
    if (BOOKING.test(n)) {
      const b = startBooking(kb, text);
      s.booking = { step: b.step, data: b.data };
      return { reply: b.reply, kind: "booking_start" };
    }
    if (GREETING.test(n) && n.split(" ").length <= 3) return { reply: `Hei! Olen ${kb.business.nimi} -yrityksen automaattinen avustaja (en ole ihminen). Vastaan yrityksen tietojen perusteella ja voin ottaa vastaan ajanvarauspyynnön. Miten voin auttaa?`, kind: "greeting" };
    if (THANKS.test(n)) return { reply: "Ole hyvä! Kysy rohkeasti lisää, jos tarvitset muuta.", kind: "thanks" };

    const a = answerQuestion(kb, text, n);
    if (a) { s.misses = 0; return a; }
    s.misses += 1;
    save("vastaamaton", { kysymys: text });
    if (s.misses >= 2) return handoff(s, "kaksi vastaamatonta kysymystä peräkkäin", text);
    return { reply: "En löydä tähän luotettavaa vastausta yrityksen tiedoista, enkä halua arvailla. Voit kysyä toisin sanoin, pyytää ihmisen vastaamaan tai jättää ajanvarauspyynnön.", kind: "unknown" };
  }

  return { respond, BOOKING_NOTICE };
}
