// Ricette di partenza, catalogo prodotti di esempio e codici GS1-128 di prova
// (da mostrare sullo schermo del PC e scansionare col telefono).

import { getDb, salvaRicetta, salvaProdotto, salvaImpostazioni, registraRicevimento, registraProduzione, addGiorni, oggiIso } from './store.js';

function conCheckDigit(base) {
  const d = base.split('').map(Number).reverse();
  const sum = d.reduce((s, n, i) => s + n * (i % 2 === 0 ? 3 : 1), 0);
  return base + ((10 - (sum % 10)) % 10);
}
const yymmdd = (iso) => iso.replaceAll('-', '').slice(2);

export const RICETTE_BASE = [
  {
    id: 'RIC-MACINATO', nome: 'Macinato di bovino', prefisso: 'MAC', categoria: 'macinato',
    shelfLifeGiorni: 1, unita: 'kg',
    conservazione: 'Conservare a 0/+2 °C. Da consumarsi previa cottura.',
    ingredienti: [{ nome: 'Carne bovina', allergeni: [], obbligatorio: true }],
  },
  {
    id: 'RIC-RAGU', nome: 'Ragù alla bolognese', prefisso: 'RAG', categoria: 'altro',
    shelfLifeGiorni: 3, unita: 'kg',
    conservazione: 'Conservare a 0/+4 °C.',
    ingredienti: [
      { nome: 'Macinato di bovino', allergeni: [], obbligatorio: true },
      { nome: 'Passata di pomodoro', allergeni: [], obbligatorio: true },
      { nome: 'Sedano', allergeni: ['Sedano'], obbligatorio: false },
      { nome: 'Carota', allergeni: [], obbligatorio: false },
      { nome: 'Cipolla', allergeni: [], obbligatorio: false },
      { nome: 'Vino rosso', allergeni: ['Solfiti'], obbligatorio: true },
      { nome: 'Olio extravergine di oliva', allergeni: [], obbligatorio: false },
      { nome: 'Sale', allergeni: [], obbligatorio: false },
    ],
  },
  {
    id: 'RIC-LASAGNE', nome: 'Lasagne alla bolognese', prefisso: 'LAS', categoria: 'altro',
    shelfLifeGiorni: 3, unita: 'teglie',
    conservazione: 'Conservare in frigorifero a 0/+4 °C. Scaldare in forno a 180 °C per 20 minuti.',
    ingredienti: [
      { nome: "Sfoglia all'uovo", allergeni: ['Glutine', 'Uova'], obbligatorio: true },
      { nome: 'Ragù alla bolognese', allergeni: [], obbligatorio: true },
      { nome: 'Latte', allergeni: ['Latte'], obbligatorio: true },
      { nome: 'Burro', allergeni: ['Latte'], obbligatorio: true },
      { nome: 'Farina di grano tenero', allergeni: ['Glutine'], obbligatorio: true },
      { nome: 'Parmigiano Reggiano DOP', allergeni: ['Latte'], obbligatorio: true },
      { nome: 'Noce moscata', allergeni: [], obbligatorio: false },
      { nome: 'Sale', allergeni: [], obbligatorio: false },
    ],
  },
];

