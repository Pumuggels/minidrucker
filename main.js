// Printing protocol based on rbaron/catprinter (MIT License,
// Copyright (c) 2021 rbaron). See NOTICE.md.
const SERVICE = 0xae30, TX = 0xae01, RX = 0xae02;
const WIDTH = 384, DPMM = 8, CHUNK = 180, DELAY = 1, FEED = 25, MAX_ROWS = 3000;
const KEYS = ['d', 'b', 'kon', 'i', 'mode', 'len', 'mar', 'gap'];
const $ = id => document.getElementById(id);
const num = id => parseFloat($(id).value) || 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const setS = t => { $('s').textContent = t; };
const log = t => { $('log').textContent = (t + '\n' + $('log').textContent).slice(0, 1500); };
const hex = u => Array.from(u, b => b.toString(16).padStart(2, '0')).join(' ');
const mmPx = v => Math.max(0, Math.round(v * DPMM));

function crc8(bytes) {
  let c = 0;
  for (const b of bytes) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c & 0x80) ? (((c << 1) ^ 0x07) & 0xff) : ((c << 1) & 0xff);
  }
  return c;
}
function cmd(id, payload) {
  return Uint8Array.from([0x51, 0x78, id, 0x00, payload.length & 0xff, payload.length >> 8,
    ...payload, crc8(payload), 0xff]);
}
function concat(parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let k = 0;
  for (const p of parts) { out.set(p, k); k += p.length; }
  return out;
}
function encodeRow(bits, y) {
  const row = new Array(WIDTH / 8).fill(0);
  for (let x = 0; x < WIDTH; x++) if (bits[y * WIDTH + x]) row[x >> 3] |= 1 << (x & 7);
  return cmd(0xa2, row);
}
function buildJob(bits, rows, energy) {
  const parts = [
    cmd(0xa3, [0]),
    cmd(0xa4, [0x32]),
    cmd(0xaf, [(energy >> 8) & 0xff, energy & 0xff]),
    cmd(0xbe, [1]),
    cmd(0xa6, [0xaa, 0x55, 0x17, 0x38, 0x44, 0x5f, 0x5f, 0x5f, 0x44, 0x38, 0x2c]),
  ];
  for (let y = 0; y < rows; y++) parts.push(encodeRow(bits, y));
  parts.push(cmd(0xbd, [FEED]));
  for (let i = 0; i < 3; i++) parts.push(cmd(0xa1, [0x30, 0x00]));
  parts.push(cmd(0xa6, [0xaa, 0x55, 0x17, 0, 0, 0, 0, 0, 0, 0, 0x17]));
  parts.push(cmd(0xa3, [0]));
  return concat(parts);
}

function toBits(imgData, method, bright, contrast, invert) {
  const { width: w, height: h, data } = imgData;
  const f = (259 * (contrast + 255)) / (255 * (259 - contrast));
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = data[4 * i + 3] / 255;
    const l = 0.299 * data[4 * i] + 0.587 * data[4 * i + 1] + 0.114 * data[4 * i + 2];
    let v = l * a + 255 * (1 - a);
    v = f * (v - 128) + 128 + (bright - 128);
    g[i] = invert ? 255 - v : v;
  }
  const out = new Uint8Array(w * h);
  if (method === 'threshold') {
    for (let i = 0; i < w * h; i++) out[i] = g[i] < 128 ? 1 : 0;
    return out;
  }
  const k = method === 'atkinson'
    ? [[1, 0, 1 / 8], [2, 0, 1 / 8], [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8], [0, 2, 1 / 8]]
    : [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, old = g[i], nw = old < 128 ? 0 : 255;
    out[i] = nw === 0 ? 1 : 0;
    const err = old - nw;
    for (const [dx, dy, fr] of k) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && xx < w && yy < h) g[yy * w + xx] += err * fr;
    }
  }
  return out;
}

// Einstellungen merken
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('mp') || '{}');
    for (const k of KEYS) if (s[k] !== undefined) $(k).value = s[k];
  } catch (e) { /* ignorieren */ }
}
function saveSettings() {
  try {
    const s = {};
    for (const k of KEYS) s[k] = $(k).value;
    localStorage.setItem('mp', JSON.stringify(s));
  } catch (e) { /* ignorieren */ }
}

// Bildaufbereitung
const c = $('c'), ctx = c.getContext('2d');
const work = document.createElement('canvas');
const wctx = work.getContext('2d', { willReadFrequently: true });
let img = null, job = null, rotation = 0;

function layout() {
  const n = Math.min(50, Math.max(1, Math.round(num('n')) || 1));
  const gapPx = mmPx(num('gap'));
  const rows = job ? job.rows : 0;
  return { n, gapPx, total: n * rows + (n - 1) * gapPx };
}

