# Tracciabilità reparto – prototipo

Web app da telefono per la tracciabilità in **macelleria e gastronomia**: dallo scarico del camion fino al prodotto finito (es. lasagne), con lettura dei codici a barre tramite **fotocamera**.

```
📦 Ricevi  →  🧊 Lotti (FEFO)  →  🍳 Produci  →  🏷️ Etichetta  →  🔎 Richiamo
   scan GS1-128   scadenze, scarti    ricetta + lotti   ingredienti,      lotto fornitore →
   lotto/scad/    stato               (scan o FEFO)     allergeni,        tutte le preparazioni
   peso/origine                                         origine, barcode  che lo contengono
```

## Cosa fa

| Schermata | Funzione |
|---|---|
| **Ricevi** | Scansiona il GS1-128 del collo: compila da sola lotto (10), scadenza (17/15), peso (310x), GTIN (01) e, per la carne, origine (251, 422–426, 7030/7031). Controlla la temperatura rispetto al limite della categoria. "Salva e scansiona il prossimo" mantiene il DDT dello stesso camion. |
| **Lotti** | Magazzino in ordine **FEFO** (scade prima → in cima), badge "scade oggi/scaduto", esaurito/scartato. |
| **Produci** | Scegli la ricetta; per ogni ingrediente propone il lotto aperto che scade prima, oppure scansioni il collo che stai usando. **Blocca i lotti scaduti**. Genera il lotto `LAS-AAMMGG-NN`. |
| **Etichetta** | 62 mm (stampante per etichette) con ingredienti, **allergeni in MAIUSCOLO grassetto**, semilavorati espansi tra parentesi (es. "Ragù (macinato di bovino (carne bovina), passata, **SEDANO**…)"), origine carne ereditata, scadenza e barcode CODE128 del lotto. |
| **Richiamo** | Cerchi/scansioni il lotto del fornitore e vedi l'albero di tutte le preparazioni che lo contengono (anche indirettamente: carne → macinato → ragù → lasagne). Pulsante "Blocca tutto", report CSV, testo da incollare in WhatsApp/email. |
| **Ricette** | Ricette con ingredienti, allergeni, durata, conservazione. I semilavorati (ragù, besciamella) sono ricette come le altre. |
| **Impostazioni** | Negozio, operatore, webhook n8n, backup JSON, dati di esempio, **codici di prova**. |

## Provarlo subito

1. Pubblicalo su GitHub Pages (vedi sotto). La fotocamera del telefono funziona **solo in HTTPS** (o su `localhost`).
2. Dal telefono: ⚙️ → **Crea giornata di esempio** → tab **Richiamo** → cerca `BOV-A123`.
3. Per provare la scansione: apri `…/#codici-prova` sul PC e inquadra i codici col telefono da **Ricevi** (prima premi "Carica catalogo prodotti di prova" così riconosce i nomi).

Per provarlo in locale sul PC:

```bash
python3 -m http.server 8080
```

Poi apri http://localhost:8080 (sul PC la fotocamera è la webcam).

## Pubblicazione su GitHub Pages

```bash
git init && git add . && git commit -m "Prototipo tracciabilità"
```

```bash
gh repo create tracciabilita-reparto --public --source=. --push
```

```bash
gh api -X POST repos/{owner}/tracciabilita-reparto/pages -f "source[branch]=main" -f "source[path]=/"
```

L'app sarà su `https://<utente>.github.io/tracciabilita-reparto/`. Sul telefono: menu del browser → **Aggiungi a schermata Home**: si apre a schermo intero come un'app.

> Il repo pubblico contiene solo il codice: **i dati restano sul telefono** (e su n8n se lo attivi). Pages su repo privato richiede un piano GitHub a pagamento.

## Collegamento a n8n → Google Sheets

1. Crea un Google Sheet con 5 fogli (tab): `Ricevimenti`, `Produzioni`, `Componenti`, `Movimenti`, `Eventi`. Basta lasciarli vuoti; se n8n non crea da solo le intestazioni, metti in riga 1 i nomi dei campi (`evento_id`, `tipo`, `ts`, `negozio`, `operatore`, `lotto_id`, `prodotto`…).
2. In n8n: **Import from file** → `n8n/workflow-tracciabilita.json`.
3. Nel nodo **Google Sheets**: scegli la credenziale Google e incolla l'URL del foglio al posto di `INCOLLA_QUI_URL_DEL_GOOGLE_SHEET`.
4. (Facoltativo) Nel nodo **Prepara righe** imposta `TOKEN = '...'` e lo stesso valore nell'app (⚙️ → Token).
5. **Attiva** il workflow e copia la **Production URL** del webhook (`…/webhook/tracciabilita`) in ⚙️ → URL webhook n8n → **Prova webhook**.

