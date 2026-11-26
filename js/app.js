import { parseBarcode } from './gs1.js';
import * as S from './store.js';
import { scanBarcode, preloadScanner, listenKeyboardWedge } from './scanner.js';
import { etichettaHtml, renderBarcodes, stampa, origineHtml } from './labels.js';
import { flush, testWebhook, startAutoSync, onSyncStatus, statoSync } from './sync.js';
import { installaRicetteBase, installaCatalogoProva, creaGiornataEsempio, codiciProva } from './demo.js';
import { cercaProdotto } from './prodotti.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dataIt = (iso) => (iso ? iso.split('-').reverse().join('/') : '—');
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const view = $('#view');

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function go(hash) {
  if (location.hash === hash) render(); else location.hash = hash;
}

// ---------- Badge di scadenza / stato ----------
function badgeScadenza(l) {
  if (l.stato === 'esaurito') return '<span class="badge neutral">esaurito</span>';
  if (l.stato === 'scartato' || l.stato === 'respinto') return `<span class="badge bad">${esc(l.stato)}</span>`;
  if (l.stato === 'bloccato') return '<span class="badge bad">bloccato</span>';
  const g = S.giorniAllaScadenza(l.scadenza);
  if (g === null) return '<span class="badge neutral">senza scadenza</span>';
  if (g < 0) return '<span class="badge bad">scaduto</span>';
  if (g === 0) return '<span class="badge warn">scade oggi</span>';
  if (g <= 2) return `<span class="badge warn">scade tra ${g} gg</span>`;
  return `<span class="badge ok">${dataIt(l.scadenza)}</span>`;
}
const isScaduto = (l) => { const g = S.giorniAllaScadenza(l.scadenza); return g !== null && g < 0; };

function chipsAllergeni(selezionati = [], name = 'allergeni') {
  return `<div class="chips" data-chips="${name}">${S.ALLERGENI.map((a) =>
    `<button type="button" class="chip ${selezionati.includes(a) ? 'on' : ''}" data-val="${esc(a)}">${esc(a)}</button>`).join('')}</div>`;
}
function bindChips(root) {
  $$('[data-chips] .chip', root).forEach((c) => { c.onclick = () => c.classList.toggle('on'); });
}
const leggiChips = (el) => $$('.chip.on', el).map((c) => c.dataset.val);

// =====================================================================
// RICEVIMENTO MERCE
// =====================================================================
let bozzaRicevimento = null;

function bozzaDaScan(res) {
  const p = parseBarcode(res.rawValue);
  const f = p.fields;
  const prodotto = S.getProdotto(f.gtin);
  const b = {
    raw: res.rawValue, parsed: p,
    gtin: f.gtin || '', sscc: f.sscc || '',
    nome: prodotto?.nome || '', fornitore: prodotto?.fornitore || '',
    categoria: prodotto?.categoria || (f.rifOrigine || f.paeseLavorazione ? 'bovino' : 'altro'),
    allergeni: prodotto?.allergeni || [],
    codiceLotto: f.lotto || '',
    scadenza: f.scadenza || f.tmc || '',
    pesoKg: f.pesoNettoKg ?? '',
    origine: {
      nato: f.paeseOrigine || f.paeseFiliera || '',
      allevato: f.paesePrimaLavorazione || f.paeseFiliera || '',
      macellato: [f.paeseLavorazione || f.paeseFiliera, f.stabilimento0?.split(' ').slice(1).join(' ')].filter(Boolean).join(' '),
      sezionato: [f.paeseSezionamento || f.paeseFiliera, f.stabilimento1?.split(' ').slice(1).join(' ')].filter(Boolean).join(' '),
      rifOrigine: f.rifOrigine || '',
    },
    prodottoNoto: !!prodotto,
  };
  if (p.type === 'testo') b.codiceLotto = res.rawValue; // es. etichetta scritta a mano / codice interno fornitore
  // Codice senza lotto (EAN della confezione): se oggi è già arrivato un collo dello stesso
  // prodotto, ripropone il suo lotto e la scadenza (di solito lo stesso camion ha lo stesso lotto).
  if (!b.codiceLotto && b.gtin) {
    const oggi = S.oggiIso();
    const ultimo = S.getDb().lotti.filter((l) => l.tipo === 'ingresso' && l.dataArrivo === oggi
      && S.gtinBase(l.gtin) === S.gtinBase(b.gtin)).pop();
    if (ultimo) {
      Object.assign(b, { codiceLotto: ultimo.codiceLotto, scadenza: b.scadenza || ultimo.scadenza, ddt: ultimo.ddt, ripresoDa: ultimo });
    }
  }
  return b;
}

/** Compila nome, fornitore, categoria e allergeni cercando il prodotto (codici di prova / Open Food Facts). */
async function riconosciProdotto(b, form) {
  if (b.nome || !b.gtin) return;
  const stato = $('#prod-stato');
  stato.innerHTML = '<span class="muted">🔎 Cerco il prodotto dal codice a barre…</span>';
  const p = await cercaProdotto(b.gtin);
  if (bozzaRicevimento !== b || !document.body.contains(form)) return; // l'utente è andato altrove
  if (!p) {
    stato.innerHTML = '<span class="muted">Prodotto non trovato: scrivi il nome una volta, dalla prossima scansione lo riconosce da solo.</span>';
    return;
  }
  if (!form.nome.value) form.nome.value = b.nome = p.nome;
  if (!form.fornitore.value && p.fornitore) form.fornitore.value = b.fornitore = p.fornitore;
  if (form.categoria.value === 'altro' && p.categoria) { form.categoria.value = b.categoria = p.categoria; form.categoria.onchange?.(); }
  const chips = $$('[data-chips] .chip', form);
  if (!chips.some((c) => c.classList.contains('on'))) {
    chips.forEach((c) => c.classList.toggle('on', p.allergeni.includes(c.dataset.val)));
    b.allergeni = p.allergeni;
  }
  stato.innerHTML = `<span class="badge ok">✓ ${esc(p.fonte)}</span> <span class="muted">controlla e salva</span>`;
}

async function avviaScanRicevimento() {
  const res = await scanBarcode({ titolo: 'Scansiona l’etichetta del collo' });
  if (!res) return;
  bozzaRicevimento = bozzaDaScan(res);
  render();
}

