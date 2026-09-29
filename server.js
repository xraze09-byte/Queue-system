'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const QUEUE  = require('./queue');
const BRIDGE = require('./bridge');

const PORT        = process.env.PORT || 10000;
const QUEUE_TOKEN = process.env.QUEUE_TOKEN || '';
const CH_RE       = /^[A-Za-z0-9_-]{6,64}$/;
const ALLOWED     = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

const rooms = new Map();
const MIME  = { '.html':'text/html; charset=utf-8', '.js':'text/javascript',
                '.css':'text/css', '.png':'image/png', '.svg':'image/svg+xml' };

// ── เสิร์ฟหน้าเว็บของตัวเอง + REST เล็กน้อย ─────────────────────────
const server = http.createServer((req, res) => {
  const u  = new URL(req.url, 'http://x');
  const cors = { 'Access-Control-Allow-Origin': '*' };

  if (u.pathname === '/health' || u.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size, bridge: BRIDGE.status() }));
  }
  // สำหรับเช็คว่าสะพานยังทำงานอยู่ไหม ก่อนขึ้นไลฟ์
  if (u.pathname === '/bridge') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
    return res.end(JSON.stringify(BRIDGE.status(), null, 2));
  }
  if (u.pathname === '/q/state') {
    const ch = u.searchParams.get('ch') || '';
    if (!CH_RE.test(ch)) { res.writeHead(400, cors); return res.end('bad ch'); }
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
    return res.end(JSON.stringify(QUEUE.snapshot(ch, false).d));
  }

  // static
  let p = u.pathname === '/embed' ? '/queue-embed.html' : u.pathname;
  const base = path.join(__dirname, 'public');
  const f = path.join(base, path.normalize(decodeURIComponent(p)).replace(/^([/\\]*\.\.)+/, ''));
  if (!f.startsWith(base + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(f)] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=300',
      // อนุญาตให้หน้าโดเนทฝัง iframe ได้ แต่เว็บอื่นฝังไม่ได้
      'Content-Security-Policy': ALLOWED.length
        ? "frame-ancestors 'self' " + ALLOWED.join(' ')
        : "frame-ancestors *"
    });
    res.end(buf);
  });
});

const wss = new WebSocketServer({
  server, path: '/ws', maxPayload: 64 * 1024,
  verifyClient(info, cb) {
    let q; try { q = new URL(info.req.url, 'http://x'); } catch { return cb(false, 400); }
    const ch = q.searchParams.get('ch') || '';
    if (!CH_RE.test(ch)) return cb(false, 400, 'bad ch');
    const og = info.origin || info.req.headers.origin || '';
    if (ALLOWED.length && og && og !== 'null' && !ALLOWED.includes(og) && !og.startsWith('https://rzclan-queue')) return cb(false, 403, 'origin');
    if (!rooms.has(ch) && rooms.size >= 200) return cb(false, 503, 'full');
    if ((rooms.get(ch)?.size || 0) >= 60)     return cb(false, 503, 'room full');
    cb(true);
  }
});

function bcastQ(ch) {
  const pub = JSON.stringify(QUEUE.snapshot(ch, false));
  const adm = JSON.stringify(QUEUE.snapshot(ch, true));
  for (const c of (rooms.get(ch) || [])) {
    if (c.readyState !== 1) continue;
    try { c.send(c._admin ? adm : pub); } catch (_) {}
  }
}

wss.on('connection', (ws, req) => {
  const q  = new URL(req.url, 'http://x');
  const ch = q.searchParams.get('ch');
  ws._ch    = ch;
  ws._admin = !!QUEUE_TOKEN && q.searchParams.get('tok') === QUEUE_TOKEN;
  ws._tok   = 20; ws._last = Date.now(); ws.isAlive = true;

  if (!rooms.has(ch)) rooms.set(ch, new Set());
  rooms.get(ch).add(ws);
  try { ws.send(JSON.stringify(QUEUE.snapshot(ch, ws._admin))); } catch (_) {}
  ws.on('error', () => { try { ws.terminate(); } catch (_) {} });

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    const now = Date.now();
    ws._tok = Math.min(20, ws._tok + (now - ws._last) / 1000 * 8);
    ws._last = now;
    if (ws._tok < 1) return;
    ws._tok -= 1;

    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || !m.t) return;

    if (m.t === 'q_sync') return ws.send(JSON.stringify(QUEUE.snapshot(ch, ws._admin)));

    if (m.t === 'q_join') {
      const r = QUEUE.join(ch, m.d || {}, 'public');   // หน้าเว็บทั่วไป = คิวฟรีเสมอ
      ws.send(JSON.stringify({ t: 'q_join_res',
        d: r.err ? { ok: false, err: r.err } : { ok: true, id: r.entry.id, tier: r.entry.tier } }));
      if (r.ok) bcastQ(ch);
      return;
    }
    if (m.t === 'q_admin') {
      if (!ws._admin) return;
      const r = QUEUE.admin(ch, m.d || {});
      ws.send(JSON.stringify({ t: 'q_admin_res', d: r }));
      if (r.ok && r.called && r.called.length) {
        const f = JSON.stringify({ t: 'q_called', _at: Date.now(),
          d: { mode: QUEUE.getQ(ch).cfg.mode, names: r.called.map(e => e.name) } });
        for (const c of rooms.get(ch) || []) if (c.readyState === 1) { try { c.send(f); } catch (_) {} }
      }
      bcastQ(ch);
    }
  });
  ws.on('close', () => {
    const s = rooms.get(ch);
    if (!s) return;
    s.delete(ws);
    if (!s.size) rooms.delete(ch);   // ห้ามล้างคิวเมื่อไม่มีคนเชื่อมอยู่ (คิวต้องอยู่ข้ามการรีเฟรช/ปิด OBS)
  });
});

const hb = setInterval(() => {
  wss.clients.forEach(c => {
    if (!c.isAlive) return c.terminate();
    c.isAlive = false; try { c.ping(); } catch (_) {}
  });
}, 30000);

const sweep = setInterval(() => {
  for (const ch of QUEUE.channels()) { if (QUEUE.sweepNoShow(ch)) bcastQ(ch); QUEUE.prune(ch); }
}, 20000);

process.on('unhandledRejection', e => console.error('[unhandled]', e));
process.on('uncaughtException',  e => console.error('[uncaught]', e));
function shutdown() {
  clearInterval(hb); clearInterval(sweep); try { BRIDGE.stop(); } catch (_) {}
  wss.clients.forEach(c => { try { c.close(1001, 'restart'); } catch (_) {} });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

server.listen(PORT, () => {
  console.log('[queue] พร้อมที่พอร์ต', PORT);
  BRIDGE.start(bcastQ);                        // สะพานเริ่มทำงานตรงนี้
});