// Archivio locale (localStorage) + coda eventi da sincronizzare verso n8n.
// Il prototipo è "local-first": funziona anche senza rete, poi invia gli eventi quando torna online.

const KEY = 'tracciabilita.v1';

export const ALLERGENI = [
  'Glutine', 'Crostacei', 'Uova', 'Pesce', 'Arachidi', 'Soia', 'Latte',
  'Frutta a guscio', 'Sedano', 'Senape', 'Sesamo', 'Solfiti', 'Lupini', 'Molluschi',
];

// Temperature massime al ricevimento (°C), riferimento Reg. CE 853/2004 e prassi HACCP.
export const CATEGORIE = {
  bovino: { nome: 'Carne bovina', tMax: 7, origineBovina: true },
  suino: { nome: 'Carne suina', tMax: 7, origine: true },
  avicolo: { nome: 'Carne avicola', tMax: 4, origine: true },
  ovicaprino: { nome: 'Carne ovina/caprina', tMax: 7, origine: true },
  macinato: { nome: 'Carne macinata / preparazioni', tMax: 2, origine: true },
  latticini: { nome: 'Latte e latticini', tMax: 4 },
  ortofrutta: { nome: 'Ortofrutta', tMax: null },
  secco: { nome: 'Secco / dispensa', tMax: null },
  surgelato: { nome: 'Surgelato', tMax: -15 },
  altro: { nome: 'Altro', tMax: null },
};

function empty() {
  return {
    versione: 1,
    prodotti: {},   // gtin -> { gtin, nome, fornitore, categoria, allergeni[] }
    lotti: [],      // vedi nuovoLotto()
    ricette: [],
    eventi: [],     // coda sync: { id, tipo, ts, dati, inviato }
    contatori: {},  // prefisso+data -> progressivo
    impostazioni: { negozio: '', operatore: '', webhookUrl: '', webhookToken: '' },
  };
}

let db = load();
const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...empty(), ...JSON.parse(raw) };
  } catch (e) { console.error('Archivio corrotto, riparto da zero', e); }
  return empty();
}

function save() {
  localStorage.setItem(KEY, JSON.stringify(db));
  listeners.forEach((fn) => fn(db));
}

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function getDb() { return db; }
export function replaceDb(newDb) { db = { ...empty(), ...newDb }; save(); }
export function resetDb() { db = empty(); save(); }

export function uid(prefix = 'ID') {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
}

export function oggiIso(d = new Date()) {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
}

export function addGiorni(iso, giorni) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + Number(giorni || 0));
  return oggiIso(d);
}

export function giorniAllaScadenza(iso) {
  if (!iso) return null;
  const a = new Date(oggiIso() + 'T12:00:00'), b = new Date(iso + 'T12:00:00');
  return Math.round((b - a) / 86400000);
}

function evento(tipo, dati) {
  db.eventi.push({
    id: uid('EV'), tipo, ts: new Date().toISOString(),
    negozio: db.impostazioni.negozio, operatore: db.impostazioni.operatore,
    dati, inviato: false,
  });
}

// ---------- Prodotti ----------
/**
 * "Radice" di un GTIN senza cifra indicatore e cifra di controllo.
 * Il cartone (GTIN-14, es. 1 8001234 56789 X) e la singola confezione (EAN-13, 8001234 56789 Y)
 * di solito condividono le stesse 12 cifre centrali: è così che colleghiamo collo e confezione.
 */
export function gtinBase(gtin) {
  const g = String(gtin || '').replace(/\D/g, '');
  if (!g) return '';
  return g.padStart(14, '0').slice(1, 13);
}

export function getProdotto(gtin) {
  if (!gtin) return null;
  if (db.prodotti[gtin]) return db.prodotti[gtin];
  const base = gtinBase(gtin);
  return Object.values(db.prodotti).find((p) => gtinBase(p.gtin) === base) || null;
}

export function salvaProdotto(p) {
  if (!p.gtin) return;
  const prima = db.prodotti[p.gtin];
  db.prodotti[p.gtin] = { ...prima, ...p };
  evento('prodotto', db.prodotti[p.gtin]);
  save();
}

// ---------- Lotti ----------
export function getLotto(id) { return db.lotti.find((l) => l.id === id); }

/**
 * Cerca un lotto da un codice scansionato/digitato: id interno, lotto fornitore, SSCC.
 * Se il codice ha solo il prodotto (EAN della singola confezione, senza lotto) restituisce
 * i lotti di quel prodotto registrati al ricevimento dal codice del cartone, in ordine FEFO.
 */
export function trovaLotti(codice, parsed) {
  const c = String(codice || '').trim().toUpperCase();
  const lotto = parsed?.fields?.lotto?.toUpperCase();
  const gtin = parsed?.fields?.gtin;
  const base = gtinBase(gtin);
  const sscc = parsed?.fields?.sscc;
  const stessoProdotto = (l) => !gtin || !l.gtin || gtinBase(l.gtin) === base;
  const diretti = db.lotti.filter((l) =>
    l.id.toUpperCase() === c ||
    (sscc && l.sscc === sscc) ||
    (lotto && l.codiceLotto?.toUpperCase() === lotto && stessoProdotto(l)) ||
    (!parsed?.elements?.length && l.codiceLotto?.toUpperCase() === c)
  );
  if (diretti.length || lotto || !base) return diretti;
  return db.lotti
    .filter((l) => l.gtin && gtinBase(l.gtin) === base)
    .sort((a, b) => (a.scadenza || '9999').localeCompare(b.scadenza || '9999'));
}