function renderRicevi() {
  if (!bozzaRicevimento) {
    const oggi = S.oggiIso();
    const recenti = S.getDb().lotti.filter((l) => l.tipo === 'ingresso' && l.dataArrivo === oggi).reverse();
    view.innerHTML = `
      <h1>Ricevimento merce</h1>
      <button class="btn btn-scan" id="scan">📷 Scansiona collo</button>
      <div class="row" style="margin-top:.6rem">
        <button class="btn btn-ghost" id="manuale">✍️ Inserimento manuale</button>
      </div>
      <p class="muted" style="font-size:.85rem">Leggi il codice GS1-128 sull’etichetta del cartone: lotto, scadenza, peso e (per la carne) origine vengono compilati da soli.</p>
      <h2>Arrivati oggi (${recenti.length})</h2>
      <div class="card">${recenti.length ? `<ul class="list">${recenti.map(rigaLotto).join('')}</ul>` : '<div class="empty">Nessun arrivo registrato oggi</div>'}</div>`;
    $('#scan').onclick = avviaScanRicevimento;
    $('#manuale').onclick = () => { bozzaRicevimento = bozzaDaScan({ rawValue: '' }); bozzaRicevimento.codiceLotto = ''; render(); };
    return;
  }

  const b = bozzaRicevimento;
  const cat = S.CATEGORIE[b.categoria] || S.CATEGORIE.altro;
  const duplicati = b.codiceLotto ? S.trovaLotti(b.codiceLotto, b.parsed) : [];
  view.innerHTML = `
    <h1>Nuovo arrivo</h1>
    ${b.raw ? `<div class="card"><div class="muted" style="font-size:.8rem">Codice letto (${esc(b.parsed.type.toUpperCase())})</div>
      <dl class="kv" style="margin-top:.4rem">${b.parsed.elements.map((e) => `<dt>${esc(e.label)}</dt><dd>${esc(e.value)}</dd>`).join('') || `<dt>Testo</dt><dd>${esc(b.raw)}</dd>`}</dl>
      ${b.parsed.errors.length ? `<div class="alert warn">${b.parsed.errors.map(esc).join('<br>')}</div>` : ''}
    </div>` : ''}
    ${duplicati.length ? `<div class="alert warn">Attenzione: questo lotto risulta già registrato (${duplicati.map((d) => esc(d.id)).join(', ')}). Salva solo se è un collo in più.</div>` : ''}
    <form id="f" class="card" autocomplete="off">
      <label>Prodotto *<input name="nome" required value="${esc(b.nome)}" placeholder="es. Carne bovina – fesa" list="prodotti-noti"></label>
      <div id="prod-stato" style="font-size:.82rem;margin:-.4rem 0 .7rem"></div>
      ${b.ripresoDa ? `<div class="alert warn" style="font-size:.85rem">Il codice non contiene il lotto: ho ripreso lotto e scadenza dall’ultimo collo di questo prodotto arrivato oggi. Verifica che sulla confezione sia lo stesso.</div>` : ''}
      ${b.gtin && !b.codiceLotto ? `<div class="alert warn" style="font-size:.85rem">Questo codice a barre identifica solo il prodotto: lotto e scadenza sono stampati sulla confezione. Se c’è, scansiona l’etichetta del cartone.</div>` : ''}
      <datalist id="prodotti-noti">${Object.values(S.getDb().prodotti).map((p) => `<option value="${esc(p.nome)}">`).join('')}</datalist>
      <div class="grid2">
        <label>Fornitore<input name="fornitore" value="${esc(b.fornitore)}"></label>
        <label>Categoria<select name="categoria">${Object.entries(S.CATEGORIE).map(([k, c]) => `<option value="${k}" ${k === b.categoria ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}</select></label>
        <label>Lotto fornitore *<input name="codiceLotto" required value="${esc(b.codiceLotto)}"></label>
        <label>Scadenza / TMC<input type="date" name="scadenza" value="${esc(b.scadenza)}"></label>
        <label>Peso netto (kg)<input name="pesoKg" inputmode="decimal" value="${esc(b.pesoKg)}"></label>
        <label>N° DDT<input name="ddt" value="${esc(b.ddt || '')}"></label>
        <label>Data arrivo<input type="date" name="dataArrivo" value="${esc(b.dataArrivo || S.oggiIso())}"></label>
        <label>Temperatura al ricevimento (°C)${cat.tMax !== null ? ` <small>max ${cat.tMax}°</small>` : ''}<input name="temperatura" inputmode="decimal" value="${esc(b.temperatura ?? '')}"></label>
      </div>
      <div id="temp-alert"></div>
      <div class="muted" style="font-size:.85rem">Allergeni del prodotto</div>
      ${chipsAllergeni(b.allergeni)}
      <fieldset id="origine" style="border:1px solid var(--line);border-radius:12px;padding:.7rem;margin:0 0 .8rem" ${cat.origine || cat.origineBovina ? '' : 'hidden'}>
        <legend class="muted" style="font-size:.85rem;padding:0 .3rem">Origine carne (Reg. CE 1760/2000 – UE 1337/2013)</legend>
        <div class="grid2">
          <label>Nato in<input name="o_nato" value="${esc(b.origine.nato)}"></label>
          <label>Allevato in<input name="o_allevato" value="${esc(b.origine.allevato)}"></label>
          <label>Macellato in (+ bollo CE)<input name="o_macellato" value="${esc(b.origine.macellato)}"></label>
          <label>Sezionato in (+ bollo CE)<input name="o_sezionato" value="${esc(b.origine.sezionato)}"></label>
        </div>
        <label>Codice di riferimento / n° animale<input name="o_rif" value="${esc(b.origine.rifOrigine)}"></label>
      </fieldset>
      <label class="check"><input type="checkbox" name="integro" checked> Imballo integro ed etichetta leggibile</label>
      <label class="check"><input type="checkbox" name="conforme" checked> Merce conforme (accettata)</label>
      <label>Note<textarea name="note" placeholder="es. non conformità, azioni correttive">${esc(b.note || '')}</textarea></label>
      <div class="row">
        <button type="button" class="btn btn-ghost" id="annulla">Annulla</button>
        <button class="btn">💾 Salva arrivo</button>
      </div>
      <button type="button" class="btn btn-ghost btn-block" id="salva-scan" style="margin-top:.6rem">Salva e scansiona il prossimo</button>
    </form>`;
  const form = $('#f');
  bindChips(form);

  const checkTemp = () => {
    const c = S.CATEGORIE[form.categoria.value];
    $('#origine').hidden = !(c.origine || c.origineBovina);
    const t = parseFloat(String(form.temperatura.value).replace(',', '.'));
    const el = $('#temp-alert');
    if (c.tMax !== null && !Number.isNaN(t) && t > c.tMax) {
      el.innerHTML = `<div class="alert bad">Temperatura ${t}°C oltre il limite di ${c.tMax}°C per “${esc(c.nome)}”: valuta il respingimento e annota l’azione correttiva.</div>`;
      form.conforme.checked = false;
    } else el.innerHTML = '';
  };
  form.categoria.onchange = checkTemp;
  form.temperatura.oninput = checkTemp;
  form.nome.onchange = () => {
    const p = Object.values(S.getDb().prodotti).find((x) => x.nome === form.nome.value);
    if (p && !form.fornitore.value) form.fornitore.value = p.fornitore || '';
  };
  checkTemp();
  riconosciProdotto(b, form);

  $('#annulla').onclick = () => { bozzaRicevimento = null; render(); };
  const salva = (poiScan) => {
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    const conforme = form.conforme.checked;
    const lotto = S.registraRicevimento({
      gtin: b.gtin, sscc: b.sscc, codiceBarre: b.raw,
      nome: fd.get('nome').trim(), fornitore: fd.get('fornitore').trim(), categoria: fd.get('categoria'),
      codiceLotto: fd.get('codiceLotto').trim(), scadenza: fd.get('scadenza'),
      pesoKg: fd.get('pesoKg') ? parseFloat(String(fd.get('pesoKg')).replace(',', '.')) : '',
      ddt: fd.get('ddt').trim(), dataArrivo: fd.get('dataArrivo'),
      temperatura: fd.get('temperatura') ? parseFloat(String(fd.get('temperatura')).replace(',', '.')) : '',
      integro: form.integro.checked, conforme,
      allergeni: leggiChips($('[data-chips]', form)),
      origine: $('#origine').hidden ? null : {
        nato: fd.get('o_nato').trim(), allevato: fd.get('o_allevato').trim(),
        macellato: fd.get('o_macellato').trim(), sezionato: fd.get('o_sezionato').trim(), rifOrigine: fd.get('o_rif').trim(),
      },
      note: fd.get('note').trim(),
      stato: conforme ? 'aperto' : 'respinto',
    });
    // Il DDT e la data si mantengono per i colli successivi dello stesso camion
    const stessoCamion = { ddt: lotto.ddt, dataArrivo: lotto.dataArrivo };
    bozzaRicevimento = null;
    toast(conforme ? `✅ Registrato: ${lotto.nome} – lotto ${lotto.codiceLotto}` : `⛔ Registrato come RESPINTO: ${lotto.nome}`);
    flush();
    if (poiScan) {
      scanBarcode({ titolo: 'Prossimo collo' }).then((res) => {
        if (res) { bozzaRicevimento = { ...bozzaDaScan(res), ...stessoCamion }; }
        render();
      });
    } else render();
  };
  form.onsubmit = (e) => { e.preventDefault(); salva(false); };
  $('#salva-scan').onclick = () => salva(true);
}

// =====================================================================
// LOTTI (magazzino)
// =====================================================================
let filtroLotti = 'aperti', testoLotti = '';

function rigaLotto(l) {
  const sub = l.tipo === 'produzione'
    ? `${esc(l.id)} · prodotto ${dataIt(l.dataProduzione)} · ${esc(l.quantita)} ${esc(l.unita || '')}`
    : `Lotto ${esc(l.codiceLotto)} · ${esc(l.fornitore || '')}${l.pesoKg ? ` · ${esc(l.pesoKg)} kg` : ''}`;
  return `<li><a href="#lotto/${encodeURIComponent(l.id)}">
    <span style="font-size:1.3rem">${l.tipo === 'produzione' ? '🍳' : '📦'}</span>
    <span class="grow"><div class="title">${esc(l.nome)}</div><div class="sub">${sub}</div>
    <div style="margin-top:.3rem">${badgeScadenza(l)}</div></span><span class="muted">›</span></a></li>`;
}

function renderLotti() {
  const db = S.getDb();
  let lotti = filtroLotti === 'aperti' ? S.lottiAperti()
    : filtroLotti === 'scadenza' ? S.lottiAperti().filter((l) => { const g = S.giorniAllaScadenza(l.scadenza); return g !== null && g <= 2; })
    : [...db.lotti].reverse();
  if (testoLotti) {
    const q = norm(testoLotti);
    lotti = lotti.filter((l) => norm(`${l.nome} ${l.id} ${l.codiceLotto} ${l.fornitore}`).includes(q));
  }
  const scaduti = S.lottiAperti().filter(isScaduto).length;
  view.innerHTML = `
    <h1>Lotti in reparto</h1>
    ${scaduti ? `<div class="alert bad">⚠️ ${scaduti} lotto/i aperti risultano scaduti: toglili dalla produzione.</div>` : ''}
    <div class="row" style="margin-bottom:.6rem">
      <input id="q" placeholder="Cerca prodotto o lotto…" value="${esc(testoLotti)}">
      <button class="btn" id="scan" style="flex:0 0 auto" aria-label="Scansiona">📷</button>
    </div>
    <div class="chips">
      ${[['aperti', 'Aperti (FEFO)'], ['scadenza', 'In scadenza'], ['tutti', 'Tutti']].map(([k, t]) =>
        `<button class="chip ${filtroLotti === k ? 'on' : ''}" data-f="${k}">${t}</button>`).join('')}
    </div>
    <div class="card">${lotti.length ? `<ul class="list">${lotti.map(rigaLotto).join('')}</ul>`
      : `<div class="empty">Nessun lotto.<br><br>${db.lotti.length ? '' : '<a href="#impostazioni">Carica i dati di esempio</a> oppure registra un arrivo.'}</div>`}</div>`;
  $$('[data-f]').forEach((c) => { c.onclick = () => { filtroLotti = c.dataset.f; render(); }; });
  const q = $('#q');
  q.oninput = () => { testoLotti = q.value; const pos = q.selectionStart; render(); const nq = $('#q'); nq.focus(); nq.setSelectionRange(pos, pos); };
  $('#scan').onclick = async () => { const r = await scanBarcode({ titolo: 'Scansiona un lotto' }); if (r) apriDaCodice(r.rawValue); };
}

function apriDaCodice(raw) {
  const p = parseBarcode(raw);
  const trovati = S.trovaLotti(raw, p);
  if (trovati.length === 1) go(`#lotto/${encodeURIComponent(trovati[0].id)}`);
  else { cercaTesto = raw; go('#cerca'); }
}

