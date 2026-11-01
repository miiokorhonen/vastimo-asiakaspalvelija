import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const tmp = mkdtempSync(join(tmpdir(), "vastimo-"));
process.env.VASTIMO_OUT_DIR = join(tmp, "out");
process.env.VASTIMO_DATA_DIR = join(tmp, "businesses");
process.env.VASTIMO_AUTH_DIR = join(tmp, "auth");
cpSync(join(import.meta.dirname, "..", "data", "businesses"), process.env.VASTIMO_DATA_DIR, { recursive: true });

const { loadKnowledgeBase, validateKb } = await import("../src/kb.js");
const { createAssistant } = await import("../src/assistant.js");
const { createApp } = await import("../src/server.js");
const store = await import("../src/store.js");

const MON_10 = () => new Date("2026-11-02T08:00:00Z"); // maanantai klo 10 Suomen aikaa
const SUN_12 = () => new Date("2026-11-01T10:00:00Z"); // sunnuntai klo 12
const bot = (id = "esimerkki-parturi", now = MON_10) => createAssistant(() => loadKnowledgeBase(id), { now });
const bid = "esimerkki-parturi";
const inbox = (id = bid, f) => store.list(id, f);

test("vastaa tietopohjasta ja näyttää lähteen (taivutetut sanat)", () => {
  const r = bot().respond("s", "Mitä maksutapoja te käytätte?");
  assert.equal(r.kind, "answer");
  assert.match(r.reply, /kortilla/);
  assert.match(r.reply, /Lähde: Maksutavat/);
});

test("aukiolokysymykset ratkaistaan rakenteisista tiedoista, myös nyt ja huomenna", () => {
  assert.match(bot().respond("a", "Milloin olette auki lauantaina?").reply, /Lauantaina ollaan auki klo 10–15/);
  assert.match(bot().respond("b", "Onko sunnuntaina auki?").reply, /Sunnuntaina yritys on suljettu/);
  assert.match(bot().respond("c", "Oletteko auki nyt?").reply, /tällä hetkellä auki ja sulkeutuu klo 17/);
  const sun = bot("esimerkki-parturi", SUN_12).respond("d", "Onko teillä nyt auki?").reply;
  assert.match(sun, /suljettu.*aukeaa maanantaina klo 9/);
  assert.match(bot("esimerkki-parturi", SUN_12).respond("e", "Entä huomenna, ootteko auki?").reply, /Huomenna ollaan auki klo 9–17/);
  assert.match(bot().respond("f", "Mitkä ovat aukioloajat?").reply, /Maanantai: klo 9–17[\s\S]*Sunnuntai: suljettu/);
});

test("ei keksi hintaa, kun tietoa ei ole", () => {
  const r = bot().respond("s", "Paljonko hiustenleikkaus maksaa euroina?");
  assert.doesNotMatch(r.reply, /\d+\s?(€|euroa)/);
});

test("tuntematon aihe: rehellinen epävarmuus, kirjaus ja toisella kerralla siirto ihmiselle", () => {
  const b = bot("esimerkki-hierontala");
  const a = b.respond("s", "Myyttekö te lentokoneita?");
  assert.equal(a.kind, "unknown");
  assert.match(a.reply, /enkä halua arvailla/);
  assert.equal(b.respond("s", "Entä rakettimoottoreita?").kind, "handoff");
  assert.equal(inbox("esimerkki-hierontala", { tyyppi: "vastaamaton" }).length, 2);
});

test("yritysten tiedot eivät vuoda toiseen yritykseen", () => {
  assert.equal(bot("esimerkki-hierontala").respond("s", "Mitä maksutapoja käytätte?").kind, "unknown");
  assert.equal(bot().respond("t", "Kuinka kauan hieronta kestää?").kind, "unknown");
  assert.match(bot("esimerkki-hierontala").respond("u", "Kuinka kauan hieronta kestää?").reply, /30 tai 60 minuuttia/);
});

