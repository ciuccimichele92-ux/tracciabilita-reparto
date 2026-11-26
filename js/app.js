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
    const sum = $('#allergeni-sum');
    if (sum) sum.textContent = p.allergeni.length ? p.allergeni.join(', ') : 'nessuno indicato';
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
  const riepilogoAllergeni = (lista) => (lista.length ? lista.join(', ') : 'nessuno indicato');
  view.innerHTML = `
    <button type="button" class="back" id="annulla">✕ Annulla</button>
    <h1>Nuovo arrivo</h1>
    ${duplicati.length ? `<div class="alert warn">Attenzione: questo lotto risulta già registrato (${duplicati.map((d) => esc(d.id)).join(', ')}). Salva solo se è un collo in più.</div>` : ''}
    <form id="f" class="card" autocomplete="off">
      <label>Prodotto *<input name="nome" required value="${esc(b.nome)}" placeholder="es. Carne bovina – fesa" list="prodotti-noti"></label>
      <div id="prod-stato" style="font-size:.82rem;margin:-.4rem 0 .7rem"></div>
      ${b.ripresoDa ? `<div class="alert warn" style="font-size:.85rem">Il codice non contiene il lotto: ho ripreso lotto e scadenza dall’ultimo collo di questo prodotto arrivato oggi. Verifica che sulla confezione sia lo stesso.</div>` : ''}
      ${b.gtin && !b.codiceLotto ? `<div class="alert warn" style="font-size:.85rem">Questo codice a barre identifica solo il prodotto: lotto e scadenza sono stampati sulla confezione. Se c’è, scansiona l’etichetta del cartone.</div>` : ''}
      <datalist id="prodotti-noti">${Object.values(S.getDb().prodotti).map((p) => `<option value="${esc(p.nome)}">`).join('')}</datalist>
      <div class="grid2">
        <label>Lotto fornitore *<input name="codiceLotto" required value="${esc(b.codiceLotto)}"></label>
        <label>Scadenza / TMC<input type="date" name="scadenza" value="${esc(b.scadenza)}"></label>
        <label>Temperatura (°C)${cat.tMax !== null ? ` <small>max ${cat.tMax}°</small>` : ''}<input name="temperatura" inputmode="decimal" value="${esc(b.temperatura ?? '')}"></label>
        <label>Categoria<select name="categoria">${Object.entries(S.CATEGORIE).map(([k, c]) => `<option value="${k}" ${k === b.categoria ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}</select></label>
        <label>Fornitore<input name="fornitore" value="${esc(b.fornitore)}"></label>
        <label>N° DDT<input name="ddt" value="${esc(b.ddt || '')}"></label>
      </div>
      <div id="temp-alert"></div>
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
      <details class="more" id="allergeni-box">
        <summary>Allergeni: <span id="allergeni-sum" style="margin-left:.3rem;color:var(--ink)">${esc(riepilogoAllergeni(b.allergeni))}</span></summary>
        ${chipsAllergeni(b.allergeni)}
      </details>
      <details class="more">
        <summary>Altri dettagli</summary>
        <div class="grid2">
          <label>Peso netto (kg)<input name="pesoKg" inputmode="decimal" value="${esc(b.pesoKg)}"></label>
          <label>Data arrivo<input type="date" name="dataArrivo" value="${esc(b.dataArrivo || S.oggiIso())}"></label>
        </div>
        <label>Note<textarea name="note" placeholder="es. non conformità, azioni correttive">${esc(b.note || '')}</textarea></label>
        ${b.raw ? `<div class="muted" style="font-size:.8rem">Codice letto (${esc(b.parsed.type.toUpperCase())})</div>
          <dl class="kv" style="margin-top:.4rem;font-size:.82rem">${b.parsed.elements.map((e) => `<dt>${esc(e.label)}</dt><dd>${esc(e.value)}</dd>`).join('') || `<dt>Testo</dt><dd>${esc(b.raw)}</dd>`}</dl>
          ${b.parsed.errors.length ? `<div class="alert warn">${b.parsed.errors.map(esc).join('<br>')}</div>` : ''}` : ''}
      </details>
      <div class="actionbar">
        <button class="btn">💾 Salva</button>
        <button type="button" class="btn btn-ghost" id="salva-scan">📷 Salva e prossimo</button>
      </div>
    </form>`;
  const form = $('#f');
  bindChips(form);
  $$('#allergeni-box .chip', form).forEach((c) => c.addEventListener('click', () => {
    $('#allergeni-sum').textContent = riepilogoAllergeni(leggiChips($('#allergeni-box', form)));
  }));

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
    <a href="#lotti" class="back">‹ Lotti</a>
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
// PRODUZIONE: si sceglie la voce, si scansiona, si chiude con "Preparazione completata"
// =====================================================================
const oraIt = (iso) => (iso ? new Date(iso).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : '');
const ricettaDi = (p) => S.getDb().ricette.find((r) => r.id === p.ricettaId);

/** Pannello che sale dal basso (sopra la tab bar). Restituisce l'elemento; chiudi con .remove(). */
function apriPannello(html) {
  const el = document.createElement('div');
  el.className = 'sheet-backdrop';
  el.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  el.addEventListener('click', (e) => { if (e.target === el) el.remove(); });
  document.body.appendChild(el);
  return el;
}

function renderProduci() {
  const db = S.getDb();
  const inCorso = db.inCorso;
  const oggi = db.lotti.filter((l) => l.tipo === 'produzione' && l.dataProduzione === S.oggiIso()).reverse();
  view.innerHTML = `
    <h1>Produzione</h1>
    ${inCorso.length ? `<h2 style="margin-top:0">In corso</h2>
      ${inCorso.map((p) => `<a class="card card-link in-corso" href="#produzione/${encodeURIComponent(p.id)}">
        <span class="grow"><div class="title">🍳 ${esc(ricettaDi(p)?.nome || 'Ricetta eliminata')}</div>
        <div class="sub">iniziata alle ${oraIt(p.avviata)} · ${p.voci.length} prodott${p.voci.length === 1 ? 'o' : 'i'} scansionat${p.voci.length === 1 ? 'o' : 'i'}</div></span>
        <span class="btn btn-small">Riprendi</span></a>`).join('')}` : ''}
    <h2 ${inCorso.length ? '' : 'style="margin-top:0"'}>Cosa prepari?</h2>
    ${db.ricette.length ? `<div class="voci">${db.ricette.map((r) =>
      `<button class="voce" data-ricetta="${esc(r.id)}">${esc(r.nome)}</button>`).join('')}</div>`
      : '<div class="empty">Nessuna voce. <a href="#ricette/nuova">Creane una in Ricette</a></div>'}
    <h2>Prodotte oggi</h2>
    <div class="card">${oggi.length ? `<ul class="list">${oggi.map(rigaLotto).join('')}</ul>` : '<div class="empty">Nessuna produzione completata oggi</div>'}</div>`;
  $$('[data-ricetta]').forEach((b) => {
    b.onclick = () => {
      const p = S.avviaProduzione(b.dataset.ricetta);
      scanAllApertura = p.id;
      go(`#produzione/${encodeURIComponent(p.id)}`);
    };
  });
}