// =====================================================================
// DETTAGLIO LOTTO
// =====================================================================
function alberoMonteHtml(nodo) {
  if (!nodo?.figli?.length) return '';
  return `<ul class="tree">${nodo.figli.map((f) => `<li>
    <span class="muted" style="font-size:.8rem">${esc(f.ingrediente)}${f.quantita ? ` · ${esc(f.quantita)}` : ''}</span><br>
    ${f.nodo ? `<a class="node" href="#lotto/${encodeURIComponent(f.nodo.lotto.id)}">${f.nodo.lotto.tipo === 'produzione' ? '🍳' : '📦'} ${esc(f.nodo.lotto.nome)} · <b>${esc(f.nodo.lotto.codiceLotto || f.nodo.lotto.id)}</b></a>${alberoMonteHtml(f.nodo)}` : '<span class="badge bad">lotto mancante</span>'}
  </li>`).join('')}</ul>`;
}
function alberoValleHtml(nodo) {
  if (!nodo?.figli?.length) return '';
  return `<ul class="tree">${nodo.figli.filter((f) => f.nodo).map((f) => `<li>
    <a class="node ${f.nodo.lotto.stato === 'aperto' ? 'hit' : ''}" href="#lotto/${encodeURIComponent(f.nodo.lotto.id)}">🍳 ${esc(f.nodo.lotto.nome)} · <b>${esc(f.nodo.lotto.id)}</b> · ${dataIt(f.nodo.lotto.dataProduzione)}</a> ${badgeScadenza(f.nodo.lotto)}
    ${alberoValleHtml(f.nodo)}</li>`).join('')}</ul>`;
}

