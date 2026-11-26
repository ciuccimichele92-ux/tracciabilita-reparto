// Riconoscimento del prodotto dal GTIN/EAN quando non è ancora nel catalogo locale:
// 1) codici di prova dell'app, 2) Open Food Facts (database pubblico e gratuito, a cui
// si invia solo il codice a barre). Il risultato viene salvato nel catalogo locale
// al primo ricevimento, quindi la volta dopo il prodotto è riconosciuto anche offline.

import { gtinBase } from './store.js';
import { codiciProva } from './demo.js';

const ALLERGENI_OFF = {
  'en:gluten': 'Glutine', 'en:crustaceans': 'Crostacei', 'en:eggs': 'Uova', 'en:fish': 'Pesce',
  'en:peanuts': 'Arachidi', 'en:soybeans': 'Soia', 'en:milk': 'Latte', 'en:nuts': 'Frutta a guscio',
  'en:celery': 'Sedano', 'en:mustard': 'Senape', 'en:sesame-seeds': 'Sesamo',
  'en:sulphur-dioxide-and-sulphites': 'Solfiti', 'en:lupin': 'Lupini', 'en:molluscs': 'Molluschi',
};

function categoriaDa(tags = []) {
  const t = tags.join(' ');
  if (/frozen/.test(t)) return 'surgelato';
  if (/beef/.test(t)) return 'bovino';
  if (/pork|ham|sausage/.test(t)) return 'suino';
  if (/poultr|chicken|turkey/.test(t)) return 'avicolo';
  if (/dair|milk|cheese|yogurt|butter|cream/.test(t)) return 'latticini';
  if (/fruit|vegetable/.test(t)) return 'ortofrutta';
  if (/meat/.test(t)) return 'altro';
  return 'secco';
}

// Cifra di controllo GS1 per 12 cifre
function conCheck(d12) {
  const sum = d12.split('').reverse().reduce((s, n, i) => s + Number(n) * (i % 2 === 0 ? 3 : 1), 0);
  return d12 + ((10 - (sum % 10)) % 10);
}

/** EAN-13 della confezione corrispondente a un GTIN (anche GTIN-14 del cartone). */
export function eanConfezione(gtin) {
  const base = gtinBase(gtin);
  return base ? conCheck(base) : '';
}

const cache = new Map();

/** @returns {Promise<{nome, fornitore, categoria, allergeni, fonte}|null>} */
export async function cercaProdotto(gtin) {
  const base = gtinBase(gtin);
  if (!base) return null;
  const prova = codiciProva().find((c) => gtinBase(c.prodotto.gtin) === base);
  if (prova) return { ...prova.prodotto, fonte: 'codici di prova' };
  if (cache.has(base)) return cache.get(base);

  const ean = eanConfezione(gtin);
  const fields = 'product_name,product_name_it,generic_name_it,brands,allergens_tags,categories_tags,quantity';
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${ean}.json?fields=${fields}`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) { cache.set(base, null); return null; }
    const j = await res.json();
    const p = j.product;
    if (j.status !== 1 || !p) { cache.set(base, null); return null; }
    const nome = [p.product_name_it || p.product_name || p.generic_name_it, p.quantity].filter(Boolean).join(' ');
    const out = nome ? {
      nome,
      fornitore: (p.brands || '').split(',')[0].trim(),
      categoria: categoriaDa(p.categories_tags),
      allergeni: [...new Set((p.allergens_tags || []).map((a) => ALLERGENI_OFF[a]).filter(Boolean))],
      fonte: 'Open Food Facts',
    } : null;
    cache.set(base, out);
    return out;
  } catch (e) {
    return null; // offline o timeout: si compila a mano
  }
}