function prepare() {
  if (!img) return;
  const m = mmPx(num('mar'));
  const label = $('mode').value === 'label';
  let l = num('cl'), r = num('cr'), o = num('co'), u = num('cu');
  if (l + r > 95) { const k = 95 / (l + r); l *= k; r *= k; }
  if (o + u > 95) { const k = 95 / (o + u); o *= k; u *= k; }
  const sx = img.width * l / 100, sy = img.height * o / 100;
  const sw = img.width * (1 - (l + r) / 100), sh = img.height * (1 - (o + u) / 100);
  const turned = rotation % 180 !== 0;
  const rw = turned ? sh : sw, rh = turned ? sw : sh;
  const aw = Math.max(8, WIDTH - 2 * m);
  let H, scale;
  if (label) {
    const len = Math.max(24, mmPx(num('len')));
    const ah = Math.max(8, len - 2 * m);
    scale = Math.min(aw / rw, ah / rh);
    H = len;
  } else {
    scale = aw / rw;
    H = Math.max(1, Math.round(rh * scale) + 2 * m);
  }
  const dw = Math.max(1, Math.round(rw * scale)), dh = Math.max(1, Math.round(rh * scale));
  work.width = WIDTH; work.height = H;
  wctx.fillStyle = '#fff'; wctx.fillRect(0, 0, WIDTH, H);
  wctx.imageSmoothingQuality = 'high';
  wctx.save();
  wctx.translate(WIDTH / 2, H / 2);
  wctx.scale($('fh').checked ? -1 : 1, $('fv').checked ? -1 : 1);
  wctx.rotate(rotation * Math.PI / 180);
  const pw = turned ? dh : dw, ph = turned ? dw : dh;
  wctx.drawImage(img, sx, sy, sw, sh, -pw / 2, -ph / 2, pw, ph);
  wctx.restore();
  const bits = toBits(wctx.getImageData(0, 0, WIDTH, H), $('d').value, num('b'), num('kon'), $('inv').checked);
  c.width = WIDTH; c.height = H;
  const out = ctx.createImageData(WIDTH, H);
  for (let i = 0; i < WIDTH * H; i++) {
    const v = bits[i] ? 0 : 255;
    out.data[4 * i] = out.data[4 * i + 1] = out.data[4 * i + 2] = v; out.data[4 * i + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  job = { bits, rows: H };
  const L = layout();
  $('info').textContent = H + ' Zeilen je Kopie, gesamt ' + L.total + ' Zeilen, ca. ' + Math.round(L.total / DPMM) + ' mm';
}

function resetImage() {
  rotation = 0; $('rotv').textContent = '0°';
  for (const id of ['cl', 'cr', 'co', 'cu']) $(id).value = 0;
  $('fh').checked = false; $('fv').checked = false; $('inv').checked = false;
}
$('f').onchange = e => {
  const im = new Image();
  im.onload = () => { resetImage(); img = im; prepare(); };
  im.src = URL.createObjectURL(e.target.files[0]);
};
$('rot').onclick = () => {
  rotation = (rotation + 90) % 360;
  $('rotv').textContent = rotation + '°';
  prepare();
};
document.addEventListener('input', e => {
  if (e.target.id === 'f') return;
  saveSettings();
  prepare();
});
loadSettings();

// Bluetooth
let tx = null;
$('conn').onclick = async () => {
  try {
    const dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [SERVICE] });
    dev.addEventListener('gattserverdisconnected', () => { tx = null; setS('getrennt'); });
    const server = await dev.gatt.connect();
    const svc = await server.getPrimaryService(SERVICE);
    tx = await svc.getCharacteristic(TX);
    const rx = await svc.getCharacteristic(RX);
    await rx.startNotifications();
    rx.addEventListener('characteristicvaluechanged', e => {
      const v = e.target.value;
      log('RX ' + hex(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)));
    });
    setS('verbunden');
  } catch (e) { setS('Fehler: ' + e.message); }
};

$('p').onclick = async () => {
  try {
    if (!tx) throw new Error('nicht verbunden');
    if (!job) throw new Error('kein Bild');
    const { n, gapPx, total } = layout();
    if (total > MAX_ROWS) throw new Error('zu lang: ' + total + ' Zeilen (max. ' + MAX_ROWS + ')');
    const all = new Uint8Array(WIDTH * total);
    for (let k = 0; k < n; k++) all.set(job.bits, k * (job.rows + gapPx) * WIDTH);
    const energy = Math.min(65535, Math.max(1, num('i') || 30000));
    const data = buildJob(all, total, energy);
    const t0 = Date.now();
    for (let o = 0; o < data.length; o += CHUNK) {
      await tx.writeValueWithoutResponse(data.slice(o, o + CHUNK));
      await sleep(DELAY);
      if ((o / CHUNK) % 5 === 0) setS('sende ' + Math.round(100 * o / data.length) + ' %');
    }
    setS('fertig: ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
  } catch (e) { setS('Fehler: ' + e.message); }
};

// PWA: Service Worker und Empfang geteilter Bilder
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
async function loadShared() {
  if (!location.search.includes('shared=1')) return;
  try {
    const cache = await caches.open('mp-share');
    const res = await cache.match('shared-image');
    if (res) {
      const blob = await res.blob();
      const im = new Image();
      im.onload = () => { resetImage(); img = im; prepare(); setS('Bild empfangen, bitte verbinden'); };
      im.src = URL.createObjectURL(blob);
      await cache.delete('shared-image');
    }
  } catch (e) { setS('Fehler: ' + e.message); }
  history.replaceState(null, '', location.pathname);
}
loadShared();