function renderLotto(id) {
  const l = S.getLotto(id);
  if (!l) { view.innerHTML = '<div class="empty">Lotto non trovato. <a href="#lotti">Torna ai lotti</a></div>'; return; }
  const monte = S.alberoMonte(id), valle = S.alberoValle(id);
  const kv = (k, v) => (v || v === 0 ? `<dt>${k}</dt><dd>${v}</dd>` : '');
  view.innerHTML = `
    <a href="#lotti" class="muted" style="text-decoration:none">← Lotti</a>
    <h1>${esc(l.nome)} ${badgeScadenza(l)}</h1>
    <div class="card"><dl class="kv">
      ${kv('ID interno', `<code>${esc(l.id)}</code>`)}
      ${kv('Tipo', l.tipo === 'produzione' ? 'Produzione interna' : 'Arrivo da fornitore')}
      ${kv('Lotto fornitore', esc(l.codiceLotto))}
      ${kv('Fornitore', esc(l.fornitore))}
      ${kv('GTIN', esc(l.gtin))}
      ${kv('Arrivato il', l.dataArrivo && dataIt(l.dataArrivo))}
      ${kv('DDT', esc(l.ddt))}
      ${kv('Temperatura', l.temperatura !== '' && l.temperatura !== undefined ? `${esc(l.temperatura)} °C` : '')}
      ${kv('Prodotto il', l.dataProduzione && dataIt(l.dataProduzione))}
      ${kv('Quantità', l.quantita ? `${esc(l.quantita)} ${esc(l.unita || '')}` : l.pesoKg ? `${esc(l.pesoKg)} kg` : '')}
      ${kv('Scadenza', dataIt(l.scadenza))}
      ${kv('Allergeni', (l.allergeni || []).map(esc).join(', ') || 'nessuno dichiarato')}
      ${kv('Origine', l.origine ? origineHtml(l.origine) : '')}
      ${kv('Operatore', esc(l.operatore))}
      ${kv('Stato', esc(l.stato) + (l.statoMotivo ? ` – ${esc(l.statoMotivo)}` : ''))}
      ${kv('Note', esc(l.note))}
    </dl></div>
    <div class="row">
      <button class="btn" id="stampa">🖨️ Stampa etichetta</button>
      ${l.stato === 'aperto' ? '<button class="btn btn-ghost" id="esaurito">Segna esaurito</button>' : '<button class="btn btn-ghost" id="riapri">Riapri</button>'}
    </div>
    ${l.stato === 'aperto' ? '<button class="btn btn-ghost btn-block" id="scarta" style="margin-top:.6rem">Scarta / butta</button>' : ''}

    ${l.tipo === 'produzione' ? `<h2>Composizione (a monte)</h2><div class="card">${alberoMonteHtml(monte) || '<span class="muted">—</span>'}</div>` : ''}
    <h2>Usato in (a valle)</h2>
    <div class="card">${alberoValleHtml(valle) || '<span class="muted">Non ancora usato in produzione.</span>'}</div>

    <h2>Anteprima etichetta</h2>
    <div class="label-preview">${etichettaHtml(l)}</div>`;
  renderBarcodes(view);
  $('#stampa').onclick = () => {
    const n = parseInt(prompt('Quante etichette?', l.tipo === 'produzione' && l.unita === 'teglie' ? String(l.quantita || 1) : '1'), 10);
    if (n > 0) stampa(etichettaHtml(l), Math.min(n, 50));
  };
  $('#esaurito')?.addEventListener('click', () => { S.cambiaStatoLotto(id, 'esaurito'); flush(); toast('Lotto esaurito'); render(); });
  $('#riapri')?.addEventListener('click', () => { S.cambiaStatoLotto(id, 'aperto', 'riaperto'); flush(); render(); });
  $('#scarta')?.addEventListener('click', () => {
    const m = prompt('Motivo dello scarto (es. scaduto, temperatura, contaminazione):');
    if (m !== null) { S.cambiaStatoLotto(id, 'scartato', m); flush(); toast('Lotto scartato'); render(); }
  });
}

// =====================================================================
// PRODUZIONE
// =====================================================================
let bozzaProd = null; // { ricettaId, scelte: { [ingrediente]: { lottoId, quantita } } }

function suggeriti(ingrediente, lotti) {
  const vuote = new Set(['alla', 'allo', 'alle', 'agli', 'della', 'dello', 'delle', 'degli', 'tipo', 'fresco', 'fresca', 'intero']);
  const parole = norm(ingrediente).split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !vuote.has(w));
  return lotti.filter((l) => {
    const n = norm(l.nome);
    return norm(l.nome) === norm(ingrediente) || parole.some((w) => n.includes(w));
  });
}

