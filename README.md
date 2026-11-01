# Vastimo – asiakaspalveluavustaja (versio 0.3, julkaisuvalmis)

Suomenkielinen asiakaspalveluavustaja pienyrityksille. Sääntöpohjainen ensimmäinen versio (ei tekoälykielimallia): asiakkaan chat, yrityskohtainen tietopohja, ylläpitonäkymä, ihmiselle siirto ja ajanvarauspyyntöjen käsittely. **Ei riippuvuuksia, Node.js 20+.**

## Käynnistys
```bash
npm test                              # 25 automaattitestiä
VASTIMO_OPERATOR_TOKEN=oma-tunnus npm start
```
- Asiakasnäkymä: http://127.0.0.1:3000/?b=esimerkki-parturi (toinen demo: `esimerkki-hierontala`)
- Ylläpito: http://127.0.0.1:3000/admin (operaattoritunnus = `VASTIMO_OPERATOR_TOKEN` (vanha `VASTIMO_ADMIN_TOKEN` toimii aliaksena); ellei asetettu, satunnainen tunnus tulostuu käynnistyksessä. Yrityksen oma tunnus luodaan operaattorin Luo yritys -toiminnolla)
- Komentorivi: `npm run cli -- esimerkki-parturi`

## Mitä toimii
| Ominaisuus | Miten |
| --- | --- |
| **Yrityskohtaiset vastaukset** | Jokaisella yrityksellä oma `data/businesses/<tunnus>/kb.json`. Haku ei ylitä yritysrajoja. Vastaus näyttää lähteen. Suomen taivutus käsitellään sanavartaloilla. |
| **Rehellisyys** | Ei tietoa → "en halua arvailla" (ei keksittyjä hintoja tms.). Kysymys kirjautuu ylläpitoon "vastaamattomana". Kaksi epäonnistumista peräkkäin → siirto ihmiselle. |
| **Aukioloajat** | Rakenteisista aukioloajoista: "auki nyt?", "huomenna?", "lauantaina?", viikkolista (Suomen aika). Rakenteiset ajat ohittavat tietopohjan vapaatekstin aukiolotiedon. |
| **Ihmiselle siirto** | Asiakkaan pyynnöstä tai reklamaatiosta (myös kesken ajanvarauksen). Kirjaa keskustelun, kysyy yhteystiedon ja liittää sen samaan pyyntöön. Kertoo, jos yritys on suljettu, eikä väitä ihmisen vastaavan heti. Näyttää yrityksen oman puhelimen/sähköpostin, jos ne on asetettu. |
| **Ajanvarauspyyntö** | Poimii palvelun avausviestistä, tarkentaa epäselvän palvelun, tarkistaa toiveen aukioloaikoja vasten (suljettu päivä, aukioloajan ulkopuolinen kellonaika), kysyy nimen ja yhteystiedon, näyttää yhteenvedon ja kirjaa vasta vahvistuksella. Korjaus, peruutus ja kysymykset kesken pyynnön toimivat. **Aikaa ei varata** eikä sitä väitetä varatuksi. |
| **Ylläpito (`/admin`)** | Luo yrityksiä; muokkaa nimeä, kuvausta, palveluita, aukioloaikoja, yhteystietoja ja tietopohjaa (muutos heti käyttöön ilman uudelleenkäynnistystä); Saapuneet-lista (ajanvarauspyynnöt, siirrot, vastaamattomat) tiloilla uusi / hoidossa / hoidettu / hylätty, muistiinpanot, CSV-vienti; vastaamattoman kysymyksen voi muuttaa tietopohjan tiedoksi yhdellä napilla; testichat ja upotuskoodi. |
| **Upotus** | `<script src="https://PALVELIN/widget.js" data-business="tunnus" defer></script>` lisää kelluvan chat-painikkeen. |
| **Ilmoitus** | Valinnainen: `VASTIMO_WEBHOOK_URL` saa POST-ilmoituksen jokaisesta uudesta ajanvarauspyynnöstä ja siirrosta (esim. automaatiopalveluun). Ei sidottu mihinkään palveluun. |
| **Suojaukset** | Yrityskohtaiset ylläpitotunnukset (ks. alla), chat-nopeusrajoitus (40/min/IP), virheellisten kirjautumisten rajoitus (10/min/IP), CSP- ja kehystyssuojat, HSTS tuotannossa, CSV-kaavainjektion esto; ylläpitonäkymä ei suorita asiakkaan kirjoittamaa HTML:ää. |

## Yrityksen tietojen asetus
Ylläpidossa: **Yrityksen tiedot** (palvelut, aukioloajat muodossa 9-17, yhteystiedot) ja **Tietopohja** (otsikko, vastausteksti, avainsanat, esimerkkikysymys pikavalintana). Kirjoita vain vahvistettuja faktoja; avustaja ei tiedä mitään sen ulkopuolelta. Tiedot tallentuvat tiedostoon `kb.json`.