let scanAllApertura = null; // apre subito la fotocamera quando si avvia una produzione

function renderProduzione(id) {
  const p = S.getProduzione(id);
  if (!p) { go('#produci'); return; }
  const r = ricettaDi(p);
  const voci = p.voci.map((v) => S.getLotto(v.lottoId)).filter(Boolean);
  view.innerHTML = `
    <a href="#produci" class="back">‹ Produzione</a>
    <h1 style="margin-bottom:.2rem">${esc(r?.nome || 'Ricetta eliminata')}</h1>
    <p class="muted" style="margin:0 0 1rem;font-size:.88rem">In corso dalle ${oraIt(p.avviata)}. Puoi uscire e riprenderla quando vuoi.</p>
    <button class="btn btn-scan" id="scan">📷 Scansiona prodotto</button>
    <button class="btn btn-ghost btn-block" id="senza-codice" style="margin-top:.6rem">＋ Aggiungi senza codice</button>
    <h2>Prodotti usati (${voci.length})</h2>
    <div class="card">${voci.length ? `<ul class="list">${voci.map((l) => `<li><div class="item">
        <span style="font-size:1.3rem">${l.tipo === 'produzione' ? '🍳' : '📦'}</span>
        <span class="grow"><div class="title">${esc(l.nome)}</div>
          <div class="sub">Lotto ${esc(l.codiceLotto || l.id)}</div>
          <div style="margin-top:.3rem">${badgeScadenza(l)}</div></span>
        <button class="icon-del" data-togli="${esc(l.id)}" aria-label="Togli ${esc(l.nome)}">✕</button>
      </div></li>`).join('')}</ul>` : '<div class="empty">Scansiona i prodotti che stai usando: carne, sfoglia, latte…</div>'}</div>
    <button class="btn btn-ghost btn-block" id="annulla-prod" style="margin-top:.4rem">Annulla produzione</button>
    <div class="actionbar">
      <button class="btn btn-block btn-ok" id="completa" ${voci.length ? '' : 'disabled'}>✅ Preparazione completata</button>
    </div>`;

  $('#scan').onclick = () => scansioneContinua(id);
  $('#senza-codice').onclick = () => scegliSenzaCodice(id);
  $$('[data-togli]').forEach((b) => { b.onclick = () => { S.rimuoviDaProduzione(id, b.dataset.togli); render(); }; });
  $('#annulla-prod').onclick = () => {
    if (confirm('Annullare questa produzione? Non verrà creato nessun lotto.')) { S.annullaProduzione(id); toast('Produzione annullata'); go('#produci'); }
  };
  $('#completa').onclick = () => completaPannello(id);

  if (scanAllApertura === id) { scanAllApertura = null; scansioneContinua(id); }
}

