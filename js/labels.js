// Etichette / cartellini da banco stampabili (stampante etichette 62 mm o A4).
// Il codice a barre interno è un CODE128 con l'ID del lotto: riscansionandolo l'app ritrova il lotto.

import { getDb, getLotto } from './store.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dataIt = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

/** Nome ingrediente con allergeni in MAIUSCOLO GRASSETTO (Reg. UE 1169/2011 art. 21). */
function ingredienteHtml(nome, allergeni) {
  let html = esc(nome);
  if (allergeni?.length) html = `<b>${html.toUpperCase()}</b>`;
  return html;
}

/** Lista ingredienti, espandendo i semilavorati prodotti in negozio (es. ragù dentro le lasagne). */
export function ingredientiHtml(lotto, profondita = 0) {
  if (!lotto?.ingredientiEtichetta || profondita > 3) return '';
  return lotto.ingredientiEtichetta.map((ing) => {
    const comp = (lotto.componenti || []).find((c) => c.ingrediente === ing.nome);
    const sub = comp ? getLotto(comp.lottoId) : null;
    const allergeniIng = new Set([...(ing.allergeni || []), ...(sub?.tipo === 'ingresso' ? sub.allergeni || [] : [])]);
    let html = ingredienteHtml(ing.nome, [...allergeniIng]);
    if (sub?.tipo === 'produzione') html += ` (${ingredientiHtml(sub, profondita + 1)})`;
    return html;
  }).join(', ');
}

export function origineHtml(o) {
  if (!o) return '';
  const r = [];
  if (o.nato) r.push(`Nato in: ${esc(o.nato)}`);
  if (o.allevato) r.push(`Allevato in: ${esc(o.allevato)}`);
  if (o.macellato) r.push(`Macellato in: ${esc(o.macellato)}`);
  if (o.sezionato) r.push(`Sezionato in: ${esc(o.sezionato)}`);
  if (o.rifOrigine) r.push(`Cod. rif.: ${esc(o.rifOrigine)}`);
  return r.join(' · ');
}

export function etichettaHtml(lotto) {
  const db = getDb();
  const prod = lotto.tipo === 'produzione';
  return `
  <div class="label">
    <div class="label-shop">${esc(db.impostazioni.negozio || 'Reparto gastronomia')}</div>
    <div class="label-name">${esc(lotto.nome)}</div>
    ${prod ? `<div class="label-ingr"><b>Ingredienti:</b> ${ingredientiHtml(lotto)}.</div>` : ''}
    ${lotto.allergeni?.length ? `<div class="label-allerg"><b>Contiene:</b> ${lotto.allergeni.map(esc).join(', ')}</div>` : ''}
    ${lotto.origine ? `<div class="label-orig"><b>Origine carne:</b> ${origineHtml(lotto.origine)}</div>` : ''}
    <div class="label-dates">
      ${prod ? `<span>Prodotto il <b>${dataIt(lotto.dataProduzione)}</b></span>` : `<span>Ricevuto il <b>${dataIt(lotto.dataArrivo)}</b></span>`}
      <span>Da consumarsi entro <b>${dataIt(lotto.scadenza)}</b></span>
    </div>
    ${lotto.conservazione ? `<div class="label-cons">${esc(lotto.conservazione)}</div>` : ''}
    ${lotto.quantita ? `<div class="label-qty">${esc(lotto.quantita)} ${esc(lotto.unita || '')}</div>` : ''}
    <svg class="label-barcode" data-code="${esc(lotto.id)}"></svg>
    <div class="label-lot">Lotto ${esc(lotto.id)}${lotto.codiceLotto ? ` · forn. ${esc(lotto.codiceLotto)}` : ''}</div>
  </div>`;
}

export function renderBarcodes(root = document) {
  if (!window.JsBarcode) return;
  root.querySelectorAll('svg[data-code]').forEach((svg) => {
    try {
      window.JsBarcode(svg, svg.dataset.code, {
        format: 'CODE128', height: 40, width: 1.6, margin: 0, displayValue: false,
      });
    } catch (e) { console.warn('Barcode non generato', e); }
  });
  root.querySelectorAll('svg[data-gs1]').forEach((svg) => {
    try {
      // \xCF = FNC1 per JsBarcode; ean128 aggiunge l'FNC1 iniziale (GS1-128)
      window.JsBarcode(svg, svg.dataset.gs1.replaceAll('|', '\xCF'), {
        format: 'CODE128', ean128: true, height: 60, width: 1.4, margin: 6,
        text: svg.dataset.text || undefined, fontSize: 12,
      });
    } catch (e) { console.warn('Barcode GS1 non generato', e); }
  });
}

export function stampa(html, copie = 1) {
  const area = document.getElementById('print-area');
  area.innerHTML = Array.from({ length: Math.max(1, copie) }, () => html).join('');
  renderBarcodes(area);
  setTimeout(() => window.print(), 50);
}