function renderProduci(ricettaId) {
  const db = S.getDb();
  if (!ricettaId) {
    view.innerHTML = `
      <h1>Nuova produzione</h1>
      <p class="muted">Scegli cosa stai preparando:</p>
      ${db.ricette.length ? db.ricette.map((r) => `
        <a class="card" href="#produci/${encodeURIComponent(r.id)}" style="display:block;text-decoration:none">
          <div style="font-weight:700;font-size:1.05rem">${esc(r.nome)}</div>
          <div class="muted" style="font-size:.85rem">${r.ingredienti.length} ingredienti · scadenza ${r.shelfLifeGiorni} gg · lotto ${esc(r.prefisso)}-AAMMGG-NN</div>
        </a>`).join('') : '<div class="empty">Nessuna ricetta. <a href="#ricette/nuova">Creane una</a></div>'}
      <h2>Prodotte oggi</h2>
      <div class="card">${(() => { const p = db.lotti.filter((l) => l.tipo === 'produzione' && l.dataProduzione === S.oggiIso()).reverse(); return p.length ? `<ul class="list">${p.map(rigaLotto).join('')}</ul>` : '<div class="empty">Nessuna produzione oggi</div>'; })()}</div>`;
    return;
  }
  const r = db.ricette.find((x) => x.id === ricettaId);
  if (!r) { go('#produci'); return; }
  if (!bozzaProd || bozzaProd.ricettaId !== r.id) bozzaProd = { ricettaId: r.id, scelte: {} };
  const aperti = S.lottiAperti();

  // Pre-selezione FEFO: per ogni ingrediente il lotto suggerito con scadenza più vicina (non scaduto)
  r.ingredienti.forEach((ing) => {
    if (bozzaProd.scelte[ing.nome] === undefined) {
      const s = suggeriti(ing.nome, aperti).find((l) => !isScaduto(l));
      bozzaProd.scelte[ing.nome] = { lottoId: s?.id || '', quantita: '' };
    }
  });

  const oggi = S.oggiIso();
  view.innerHTML = `
    <a href="#produci" class="muted" style="text-decoration:none">← Ricette</a>
    <h1>${esc(r.nome)}</h1>
    <p class="muted" style="font-size:.88rem">Per ogni ingrediente è proposto il lotto aperto che scade prima (FEFO). Puoi cambiarlo o scansionare il collo che stai usando davvero.</p>
    <form id="f">
      ${r.ingredienti.map((ing, i) => {
        const scelta = bozzaProd.scelte[ing.nome];
        const sugg = suggeriti(ing.nome, aperti);
        const altri = aperti.filter((l) => !sugg.includes(l));
        const opt = (l) => `<option value="${esc(l.id)}" ${scelta.lottoId === l.id ? 'selected' : ''} ${isScaduto(l) ? 'disabled' : ''}>${esc(l.nome)} · ${esc(l.codiceLotto || l.id)} · scad. ${dataIt(l.scadenza)}${isScaduto(l) ? ' (SCADUTO)' : ''}</option>`;
        const sel = S.getLotto(scelta.lottoId);
        return `<div class="ingr-row ${scelta.lottoId ? 'done' : ing.obbligatorio ? 'missing' : ''}" data-i="${i}">
          <div class="head"><b>${esc(ing.nome)}</b> <span>${(ing.allergeni || []).map((a) => `<span class="badge warn">${esc(a)}</span>`).join(' ')} ${ing.obbligatorio ? '' : '<span class="badge neutral">lotto facoltativo</span>'}</span></div>
          <div class="row">
            <select data-ing="${esc(ing.nome)}">
              <option value="">— ${ing.obbligatorio ? 'scegli il lotto' : 'nessun lotto'} —</option>
              ${sugg.length ? `<optgroup label="Suggeriti">${sugg.map(opt).join('')}</optgroup>` : ''}
              ${altri.length ? `<optgroup label="Altri lotti aperti">${altri.map(opt).join('')}</optgroup>` : ''}
            </select>
            <button type="button" class="btn btn-ghost" data-scan="${esc(ing.nome)}" style="flex:0 0 auto" aria-label="Scansiona">📷</button>
          </div>
          ${sel ? `<div class="muted" style="font-size:.8rem;margin-top:.35rem">${badgeScadenza(sel)} ${sel.origine ? 'Origine: ' + origineHtml(sel.origine) : ''}</div>` : ''}
          <input data-qta="${esc(ing.nome)}" placeholder="Quantità usata (facoltativa, es. 3 kg)" value="${esc(scelta.quantita)}" style="margin-top:.4rem">
        </div>`;
      }).join('')}
      <div class="card">
        <div class="grid2">
          <label>Quantità prodotta *<input name="quantita" inputmode="decimal" required value="${esc(bozzaProd.quantita || '')}"></label>
          <label>Unità<input name="unita" value="${esc(bozzaProd.unita || r.unita || 'kg')}"></label>
          <label>Data produzione<input type="date" name="dataProduzione" value="${esc(bozzaProd.dataProduzione || oggi)}"></label>
          <label>Da consumarsi entro<input type="date" name="scadenza" value="${esc(bozzaProd.scadenza || S.addGiorni(oggi, r.shelfLifeGiorni))}"></label>
        </div>
        <label>Note<input name="note" value="${esc(bozzaProd.note || '')}" placeholder="es. abbattuto a +3 °C in 90 min"></label>
        <div id="err"></div>
        <button class="btn btn-block">✅ Registra produzione e stampa etichette</button>
      </div>
    </form>`;

  const form = $('#f');
  const salvaBozza = () => {
    $$('select[data-ing]', form).forEach((s) => { bozzaProd.scelte[s.dataset.ing].lottoId = s.value; });
    $$('input[data-qta]', form).forEach((q) => { bozzaProd.scelte[q.dataset.qta].quantita = q.value; });
    ['quantita', 'unita', 'dataProduzione', 'scadenza', 'note'].forEach((k) => { bozzaProd[k] = form[k].value; });
  };
  form.dataProduzione.onchange = () => { form.scadenza.value = S.addGiorni(form.dataProduzione.value, r.shelfLifeGiorni); };
  $$('select[data-ing]', form).forEach((s) => { s.onchange = () => { salvaBozza(); render(); }; });
  $$('[data-scan]', form).forEach((b) => {
    b.onclick = async () => {
      salvaBozza();
      const res = await scanBarcode({ titolo: `Scansiona: ${b.dataset.scan}` });
      if (!res) return;
      assegnaScanAIngrediente(b.dataset.scan, res.rawValue);
    };
  });
  form.onsubmit = (e) => {
    e.preventDefault();
    salvaBozza();
    const mancanti = r.ingredienti.filter((i) => i.obbligatorio && !bozzaProd.scelte[i.nome].lottoId).map((i) => i.nome);
    const scaduti = r.ingredienti.map((i) => S.getLotto(bozzaProd.scelte[i.nome].lottoId)).filter((l) => l && isScaduto(l));
    if (scaduti.length) { $('#err').innerHTML = `<div class="alert bad">Lotti scaduti: ${scaduti.map((l) => esc(l.nome)).join(', ')}. Non si possono usare.</div>`; return; }
    if (mancanti.length) { $('#err').innerHTML = `<div class="alert warn">Manca il lotto per: <b>${mancanti.map(esc).join(', ')}</b>.</div>`; return; }
    if (!form.reportValidity()) return;
    const lotto = S.registraProduzione({
      ricetta: r,
      componenti: r.ingredienti.filter((i) => bozzaProd.scelte[i.nome].lottoId).map((i) => ({ ingrediente: i.nome, ...bozzaProd.scelte[i.nome] })),
      quantita: form.quantita.value, unita: form.unita.value,
      dataProduzione: form.dataProduzione.value, scadenza: form.scadenza.value, note: form.note.value,
    });
    bozzaProd = null;
    flush();
    toast(`✅ Prodotto lotto ${lotto.id}`);
    go(`#lotto/${encodeURIComponent(lotto.id)}`);
    const copie = lotto.unita === 'teglie' || lotto.unita === 'pz' ? parseInt(lotto.quantita, 10) || 1 : 1;
    if (confirm(`Stampare ${copie} etichett${copie === 1 ? 'a' : 'e'}?`)) stampa(etichettaHtml(lotto), Math.min(copie, 50));
  };
}

