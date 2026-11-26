// Invio degli eventi a un webhook n8n (che poi scrive su Google Sheets, Postgres, Telegram…).
// Gli eventi restano in coda finché il webhook non risponde 2xx: niente si perde se manca la rete.

import { getDb, eventiDaInviare, segnaInviati } from './store.js';

let inCorso = false;
const statoListeners = new Set();
export const statoSync = { ultimoOk: null, ultimoErrore: null };

export function onSyncStatus(fn) { statoListeners.add(fn); }
function notify() { statoListeners.forEach((fn) => fn(statoSync)); }

async function post(url, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Trac-Token'] = token;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

export async function flush() {
  const { webhookUrl, webhookToken } = getDb().impostazioni;
  if (!webhookUrl || inCorso || !navigator.onLine) return;
  const coda = eventiDaInviare();
  if (!coda.length) return;
  inCorso = true;
  try {
    // A blocchi da 20 per non fare richieste enormi
    for (let i = 0; i < coda.length; i += 20) {
      const blocco = coda.slice(i, i + 20).map(({ inviato, ...e }) => e);
      await post(webhookUrl, webhookToken, { sorgente: 'tracciabilita-app', eventi: blocco });
      segnaInviati(blocco.map((e) => e.id));
    }
    statoSync.ultimoOk = new Date().toISOString();
    statoSync.ultimoErrore = null;
  } catch (e) {
    statoSync.ultimoErrore = e.message || String(e);
  } finally {
    inCorso = false;
    notify();
  }
}

export async function testWebhook(url, token) {
  await post(url, token, {
    sorgente: 'tracciabilita-app',
    eventi: [{ id: 'TEST', tipo: 'test', ts: new Date().toISOString(), negozio: getDb().impostazioni.negozio, dati: { messaggio: 'Prova di connessione' } }],
  });
}

export function startAutoSync() {
  window.addEventListener('online', flush);
  setInterval(flush, 30000);
  setTimeout(flush, 2000);
}