export function lottiAperti() {
  return db.lotti
    .filter((l) => l.stato === 'aperto')
    .sort((a, b) => (a.scadenza || '9999').localeCompare(b.scadenza || '9999')); // FEFO
}

export function registraRicevimento(dati) {
  const lotto = {
    id: uid('IN'),
    tipo: 'ingresso',
    stato: 'aperto',
    creato: new Date().toISOString(),
    operatore: db.impostazioni.operatore,
    ...dati,
  };
  db.lotti.push(lotto);
  if (dati.gtin) {
    db.prodotti[dati.gtin] = {
      ...db.prodotti[dati.gtin],
      gtin: dati.gtin, nome: dati.nome, fornitore: dati.fornitore,
      categoria: dati.categoria, allergeni: dati.allergeni,
    };
  }
  evento('ricevimento', lotto);
  save();
  return lotto;
}

function prossimoCodice(prefisso, dataIso) {
  const yymmdd = dataIso.replaceAll('-', '').slice(2);
  const k = `${prefisso}-${yymmdd}`;
  db.contatori[k] = (db.contatori[k] || 0) + 1;
  return `${k}-${String(db.contatori[k]).padStart(2, '0')}`;
}

export function registraProduzione({ ricetta, componenti, quantita, unita, dataProduzione, scadenza, note }) {
  const comp = componenti.map((c) => ({ ...c, lotto: getLotto(c.lottoId) }));
  const allergeni = new Set(ricetta.ingredienti.flatMap((i) => i.allergeni || []));
  comp.forEach((c) => (c.lotto?.allergeni || []).forEach((a) => allergeni.add(a)));
  // L'origine della carne si eredita dai componenti (serve sull'etichetta al banco)
  const origini = comp.map((c) => c.lotto?.origine).filter((o) => o && Object.values(o).some(Boolean));

  const lotto = {
    id: prossimoCodice(ricetta.prefisso || 'PRD', dataProduzione),
    tipo: 'produzione',
    stato: 'aperto',
    creato: new Date().toISOString(),
    operatore: db.impostazioni.operatore,
    ricettaId: ricetta.id,
    nome: ricetta.nome,
    categoria: ricetta.categoria || 'altro',
    conservazione: ricetta.conservazione,
    dataProduzione,
    scadenza,
    quantita, unita,
    note,
    allergeni: ALLERGENI.filter((a) => allergeni.has(a)),
    ingredientiEtichetta: ricetta.ingredienti.map((i) => ({ nome: i.nome, allergeni: i.allergeni || [] })),
    origine: origini[0] || null,
    componenti: comp.map((c) => ({ ingrediente: c.ingrediente, lottoId: c.lottoId, quantita: c.quantita || '' })),
  };
  db.lotti.push(lotto);
  evento('produzione', lotto);
  save();
  return lotto;
}

export function cambiaStatoLotto(id, stato, motivo = '') {
  const l = getLotto(id);
  if (!l) return;
  l.stato = stato;
  l.statoMotivo = motivo;
  l.statoData = new Date().toISOString();
  evento('stato_lotto', { id, stato, motivo, nome: l.nome, codiceLotto: l.codiceLotto });
  save();
}

// ---------- Ricette ----------
export function salvaRicetta(r) {
  r = { ...r, id: r.id || uid('RIC') };
  const i = db.ricette.findIndex((x) => x.id === r.id);
  if (i >= 0) db.ricette[i] = r; else db.ricette.push(r);
  evento('ricetta', r);
  save();
  return r;
}
export function eliminaRicetta(id) {
  db.ricette = db.ricette.filter((r) => r.id !== id);
  save();
}

// ---------- Tracciabilità ----------
/** Albero "a monte": di cosa è fatto il lotto (ricorsivo). */
export function alberoMonte(id, visti = new Set()) {
  const l = getLotto(id);
  if (!l || visti.has(id)) return null;
  visti.add(id);
  return {
    lotto: l,
    figli: (l.componenti || []).map((c) => ({ ingrediente: c.ingrediente, quantita: c.quantita, nodo: alberoMonte(c.lottoId, visti) })),
  };
}

/** Albero "a valle": dove è stato usato il lotto (ricorsivo). È quello che serve per un richiamo. */
export function alberoValle(id, visti = new Set()) {
  const l = getLotto(id);
  if (!l || visti.has(id)) return null;
  visti.add(id);
  const usi = db.lotti.filter((x) => (x.componenti || []).some((c) => c.lottoId === id));
  return { lotto: l, figli: usi.map((u) => ({ nodo: alberoValle(u.id, visti) })) };
}

// ---------- Coda eventi ----------
export function eventiDaInviare() { return db.eventi.filter((e) => !e.inviato); }
export function segnaInviati(ids) {
  const set = new Set(ids);
  db.eventi.forEach((e) => { if (set.has(e.id)) e.inviato = true; });
  // Teniamo solo gli ultimi 500 eventi già inviati per non riempire lo storage
  const inviati = db.eventi.filter((e) => e.inviato);
  if (inviati.length > 500) {
    const daTogliere = new Set(inviati.slice(0, inviati.length - 500).map((e) => e.id));
    db.eventi = db.eventi.filter((e) => !daTogliere.has(e.id));
  }
  save();
}
export function salvaImpostazioni(imp) { db.impostazioni = { ...db.impostazioni, ...imp }; save(); }
