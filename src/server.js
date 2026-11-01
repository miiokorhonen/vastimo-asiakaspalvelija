import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync, cpSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";
import { randomBytes } from "node:crypto";
import { loadKnowledgeBase, saveKnowledgeBase, createBusiness, deleteBusinessData, listBusinesses, dataRoot, ID_RE, DEFAULT_RETENTION } from "./kb.js";
import { createAssistant } from "./assistant.js";
import { issueToken, verifyBusinessToken, removeToken, hasToken, safeEqual } from "./auth.js";
import * as store from "./store.js";

const PUB = join(import.meta.dirname, "..", "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".js": "text/javascript; charset=utf-8", ".css": "text/css" };
const PAGES = { "/": "index.html", "/admin": "admin.html", "/tietosuoja": "tietosuoja.html" };
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'";

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((ok, fail) => {
    let s = "";
    req.on("data", (c) => { s += c; if (s.length > 100_000) { fail(new Error("liian suuri")); req.destroy(); } });
    req.on("end", () => ok(s));
    req.on("error", fail);
  });
}
const parse = async (req) => { try { return JSON.parse((await readBody(req)) || "{}"); } catch { throw new SyntaxError("json"); } };

/** Ensikäynnistys: kopioi mukana tulevat demoyritykset pysyvälle levylle, jos tietohakemisto on tyhjä. */
export function seedIfEmpty() {
  const root = dataRoot(), seed = join(import.meta.dirname, "..", "data", "businesses");
  if (root === seed || !existsSync(seed)) return 0;
  mkdirSync(root, { recursive: true });
  if (readdirSync(root).length) return 0;
  cpSync(seed, root, { recursive: true });
  return readdirSync(root).length;
}