/** Codici di prova: GTIN validi ma inventati (prefisso 800123…). */
export function codiciProva() {
  const oggi = oggiIso();
  const g = {
    bovino: conCheckDigit('9800123456789'),
    passata: conCheckDigit('0800123456001'),
    latte: conCheckDigit('0800123456002'),
    sfoglia: conCheckDigit('0800123456003'),
    parmigiano: conCheckDigit('0800123456004'),
    burro: conCheckDigit('0800123456005'),
    vino: conCheckDigit('0800123456006'),
  };
  const farinaEan = conCheckDigit('800123456007');
  return [
    {
      nome: 'Carne bovina – pezzi per macinato (cartone fornitore)',
      prodotto: { gtin: g.bovino, nome: 'Carne bovina – pezzi per macinato', fornitore: 'Macello Esempio S.r.l.', categoria: 'bovino', allergeni: [] },
      // GS1-128 con dati di origine (linea guida GS1 per la carne bovina). "|" = FNC1
      gs1: `01${g.bovino}3103012345` + `17${yymmdd(addGiorni(oggi, 10))}` + `10BOV-A123|251IT012345678901|422380|423380|424380|7030380IT1234L|425380|7031380IT5678S`,
      testo: `(01)${g.bovino}(3103)012345(17)${yymmdd(addGiorni(oggi, 10))}(10)BOV-A123 …`,
    },
    {
      nome: 'Passata di pomodoro (cartone)',
      prodotto: { gtin: g.passata, nome: 'Passata di pomodoro', fornitore: 'Conserve Esempio', categoria: 'secco', allergeni: [] },
      gs1: `01${g.passata}15${yymmdd(addGiorni(oggi, 300))}10L2345`,
      testo: `(01)${g.passata}(15)${yymmdd(addGiorni(oggi, 300))}(10)L2345`,
    },
    {
      nome: 'Latte intero fresco (cassa)',
      prodotto: { gtin: g.latte, nome: 'Latte intero fresco', fornitore: 'Centrale del latte esempio', categoria: 'latticini', allergeni: ['Latte'] },
      gs1: `01${g.latte}17${yymmdd(addGiorni(oggi, 6))}10LT556`,
      testo: `(01)${g.latte}(17)${yymmdd(addGiorni(oggi, 6))}(10)LT556`,
    },
    {
      nome: "Sfoglia all'uovo fresca",
      prodotto: { gtin: g.sfoglia, nome: "Sfoglia all'uovo fresca", fornitore: 'Pastificio Esempio', categoria: 'latticini', allergeni: ['Glutine', 'Uova'] },
      gs1: `01${g.sfoglia}17${yymmdd(addGiorni(oggi, 20))}10SF889`,
      testo: `(01)${g.sfoglia}(17)${yymmdd(addGiorni(oggi, 20))}(10)SF889`,
    },
    {
      nome: 'Parmigiano Reggiano DOP – grattugiato (busta 5 kg)',
      prodotto: { gtin: g.parmigiano, nome: 'Parmigiano Reggiano DOP grattugiato', fornitore: 'Caseificio Esempio', categoria: 'latticini', allergeni: ['Latte'] },
      gs1: `01${g.parmigiano}3102005000` + `15${yymmdd(addGiorni(oggi, 90))}10PR77`,
      testo: `(01)${g.parmigiano}(3102)005000(15)${yymmdd(addGiorni(oggi, 90))}(10)PR77`,
    },
    {
      nome: 'Burro (cartone)',
      prodotto: { gtin: g.burro, nome: 'Burro', fornitore: 'Caseificio Esempio', categoria: 'latticini', allergeni: ['Latte'] },
      gs1: `01${g.burro}15${yymmdd(addGiorni(oggi, 60))}10BU12`,
      testo: `(01)${g.burro}(15)${yymmdd(addGiorni(oggi, 60))}(10)BU12`,
    },
    {
      nome: 'Vino rosso da cucina',
      prodotto: { gtin: g.vino, nome: 'Vino rosso', fornitore: 'Cantina Esempio', categoria: 'secco', allergeni: ['Solfiti'] },
      gs1: `01${g.vino}10V2026A`,
      testo: `(01)${g.vino}(10)V2026A`,
    },
    {
      nome: 'Farina 00 – solo EAN-13 (il lotto va inserito a mano)',
      prodotto: { gtin: farinaEan.padStart(14, '0'), nome: 'Farina di grano tenero tipo 00', fornitore: 'Molino Esempio', categoria: 'secco', allergeni: ['Glutine'] },
      ean: farinaEan,
    },
  ];
}

export function installaRicetteBase(forza = false) {
  const db = getDb();
  // Solo al primo avvio (o su richiesta): se l'utente cancella una ricetta base non deve ricomparire
  if (!forza && db.impostazioni.ricetteBaseInstallate) return;
  RICETTE_BASE.forEach((r) => {
    if (forza || !db.ricette.some((x) => x.id === r.id)) salvaRicetta(structuredClone(r));
  });
  salvaImpostazioni({ ricetteBaseInstallate: true });
}