function assegnaScanAIngrediente(ingrediente, raw) {
  const parsed = parseBarcode(raw);
  const trovati = S.trovaLotti(raw, parsed);
  const aperti = trovati.filter((l) => l.stato === 'aperto');
  // FEFO: tra i lotti aperti e non scaduti, quello che scade prima
  const aperto = aperti.find((l) => !isScaduto(l)) || aperti[0] || trovati[0];
  if (!aperto) { toast('Lotto non trovato: registralo prima in “Ricevi”.', 3500); return; }
  if (aperto.stato !== 'aperto') { toast(`Il lotto è ${aperto.stato}: non utilizzabile.`, 3500); return; }
  if (isScaduto(aperto)) { toast(`⛔ ${aperto.nome} lotto ${aperto.codiceLotto || aperto.id} è SCADUTO.`, 4000); return; }
  bozzaProd.scelte[ingrediente].lottoId = aperto.id;
  // Confezione singola senza lotto nel codice: se ci sono più lotti aperti lo diciamo
  const solaConfezione = !parsed.fields.lotto && parsed.fields.gtin && aperti.length > 1;
  toast(solaConfezione
    ? `✓ ${ingrediente}: lotto ${aperto.codiceLotto} (scade prima). Ci sono ${aperti.length} lotti aperti: se sulla confezione c’è un altro lotto, cambialo.`
    : `✓ ${ingrediente}: ${aperto.nome} · ${aperto.codiceLotto || aperto.id}`, solaConfezione ? 5000 : 2600);
  render();
}

// =====================================================================
// RICERCA / RICHIAMO
// =====================================================================
let cercaTesto = '';

function discendentiAperti(nodo, acc = []) {
  (nodo?.figli || []).forEach((f) => { if (f.nodo) { acc.push(f.nodo.lotto); discendentiAperti(f.nodo, acc); } });
  return acc;
}

function renderCerca() {
  const q = cercaTesto.trim();
  let risultati = [];
  if (q) {
    const p = parseBarcode(q);
    risultati = S.trovaLotti(q, p);
    if (!risultati.length) {
      const nq = norm(q);
      risultati = S.getDb().lotti.filter((l) => norm(`${l.codiceLotto} ${l.id} ${l.nome} ${l.origine?.rifOrigine || ''}`).includes(nq));
    }
  }
  view.innerHTML = `
    <h1>Ricerca e richiamo</h1>
    <p class="muted" style="font-size:.88rem">Inserisci il lotto comunicato dal fornitore (o scansionalo): vedi subito in quali preparazioni è finito e se sono ancora in vendita.</p>
    <form id="f" class="row" style="margin-bottom:.8rem">
      <input name="q" placeholder="Lotto, codice animale, prodotto…" value="${esc(q)}">
      <button class="btn" style="flex:0 0 auto">Cerca</button>
      <button type="button" class="btn btn-ghost" id="scan" style="flex:0 0 auto" aria-label="Scansiona">📷</button>
    </form>
    ${q && !risultati.length ? '<div class="empty">Nessun lotto corrispondente.</div>' : ''}
    ${risultati.map((l) => {
      const valle = S.alberoValle(l.id);
      const coinvolti = discendentiAperti(valle);
      const daBloccare = [l, ...coinvolti].filter((x) => x.stato === 'aperto');
      return `<div class="card">
        <div class="row" style="justify-content:space-between"><a href="#lotto/${encodeURIComponent(l.id)}" style="font-weight:700;flex:0 1 auto">${esc(l.nome)}</a> ${badgeScadenza(l)}</div>
        <div class="muted" style="font-size:.85rem">${l.tipo === 'ingresso' ? `Lotto fornitore <b>${esc(l.codiceLotto)}</b> · ${esc(l.fornitore || '')} · arrivato ${dataIt(l.dataArrivo)} · DDT ${esc(l.ddt || '—')}` : `Produzione ${esc(l.id)} del ${dataIt(l.dataProduzione)}`}</div>
        <h2 style="margin-top:.9rem">Preparazioni che lo contengono: ${coinvolti.length}</h2>
        ${alberoValleHtml(valle) || '<span class="muted">Nessuna.</span>'}
        ${daBloccare.length ? `<div class="alert bad" style="margin-top:.8rem">${daBloccare.length} lotto/i ancora <b>aperti/in vendita</b> collegati.</div>
          <button class="btn btn-danger btn-block" data-blocca="${esc(l.id)}">⛔ Blocca tutto (richiamo)</button>` : ''}
        <div class="row" style="margin-top:.6rem">
          <button class="btn btn-ghost btn-small" data-csv="${esc(l.id)}">⬇️ Report CSV</button>
          <button class="btn btn-ghost btn-small" data-copy="${esc(l.id)}">📋 Copia testo</button>
        </div>
      </div>`;
    }).join('')}`;

  $('#f').onsubmit = (e) => { e.preventDefault(); cercaTesto = e.target.q.value; render(); };
  $('#scan').onclick = async () => { const r = await scanBarcode({ titolo: 'Scansiona il lotto da cercare' }); if (r) { cercaTesto = r.rawValue; render(); } };
  $$('[data-blocca]').forEach((b) => {
    b.onclick = () => {
      const l = S.getLotto(b.dataset.blocca);
      const tutti = [l, ...discendentiAperti(S.alberoValle(l.id))].filter((x) => x.stato === 'aperto');
      if (!confirm(`Bloccare ${tutti.length} lotti collegati a ${l.codiceLotto || l.id}? Andranno tolti dal banco.`)) return;
      tutti.forEach((x) => S.cambiaStatoLotto(x.id, 'bloccato', `Richiamo lotto ${l.codiceLotto || l.id}`));
      flush();
      toast(`⛔ Bloccati ${tutti.length} lotti`);
      render();
    };
  });
  $$('[data-csv]').forEach((b) => { b.onclick = () => scaricaReport(b.dataset.csv); });
  $$('[data-copy]').forEach((b) => {
    b.onclick = async () => {
      await navigator.clipboard.writeText(testoReport(b.dataset.copy)).then(() => toast('Copiato'), () => toast('Copia non riuscita'));
    };
  });
}