Come funziona l'invio:
- l'app manda gli eventi `{ sorgente, eventi: [...] }` in blocchi da 20;
- il webhook risponde solo dopo la scrittura sul foglio (`responseMode: lastNode`), quindi se Sheets fallisce l'evento **resta in coda** e viene ritentato (ogni 30 s e quando torna la rete);
- il webhook ha `allowedOrigins: *` per il CORS; se usi un reverse proxy, deve lasciar passare le richieste `OPTIONS`.

Il foglio **Componenti** ha una riga per ogni "lotto X usato in produzione Y": con un filtro su `lotto_ingrediente` fai il richiamo anche da Google Sheets.

Da qui puoi estendere il workflow: avviso Telegram se una temperatura è fuori limite, report settimanale per l'HACCP, salvataggio su Postgres.

## Scanner Bluetooth (opzionale)

Qualsiasi scanner in modalità **HID/tastiera** con suffisso **Invio** funziona già: fuori dai campi di testo l'app intercetta il "bip" e:
- in Ricevi apre il nuovo arrivo;
- in Produci assegna il lotto all'ingrediente giusto;
- altrove apre il lotto.

In modalità tastiera il separatore GS1 (FNC1/GS) spesso **si perde**. Configura lo scanner per sostituirlo con `|` (oppure `^`, `~`, `#`): il parser li riconosce tutti, perché non possono comparire nei dati GS1.

## Note tecniche

- **Lettore**: usa `BarcodeDetector` nativo (Chrome Android). Se non c'è (Safari iOS) carica [barcode-detector](https://github.com/Sec-ant/barcode-detector) (ZXing in WebAssembly) da jsDelivr. La prima volta serve internet. Formati: Code128/GS1-128, EAN-13/8, UPC, ITF-14, DataMatrix, QR, DataBar. Torcia attivabile dove supportata (utile in cella).
- **Parser GS1** (`js/gs1.js`): formato con parentesi, stringa grezza con FNC1, prefissi AIM `]C1`/`]d2`, date con giorno `00`, decimali dei pesi, codici paese ISO. La mappatura dei campi origine segue la linea guida GS1 per la carne bovina: 422 nato, 423 allevato, 424 + 7030 macellato, 425 + 7031 sezionato. **Verificala sulle etichette reali dei fornitori.**
- **Dati**: `localStorage` del browser, con coda eventi verso n8n. Nessun framework e nessuna build: sono file statici.
- **Test**: `npm test` (19 test: parser GS1 e flusso completo arrivo → macinato → ragù → lasagne → richiamo).

## Limiti del prototipo (prossimi passi)

1. **Ogni telefono ha il suo magazzino.** Per più dispositivi serve un archivio condiviso: Supabase, oppure n8n + Postgres con un endpoint che restituisce i lotti aperti.
2. **Nessun login.** L'operatore si imposta a mano su ogni telefono.
3. **Etichette**: stampa via browser (AirPrint/driver). Con una stampante tipo Brother QL da 62 mm va bene; l'integrazione diretta con le bilance etichettatrici del reparto è un passo successivo.
4. È uno strumento di supporto: **non sostituisce il piano HACCP** del punto vendita. Formati di etichetta e tempi di conservazione vanno validati con il consulente HACCP o la Cooperativa.

## Struttura

```
index.html            shell dell'app + tab bar
css/app.css           stile mobile-first + layout etichetta 62 mm
js/app.js             schermate e router (#ricevi, #lotti, #produci, #cerca, #ricette, #impostazioni)
js/gs1.js             parser GS1-128 / EAN
js/scanner.js         fotocamera + scanner Bluetooth
js/store.js           archivio locale, lotti, alberi di tracciabilità, coda eventi
js/labels.js          etichette e barcode
js/sync.js            invio a n8n con retry
js/demo.js            ricette base, codici di prova, giornata di esempio
n8n/                  workflow importabile
test/                 test Node (node --test)
```
