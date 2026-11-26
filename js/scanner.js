// Lettura codici con la fotocamera del telefono.
// Usa il BarcodeDetector nativo (Chrome Android) e, se manca o non supporta i formati
// che servono (es. Safari iOS), carica il "ponyfill" basato su ZXing (WebAssembly).
// Supporta anche gli scanner Bluetooth/USB in modalità tastiera (vedi listenKeyboardWedge).

const FORMATI = [
  'code_128', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf',
  'data_matrix', 'qr_code', 'databar', 'databar_expanded',
];
const PONYFILL_URL = 'https://cdn.jsdelivr.net/npm/barcode-detector@3.2.5/dist/es/ponyfill.js/+esm';

let detectorPromise = null;

async function getDetector() {
  if (detectorPromise) return detectorPromise;
  detectorPromise = (async () => {
    if ('BarcodeDetector' in window) {
      try {
        const supportati = await window.BarcodeDetector.getSupportedFormats();
        if (supportati.includes('code_128') && supportati.includes('ean_13')) {
          const formats = FORMATI.filter((f) => supportati.includes(f));
          return { detector: new window.BarcodeDetector({ formats }), motore: 'nativo' };
        }
      } catch (e) { /* passa al ponyfill */ }
    }
    const { BarcodeDetector } = await import(PONYFILL_URL);
    return { detector: new BarcodeDetector({ formats: FORMATI }), motore: 'zxing' };
  })();
  detectorPromise.catch(() => { detectorPromise = null; });
  return detectorPromise;
}

// Precarica il motore (così il primo scan è veloce)
export function preloadScanner() { getDetector().catch(() => {}); }

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 1800; g.gain.value = 0.15;
    o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.09);
    o.onended = () => ctx.close();
  } catch (e) { /* niente audio */ }
  if (navigator.vibrate) navigator.vibrate(80);
}

/**
 * Apre la fotocamera a schermo intero e restituisce il primo codice letto.
 * @param {{titolo?:string}} opts
 * @returns {Promise<{rawValue:string, format:string}|null>} null se l'utente annulla
 */
export function scanBarcode(opts = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'scanner';
    overlay.innerHTML = `
      <div class="scanner-top">
        <span>${opts.titolo || 'Inquadra il codice a barre'}</span>
        <button class="scanner-close" aria-label="Chiudi">✕</button>
      </div>
      <video playsinline muted autoplay></video>
      <div class="scanner-frame"><div class="scanner-line"></div></div>
      <div class="scanner-status">Avvio fotocamera…</div>
      <div class="scanner-bottom">
        <button class="btn btn-ghost scanner-torch" hidden>🔦 Torcia</button>
        <form class="scanner-manual">
          <input name="code" placeholder="…oppure digita / usa scanner" autocomplete="off" />
          <button class="btn">OK</button>
        </form>
      </div>`;
    document.body.appendChild(overlay);

    const video = overlay.querySelector('video');
    const status = overlay.querySelector('.scanner-status');
    const torchBtn = overlay.querySelector('.scanner-torch');
    let stream = null, stopped = false, timer = null, torchOn = false;

    const finish = (result) => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      overlay.remove();
      resolve(result);
    };

    overlay.querySelector('.scanner-close').onclick = () => finish(null);
    overlay.querySelector('.scanner-manual').onsubmit = (e) => {
      e.preventDefault();
      const v = e.target.code.value.trim();
      if (v) finish({ rawValue: v, format: 'manuale' });
    };

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        });
      } catch (e) {
        status.textContent = location.protocol !== 'https:' && location.hostname !== 'localhost'
          ? 'La fotocamera funziona solo su HTTPS (es. GitHub Pages).'
          : 'Fotocamera non disponibile: ' + (e.message || e.name) + '. Puoi digitare il codice.';
        return;
      }
      if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
      video.srcObject = stream;
      await video.play().catch(() => {});

      const track = stream.getVideoTracks()[0];
      const caps = track.getCapabilities?.() || {};
      if (caps.torch) {
        torchBtn.hidden = false;
        torchBtn.onclick = async () => {
          torchOn = !torchOn;
          await track.applyConstraints({ advanced: [{ torch: torchOn }] }).catch(() => {});
        };
      }
      if (caps.focusMode?.includes('continuous')) {
        track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
      }

      let det;
      try {
        status.textContent = 'Carico il lettore…';
        det = await getDetector();
      } catch (e) {
        status.textContent = 'Impossibile caricare il lettore di codici (serve internet la prima volta). Digita il codice.';
        return;
      }
      status.textContent = `Cerco il codice… (${det.motore})`;

      const loop = async () => {
        if (stopped) return;
        if (video.readyState >= 2) {
          try {
            const codes = await det.detector.detect(video);
            if (codes.length) {
              beep();
              finish({ rawValue: codes[0].rawValue, format: codes[0].format });
              return;
            }
          } catch (e) { /* frame non valido, riprova */ }
        }
        timer = setTimeout(loop, 120);
      };
      loop();
    })();
  });
}

/**
 * Scanner fisici in modalità tastiera (HID): digitano il codice molto velocemente e premono Invio.
 * Se il focus non è su un campo di testo, intercettiamo la sequenza e la passiamo al callback.
 */
export function listenKeyboardWedge(callback) {
  let buf = '', last = 0;
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (document.querySelector('.scanner')) return;
    const now = performance.now();
    if (now - last > 60) buf = '';
    last = now;
    if (e.key === 'Enter') {
      if (buf.length >= 6) { callback({ rawValue: buf, format: 'scanner' }); e.preventDefault(); }
      buf = '';
    } else if (e.key.length === 1) {
      buf += e.key;
    }
  });
}