function righeReport(id) {
  const l = S.getLotto(id);
  const righe = [[l, 0]];
  const visita = (nodo, liv) => (nodo?.figli || []).forEach((f) => { if (f.nodo) { righe.push([f.nodo.lotto, liv]); visita(f.nodo, liv + 1); } });
  visita(S.alberoValle(id), 1);
  return righe;
}
function testoReport(id) {
  const l = S.getLotto(id);
  const neg = S.getDb().impostazioni.negozio;
  return [`RICHIAMO – ${neg}`, `Lotto origine: ${l.nome} – ${l.codiceLotto || l.id} (${l.fornitore || 'produzione interna'})`, '',
    ...righeReport(id).slice(1).map(([x, liv]) => `${'  '.repeat(liv - 1)}• ${x.nome} – lotto ${x.id} – prodotto ${dataIt(x.dataProduzione)} – ${x.quantita} ${x.unita || ''} – stato: ${x.stato}`),
  ].join('\n');
}
function scaricaReport(id) {
  const cols = ['livello', 'id', 'tipo', 'nome', 'lotto_fornitore', 'fornitore', 'data_arrivo', 'data_produzione', 'scadenza', 'quantita', 'unita', 'stato'];
  const csvCell = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  const rows = righeReport(id).map(([x, liv]) => [liv, x.id, x.tipo, x.nome, x.codiceLotto, x.fornitore, x.dataArrivo, x.dataProduzione, x.scadenza, x.quantita, x.unita, x.stato].map(csvCell).join(';'));
  const blob = new Blob(['﻿' + [cols.join(';'), ...rows].join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `richiamo-${id}-${S.oggiIso()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// =====================================================================
// RICETTE
// =====================================================================
function renderRicette(id) {
  const db = S.getDb();
  if (!id) {
    view.innerHTML = `
      <h1>Ricette</h1>
      <div class="card"><ul class="list">${db.ricette.map((r) => `<li><a href="#ricette/${encodeURIComponent(r.id)}">
        <span class="grow"><div class="title">${esc(r.nome)}</div><div class="sub">${r.ingredienti.map((i) => esc(i.nome)).join(', ')}</div></span><span>›</span></a></li>`).join('') || '<div class="empty">Nessuna ricetta</div>'}</ul></div>
      <a class="btn btn-block" href="#ricette/nuova">➕ Nuova ricetta</a>
      <p class="muted" style="font-size:.85rem">Un semilavorato (es. ragù, besciamella) è una ricetta come le altre: il suo lotto si usa poi come ingrediente.</p>`;
    return;
  }
  const r = id === 'nuova'
    ? { id: '', nome: '', prefisso: '', categoria: 'altro', shelfLifeGiorni: 3, unita: 'kg', conservazione: 'Conservare a 0/+4 °C.', ingredienti: [{ nome: '', allergeni: [], obbligatorio: true }] }
    : structuredClone(db.ricette.find((x) => x.id === id));
  if (!r) { go('#ricette'); return; }

  const disegna = () => {
    view.innerHTML = `
      <a href="#ricette" class="muted" style="text-decoration:none">← Ricette</a>
      <h1>${r.id ? 'Modifica ricetta' : 'Nuova ricetta'}</h1>
      <form id="f" class="card">
        <label>Nome *<input name="nome" required value="${esc(r.nome)}"></label>
        <div class="grid2">
          <label>Prefisso lotto (3 lettere) *<input name="prefisso" required maxlength="4" value="${esc(r.prefisso)}" style="text-transform:uppercase"></label>
          <label>Scadenza (giorni)<input name="shelfLifeGiorni" type="number" min="0" value="${esc(r.shelfLifeGiorni)}"></label>
          <label>Unità<input name="unita" value="${esc(r.unita)}"></label>
          <label>Categoria<select name="categoria">${Object.entries(S.CATEGORIE).map(([k, c]) => `<option value="${k}" ${k === r.categoria ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}</select></label>
        </div>
        <label>Conservazione / modalità d’uso (va in etichetta)<input name="conservazione" value="${esc(r.conservazione)}"></label>
        <h2>Ingredienti</h2>
        ${r.ingredienti.map((ing, i) => `<div class="ingr-row" data-i="${i}">
          <div class="row"><input data-k="nome" placeholder="Ingrediente" value="${esc(ing.nome)}" required><button type="button" class="btn btn-ghost btn-small" data-del="${i}" style="flex:0 0 auto">🗑️</button></div>
          ${chipsAllergeni(ing.allergeni || [], 'ing' + i)}
          <label class="check"><input type="checkbox" data-k="obbligatorio" ${ing.obbligatorio ? 'checked' : ''}> Lotto obbligatorio in produzione</label>
        </div>`).join('')}
        <button type="button" class="btn btn-ghost btn-block" id="add">➕ Aggiungi ingrediente</button>
        <div class="row" style="margin-top:1rem">
          ${r.id ? '<button type="button" class="btn btn-ghost" id="del">Elimina</button>' : ''}
          <button class="btn">💾 Salva ricetta</button>
        </div>
      </form>`;
    const form = $('#f');
    bindChips(form);
    const leggi = () => {
      ['nome', 'prefisso', 'unita', 'categoria', 'conservazione'].forEach((k) => { r[k] = form[k].value.trim(); });
      r.prefisso = r.prefisso.toUpperCase();
      r.shelfLifeGiorni = parseInt(form.shelfLifeGiorni.value, 10) || 0;
      r.ingredienti = $$('.ingr-row', form).map((row) => ({
        nome: $('[data-k="nome"]', row).value.trim(),
        allergeni: leggiChips($('[data-chips]', row)),
        obbligatorio: $('[data-k="obbligatorio"]', row).checked,
      }));
    };
    $('#add').onclick = () => { leggi(); r.ingredienti.push({ nome: '', allergeni: [], obbligatorio: true }); disegna(); };
    $$('[data-del]', form).forEach((b) => { b.onclick = () => { leggi(); r.ingredienti.splice(+b.dataset.del, 1); disegna(); }; });
    $('#del')?.addEventListener('click', () => { if (confirm(`Eliminare la ricetta “${r.nome}”? I lotti già prodotti restano.`)) { S.eliminaRicetta(r.id); go('#ricette'); } });
    form.onsubmit = (e) => {
      e.preventDefault();
      leggi();
      r.ingredienti = r.ingredienti.filter((i) => i.nome);
      if (!r.ingredienti.length) { toast('Aggiungi almeno un ingrediente'); return; }
      const salvata = S.salvaRicetta(r);
      flush();
      toast('Ricetta salvata');
      go(`#ricette/${encodeURIComponent(salvata.id)}`);
    };
  };
  disegna();
}

// =====================================================================
// IMPOSTAZIONI
// =====================================================================
function renderImpostazioni() {
  const db = S.getDb();
  const imp = db.impostazioni;
  const coda = S.eventiDaInviare().length;
  view.innerHTML = `
    <h1>Impostazioni</h1>
    <form id="f" class="card">
      <label>Nome punto vendita / reparto (va in etichetta)<input name="negozio" value="${esc(imp.negozio)}" placeholder="es. Gastronomia – Via Roma"></label>
      <label>Operatore su questo telefono<input name="operatore" value="${esc(imp.operatore)}" placeholder="es. Marco"></label>
      <h2>Sincronizzazione n8n</h2>
      <label>URL webhook n8n<input name="webhookUrl" type="url" value="${esc(imp.webhookUrl)}" placeholder="https://tuo-n8n/webhook/tracciabilita"></label>
      <label>Token (header X-Trac-Token, facoltativo)<input name="webhookToken" value="${esc(imp.webhookToken)}"></label>
      <div class="muted" style="font-size:.85rem;margin-bottom:.6rem">Eventi in coda: <b>${coda}</b>${statoSync.ultimoOk ? ` · ultimo invio ok ${new Date(statoSync.ultimoOk).toLocaleTimeString('it-IT')}` : ''}${statoSync.ultimoErrore ? ` · <span style="color:var(--bad)">errore: ${esc(statoSync.ultimoErrore)}</span>` : ''}</div>
      <div class="row">
        <button class="btn">💾 Salva</button>
        <button type="button" class="btn btn-ghost" id="test">Prova webhook</button>
        <button type="button" class="btn btn-ghost" id="sync">Invia ora</button>
      </div>
    </form>

    <h2>Prova l’app</h2>
    <div class="card">
      <a class="btn btn-ghost btn-block" href="#codici-prova">🏷️ Codici a barre di prova (da scansionare)</a>
      <div class="row" style="margin-top:.6rem">
        <button class="btn btn-ghost" id="catalogo">Carica catalogo prodotti di prova</button>
        <button class="btn btn-ghost" id="giornata">Crea giornata di esempio</button>
      </div>
      <p class="muted" style="font-size:.82rem">La giornata di esempio crea arrivi e la catena carne → macinato → ragù → lasagne: poi cerca il lotto <b>BOV-A123</b> in “Richiamo”.</p>
    </div>

    <h2>Dati</h2>
    <div class="card">
      <div class="muted" style="font-size:.85rem;margin-bottom:.6rem">${db.lotti.length} lotti · ${db.ricette.length} ricette · ${Object.keys(db.prodotti).length} prodotti. I dati stanno su questo telefono: fai un backup o attiva n8n.</div>
      <div class="row">
        <button class="btn btn-ghost" id="export">⬇️ Backup JSON</button>
        <label class="btn btn-ghost" style="margin:0;color:var(--ink)">⬆️ Ripristina<input type="file" id="import" accept="application/json" hidden></label>
      </div>
      <button class="btn btn-danger btn-block" id="reset" style="margin-top:.6rem">Cancella tutti i dati</button>
    </div>
    <p class="muted" style="font-size:.8rem;text-align:center">Prototipo – lettore: fotocamera (BarcodeDetector/ZXing) o scanner Bluetooth in modalità tastiera.</p>`;

  const form = $('#f');
  const valori = () => Object.fromEntries(['negozio', 'operatore', 'webhookUrl', 'webhookToken'].map((k) => [k, form[k].value.trim()]));
  form.onsubmit = (e) => { e.preventDefault(); S.salvaImpostazioni(valori()); toast('Impostazioni salvate'); flush(); render(); };
  $('#test').onclick = async () => {
    const v = valori();
    if (!v.webhookUrl) { toast('Inserisci prima l’URL del webhook'); return; }
    try { await testWebhook(v.webhookUrl, v.webhookToken); toast('✅ Webhook raggiunto'); }
    catch (e) { toast(`❌ ${e.message}. Controlla URL, workflow attivo e CORS.`, 5000); }
  };
  $('#sync').onclick = async () => { await flush(); render(); };
  $('#catalogo').onclick = () => { installaCatalogoProva(); toast('Catalogo di prova caricato'); render(); };
  $('#giornata').onclick = () => { creaGiornataEsempio(); flush(); toast('Giornata di esempio creata'); go('#lotti'); };
  $('#export').onclick = () => {
    const blob = new Blob([JSON.stringify(S.getDb(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tracciabilita-backup-${S.oggiIso()}.json`;
    a.click();
  };
  $('#import').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const dati = JSON.parse(await file.text());
      if (!Array.isArray(dati.lotti)) throw new Error('formato non valido');
      if (confirm(`Sostituire i dati attuali con il backup (${dati.lotti.length} lotti)?`)) { S.replaceDb(dati); toast('Backup ripristinato'); render(); }
    } catch (err) { toast('File non valido: ' + err.message); }
  };
  $('#reset').onclick = () => {
    if (confirm('Cancellare TUTTI i dati da questo telefono? Non si può annullare (gli eventi già inviati a n8n restano lì).')) {
      S.resetDb(); installaRicetteBase(); toast('Dati cancellati'); render();
    }
  };
}

function renderCodiciProva() {
  view.innerHTML = `
    <a href="#impostazioni" class="muted" style="text-decoration:none">← Impostazioni</a>
    <h1>Codici di prova</h1>
    <p class="muted" style="font-size:.88rem">Apri questa pagina sul PC e scansiona i codici col telefono da “Ricevi”. Sono GS1-128 come quelli sui cartoni dei fornitori (dati inventati). Per riconoscere il nome prodotto, prima carica il catalogo di prova dalle impostazioni.</p>
    ${codiciProva().map((c) => `<div class="sample">
      <div class="t">${esc(c.nome)}</div>
      ${c.gs1 ? `<svg data-gs1="${esc(c.gs1)}" data-text="${esc(c.testo)}"></svg>` : `<svg data-ean="${esc(c.ean)}"></svg>`}
    </div>`).join('')}`;
  renderBarcodes(view);
  $$('svg[data-ean]', view).forEach((svg) => {
    try { window.JsBarcode?.(svg, svg.dataset.ean, { format: 'EAN13', height: 60 }); } catch (e) { console.warn(e); }
  });
}

// =====================================================================
// ROUTER
// =====================================================================
function render() {
  const [route, param] = (location.hash.slice(1) || 'lotti').split('/').map(decodeURIComponent);
  const tab = { lotto: 'lotti', 'codici-prova': 'impostazioni' }[route] || route;
  $$('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  switch (route) {
    case 'ricevi': renderRicevi(); break;
    case 'lotto': renderLotto(param); break;
    case 'produci': renderProduci(param); break;
    case 'cerca': renderCerca(); break;
    case 'ricette': renderRicette(param); break;
    case 'impostazioni': renderImpostazioni(); break;
    case 'codici-prova': renderCodiciProva(); break;
    default: renderLotti();
  }
}

function aggiornaBadgeSync() {
  const { webhookUrl } = S.getDb().impostazioni;
  const n = S.eventiDaInviare().length;
  const el = $('#sync-badge');
  if (!webhookUrl) el.textContent = 'solo locale';
  else if (statoSync.ultimoErrore) el.textContent = `⚠️ ${n} in coda`;
  else el.textContent = n ? `⏳ ${n} in coda` : '☁️ sincronizzato';
}

// Scanner Bluetooth in modalità tastiera: il "bip" arriva come digitazione veloce + Invio
listenKeyboardWedge(({ rawValue }) => {
  const route = location.hash.slice(1).split('/')[0];
  if (route === 'ricevi') { bozzaRicevimento = bozzaDaScan({ rawValue }); render(); }
  else if (route === 'produci' && bozzaProd) {
    const r = S.getDb().ricette.find((x) => x.id === bozzaProd.ricettaId);
    const libero = r?.ingredienti.find((i) => !bozzaProd.scelte[i.nome]?.lottoId);
    const lotto = S.trovaLotti(rawValue, parseBarcode(rawValue))[0];
    // Assegna all'ingrediente che corrisponde al prodotto scansionato, altrimenti al primo libero
    const target = (lotto && r?.ingredienti.find((i) => suggeriti(i.nome, [lotto]).length)) || libero;
    if (target) assegnaScanAIngrediente(target.nome, rawValue);
  } else if (route === 'cerca') { cercaTesto = rawValue; render(); }
  else apriDaCodice(rawValue);
});

window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
S.onChange(aggiornaBadgeSync);
onSyncStatus(aggiornaBadgeSync);

installaRicetteBase();
aggiornaBadgeSync();
render();
startAutoSync();
preloadScanner();
