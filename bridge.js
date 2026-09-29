'use strict';
// bridge.js — ฟัง relay โดเนทแบบอ่านอย่างเดียว แล้วสร้างคิวโดเนทเมื่อ "อนุมัติ"
// ทิศทางเดียว: donate -> queue  (ไม่เขียนอะไรกลับเข้า donate)
const WebSocket = require('ws');
const QUEUE = require('./queue');

const DONATE_WS = process.env.DONATE_WS || 'wss://donate-backend-60hc.onrender.com/ws';
const DONATE_CH = process.env.DONATE_CH || '';
const LISTEN_TOKEN = process.env.DONATE_LISTEN_TOKEN || '';
const QUEUE_CH = process.env.QUEUE_CH || DONATE_CH;

let connectedAt = 0;
const REPLAY_WINDOW_MS = 1500;  // relay ส่ง backlog ทันทีหลัง connect: ช่วงนี้ = replay เท่านั้น ห้ามสร้างคิว
const st = { alive: false, since: 0, lastMsg: 0, lastErr: '', reconnects: 0, joined: 0, skipped: 0, pending: 0 };
const pending = new Map();      // donation id -> { rec, at }   (จำไว้รอจับคู่ตอน approved)
const seenResolved = new Map(); // กัน approved ซ้ำ (relay replay)
let ws = null, timer = null, hb = null, back = 1000, onChange = () => {}, stopped = false;

function gc() {
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.at > 6 * 3600e3) pending.delete(k);
  for (const [k, t] of seenResolved) if (now - t > 6 * 3600e3) seenResolved.delete(k);
  while (pending.size > 500) pending.delete(pending.keys().next().value);
  st.pending = pending.size;
}

function handle(m) {
  if (!m || !m.t) return;
  st.lastMsg = Date.now();

  if (m.t === 'donation' && m.d && m.d.rec && m.d.rec.id) {
    pending.set(m.d.rec.id, { rec: m.d.rec, at: Date.now() });
    return gc();
  }
  if (m.t === 'resolved' && m.d && m.d.id) {
    const id = m.d.id;
    if (m.d.status !== 'approved') { pending.delete(id); return; }
    if (seenResolved.has(id)) return;                 // อนุมัติซ้ำ = ไม่ทำซ้ำ
    seenResolved.set(id, Date.now());
    // ★ ห้ามตามเก็บย้อนหลัง: resolved ที่เกิดก่อนเราเชื่อมต่อ = ของเก่าที่ relay replay มา
    //   (การตามเก็บย้อนหลังคือต้นเหตุของการยัดคิวซ้ำ ซึ่งแย่กว่าคิวขาดไปหนึ่งคน)
    const replaying = Date.now() - connectedAt < REPLAY_WINDOW_MS;
    if (replaying || !m._at || m._at < connectedAt - 500) { pending.delete(id); st.skipped++; return; }

    const hit = pending.get(id);
    pending.delete(id);
    const rec = hit && hit.rec;
    const q = (m.d.q) || (rec && rec.q);              // relay รุ่นใหม่แนบ q มาใน resolved/record
    if (!rec || !q || !q.uid) { st.skipped++; return; }   // ไม่ขอคิว/ไม่รู้จักรายการ = ไม่ทำอะไร

    const r = QUEUE.join(QUEUE_CH, {
      name: q.name, uid: q.uid,
      amount: Number(m.d.amount != null ? m.d.amount : rec.amount) || 0,
      ref: id, note: 'จากโดเนท ' + (rec.amount || '') + '฿'
    }, 'admin');
    if (r.ok) { st.joined++; console.log('[bridge] +คิวโดเนท', r.entry.name, '…' + String(r.entry.uid).slice(-3), r.entry.tier); onChange(QUEUE_CH); }
    else { st.skipped++; console.warn('[bridge] ไม่เข้าคิว:', r.err); }
  }
}

function connect() {
  if (stopped) return;
  if (!DONATE_CH) { st.lastErr = 'DONATE_CH ไม่ได้ตั้งค่า'; return; }
  const url = DONATE_WS + '?ch=' + encodeURIComponent(DONATE_CH) + (LISTEN_TOKEN ? '&tok=' + encodeURIComponent(LISTEN_TOKEN) : '');
  try { ws = new WebSocket(url, { handshakeTimeout: 10000 }); } catch (e) { st.lastErr = String(e.message); return retry(); }

  ws.on('open', () => { st.alive = true; st.since = Date.now(); connectedAt = Date.now(); st.lastErr = ''; back = 1000; console.log('[bridge] เชื่อมแล้ว'); });
  ws.on('message', raw => { let m; try { m = JSON.parse(raw.toString()); } catch { return; } try { handle(m); } catch (e) { console.error('[bridge] handle', e); } });
  ws.on('unexpected-response', (_q, res) => { st.lastErr = 'ปฏิเสธ HTTP ' + res.statusCode; console.warn('[bridge]', st.lastErr); });
  ws.on('close', (code) => { st.alive = false; if (code === 4001) st.lastErr = 'token ไม่ถูกต้อง (4001)'; retry(); });
  ws.on('error', e => { st.alive = false; st.lastErr = String(e && e.message); });
}
function retry() {
  if (stopped) return;
  st.reconnects++;
  clearTimeout(timer);
  timer = setTimeout(connect, back);
  back = Math.min(back * 1.8, 30000);
}

function start(cb) {
  onChange = cb || onChange;
  connect();
  // ตรวจว่า socket ตายเงียบ (Render ตัดโดยไม่ส่ง close) — ไม่มีอะไรมา 90 วิ = ต่อใหม่
  hb = setInterval(() => {
    if (ws && ws.readyState === 1) { try { ws.ping(); } catch (_) {} }
    if (st.alive && Date.now() - st.lastMsg > 90000 && st.lastMsg) { try { ws.terminate(); } catch (_) {} }
  }, 30000);
}
function stop() { stopped = true; clearTimeout(timer); clearInterval(hb); try { ws && ws.terminate(); } catch (_) {} }
function status() { gc(); return { alive: st.alive, since: st.since, lastMsg: st.lastMsg, lastErr: st.lastErr, reconnects: st.reconnects, joined: st.joined, skipped: st.skipped, pending: st.pending, ch: QUEUE_CH ? '…' + QUEUE_CH.slice(-4) : '' }; }

module.exports = { start, stop, status, _handle: handle };
