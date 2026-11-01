import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "vastimo-sec-"));
process.env.VASTIMO_OUT_DIR = join(tmp, "out");
process.env.VASTIMO_DATA_DIR = join(tmp, "businesses");
process.env.VASTIMO_AUTH_DIR = join(tmp, "auth");
cpSync(join(import.meta.dirname, "..", "data", "businesses"), process.env.VASTIMO_DATA_DIR, { recursive: true });

const { createApp } = await import("../src/server.js");
const store = await import("../src/store.js");
const auth = await import("../src/auth.js");

const OP = "operaattori-tunnus-0123456789";
function client(app) {
  const port = app.address().port;
  return async (method, path, body, token, extra = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "x-admin-token": token ?? "", connection: "close", ...extra } });
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch { j = t; }
    return { status: r.status, body: j, headers: r.headers };
  };
}
const boot = (opts = {}) => { const a = createApp({ operatorToken: OP, ...opts }).listen(0); after(() => a.closeAllConnections?.() || a.close()); return client(a); };

test("yrityskohtainen tunnus: näkee vain oman yrityksensä, operaattori kaiken", async () => {
  const call = boot();
  const a = await call("POST", "/api/admin/businesses", { id: "kahvila-a", nimi: "Kahvila A" }, OP);
  const b = await call("POST", "/api/admin/businesses", { id: "kahvila-b", nimi: "Kahvila B" }, OP);
  assert.equal(a.status, 201); assert.match(a.body.tunnus, /^kahvila-a\./);
  const TA = a.body.tunnus, TB = b.body.tunnus;

  assert.equal((await call("GET", "/api/admin/kb/kahvila-a", undefined, TA)).status, 200);
  for (const p of ["/api/admin/kb/kahvila-b", "/api/admin/inbox/kahvila-b", "/api/admin/inbox/kahvila-b/export.csv", "/api/admin/kb/esimerkki-parturi"]) assert.equal((await call("GET", p, undefined, TA)).status, 403, p);
  assert.equal((await call("PUT", "/api/admin/kb/kahvila-b", { business: { nimi: "Haltuunotto" } }, TA)).status, 403);
  assert.equal((await call("DELETE", "/api/admin/inbox/kahvila-b/x", undefined, TA)).status, 403);
  const list = (await call("GET", "/api/admin/businesses", undefined, TA)).body;
  assert.deepEqual(list.map((x) => x.id), ["kahvila-a"]);
  assert.equal((await call("GET", "/api/admin/me", undefined, TA)).body.rooli, "yritys");
  assert.equal((await call("GET", "/api/admin/businesses", undefined, OP)).body.length >= 4, true);
  assert.equal((await call("GET", "/api/admin/me", undefined, OP)).body.rooli, "operaattori");

  // yritys ei voi luoda yrityksiä, kierrättää tunnuksia, poistaa yritystä eikä julkaista itseään demona
  assert.equal((await call("POST", "/api/admin/businesses", { id: "x", nimi: "x" }, TA)).status, 403);
  assert.equal((await call("POST", "/api/admin/businesses/kahvila-a/token", {}, TA)).status, 403);
  assert.equal((await call("DELETE", "/api/admin/businesses/kahvila-a", undefined, TA)).status, 403);
  const kb = (await call("GET", "/api/admin/kb/kahvila-a", undefined, TA)).body;
  kb.business.demo = true;
  assert.equal((await call("PUT", "/api/admin/kb/kahvila-a", kb, TA)).status, 200);
  assert.equal((await call("GET", "/api/demo")).body.some((x) => x.id === "kahvila-a"), false);

  // vaihtamalla id:n toisen yrityksen tunnukseen ei pääse sisään; väärä salaisuus ei kelpaa
  assert.equal((await call("GET", "/api/admin/kb/kahvila-a", undefined, TB)).status, 403);
  assert.equal((await call("GET", "/api/admin/kb/kahvila-a", undefined, "kahvila-a.arvattu")).status, 401);
  assert.equal((await call("GET", "/api/admin/kb/kahvila-a", undefined, TA + "x")).status, 401);
  assert.equal((await call("GET", "/api/admin/kb/kahvila-a", undefined, "")).status, 401);
});