test("ihmisen pyytäminen: kirjaus, yhteystiedon lisäys samaan pyyntöön, ei väitettä välittömästä vastauksesta", () => {
  const b = bot();
  const r = b.respond("h1", "Haluan puhua oikean ihmisen kanssa");
  assert.equal(r.kind, "handoff");
  assert.match(r.reply, /Kirjoita vielä sähköpostisi/);
  assert.equal(b.respond("h1", "maija@example.com").kind, "handoff_contact");
  const row = inbox(bid, { tyyppi: "yhteydenotto" }).find((x) => x.id === r.row.id);
  assert.equal(row.yhteystieto, "maija@example.com");
  assert.match(row.keskustelu[0].teksti, /puhua oikean ihmisen/);
});

test("yhteystieto samassa viestissä ja kielto 'en halua ihmistä' eivät sekoitu", () => {
  const r = bot().respond("h2", "Reklamaatio! Soittakaa 0401234567");
  assert.equal(r.kind, "handoff");
  assert.equal(r.row.yhteystieto, "0401234567");
  assert.notEqual(bot().respond("h3", "En halua puhua ihmisen kanssa, kerro aukioloajat").kind, "handoff");
});

test("siirto suljettuna aikana kertoo viiveestä", () => {
  assert.match(bot("esimerkki-parturi", SUN_12).respond("h4", "Haluan puhua ihmisen kanssa").reply, /nyt suljettu/);
});

test("ajanvaraus: koko polku, vahvistus ja kirjaus; ei väitä varanneensa", () => {
  const b = bot();
  const start = b.respond("b1", "Haluaisin varata ajan");
  assert.equal(start.kind, "booking_start");
  assert.match(start.reply, /en voi varata aikaa itse/);
  assert.equal(b.respond("b1", "kaljuuntumishoito").kind, "booking_step"); // tuntematon palvelu -> tarkennus
  assert.match(b.respond("b1", "hiustenleikkaukseen").reply, /Mikä päivä/);
  assert.match(b.respond("b1", "Sunnuntaina").reply, /suljettu sunnuntaina/);
  assert.match(b.respond("b1", "Tiistaina klo 18").reply, /auki klo 9–17.*ei sovi/);
  assert.match(b.respond("b1", "Tiistaina klo 15").reply, /Millä nimellä/);
  assert.match(b.respond("b1", "Matti Meikäläinen").reply, /sähköpostiin tai puhelinnumeroon/);
  assert.match(b.respond("b1", "ei numero").reply, /en tunnistanut/i);
  const sum = b.respond("b1", "matti@example.com");
  assert.match(sum.reply, /Tarkista pyyntö[\s\S]*Hiustenleikkaus[\s\S]*Tiistaina klo 15/);
  assert.equal(inbox(bid, { tyyppi: "ajanvarauspyyntö" }).length, 0); // ei vielä kirjattu
  const done = b.respond("b1", "kyllä");
  assert.equal(done.kind, "booking_done");
  assert.match(done.reply, /Aikaa ei ole vielä varattu/);
  assert.doesNotMatch(done.reply, /aika on varattu|varaus vahvistettu/i);
  const row = inbox(bid, { tyyppi: "ajanvarauspyyntö" })[0];
  assert.deepEqual([row.palvelu, row.aikatoive, row.nimi, row.yhteystieto, row.tila], ["Hiustenleikkaus", "Tiistaina klo 15", "Matti Meikäläinen", "matti@example.com", "uusi"]);
  assert.ok(row.luotu && !isNaN(Date.parse(row.luotu)));
});

test("ajanvaraus: palvelu poimitaan avausviestistä, epäselvä palvelu tarkennetaan, korjaus ja peruutus toimivat", () => {
  const b = bot();
  assert.match(b.respond("b2", "Haluan varata ajan parranajoon").reply, /Valitsin palveluksi: Parranajo/);
  b.respond("b2", "keskiviikkona aamulla"); b.respond("b2", "Liisa"); b.respond("b2", "0501112222");
  assert.match(b.respond("b2", "muuta").reply, /Minkä tiedon/);
  assert.match(b.respond("b2", "aika").reply, /Mikä päivä/);
  assert.match(b.respond("b2", "torstaina iltapäivällä").reply, /torstaina iltapäivällä/); // palaa suoraan yhteenvetoon
  assert.equal(b.respond("b2", "peruuta").kind, "booking_cancelled");
  const amb = bot(), r = (m) => amb.respond("b3", m).reply;
  r("varaa aika"); assert.match(r("leikkaus"), /Tarkoitatko jotakin näistä: Hiustenleikkaus, Lasten leikkaus/);
});

