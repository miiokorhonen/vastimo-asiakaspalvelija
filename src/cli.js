import { createInterface } from "node:readline/promises";
import { loadKnowledgeBase } from "./kb.js";
import { createAssistant } from "./assistant.js";

const id = process.argv[2] || "esimerkki-parturi";
const bot = createAssistant(() => loadKnowledgeBase(id));
const rl = createInterface({ input: process.stdin, output: process.stdout });
console.log(`Vastimo – ${loadKnowledgeBase(id).business.nimi}\nKirjoita viesti (tyhjä rivi lopettaa).\n`);
for (;;) {
  const q = (await rl.question("Sinä: ")).trim();
  if (!q) break;
  console.log("\nVastimo:", bot.respond("cli", q).reply, "\n");
}
rl.close();