test("tunnus tallennetaan vain tiivisteenä ja kierrätys mitätöi vanhan", async () => {
  const call = boot();
  const t1 = (await call("POST", "/api/admin/businesses", { id: "kampaamo-x", nimi: "Kampaamo X" }, OP)).body.tunnus;
  const raw = readFileSync(join(process.env.VASTIMO_AUTH_DIR, "kampaamo-x.json"), "utf8");
  assert.equal(raw.includes(t1.split(".")[1]), false);
  const t2 = (await call("POST", "/api/admin/businesses/kampaamo-x/token", {}, OP)).body.tunnus;
  assert.notEqual(t1, t2);
  assert.equal((await call("GET", "/api/admin/kb/kampaamo-x", undefined, t1)).status, 401);
  assert.equal((await call("GET", "/api/admin/kb/kampaamo-x", undefined, t2)).status, 200);
  assert.equal(auth.verifyBusinessToken(t2), "kampaamo-x");
  assert.equal(auth.verifyBusinessToken("../x." + "a".repeat(40)), null);
});

test("virheellisten kirjautumisten rajoitus", async () => {
  const call = boot({ failLimit: 3 });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await call("GET", "/api/admin/businesses", undefined, "väärä")).status);
  assert.deepEqual(codes, [401, 401, 401, 429, 429]);
  assert.equal((await call("GET", "/api/admin/businesses", undefined, OP)).status, 429); // myös oikea tunnus odottaa minuutin
});

test("säilytysaika: vanhentuneet poistuvat, tuoreet jäävät; yrityskohtainen aika", async () => {
  const day = 86_400_000, t0 = Date.parse("2026-11-01T12:00:00Z");
  store.add("esimerkki-hierontala", "yhteydenotto", { syy: "x", yhteystieto: "vanha@example.com" });
  const rows = JSON.parse(readFileSync(join(process.env.VASTIMO_OUT_DIR, "esimerkki-hierontala", "inbox.json"), "utf8"));
  assert.equal(rows.length, 1);
  // aika siirretään eteenpäin: 89 pv -> jää, 91 pv -> poistuu
  assert.equal(store.purgeOlderThan("esimerkki-hierontala", 90, Date.parse(rows[0].luotu) + 89 * day), 0);
  assert.equal(store.purgeOlderThan("esimerkki-hierontala", 90, Date.parse(rows[0].luotu) + 91 * day), 1);
  assert.equal(store.list("esimerkki-hierontala").length, 0);

  const call = boot({ now: () => new Date(t0 + 40 * day) });
  const T = (await call("POST", "/api/admin/businesses", { id: "sailytys-testi", nimi: "Säilytys" }, OP)).body.tunnus;
  store.add("sailytys-testi", "yhteydenotto", { syy: "x", yhteystieto: "a@example.com" });
  const kb = (await call("GET", "/api/admin/kb/sailytys-testi", undefined, T)).body;
  assert.equal(kb.business.sailytysPaivat, 90);
  kb.business.sailytysPaivat = 7;
  assert.equal((await call("PUT", "/api/admin/kb/sailytys-testi", kb, T)).status, 200);
  kb.business.sailytysPaivat = 3;
  assert.equal((await call("PUT", "/api/admin/kb/sailytys-testi", kb, T)).status, 422);
  kb.business.sailytysPaivat = 400;
  assert.equal((await call("PUT", "/api/admin/kb/sailytys-testi", kb, T)).status, 422);
  // kello on 40 pv jäljessä todellisuudesta (luotu "nyt"), joten kirjaus on tulevaisuudessa eikä vanhene; siirrä kello eteenpäin
  const later = boot({ now: () => new Date(Date.now() + 8 * day) });
  const OPlater = OP;
  assert.equal((await later("POST", "/api/admin/inbox/sailytys-testi/purge", {}, OPlater)).body.poistettu, 1);
});