test("kesken ajanvarauksen voi kysyä ja pyytää ihmistä, eikä viesti päädy nimeksi", () => {
  const b = bot();
  b.respond("b4", "varaa aika");
  const q = b.respond("b4", "Mitä maksutapoja käytätte?");
  assert.match(q.reply, /kortilla[\s\S]*Jatketaan ajanvarausta[\s\S]*Mihin palveluun/);
  b.respond("b4", "värjäys"); b.respond("b4", "maanantaina klo 12");
  const h = b.respond("b4", "haluan puhua ihmisen kanssa");
  assert.equal(h.kind, "handoff");
  assert.deepEqual(h.row.keskenerainen_ajanvaraus, { palvelu: "Värjäys", aika: "maanantaina klo 12" });
});

test("tietopohjan validointi: aukioloajat, sähköposti, pituudet, tunnisteet", () => {
  const ok = validateKb({ business: { nimi: "X", aukiolo: { ma: "9.30-16", su: "suljettu" } }, entries: [{ otsikko: "Hinnat", teksti: "a" }, { otsikko: "Hinnat", teksti: "b" }] }, "x");
  assert.equal(ok.business.aukiolo.ma, "09:30-16:00");
  assert.equal(ok.business.aukiolo.su, "");
  assert.deepEqual(ok.entries.map((e) => e.id), ["hinnat", "hinnat-2"]);
  assert.throws(() => validateKb({ business: { nimi: "X", aukiolo: { ma: "17-9" } }, entries: [] }, "x"), /Aukioloaika/);
  assert.throws(() => validateKb({ business: { nimi: "X", yhteys: { sahkoposti: "ei" } }, entries: [] }, "x"), /Sähköposti/);
  assert.throws(() => validateKb({ business: { nimi: "" }, entries: [] }, "x"), /nimi puuttuu/);
  assert.throws(() => loadKnowledgeBase("../etc"), /Virheellinen/);
  assert.throws(() => loadKnowledgeBase("ei-ole"), /Tuntematon/);
});

function api(app) {
  const port = app.address().port;
  return async (method, path, body, token) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "x-admin-token": token ?? "", connection: "close" } });
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch { j = t; }
    return { status: r.status, body: j, headers: r.headers };
  };
}

test("HTTP: julkinen chat, yksityisyys, ylläpidon suojaus", async () => {
  const app = createApp({ adminToken: "testitunnus-123" }).listen(0);
  after(() => app.closeAllConnections?.() || app.close());
  const call = api(app);
  const chat = (b) => call("POST", "/api/chat", b);
  assert.match((await chat({ businessId: bid, sessionId: "x", message: "Mitä maksutapoja käytätte?" })).body.reply, /kortilla/);
  assert.equal((await chat({ businessId: "toinen", sessionId: "x", message: "hei" })).status, 404);
  assert.equal((await chat({ businessId: bid, message: "hei" })).status, 400);
  assert.equal((await call("GET", "/api/public/" + bid)).body.pikavalinnat.length, 4);
  assert.equal((await call("GET", "/api/public/" + bid)).body.entries, undefined);
  assert.equal((await call("GET", "/api/demo")).body.length, 2);
  for (const p of ["/api/admin/businesses", `/api/admin/kb/${bid}`, `/api/admin/inbox/${bid}`]) assert.equal((await call("GET", p)).status, 401);
  assert.equal((await call("GET", "/api/admin/businesses", undefined, "väärä")).status, 401);
  assert.equal((await call("GET", "/", undefined)).status, 200);
  assert.equal((await call("GET", "/admin")).status, 200);
  assert.equal((await call("GET", "/data/businesses/x/kb.json")).status, 404);
  assert.equal((await call("GET", "/..%2fpackage.json")).status, 404);
});