/** Fotocamera in modalità continua: dopo ogni prodotto si riapre, finché non premi ✕. */
async function scansioneContinua(id) {
  for (;;) {
    const p = S.getProduzione(id);
    if (!p) return;
    const n = p.voci.length;
    const res = await scanBarcode({ titolo: `${ricettaDi(p)?.nome || ''} · ${n} prodott${n === 1 ? 'o' : 'i'} · ✕ per finire` });
    if (!res) { render(); return; }
    const ok = await aggiungiDaCodice(id, res.rawValue);
    render();
    if (ok === 'stop') return;
    await new Promise((r) => setTimeout(r, 700)); // il tempo di leggere il messaggio
  }
}

/** @returns {Promise<'ok'|'skip'|'stop'>} */
async function aggiungiDaCodice(id, raw) {
  const parsed = parseBarcode(raw);
  const trovati = S.trovaLotti(raw, parsed);
  const aperti = trovati.filter((l) => l.stato === 'aperto');
  const lotto = aperti.find((l) => !isScaduto(l)) || aperti[0] || trovati[0];
  if (!lotto) {
    // Mai registrato in Ricevi: lo registriamo al volo, senza bloccare la produzione
    const nuovo = await registraAlVolo(raw, parsed);
    if (!nuovo) return 'stop';
    return aggiungi(id, nuovo, parsed, [nuovo]);
  }
  if (lotto.stato !== 'aperto') { toast(`⛔ ${lotto.nome}: lotto ${lotto.stato}, non utilizzabile.`, 4000); return 'skip'; }
  if (isScaduto(lotto)) { toast(`⛔ ${lotto.nome} lotto ${lotto.codiceLotto || lotto.id} è SCADUTO.`, 4000); return 'skip'; }
  return aggiungi(id, lotto, parsed, aperti);
}

function aggiungi(id, lotto, parsed, aperti) {
  const esito = S.aggiungiAProduzione(id, lotto.id);
  if (esito === 'gia') { toast(`Già aggiunto: ${lotto.nome}`); return 'skip'; }
  const ambiguo = !parsed.fields.lotto && parsed.fields.gtin && aperti.length > 1;
  toast(ambiguo
    ? `✓ ${lotto.nome} · lotto ${lotto.codiceLotto} (scade prima). Ci sono ${aperti.length} lotti aperti: se sulla confezione ne vedi un altro, cambialo.`
    : `✓ ${lotto.nome} · lotto ${lotto.codiceLotto || lotto.id}`, ambiguo ? 5000 : 2200);
  return 'ok';
}