export function createApp({
  operatorToken = process.env.VASTIMO_OPERATOR_TOKEN || process.env.VASTIMO_ADMIN_TOKEN,
  adminToken, // vanha nimi, sama kuin operatorToken
  chatLimit = 40, failLimit = 10, now,
  trustProxyHops = Number(process.env.VASTIMO_TRUST_PROXY_HOPS || 0),
  production = process.env.NODE_ENV === "production",
  purgeIntervalMs = 6 * 3600_000,
} = {}) {
  const operator = adminToken || operatorToken || randomBytes(18).toString("hex");
  const kbs = new Map(), bots = new Map(), hits = new Map(), fails = new Map();
  const kbFor = (id) => { if (!kbs.has(id)) kbs.set(id, loadKnowledgeBase(id)); return kbs.get(id); };
  const botFor = (id) => { kbFor(id); if (!bots.has(id)) bots.set(id, createAssistant(() => kbFor(id), now ? { now } : {})); return bots.get(id); };
  const forget = (id) => { kbs.delete(id); bots.delete(id); };

  // Asiakkaan IP: proxyn (esim. Render) lisäämästä x-forwarded-for-ketjusta, oikealta luettuna; muuten suora yhteys.
  const clientIp = (req) => {
    const xff = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return (trustProxyHops > 0 && xff.length ? xff[Math.max(0, xff.length - trustProxyHops)] : req.socket.remoteAddress) || "?";
  };
  const hit = (map, ip, limit, windowMs = 60_000) => {
    const t = Date.now(), r = (map.get(ip) ?? []).filter((x) => t - x < windowMs);
    r.push(t); map.set(ip, r);
    if (map.size > 5000) map.clear();
    return r.length > limit;
  };
  const limited = (ip) => hit(hits, ip, chatLimit);

  /** Palauttaa { rooli: "operaattori" } | { rooli: "yritys", id } | null. */
  const who = (req) => {
    const t = String(req.headers["x-admin-token"] ?? (req.headers.authorization ?? "").replace(/^Bearer /i, ""));
    if (!t) return null;
    if (safeEqual(t, operator)) return { rooli: "operaattori" };
    const id = verifyBusinessToken(t);
    return id ? { rooli: "yritys", id } : null;
  };
  const publicInfo = (kb) => ({
    id: kb.business.id, nimi: kb.business.nimi, kuvaus: kb.business.kuvaus, palvelut: kb.business.palvelut,
    pikavalinnat: kb.entries.filter((e) => e.kysymys).slice(0, 4).map((e) => e.kysymys),
  });
  const retentionOf = (id) => { try { return kbFor(id).business.sailytysPaivat ?? DEFAULT_RETENTION; } catch { return DEFAULT_RETENTION; } };

  /** Poistaa yli säilytysajan vanhat kirjaukset kaikilta yrityksiltä. */
  function purgeAll() {
    let n = 0;
    for (const b of listBusinesses()) { try { n += store.purgeOlderThan(b.id, retentionOf(b.id), now ? now().getTime() : Date.now()); } catch { /* seuraava yritys */ } }
    return n;
  }

  function headers(extra = {}, admin = false) {
    return {
      "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
      "content-security-policy": `${CSP}; frame-ancestors ${admin ? "'none'" : "*"}; frame-src 'self'`,
      ...(admin ? { "x-frame-options": "DENY", "x-robots-tag": "noindex" } : {}),
      ...(production ? { "strict-transport-security": "max-age=31536000" } : {}),
      ...extra,
    };
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const path = url.pathname;
      const ip = clientIp(req);

      if (path === "/healthz") return json(res, 200, { ok: true });

      if (req.method === "POST" && path === "/api/chat") {
        if (limited(ip)) return json(res, 429, { virhe: "Liian monta viestiä. Odota hetki ja yritä uudelleen." });
        const b = await parse(req);
        if (typeof b.sessionId !== "string" || !b.sessionId || b.sessionId.length > 80) return json(res, 400, { virhe: "sessionId puuttuu" });
        let bot;
        try { bot = botFor(String(b.businessId)); } catch (e) { return json(res, 404, { virhe: e.message }); }
        const out = bot.respond(`${b.businessId}:${b.sessionId}`, b.message);
        return json(res, 200, { reply: out.reply, kind: out.kind });
      }
      if (req.method === "GET" && path === "/api/demo") return json(res, 200, listBusinesses().filter((x) => x.demo).map(({ id, nimi }) => ({ id, nimi })));
      if (req.method === "GET" && path.startsWith("/api/public/")) {
        try { return json(res, 200, publicInfo(kbFor(decodeURIComponent(path.slice(12))))); } catch (e) { return json(res, 404, { virhe: e.message }); }
      }

      if (path.startsWith("/api/admin/")) {
        const failCount = (fails.get(ip) ?? []).filter((x) => Date.now() - x < 60_000).length;
        if (failCount >= failLimit) return json(res, 429, { virhe: "Liian monta virheellistä kirjautumisyritystä. Odota minuutti." });
        const me = who(req);
        if (!me) { fails.set(ip, [...(fails.get(ip) ?? []), Date.now()].slice(-50)); return json(res, 401, { virhe: "Ylläpitotunnus puuttuu tai on väärä" }); }
        const isOp = me.rooli === "operaattori";
        const parts = path.slice(11).split("/").map(decodeURIComponent);
        const [what, id, sub, itemId] = parts;

        if (what === "me") return json(res, 200, { rooli: me.rooli, yritys: me.id ?? null });
        if (what === "businesses" && !id) {
          if (req.method === "GET") {
            const all = listBusinesses().filter((x) => isOp || x.id === me.id);
            return json(res, 200, all.map((x) => ({ ...x, uudet: store.list(x.id, { tila: "uusi" }).filter((r) => r.tyyppi !== "vastaamaton").length })));
          }
          if (req.method === "POST") {
            if (!isOp) return json(res, 403, { virhe: "Vain Vastimon ylläpitäjä voi luoda yrityksiä" });
            const b = await parse(req);
            try { createBusiness(String(b.id), String(b.nimi ?? "").trim() || String(b.id)); } catch (e) { return json(res, 400, { virhe: e.message }); }
            return json(res, 201, { id: b.id, tunnus: issueToken(b.id) }); // tunnus näytetään vain kerran
          }
        }
        if (!ID_RE.test(String(id ?? ""))) return json(res, 404, { virhe: "Tuntematon yritys" });
        if (!isOp && me.id !== id) return json(res, 403, { virhe: "Ei oikeutta tähän yritykseen" });
        let kb;
        try { kb = loadKnowledgeBase(id); } catch (e) { return json(res, 404, { virhe: e.message }); }

        if (what === "businesses") {
          if (!isOp) return json(res, 403, { virhe: "Vain Vastimon ylläpitäjä voi hallita tunnuksia ja poistaa yrityksiä" });
          if (req.method === "POST" && sub === "token") return json(res, 200, { id, tunnus: issueToken(id) }); // vanha tunnus lakkaa heti
          if (req.method === "DELETE" && !sub) {
            deleteBusinessData(id); store.wipe(id); removeToken(id); forget(id);
            return json(res, 200, { ok: true, poistettu: id });
          }
        }
        if (what === "kb") {
          if (req.method === "GET") { const { index, ...clean } = kb; return json(res, 200, { ...clean, tunnusKaytossa: hasToken(id) }); }
          if (req.method === "PUT") {
            try {
              const body = await parse(req);
              if (!isOp && body?.business) body.business.demo = kb.business.demo === true; // vain operaattori päättää julkisesta demosta
              saveKnowledgeBase(id, body);
            } catch (e) { return json(res, e instanceof SyntaxError ? 400 : 422, { virhe: e.message }); }
            forget(id);
            return json(res, 200, { ok: true });
          }
        }
        if (what === "inbox") {
          if (req.method === "GET" && sub === "export.csv") {
            res.writeHead(200, headers({ "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${id}-saapuneet.csv"`, "cache-control": "no-store" }, true));
            return res.end(store.csv(id));
          }
          if (req.method === "GET" && !sub) return json(res, 200, store.list(id, { tila: url.searchParams.get("tila") || undefined, tyyppi: url.searchParams.get("tyyppi") || undefined, haku: url.searchParams.get("haku") || undefined }));
          if (req.method === "POST" && sub === "erase") { // poistopyyntö: poistaa kaikki kirjaukset, joissa hakusana esiintyy
            const b = await parse(req);
            try { return json(res, 200, { poistettu: store.erase(id, b.haku) }); } catch (e) { return json(res, 422, { virhe: e.message }); }
          }
          if (req.method === "POST" && sub === "purge") return json(res, 200, { poistettu: store.purgeOlderThan(id, retentionOf(id), now ? now().getTime() : Date.now()) });
          if (req.method === "DELETE" && sub) return store.remove(id, sub) ? json(res, 200, { ok: true }) : json(res, 404, { virhe: "Ei löytynyt" });
          if (req.method === "PATCH" && sub) {
            let it;
            try { it = store.update(id, sub, await parse(req)); } catch (e) { return json(res, e instanceof SyntaxError ? 400 : 422, { virhe: e.message }); }
            return it ? json(res, 200, it) : json(res, 404, { virhe: "Ei löytynyt" });
          }
        }
        return json(res, 404, { virhe: "Ei löytynyt" });
      }

      if (req.method === "GET") {
        const f = PAGES[path] ?? path.slice(1);
        if (!/^[a-z0-9.-]+$/i.test(f) || !existsSync(join(PUB, f))) return json(res, 404, { virhe: "Ei löytynyt" });
        res.writeHead(200, headers({ "content-type": TYPES[extname(f)] || "application/octet-stream", ...(extname(f) === ".html" ? { "cache-control": "no-cache" } : {}) }, path === "/admin"));
        return res.end(readFileSync(join(PUB, f)));
      }
      json(res, 405, { virhe: "Ei sallittu" });
    } catch (e) {
      json(res, e instanceof SyntaxError ? 400 : 500, { virhe: "Pyyntöä ei voitu käsitellä" });
    }
  });
  server.adminToken = operator;
  server.purgeAll = purgeAll;
  const timer = setInterval(purgeAll, purgeIntervalMs);
  timer.unref();
  server.on("close", () => clearInterval(timer));
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const production = process.env.NODE_ENV === "production";
  const op = process.env.VASTIMO_OPERATOR_TOKEN || process.env.VASTIMO_ADMIN_TOKEN;
  if (production && (!op || op.length < 24)) { console.error("VASTIMO_OPERATOR_TOKEN puuttuu tai on liian lyhyt (väh. 24 merkkiä). Tuotanto ei käynnisty ilman sitä."); process.exit(1); }
  const port = Number(process.env.PORT || 3000), host = process.env.HOST || (production ? "0.0.0.0" : "127.0.0.1");
  const seeded = seedIfEmpty();
  const app = createApp();
  const purged = app.purgeAll();
  app.listen(port, host, () => {
    console.log(`Vastimo-asiakaspalvelija kuuntelee ${host}:${port}${seeded ? ` (demoyritykset kopioitu: ${seeded})` : ""}; säilytysajan yli menneitä kirjauksia poistettu: ${purged}`);
    if (!production) {
      console.log(`Demo:    http://${host}:${port}/?b=esimerkki-parturi`);
      console.log(`Ylläpito: http://${host}:${port}/admin`);
      console.log(`Operaattoritunnus: ${app.adminToken}${op ? " (ympäristömuuttujasta)" : " (satunnainen, vaihtuu käynnistyksessä)"}`);
    }
  });
}
