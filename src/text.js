// Suomen kielen kevyt normalisointi. Taivutus hoidetaan typistämällä sanat
// vartaloiksi (ensimmäiset 5 merkkiä), mikä riittää pienen tietopohjan hakuun.
const STOP = new Set(["ja","tai","on","ei","se","ne","että","mikä","mitä","miten","kuinka","voi","voiko","voinko","onko","olla","minä","mä","te","me","oma","vai","kun","jos","niin","myös","vain","tämä","tuo","sitä","siitä","kanssa","teillä","teidän","haluan","haluaisin","kertoa","kertoisitko","tietää","kysyä","hei","moi","terve","kiitos","ole","hyvä"]);

export function normalize(s) {
  return String(s ?? "").toLowerCase().normalize("NFC").replace(/[^a-zäöå0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
export function stem(w) { return w.length > 5 ? w.slice(0, 5) : w; }
export function tokens(s) {
  return normalize(s).split(" ").filter((w) => w.length > 2 && !STOP.has(w)).map(stem);
}
