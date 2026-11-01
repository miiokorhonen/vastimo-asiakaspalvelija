// Yrityskohtainen ylläpitopääsy. Yrityksen tunnus on muotoa "<yritys-id>.<salaisuus>".
// Palvelimelle tallennetaan vain tiivisteet (sha256; salaisuus on 256 bittiä satunnaista, joten suolaa ei tarvita).
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const ID_RE = /^[a-z0-9-]{1,60}$/;
export const authDir = () => process.env.VASTIMO_AUTH_DIR || join(import.meta.dirname, "..", "data", "auth");
const sha = (s) => createHash("sha256").update(s).digest();
const file = (id) => { if (!ID_RE.test(String(id))) throw new Error("Virheellinen yritystunniste"); return join(authDir(), `${id}.json`); };

export function safeEqual(a, b) {
  const x = sha(String(a)), y = sha(String(b)); // vakiopituus, vakioaikavertailu
  return timingSafeEqual(x, y);
}

/** Luo (tai kierrättää) yrityksen tunnuksen. Selväkielinen tunnus palautetaan vain tässä kutsussa. */
export function issueToken(id) {
  const token = `${id}.${randomBytes(32).toString("base64url")}`;
  const f = file(id);
  mkdirSync(authDir(), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ hash: sha(token).toString("hex"), luotu: new Date().toISOString() }), { mode: 0o600 });
  renameSync(tmp, f);
  return token;
}

/** Palauttaa yrityksen tunnuksen, jos annettu tunnus on kyseisen yrityksen voimassa oleva tunnus. */
export function verifyBusinessToken(token) {
  const t = String(token ?? "");
  const i = t.indexOf(".");
  if (i < 1 || t.length > 200) return null;
  const id = t.slice(0, i);
  if (!ID_RE.test(id)) return null;
  const f = file(id);
  if (!existsSync(f)) return null;
  try {
    const { hash } = JSON.parse(readFileSync(f, "utf8"));
    return timingSafeEqual(Buffer.from(hash, "hex"), sha(t)) ? id : null;
  } catch { return null; }
}

export const hasToken = (id) => existsSync(file(id));
export function removeToken(id) { rmSync(file(id), { force: true }); }