/** Prodotto scansionato ma non ricevuto: chiede il lotto scritto sulla confezione e registra l'arrivo. */
function registraAlVolo(raw, parsed) {
  return new Promise(async (resolve) => {
    const f = parsed.fields;
    const noto = S.getProdotto(f.gtin);
    const el = apriPannello(`
      <h2 style="margin-top:0">Prodotto non ancora ricevuto</h2>
      <p class="muted" style="font-size:.88rem;margin-top:0">Registralo ora: finisce tra gli arrivi di oggi e nella produzione.</p>
      <form id="volo" autocomplete="off">
        <label>Prodotto *<input name="nome" required value="${esc(noto?.nome || '')}" placeholder="${f.gtin ? 'cerco il nome…' : 'nome del prodotto'}"></label>
        <div class="grid2">
          <label>Lotto (sulla confezione) *<input name="lotto" required value="${esc(f.lotto || (parsed.type === 'testo' ? raw : ''))}"></label>
          <label>Scadenza<input type="date" name="scadenza" value="${esc(f.scadenza || f.tmc || '')}"></label>
        </div>
        <label>Fornitore<input name="fornitore" value="${esc(noto?.fornitore || '')}"></label>
        <div class="row"><button type="button" class="btn btn-ghost" id="no">Annulla</button><button class="btn">Registra e aggiungi</button></div>
      </form>`);
    const form = $('#volo', el);
    let info = noto;
    if (!noto && f.gtin) {
      cercaProdotto(f.gtin).then((p) => {
        info = p;
        if (p && !form.nome.value) form.nome.value = p.nome;
        if (p && !form.fornitore.value) form.fornitore.value = p.fornitore || '';
        form.nome.placeholder = 'nome del prodotto';
      });
    }
    (form.lotto.value ? form.scadenza : form.lotto).focus();
    $('#no', el).onclick = () => { el.remove(); resolve(null); };
    form.onsubmit = (e) => {
      e.preventDefault();
      const lotto = S.registraRicevimento({
        gtin: f.gtin || '', codiceBarre: raw, nome: form.nome.value.trim(), fornitore: form.fornitore.value.trim(),
        categoria: info?.categoria || 'altro', allergeni: info?.allergeni || [],
        codiceLotto: form.lotto.value.trim(), scadenza: form.scadenza.value, dataArrivo: S.oggiIso(),
        conforme: true, stato: 'aperto', note: 'Registrato durante la produzione',
      });
      flush();
      el.remove();
      resolve(lotto);
    };
  });
}

function scegliSenzaCodice(id) {
  const p = S.getProduzione(id);
  const r = ricettaDi(p);
  const presi = new Set(p.voci.map((v) => v.lottoId));
  // Esclusi: già aggiunti, scaduti e lotti della stessa voce (le lasagne non contengono lasagne)
  const aperti = S.lottiAperti().filter((l) => !presi.has(l.id) && !isScaduto(l) && l.ricettaId !== p.ricettaId);
  // In cima i lotti che corrispondono agli ingredienti della ricetta ancora mancanti
  const mancanti = S.ingredientiMancanti(id);
  const rilevanti = (l) => (r?.ingredienti || []).some((i) => S.lottoCorrispondeA(i.nome, l));
  const ordinati = [...aperti.filter(rilevanti), ...aperti.filter((l) => !rilevanti(l))];
  const el = apriPannello(`
    <h2 style="margin-top:0">Aggiungi senza codice</h2>
    <input id="cerca-lotto" placeholder="Cerca prodotto o lotto…" style="margin-bottom:.6rem">
    <ul class="list sheet-list">${ordinati.map((l) => `<li><button class="item pick" data-id="${esc(l.id)}" data-q="${esc(norm(`${l.nome} ${l.codiceLotto} ${l.id}`))}">
      <span class="grow"><div class="title">${esc(l.nome)}${rilevanti(l) ? ' <span class="badge ok">ricetta</span>' : ''}</div>
      <div class="sub">Lotto ${esc(l.codiceLotto || l.id)} · scad. ${dataIt(l.scadenza)}</div></span></button></li>`).join('') || '<div class="empty">Nessun lotto aperto disponibile</div>'}</ul>
    ${mancanti.length ? `<p class="muted" style="font-size:.82rem">Della ricetta mancano ancora: ${mancanti.map(esc).join(', ')}.</p>` : ''}
    <button class="btn btn-ghost btn-block" id="chiudi">Chiudi</button>`);
  $('#chiudi', el).onclick = () => el.remove();
  $('#cerca-lotto', el).oninput = (e) => {
    const q = norm(e.target.value);
    $$('.pick', el).forEach((b) => { b.parentElement.hidden = q && !b.dataset.q.includes(q); });
  };
  $$('.pick', el).forEach((b) => {
    b.onclick = () => {
      const l = S.getLotto(b.dataset.id);
      S.aggiungiAProduzione(id, l.id);
      toast(`✓ ${l.nome} · lotto ${l.codiceLotto || l.id}`);
      el.remove();
      render();
    };
  });
}