export function installaCatalogoProva() {
  codiciProva().forEach((c) => salvaProdotto(c.prodotto));
}

/** Crea una "giornata tipo": arrivi + macinato → ragù → lasagne, per provare subito la ricerca richiamo. */
export function creaGiornataEsempio() {
  installaRicetteBase(true);
  installaCatalogoProva();
  const oggi = oggiIso();
  const c = Object.fromEntries(codiciProva().map((x) => [x.prodotto.nome, x.prodotto]));
  const arrivo = (p, extra) => registraRicevimento({
    gtin: p.gtin, nome: p.nome, fornitore: p.fornitore, categoria: p.categoria, allergeni: p.allergeni,
    dataArrivo: oggi, ddt: 'DDT 4512', temperatura: p.categoria === 'secco' ? '' : 3, conforme: true, ...extra,
  });
  const bov = arrivo(c['Carne bovina – pezzi per macinato'], {
    codiceLotto: 'BOV-A123', scadenza: addGiorni(oggi, 10), pesoKg: 12.345,
    origine: { nato: 'Italia', allevato: 'Italia', macellato: 'Italia IT1234L', sezionato: 'Italia IT5678S', rifOrigine: 'IT012345678901' },
  });
  const pas = arrivo(c['Passata di pomodoro'], { codiceLotto: 'L2345', scadenza: addGiorni(oggi, 300) });
  const vin = arrivo(c['Vino rosso'], { codiceLotto: 'V2026A', scadenza: '' });
  const lat = arrivo(c['Latte intero fresco'], { codiceLotto: 'LT556', scadenza: addGiorni(oggi, 6) });
  const sfo = arrivo(c["Sfoglia all'uovo fresca"], { codiceLotto: 'SF889', scadenza: addGiorni(oggi, 20) });
  const par = arrivo(c['Parmigiano Reggiano DOP grattugiato'], { codiceLotto: 'PR77', scadenza: addGiorni(oggi, 90), pesoKg: 5 });
  const bur = arrivo(c['Burro'], { codiceLotto: 'BU12', scadenza: addGiorni(oggi, 60) });
  const far = arrivo(c['Farina di grano tenero tipo 00'], { codiceLotto: 'F0925', scadenza: addGiorni(oggi, 200) });

  const ric = (id) => getDb().ricette.find((r) => r.id === id);
  const mac = registraProduzione({
    ricetta: ric('RIC-MACINATO'), componenti: [{ ingrediente: 'Carne bovina', lottoId: bov.id, quantita: '6 kg' }],
    quantita: 6, unita: 'kg', dataProduzione: oggi, scadenza: addGiorni(oggi, 1),
  });
  const rag = registraProduzione({
    ricetta: ric('RIC-RAGU'),
    componenti: [
      { ingrediente: 'Macinato di bovino', lottoId: mac.id, quantita: '4 kg' },
      { ingrediente: 'Passata di pomodoro', lottoId: pas.id, quantita: '3 kg' },
      { ingrediente: 'Vino rosso', lottoId: vin.id, quantita: '0,5 l' },
    ],
    quantita: 7, unita: 'kg', dataProduzione: oggi, scadenza: addGiorni(oggi, 3),
  });
  registraProduzione({
    ricetta: ric('RIC-LASAGNE'),
    componenti: [
      { ingrediente: "Sfoglia all'uovo", lottoId: sfo.id },
      { ingrediente: 'Ragù alla bolognese', lottoId: rag.id, quantita: '5 kg' },
      { ingrediente: 'Latte', lottoId: lat.id, quantita: '3 l' },
      { ingrediente: 'Burro', lottoId: bur.id },
      { ingrediente: 'Farina di grano tenero', lottoId: far.id },
      { ingrediente: 'Parmigiano Reggiano DOP', lottoId: par.id },
    ],
    quantita: 8, unita: 'teglie', dataProduzione: oggi, scadenza: addGiorni(oggi, 3),
  });
}