## Ylläpitopääsy (v0.3)
- **Operaattori** (Vastimo): `VASTIMO_OPERATOR_TOKEN`, väh. 24 merkkiä; tuotanto ei käynnisty ilman sitä. Näkee kaikki yritykset, luo ja poistaa yrityksiä, kierrättää tunnuksia.
- **Yritys**: oma tunnus `<yritys-id>.<salaisuus>`. Näkee ja muokkaa vain omaa tietopohjaansa ja saapuneitaan (muihin 403). Tunnus näytetään vain luotaessa; levylle tallennetaan vain sha256-tiiviste (`VASTIMO_AUTH_DIR`). Kierrätys mitätöi vanhan heti. Yritys ei voi muuttaa julkista demo-lippua.

## Tallennus ja tietosuoja
- Pysyvä levy: kolme hakemistoa (`VASTIMO_DATA_DIR` tietopohjat, `VASTIMO_OUT_DIR` saapuneet, `VASTIMO_AUTH_DIR` tunnusten tiivisteet), kirjoitus atomisesti (tmp + rename). Ensikäynnistyksellä demoyritykset kopioidaan tyhjälle tietohakemistolle. Yksi instanssi; useampi vaatii tietokannan.
- **Säilytys**: yrityksen asetus `sailytysPaivat` (7–365, oletus 90). Kirjaus poistetaan, kun sitä ei ole päivitetty ajassa; ajo käynnistyksessä ja 6 tunnin välein, sekä käsin ylläpidossa.
- **Poisto**: yksittäinen kirjaus, poisto hakusanalla (esim. asiakkaan sähköposti, haku näyttää osumat ensin), operaattorin yrityksen täysi poisto (tietopohja, saapuneet, tunnus).
- **Tietosuojaseloste**: `/tietosuoja` (yritys rekisterinpitäjä, Vastimo käsittelijä; yritys täydentää omat yhteystietonsa). Chat kertoo olevansa automaattinen avustaja, ei ihminen.
- Webhook (`VASTIMO_WEBHOOK_URL`) lähettää henkilötietoja ulos: älä käytä ilman yrityksen kanssa sovittua käsittelysopimusta.

## Julkaisu (Render)
`render.yaml`: Node-palvelu (Frankfurt), 1 Gt levy `/var/data`, terveystarkistus `/healthz`, `NODE_ENV=production`. Levy vaatii maksullisen tason. `VASTIMO_TRUST_PROXY_HOPS` määrittää asiakkaan IP:n luvun `x-forwarded-for`-ketjusta; tarkista julkaisun jälkeen.

## Mikä ei ole mukana (tarvitsee palvelun tai päätöksen)
- **Todellinen ajanvaraus:** ei varausjärjestelmää valittu eikä integraatiota. Yritys vahvistaa ajan itse. Kytkentä vaatii valitun palvelun ja pääsyn siihen.
- **Sähköposti-/tekstari-ilmoitukset yritykselle:** vain webhook; sähköposti vaatii päätöksen palvelusta.
- **Oma verkkotunnus:** palvelu toimii palveluntarjoajan osoitteessa; oma alidomain on erillinen päätös.
- **Varmuuskopiot:** levy on pysyvä mutta ei varmuuskopioitu; tee tarvittaessa levykuvat Renderissä tai siirry tietokantaan.
- **Tekoälymalli:** vastaukset ovat sääntöpohjaisia lainauksia tietopohjasta: luotettavia mutta jäykkiä. Luonnollisempi muotoilu vaatii mallitarjoajan valinnan.
- **Tietosuoja:** seloste on pohja, jonka rekisterinpitäjä (yritys) tarkistaa ja täydentää omilla tiedoillaan ennen oikeita asiakkaita; juridista arviota ei ole tehty.
- **Tunnetut rajat:** suomen taivutus perustuu vartaloihin (esim. "pöydän" ei vastaa sanaa "pöytä"; lisää taivutusmuotoja avainsanoiksi); aikatoiveesta tarkistetaan vain päivä ja kellonaika, ei kalenteria; hinnat vain jos ne kirjoitetaan tietopohjaan.

## Rakenne
`src/assistant.js` päätöslogiikka · `src/booking.js` ajanvarauspyyntö · `src/hours.js` aukioloajat · `src/kb.js` tietopohja ja validointi · `src/store.js` saapuneet, CSV, säilytys ja poisto · `src/auth.js` yrityskohtaiset tunnukset · `src/server.js` HTTP ja ylläpito-API · `public/` chat, ylläpito, upotus · `test/` testit.
