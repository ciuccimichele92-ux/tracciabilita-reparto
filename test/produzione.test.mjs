// Produzioni "in corso": scansioni libere, chiusura con "Preparazione completata".
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const S = await import('../js/store.js');
const { creaGiornataEsempio } = await import('../js/demo.js');
const { ingredientiHtml } = await import('../js/labels.js');

beforeEach(() => { S.resetDb(); creaGiornataEsempio(); });

const lottoDi = (nome) => S.getDb().lotti.find((l) => l.nome === nome);
const yymmdd = () => S.oggiIso().replaceAll('-', '').slice(2);

test('due lasagne nello stesso giorno: due produzioni, lotti 02 e 03', () => {
  const a = S.avviaProduzione('RIC-LASAGNE');
  const b = S.avviaProduzione('RIC-LASAGNE');
  assert.equal(S.getDb().inCorso.length, 2);
  S.aggiungiAProduzione(a.id, lottoDi('Ragù alla bolognese').id);
  S.aggiungiAProduzione(b.id, lottoDi("Sfoglia all'uovo fresca").id);
  // si completa prima la seconda: il numero nasce alla chiusura
  const lb = S.completaProduzione(b.id, { quantita: '4', unita: 'teglie', scadenza: S.oggiIso() });
  const la = S.completaProduzione(a.id, { quantita: '6', unita: 'teglie', scadenza: S.oggiIso() });
  assert.equal(lb.id, `LAS-${yymmdd()}-02`); // la -01 è della giornata di esempio
  assert.equal(la.id, `LAS-${yymmdd()}-03`);
  assert.equal(S.getDb().inCorso.length, 0);
});

test('stesso lotto scansionato due volte non si duplica', () => {
  const p = S.avviaProduzione('RIC-LASAGNE');
  const id = lottoDi('Burro').id;
  assert.equal(S.aggiungiAProduzione(p.id, id), 'aggiunto');
  assert.equal(S.aggiungiAProduzione(p.id, id), 'gia');
  assert.equal(S.getProduzione(p.id).voci.length, 1);
});

test('ingredienti mancanti e associazione per l’etichetta', () => {
  const p = S.avviaProduzione('RIC-LASAGNE');
  for (const n of ["Sfoglia all'uovo fresca", 'Ragù alla bolognese', 'Latte intero fresco', 'Burro']) {
    S.aggiungiAProduzione(p.id, lottoDi(n).id);
  }
  assert.deepEqual(S.ingredientiMancanti(p.id), ['Farina di grano tenero', 'Parmigiano Reggiano DOP']);
  S.aggiungiAProduzione(p.id, lottoDi('Farina di grano tenero tipo 00').id);
  S.aggiungiAProduzione(p.id, lottoDi('Parmigiano Reggiano DOP grattugiato').id);
  assert.deepEqual(S.ingredientiMancanti(p.id), []);
  const l = S.completaProduzione(p.id, { quantita: '8', unita: 'teglie', scadenza: S.oggiIso() });
  assert.deepEqual(l.componenti.map((c) => c.ingrediente),
    ["Sfoglia all'uovo", 'Ragù alla bolognese', 'Latte', 'Burro', 'Farina di grano tenero', 'Parmigiano Reggiano DOP']);
  assert.match(ingredientiHtml(l), /Ragù alla bolognese \(Macinato di bovino/);
  assert.equal(l.origine?.nato, 'Italia');
  assert.ok(l.avviata);
});

test('annulla produzione: nessun lotto creato', () => {
  const prima = S.getDb().lotti.length;
  const p = S.avviaProduzione('RIC-RAGU');
  S.aggiungiAProduzione(p.id, lottoDi('Passata di pomodoro').id);
  S.annullaProduzione(p.id);
  assert.equal(S.getDb().inCorso.length, 0);
  assert.equal(S.getDb().lotti.length, prima);
});

test('la produzione in corso sopravvive alla riapertura dell’app', async () => {
  const p = S.avviaProduzione('RIC-RAGU');
  S.aggiungiAProduzione(p.id, lottoDi('Vino rosso').id);
  const salvato = JSON.parse(mem.get('tracciabilita.v1'));
  assert.equal(salvato.inCorso[0].voci.length, 1);
});
