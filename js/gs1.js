// Parser GS1 (GS1-128, DataMatrix GS1, DataBar, EAN/UPC).
// Gestisce: formato "umano" con parentesi, stringa grezza con separatore FNC1 (GS, \x1d)
// o separatori sostitutivi (| ^ ~ #) che gli scanner in modalità tastiera usano al posto di GS.

const GS = '\x1d';
const SEPARATORS = /[\x1d|^~#]/;

// len: lunghezza fissa dei dati | max: lunghezza massima (variabile)
// dec: true se l'ultima cifra dell'AI indica i decimali (es. 3103 = kg con 3 decimali)
const AI_TABLE = {
  '00': { key: 'sscc', label: 'SSCC (collo)', len: 18 },
  '01': { key: 'gtin', label: 'GTIN (prodotto)', len: 14 },
  '02': { key: 'gtinContenuto', label: 'GTIN contenuto', len: 14 },
  '10': { key: 'lotto', label: 'Lotto', max: 20 },
  '11': { key: 'dataProduzione', label: 'Data produzione', len: 6, date: true },
  '13': { key: 'dataConfezionamento', label: 'Data confezionamento', len: 6, date: true },
  '15': { key: 'tmc', label: 'Da consumarsi preferibilmente entro', len: 6, date: true },
  '16': { key: 'dataVendita', label: 'Vendere entro', len: 6, date: true },
  '17': { key: 'scadenza', label: 'Da consumarsi entro', len: 6, date: true },
  '20': { key: 'variante', label: 'Variante', len: 2 },
  '21': { key: 'seriale', label: 'Numero seriale', max: 20 },
  '240': { key: 'idAggiuntivo', label: 'ID aggiuntivo', max: 30 },
  '251': { key: 'rifOrigine', label: 'Riferimento origine (cod. animale)', max: 30 },
  '30': { key: 'quantita', label: 'Quantità', max: 8 },
  '37': { key: 'unita', label: 'Numero unità', max: 8 },
  '400': { key: 'ordine', label: 'Ordine cliente', max: 30 },
  '422': { key: 'paeseOrigine', label: 'Paese di origine (nato in)', len: 3, country: true },
  '423': { key: 'paesePrimaLavorazione', label: 'Paese prima lavorazione (allevato in)', max: 15, countries: true },
  '424': { key: 'paeseLavorazione', label: 'Paese di lavorazione (macellato in)', len: 3, country: true },
  '425': { key: 'paeseSezionamento', label: 'Paese di sezionamento (sezionato in)', max: 15, countries: true },
  '426': { key: 'paeseFiliera', label: 'Paese intera filiera', len: 3, country: true },
};
// 310n peso netto kg, 330n peso lordo kg
for (let n = 0; n <= 5; n++) {
  AI_TABLE['310' + n] = { key: 'pesoNettoKg', label: 'Peso netto (kg)', len: 6, decimals: n };
  AI_TABLE['330' + n] = { key: 'pesoLordoKg', label: 'Peso lordo (kg)', len: 6, decimals: n };
  AI_TABLE['392' + n] = { key: 'prezzo', label: 'Prezzo', max: 15, decimals: n };
}
// 7030-7039 numero di approvazione stabilimento (bollo CE) con paese ISO
for (let n = 0; n <= 9; n++) {
  AI_TABLE['703' + n] = { key: 'stabilimento' + n, label: 'Stabilimento (bollo CE) fase ' + n, max: 30, approval: true };
}

const COUNTRIES = {
  '380': 'Italia', '250': 'Francia', '276': 'Germania', '724': 'Spagna', '616': 'Polonia',
  '528': 'Paesi Bassi', '056': 'Belgio', '040': 'Austria', '372': 'Irlanda', '826': 'Regno Unito',
  '032': 'Argentina', '076': 'Brasile', '858': 'Uruguay', '036': 'Australia', '840': 'Stati Uniti',
  '203': 'Rep. Ceca', '348': 'Ungheria', '208': 'Danimarca', '620': 'Portogallo', '642': 'Romania',
  '756': 'Svizzera', '124': 'Canada', '554': 'Nuova Zelanda', '705': 'Slovenia', '191': 'Croazia',
  '300': 'Grecia', '100': 'Bulgaria', '703': 'Slovacchia', '440': 'Lituania', '428': 'Lettonia',
  '233': 'Estonia', '752': 'Svezia', '246': 'Finlandia', '442': 'Lussemburgo', '470': 'Malta',
};

export function countryName(code) {
  return COUNTRIES[code] || `Paese ${code}`;
}

// YYMMDD -> ISO "YYYY-MM-DD". DD=00 significa ultimo giorno del mese (regola GS1).
// Secolo: finestra mobile GS1 semplificata (anni 51..99 avanti = secolo precedente).
export function gs1DateToIso(yymmdd) {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = +yymmdd.slice(0, 2), mm = +yymmdd.slice(2, 4);
  let dd = +yymmdd.slice(4, 6);
  if (mm < 1 || mm > 12) return null;
  const nowYY = new Date().getFullYear() % 100;
  const diff = yy - nowYY;
  let century = Math.floor(new Date().getFullYear() / 100) * 100;
  if (diff >= 51) century -= 100;
  else if (diff <= -50) century += 100;
  const yyyy = century + yy;
  if (dd === 0) dd = new Date(Date.UTC(yyyy, mm, 0)).getUTCDate();
  const last = new Date(Date.UTC(yyyy, mm, 0)).getUTCDate();
  if (dd > last) return null;
  return `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

function findAi(str, pos) {
  for (const l of [2, 3, 4]) {
    const ai = str.slice(pos, pos + l);
    if (AI_TABLE[ai]) return ai;
  }
  return null;
}

function interpret(ai, raw, out) {
  const def = AI_TABLE[ai];
  let value = raw;
  if (def.date) value = gs1DateToIso(raw) || raw;
  else if (def.decimals !== undefined) value = Number(raw) / Math.pow(10, def.decimals);
  else if (def.country) value = countryName(raw);
  else if (def.countries) value = (raw.match(/\d{3}/g) || []).map(countryName).join(', ');
  else if (def.approval) value = `${countryName(raw.slice(0, 3))} ${raw.slice(3)}`;
  out.fields[def.key] = value;
  out.elements.push({ ai, label: def.label, raw, value });
}

function parseElementString(s, out) {
  let pos = 0;
  while (pos < s.length) {
    if (SEPARATORS.test(s[pos])) { pos++; continue; }
    const ai = findAi(s, pos);
    if (!ai) {
      out.errors.push(`AI non riconosciuto alla posizione ${pos}: "${s.slice(pos, pos + 6)}…"`);
      break;
    }
    pos += ai.length;
    const def = AI_TABLE[ai];
    let data;
    if (def.len) {
      data = s.slice(pos, pos + def.len);
      if (data.length < def.len) out.errors.push(`Dati incompleti per AI ${ai}`);
      pos += def.len;
    } else {
      let end = pos;
      while (end < s.length && !SEPARATORS.test(s[end]) && end - pos < def.max) end++;
      data = s.slice(pos, end);
      pos = end;
    }
    interpret(ai, data, out);
  }
}

function parseParentheses(s, out) {
  const re = /\((\d{2,4})\)([^(]*)/g;
  let m, found = false;
  while ((m = re.exec(s))) {
    found = true;
    const ai = m[1], data = m[2].trim();
    if (!AI_TABLE[ai]) { out.errors.push(`AI (${ai}) non gestito`); continue; }
    interpret(ai, data, out);
  }
  return found;
}

export function isValidGtin(digits) {
  if (!/^\d{8}$|^\d{12,14}$/.test(digits)) return false;
  const d = digits.split('').map(Number);
  const check = d.pop();
  let sum = 0;
  d.reverse().forEach((n, i) => { sum += n * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === check;
}

/**
 * Analizza il contenuto letto da un codice.
 * @returns {{type:string, raw:string, fields:object, elements:Array, errors:string[]}}
 *  type: 'gs1' | 'ean' | 'testo'
 */
export function parseBarcode(input) {
  const out = { type: 'testo', raw: input, fields: {}, elements: [], errors: [] };
  if (!input) return out;
  let s = String(input).trim();
  // Rimuove l'identificatore di simbologia AIM (es. ]C1 = GS1-128, ]d2 = GS1 DataMatrix, ]e0 = DataBar)
  s = s.replace(/^\][A-Za-z]\d/, '');
  // Alcuni scanner inviano FNC1 come testo
  s = s.replace(/<GS>|\{GS\}|\[GS\]/gi, GS);
  if (s.startsWith(GS)) s = s.slice(1);

  if (/^\(\d{2,4}\)/.test(s)) {
    out.type = 'gs1';
    parseParentheses(s, out);
  } else if (/^\d{8}$|^\d{12,14}$/.test(s)) {
    out.type = 'ean';
    const gtin = s.padStart(14, '0');
    out.fields.gtin = gtin;
    out.fields.gtinValido = isValidGtin(s);
    // Prefisso 2x: codice interno / a peso variabile (stampato dalla bilancia)
    if (s.length === 13 && s.startsWith('2')) out.fields.pesoVariabile = true;
    out.elements.push({ ai: '', label: 'EAN/GTIN', raw: s, value: gtin });
  } else if (/^\d{2}/.test(s) && findAi(s, 0) && s.length >= 10) {
    out.type = 'gs1';
    parseElementString(s, out);
    if (out.errors.length && !out.elements.length) out.type = 'testo';
  }
  return out;
}

export const _internal = { AI_TABLE };