function completaPannello(id) {
  const p = S.getProduzione(id);
  const r = ricettaDi(p);
  if (!r) { toast('La ricetta di questa produzione non esiste più.'); return; }
  const mancanti = S.ingredientiMancanti(id);
  const oggi = S.oggiIso();
  const el = apriPannello(`
    <h2 style="margin-top:0">${esc(r.nome)}: preparazione completata</h2>
    ${mancanti.length ? `<div class="alert warn">Non hai scansionato: <b>${mancanti.map(esc).join(', ')}</b>.<br>Se li hai usati, aggiungili prima di chiudere: senza lotto non sono tracciabili.</div>` : ''}
    <form id="fine" autocomplete="off">
      <div class="grid2">
        <label>Quantità prodotta *<input name="quantita" inputmode="decimal" required></label>
        <label>Unità<input name="unita" value="${esc(r.unita || 'kg')}"></label>
      </div>
      <label>Da consumarsi entro<input type="date" name="scadenza" value="${esc(S.addGiorni(oggi, r.shelfLifeGiorni))}"></label>
      <label>Note<input name="note" placeholder="es. abbattuto a +3 °C in 90 min"></label>
      <div class="row">
        <button type="button" class="btn btn-ghost" id="indietro">${mancanti.length ? 'Aggiungo' : 'Indietro'}</button>
        <button class="btn btn-ok">${mancanti.length ? 'Chiudi comunque' : 'Crea lotto'}</button>
      </div>
    </form>`);
  const form = $('#fine', el);
  form.quantita.focus();
  $('#indietro', el).onclick = () => el.remove();
  form.onsubmit = (e) => {
    e.preventDefault();
    const lotto = S.completaProduzione(id, {
      quantita: form.quantita.value.trim(), unita: form.unita.value.trim(),
      scadenza: form.scadenza.value, note: form.note.value.trim(),
    });
    el.remove();
    flush();
    toast(`✅ Nuovo lotto ${lotto.id}`, 3500);
    go(`#lotto/${encodeURIComponent(lotto.id)}`);
    const copie = ['teglie', 'pz', 'porzioni', 'vaschette'].includes(lotto.unita) ? parseInt(lotto.quantita, 10) || 1 : 1;
    if (confirm(`Lotto ${lotto.id} creato. Stampare ${copie} etichett${copie === 1 ? 'a' : 'e'}?`)) stampa(etichettaHtml(lotto), Math.min(copie, 50));
  };
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
      <a href="#ricette" class="back">‹ Ricette</a>
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
    <a href="#impostazioni" class="back">‹ Impostazioni</a>
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
  const tab = { lotto: 'lotti', produzione: 'produci', 'codici-prova': 'impostazioni' }[route] || route;
  $$('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  switch (route) {
    case 'ricevi': renderRicevi(); break;
    case 'lotto': renderLotto(param); break;
    case 'produci': renderProduci(); break;
    case 'produzione': renderProduzione(param); break;
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
  else if (route === 'produzione') {
    const id = decodeURIComponent(location.hash.slice(1).split('/')[1] || '');
    if (document.querySelector('.sheet-backdrop')) return; // un pannello è aperto
    aggiungiDaCodice(id, rawValue).then(() => render());
  } else if (route === 'cerca') { cercaTesto = rawValue; render(); }
  else apriDaCodice(rawValue);
});

window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
// Pallino sulla tab "Produci" con il numero di produzioni in corso
function aggiornaBadgeProduci() {
  const tab = $('.tabbar a[data-tab="produci"]');
  const n = S.getDb().inCorso.length;
  let c = $('.count', tab);
  if (!n) { c?.remove(); return; }
  if (!c) { c = document.createElement('span'); c.className = 'count'; tab.appendChild(c); }
  c.textContent = n;
}
S.onChange(aggiornaBadgeSync);
S.onChange(aggiornaBadgeProduci);
aggiornaBadgeProduci();
onSyncStatus(aggiornaBadgeSync);

installaRicetteBase();
aggiornaBadgeSync();
render();
startAutoSync();
preloadScanner();