test("HTTP: yrityksen luonti, tietojen muokkaus tulee heti käyttöön, saapuneiden käsittely ja CSV", async () => {
  const app = createApp({ adminToken: "t", now: MON_10 }).listen(0);
  after(() => app.closeAllConnections?.() || app.close());
  const call = api(app), T = "t";
  assert.equal((await call("POST", "/api/admin/businesses", { id: "Huono Tunnus", nimi: "x" }, T)).status, 400);
  assert.equal((await call("POST", "/api/admin/businesses", { id: "kahvila-testi", nimi: "Kahvila Testi" }, T)).status, 201);
  assert.equal((await call("POST", "/api/admin/businesses", { id: "kahvila-testi", nimi: "x" }, T)).status, 400);
  const chat = async (m, s = "k1") => (await call("POST", "/api/chat", { businessId: "kahvila-testi", sessionId: s, message: m })).body;
  assert.equal((await chat("Onko teillä lounasta?")).kind, "unknown");

  const kb = (await call("GET", "/api/admin/kb/kahvila-testi", undefined, T)).body;
  kb.business.palvelut = ["Pöytävaraus"];
  kb.business.aukiolo = { ma: "8-16", ti: "8-16", ke: "8-16", to: "8-16", pe: "8-16", la: "", su: "" };
  kb.entries.push({ otsikko: "Lounas", avainsanat: "lounas, ruoka", teksti: "Lounas tarjoillaan arkisin klo 11–14.", kysymys: "Onko teillä lounasta?" });
  const put = await call("PUT", "/api/admin/kb/kahvila-testi", kb, T);
  assert.equal(put.status, 200);
  assert.match((await chat("Onko teillä lounasta?", "k2")).reply, /arkisin klo 11–14/);
  assert.match((await chat("Oletteko auki nyt?", "k2")).reply, /auki ja sulkeutuu klo 16/);
  assert.equal((await call("PUT", "/api/admin/kb/kahvila-testi", { business: { nimi: "" } }, T)).status, 422);

  await chat("Haluaisin tehdä pöytävarauksen", "k3");
  for (const m of ["tiistaina klo 12", "=HYPERLINK(\"x\")", "kahvi@example.com", "kyllä"]) await chat(m, "k3");
  const items = (await call("GET", "/api/admin/inbox/kahvila-testi", undefined, T)).body;
  const req = items.find((x) => x.tyyppi === "ajanvarauspyyntö");
  assert.equal(req.palvelu, "Pöytävaraus");
  assert.equal(items.filter((x) => x.tyyppi === "vastaamaton").length, 1);
  const list = (await call("GET", "/api/admin/businesses", undefined, T)).body.find((b) => b.id === "kahvila-testi");
  assert.equal(list.uudet, 1);
  const patched = await call("PATCH", `/api/admin/inbox/kahvila-testi/${req.id}`, { tila: "hoidettu", muistiinpano: "Soitettu asiakkaalle" }, T);
  assert.equal(patched.body.tila, "hoidettu");
  assert.equal((await call("PATCH", `/api/admin/inbox/kahvila-testi/${req.id}`, { tila: "outo" }, T)).status, 422);
  assert.equal((await call("PATCH", `/api/admin/inbox/kahvila-testi/eiole`, { tila: "uusi" }, T)).status, 404);
  const csv = (await call("GET", "/api/admin/inbox/kahvila-testi/export.csv", undefined, T)).body;
  assert.match(csv, /Pöytävaraus/);
  assert.match(csv, /"'=HYPERLINK/); // CSV-kaavainjektio estetty
  assert.equal(store.list("esimerkki-hierontala", {}).some((x) => x.palvelu === "Pöytävaraus"), false);
});

test("HTTP: nopeusrajoitus", async () => {
  const app = createApp({ adminToken: "t", chatLimit: 3 }).listen(0);
  after(() => app.closeAllConnections?.() || app.close());
  const call = api(app);
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await call("POST", "/api/chat", { businessId: bid, sessionId: "r", message: "hei" })).status);
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
});

test("webhook-ilmoitus lähtee uudesta pyynnöstä, kun osoite on asetettu", async () => {
  const got = [];
  const srv = http.createServer((req, res) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => { got.push(JSON.parse(s)); res.end("ok"); }); }).listen(0);
  process.env.VASTIMO_WEBHOOK_URL = `http://127.0.0.1:${srv.address().port}/hook`;
  const b = bot();
  b.respond("w", "Haluan puhua ihmisen kanssa");
  await new Promise((r) => setTimeout(r, 300));
  delete process.env.VASTIMO_WEBHOOK_URL;
  srv.closeAllConnections?.(); srv.close();
  assert.equal(got.length, 1);
  assert.equal(got[0].yritys, bid);
  assert.equal(got[0].tyyppi, "yhteydenotto");
});
