// Test del flusso completo: arrivo → macinato → ragù → lasagne → richiamo.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// localStorage finto per Node
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const S = await import('../js/store.js');
const { creaGiornataEsempio, codiciProva, installaCatalogoProva } = await import('../js/demo.js');
const { ingredientiHtml, etichettaHtml } = await import('../js/labels.js');
const { parseBarcode } = await import('../js/gs1.js');

beforeEach(() => { S.resetDb(); });

const flatValle = (nodo, acc = []) => {
  (nodo?.figli || []).forEach((f) => { if (f.nodo) { acc.push(f.nodo.lotto); flatValle(f.nodo, acc); } });
  return acc;
};

test('giornata di esempio: catena a 3 livelli e lotti con prefisso data', () => {
  creaGiornataEsempio();
  const db = S.getDb();
  const prod = db.lotti.filter((l) => l.tipo === 'produzione');
  assert.equal(prod.length, 3);
  const yymmdd = S.oggiIso().replaceAll('-', '').slice(2);
  assert.deepEqual(prod.map((l) => l.id), [`MAC-${yymmdd}-01`, `RAG-${yymmdd}-01`, `LAS-${yymmdd}-01`]);
});

test('richiamo carne bovina BOV-A123 → trova macinato, ragù e lasagne', () => {
  creaGiornataEsempio();
  const [bov] = S.trovaLotti('BOV-A123', parseBarcode('BOV-A123'));
  assert.ok(bov, 'lotto bovino trovato');
  const coinvolti = flatValle(S.alberoValle(bov.id)).map((l) => l.nome);
  assert.deepEqual(coinvolti, ['Macinato di bovino', 'Ragù alla bolognese', 'Lasagne alla bolognese']);
});

test('richiamo passata L2345 → solo ragù e lasagne', () => {
  creaGiornataEsempio();
  const [pas] = S.trovaLotti('L2345', parseBarcode('L2345'));
  const coinvolti = flatValle(S.alberoValle(pas.id)).map((l) => l.nome);
  assert.deepEqual(coinvolti, ['Ragù alla bolognese', 'Lasagne alla bolognese']);
});

test('lasagne: allergeni ereditati e origine carne propagata', () => {
  creaGiornataEsempio();
  const las = S.getDb().lotti.find((l) => l.nome === 'Lasagne alla bolognese');
  // Le lasagne contengono il ragù: ne ereditano sedano e solfiti
  assert.deepEqual(las.allergeni, ['Glutine', 'Uova', 'Latte', 'Sedano', 'Solfiti']);
  const rag = S.getDb().lotti.find((l) => l.nome === 'Ragù alla bolognese');
  assert.deepEqual(rag.allergeni, ['Sedano', 'Solfiti']);
  // L'origine passa da carne → macinato → ragù → lasagne
  assert.equal(las.origine?.nato, 'Italia');
  assert.equal(las.origine?.rifOrigine, 'IT012345678901');
});

test('etichetta lasagne: ragù espanso tra parentesi con allergeni in maiuscolo', () => {
  creaGiornataEsempio();
  const las = S.getDb().lotti.find((l) => l.nome === 'Lasagne alla bolognese');
  const ingr = ingredientiHtml(las);
  assert.match(ingr, /Ragù alla bolognese \(Macinato di bovino \(Carne bovina\), Passata di pomodoro, <b>SEDANO<\/b>/);
  assert.match(ingr, /<b>VINO ROSSO<\/b>/);
  assert.match(ingr, /<b>SFOGLIA ALL&#39;UOVO<\/b>/);
  const html = etichettaHtml(las);
  assert.match(html, /data-code="LAS-/);
});

test('scansione codice di prova bovino → campi origine e peso', () => {
  installaCatalogoProva();
  const bov = codiciProva()[0];
  const raw = bov.gs1.replaceAll('|', '\x1d');
  const p = parseBarcode(raw);
  assert.equal(p.fields.lotto, 'BOV-A123');
  assert.equal(p.fields.pesoNettoKg, 12.345);
  assert.equal(p.fields.paeseOrigine, 'Italia');
  assert.equal(p.fields.stabilimento0, 'Italia IT1234L');
  assert.equal(p.fields.stabilimento1, 'Italia IT5678S');
  assert.equal(S.getProdotto(p.fields.gtin)?.nome, 'Carne bovina – pezzi per macinato');
  assert.deepEqual(p.errors, []);
});

test('ogni codice di prova si legge senza errori', () => {
  for (const c of codiciProva()) {
    const p = parseBarcode(c.gs1 ? c.gs1.replaceAll('|', '\x1d') : c.ean);
    assert.deepEqual(p.errors, [], c.nome);
    assert.ok(p.fields.gtin, c.nome);
  }
});

test('blocco richiamo e coda eventi per n8n', () => {
  creaGiornataEsempio();
  const [bov] = S.trovaLotti('BOV-A123', parseBarcode('BOV-A123'));
  flatValle(S.alberoValle(bov.id)).forEach((l) => S.cambiaStatoLotto(l.id, 'bloccato', 'Richiamo'));
  assert.equal(S.lottiAperti().filter((l) => l.tipo === 'produzione').length, 0);
  const tipi = S.eventiDaInviare().map((e) => e.tipo);
  assert.ok(tipi.includes('ricevimento') && tipi.includes('produzione') && tipi.includes('stato_lotto'));
});

test('ricerca lotto interno dal codice a barre dell’etichetta', () => {
  creaGiornataEsempio();
  const las = S.getDb().lotti.find((l) => l.nome === 'Lasagne alla bolognese');
  const trovati = S.trovaLotti(las.id, parseBarcode(las.id));
  assert.equal(trovati[0]?.id, las.id);
});

test('confezione singola (EAN-13) collegata al lotto del cartone (GTIN-14)', async () => {
  const { eanConfezione } = await import('../js/prodotti.js');
  // Cartone: indicatore 1 + stesse 12 cifre della confezione
  const ean = '8001234560072';
  const cartone = '1' + ean.slice(0, 12);
  const gtin14 = cartone + ((10 - ([...cartone].reverse().reduce((s, n, i) => s + n * (i % 2 === 0 ? 3 : 1), 0) % 10)) % 10);
  assert.equal(S.gtinBase(gtin14), S.gtinBase(ean));
  assert.equal(eanConfezione(gtin14), ean);
  const vecchio = S.registraRicevimento({ gtin: gtin14, nome: 'Latte', codiceLotto: 'LT1', scadenza: S.addGiorni(S.oggiIso(), 2), dataArrivo: S.oggiIso() });
  const nuovo = S.registraRicevimento({ gtin: gtin14, nome: 'Latte', codiceLotto: 'LT2', scadenza: S.addGiorni(S.oggiIso(), 6), dataArrivo: S.oggiIso() });
  const trovati = S.trovaLotti(ean, parseBarcode(ean));
  assert.deepEqual(trovati.map((l) => l.id), [vecchio.id, nuovo.id], 'FEFO: prima quello che scade prima');
  assert.equal(S.getProdotto(ean)?.nome, 'Latte', 'catalogo riconosce la confezione dal cartone');
});

test('EAN senza lotti registrati non restituisce lotti di altri prodotti', () => {
  creaGiornataEsempio();
  assert.deepEqual(S.trovaLotti('4006381333931', parseBarcode('4006381333931')), []);
});