test("poistopyyntö: haku, poisto hakusanalla ja yksittäin; vain oman yrityksen tiedot", async () => {
  const call = boot();
  const T = (await call("POST", "/api/admin/businesses", { id: "poisto-testi", nimi: "Poisto" }, OP)).body.tunnus;
  const mine = store.add("poisto-testi", "yhteydenotto", { syy: "a", yhteystieto: "Asiakas@Example.com", keskustelu: [{ rooli: "asiakas", teksti: "hei" }] });
  store.add("poisto-testi", "ajanvarauspyyntö", { palvelu: "x", nimi: "Matti", yhteystieto: "matti@example.com", aikatoive: "ma" });
  store.add("esimerkki-parturi", "yhteydenotto", { syy: "b", yhteystieto: "asiakas@example.com" });

  assert.equal((await call("GET", "/api/admin/inbox/poisto-testi?haku=asiakas@example.com", undefined, T)).body.length, 1);
  assert.equal((await call("POST", "/api/admin/inbox/poisto-testi/erase", { haku: "ab" }, T)).status, 422);
  assert.equal((await call("POST", "/api/admin/inbox/poisto-testi/erase", { haku: "asiakas@example.com" }, T)).body.poistettu, 1);
  assert.equal(store.list("poisto-testi").length, 1);
  assert.equal(store.list("esimerkki-parturi").some((r) => r.yhteystieto === "asiakas@example.com"), true); // toinen yritys koskematon
  const left = store.list("poisto-testi")[0];
  assert.equal((await call("DELETE", `/api/admin/inbox/poisto-testi/${left.id}`, undefined, T)).status, 200);
  assert.equal((await call("DELETE", `/api/admin/inbox/poisto-testi/${left.id}`, undefined, T)).status, 404);
  assert.equal(mine.id.length > 0, true);
});

test("yrityksen poisto operaattorilta poistaa tiedot, saapuneet ja tunnuksen", async () => {
  const call = boot();
  const T = (await call("POST", "/api/admin/businesses", { id: "poistettava", nimi: "P" }, OP)).body.tunnus;
  store.add("poistettava", "yhteydenotto", { syy: "x", yhteystieto: "z@example.com" });
  assert.equal((await call("DELETE", "/api/admin/businesses/poistettava", undefined, OP)).status, 200);
  assert.equal(existsSync(join(process.env.VASTIMO_DATA_DIR, "poistettava")), false);
  assert.equal(existsSync(join(process.env.VASTIMO_OUT_DIR, "poistettava")), false);
  assert.equal(existsSync(join(process.env.VASTIMO_AUTH_DIR, "poistettava.json")), false);
  assert.equal((await call("GET", "/api/admin/kb/poistettava", undefined, T)).status, 401);
  assert.equal((await call("POST", "/api/chat", { businessId: "poistettava", sessionId: "s", message: "hei" })).status, 404);
});

test("tuotantotila: otsakkeet, terveystarkistus, tietosuojasivu, ei vuotoja", async () => {
  const call = boot({ production: true });
  assert.equal((await call("GET", "/healthz")).body.ok, true);
  const admin = await call("GET", "/admin");
  assert.match(admin.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(admin.headers.get("x-frame-options"), "DENY");
  assert.match(admin.headers.get("strict-transport-security"), /max-age/);
  assert.match((await call("GET", "/")).headers.get("content-security-policy"), /frame-ancestors \*/);
  const p = await call("GET", "/tietosuoja");
  assert.equal(p.status, 200);
  assert.match(p.body, /Rekisterinpitäjä/);
  assert.match(p.body, /eikä käytä tekoälykielimallia/);
  for (const bad of ["/auth/x.json", "/data/auth/x.json", "/package.json", "/src/server.js"]) assert.equal((await call("GET", bad)).status, 404, bad);
});

test("IP luetaan proxyn ketjusta vain, kun luotettuja hyppyjä on määritetty", async () => {
  const strict = boot({ chatLimit: 2, trustProxyHops: 1 });
  const chat = (xff) => strict("POST", "/api/chat", { businessId: "esimerkki-parturi", sessionId: "s", message: "hei" }, "", { "x-forwarded-for": xff });
  const codes = [];
  // asiakas väärentää ketjun alkua, mutta oikeanpuoleisin (proxyn lisäämä) arvo on sama -> sama laskuri
  for (const x of ["1.1.1.1, 9.9.9.9", "2.2.2.2, 9.9.9.9", "3.3.3.3, 9.9.9.9"]) codes.push((await chat(x)).status);
  assert.deepEqual(codes, [200, 200, 429]);
});

test("ensikäynnistys kopioi demoyritykset tyhjälle levylle vain kerran", async () => {
  const { seedIfEmpty } = await import("../src/server.js");
  const saved = process.env.VASTIMO_DATA_DIR, d = mkdtempSync(join(tmpdir(), "vastimo-seed-"));
  process.env.VASTIMO_DATA_DIR = d;
  try {
    assert.equal(seedIfEmpty(), 2);
    assert.equal(seedIfEmpty(), 0);
    assert.deepEqual(readdirSync(d).sort(), ["esimerkki-hierontala", "esimerkki-parturi"]);
  } finally { process.env.VASTIMO_DATA_DIR = saved; }
});
