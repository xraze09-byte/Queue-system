// ════════════════════════════════════════════════════════════════════
//  ไฟล์ใหม่:  queue.js   (วางข้างๆ server.js และ tts.js)
//  ไม่มี dependency ใหม่
// ════════════════════════════════════════════════════════════════════
'use strict';
const crypto = require('crypto');

// ── ค่าตั้งต้น (แอดมินแก้ได้จากหน้าเว็บ) ─────────────────────────────
const DEFAULT_CFG = {
  open        : true,      // เปิดรับคิวไหม
  pattern     : 'PPFPF',   // P=โดเนท F=ฟรี
  agingPerMin : 1,         // แต้มรอต่อนาที (0 = ปิด)
  minPaid     : 50,        // โดเนทขั้นต่ำที่นับเป็นคิวโดเนท
  slots       : 3,         // เรียกกี่คนต่อรอบ (FF สควอด = 3 + ตัวสตรีมเมอร์)
  mode        : 'br',      // br | cs | lw
  maxFree     : 40,        // เพดานคิวฟรี กันสแปม
  maxPaid     : 60,
  cooldownMin : 30,        // เล่นจบแล้วห้ามต่อคิวซ้ำกี่นาที
  cooldownPaid: 10,        // คิวโดเนทรอสั้นกว่า
  noShowSec   : 180,       // เรียกแล้วไม่เข้าห้องภายในกี่วินาที
  graceReq    : 1,         // คิวโดเนทให้อภัย no-show กี่ครั้ง
  roomCode    : '',        // รหัสห้องคัสตอม
  showCode    : false      // โชว์รหัสห้องบน overlay ไหม (ดูหมายเหตุ)
};

const UID_RE  = /^\d{6,14}$/;              // Free Fire UID
const NICK_RE = /^[\w\u0E00-\u0E7F .\-\[\]]{2,20}$/;
const MODES   = { br: 'Battle Royale', cs: 'Clash Squad', lw: 'Lone Wolf' };

// ── state ต่อห้อง ───────────────────────────────────────────────────
const Q = new Map();   // ch -> { cfg, list, round, played, seq, updated }

function getQ(ch) {
  if (!Q.has(ch)) {
    Q.set(ch, {
      cfg    : { ...DEFAULT_CFG },
      list   : [],       // คิวทั้งหมดรอบนี้
      round  : [],       // id ของคนที่ถูกเรียกอยู่ตอนนี้
      played : {},       // uid -> เวลาที่เล่นจบล่าสุด (คูลดาวน์)
      seq    : 0,
      updated: Date.now()
    });
  }
  return Q.get(ch);
}

// ── คะแนน + จัดลำดับตามรูปแบบสลอต ───────────────────────────────────
function scoreOf(e, cfg, now) {
  if (e.tier === 'free') return 0;
  return e.amount + ((now - e.ts) / 60000) * (cfg.agingPerMin || 0);
}

function buildOrder(st, now) {
  const cfg  = st.cfg;
  const wait = st.list.filter(e => e.status === 'waiting');
  const paid = wait.filter(e => e.tier === 'paid')
    .sort((a, b) => scoreOf(b, cfg, now) - scoreOf(a, cfg, now) || a.ts - b.ts);
  const free = wait.filter(e => e.tier === 'free')
    .sort((a, b) => a.ts - b.ts);

  const pat = (cfg.pattern || 'PPFPF').toUpperCase().replace(/[^PF]/g, '') || 'PF';
  const out = [];
  let pi = 0, fi = 0, k = 0;

  // เพดานกันลูปไม่รู้จบถ้า pattern แปลกๆ
  while ((pi < paid.length || fi < free.length) && out.length < 500) {
    const want = pat[k++ % pat.length];
    if (want === 'P') {
      if (pi < paid.length)      out.push(paid[pi++]);
      else if (fi < free.length) out.push(free[fi++]);   // โดเนทหมด → ฟรีกินสลอต
    } else {
      if (fi < free.length)      out.push(free[fi++]);
      else if (pi < paid.length) out.push(paid[pi++]);
    }
  }
  return out;
}

// ── สิ่งที่ส่งออกไปให้ overlay / หน้าโดเนท ──────────────────────────
// ⚠ ห้ามส่ง uid เต็มออกไปเด็ดขาด — UID ของ Free Fire ใช้ค้นหา/ส่งคำขอ
//   เป็นเพื่อนได้ การขึ้นจอสตรีมเท่ากับเปิดช่องให้คนสแปมคนดู
function pub(e, pos, admin) {
  const o = {
    id: e.id, pos,
    name  : e.name,
    uidTail: '…' + String(e.uid).slice(-3),
    tier  : e.tier,
    amount: e.tier === 'paid' ? e.amount : 0,
    status: e.status,
    note  : e.note || ''
  };
  if (admin) { o.uid = e.uid; o.ref = e.donationRef || ''; o.ts = e.ts; }
  return o;
}

function snapshot(ch, admin) {
  const st  = getQ(ch);
  const now = Date.now();
  const ord = buildOrder(st, now);
  const cur = st.list.filter(e => st.round.includes(e.id));

  return {
    t: 'q_state',
    d: {
      cfg: {
        open: st.cfg.open, pattern: st.cfg.pattern, mode: st.cfg.mode,
        modeName: MODES[st.cfg.mode] || st.cfg.mode,
        slots: st.cfg.slots, minPaid: st.cfg.minPaid,
        roomCode: (admin || st.cfg.showCode) ? st.cfg.roomCode : '',
        showCode: st.cfg.showCode,
        ...(admin ? { full: { ...st.cfg } } : {})
      },
      now,
      round  : cur.map((e, i) => pub(e, i + 1, admin)),
      list   : ord.slice(0, admin ? 200 : 30).map((e, i) => pub(e, i + 1, admin)),
      counts : {
        free : st.list.filter(e => e.tier === 'free' && e.status === 'waiting').length,
        paid : st.list.filter(e => e.tier === 'paid' && e.status === 'waiting').length,
        done : st.list.filter(e => e.status === 'done').length
      },
      updated: st.updated
    }
  };
}

// ── เข้าคิว ─────────────────────────────────────────────────────────
function join(ch, d, scope) {
  const st  = getQ(ch);
  const cfg = st.cfg;
  const now = Date.now();

  if (!cfg.open) return { err: 'คิวปิดรับอยู่ตอนนี้' };

  const name = String(d.name || '').trim();
  const uid  = String(d.uid  || '').replace(/\D/g, '');
  if (!NICK_RE.test(name)) return { err: 'ชื่อในเกมไม่ถูกต้อง (2-20 ตัว)' };
  if (!UID_RE.test(uid))   return { err: 'UID ต้องเป็นตัวเลข 6-14 หลัก' };

  // ── tier: client ขอเองไม่ได้ ต้องมาจากโดเนทที่แอดมินอนุมัติแล้วเท่านั้น
  const amount = scope === 'admin' ? Math.max(0, Number(d.amount) || 0) : 0;
  const tier   = (scope === 'admin' && amount >= cfg.minPaid) ? 'paid' : 'free';

  // กันโดเนทรายการเดียวกันเข้าคิวซ้ำ (เช่น relay replay backlog)
  if (scope === 'admin' && d.ref && st.list.some(e => e.donationRef && e.donationRef === String(d.ref).slice(0, 64)))
    return { err: 'โดเนทรายการนี้เข้าคิวไปแล้ว' };

  // กันต่อคิวซ้อน
  if (st.list.some(e => e.uid === uid && ['waiting', 'called', 'playing'].includes(e.status)))
    return { err: 'UID นี้อยู่ในคิวแล้ว' };

  // คูลดาวน์หลังเล่นจบ
  const last = st.played[uid];
  const cd   = (tier === 'paid' ? cfg.cooldownPaid : cfg.cooldownMin) * 60000;
  if (last && now - last < cd) {
    const left = Math.ceil((cd - (now - last)) / 60000);
    return { err: 'เพิ่งเล่นไป รออีก ' + left + ' นาที' };
  }

  const cap = tier === 'paid' ? cfg.maxPaid : cfg.maxFree;
  if (st.list.filter(e => e.tier === tier && e.status === 'waiting').length >= cap)
    return { err: 'คิว' + (tier === 'paid' ? 'โดเนท' : 'ฟรี') + 'เต็มแล้ว' };

  const e = {
    id: crypto.randomBytes(8).toString('hex'),
    seq: ++st.seq, ts: now,
    name, uid, tier, amount,
    donationRef: scope === 'admin' ? String(d.ref || '').slice(0, 64) : '',
    note  : String(d.note || '').slice(0, 60),
    status: 'waiting',
    grace : tier === 'paid' ? cfg.graceReq : 0,
    calledAt: 0
  };
  st.list.push(e);
  st.updated = now;
  return { ok: true, entry: e };
}

// ── เรียกคิวถัดไป ───────────────────────────────────────────────────
function callNext(ch, n) {
  const st  = getQ(ch);
  const now = Date.now();

  // ใครยังค้างอยู่ในรอบเดิมให้ถือว่าเล่นจบก่อน
  finishRound(ch, 'done');

  const take = Math.max(1, Math.min(10, n || st.cfg.slots));
  const ord  = buildOrder(st, now).slice(0, take);
  if (!ord.length) return { err: 'ไม่มีคิวรออยู่' };

  st.round = ord.map(e => e.id);
  ord.forEach(e => { e.status = 'called'; e.calledAt = now; });
  st.updated = now;
  return { ok: true, called: ord.map(e => ({ ...e })) };
}

function finishRound(ch, as) {
  const st = getQ(ch);
  if (!st.round.length) return;
  const now = Date.now();
  st.list.forEach(e => {
    if (!st.round.includes(e.id)) return;
    e.status = as;
    if (as === 'done') st.played[e.uid] = now;   // เริ่มนับคูลดาวน์
  });
  st.round = [];
  st.updated = now;
}

// ── no-show : เรียกแล้วไม่เข้าห้อง ───────────────────────────────────
// คิวโดเนทที่มี grace เหลือ จะถูกส่งกลับไปต่อคิวด้วย ts เดิม
// = ได้ตำแหน่งเดิมคืน ไม่ใช่ไปต่อท้ายแถว (เพราะเขาจ่ายเงินมาแล้ว)
function sweepNoShow(ch) {
  const st  = getQ(ch);
  const now = Date.now();
  let changed = false;
  st.list.forEach(e => {
    if (e.status !== 'called') return;
    if (now - e.calledAt < st.cfg.noShowSec * 1000) return;
    if (e.grace > 0) {
      e.grace--; e.status = 'waiting'; e.calledAt = 0;
      e.note = 'ไม่เข้าห้อง (เหลือสิทธิ์ ' + e.grace + ')';
    } else {
      e.status = 'noshow';
    }
    st.round = st.round.filter(id => id !== e.id);
    changed = true;
  });
  if (changed) st.updated = now;
  return changed;
}

// ── คำสั่งแอดมิน ────────────────────────────────────────────────────
function admin(ch, d) {
  const st = getQ(ch);
  const a  = d.act;
  const id = d.id;
  const e  = id ? st.list.find(x => x.id === id) : null;

  switch (a) {
    case 'call':    return callNext(ch, d.n);
    case 'done':    finishRound(ch, 'done');    return { ok: true };
    case 'cancel':  finishRound(ch, 'waiting'); return { ok: true };
    case 'remove':
      if (!e) return { err: 'ไม่พบรายการ' };
      e.status = 'removed';
      st.round = st.round.filter(x => x !== id);
      break;
    case 'bump':                        // ดันขึ้นหัวคิว (ใช้ตอนต้องแก้ปัญหาสด)
      if (!e) return { err: 'ไม่พบรายการ' };
      e.ts = 0; e.amount = 999999; e.tier = 'paid';
      e.note = 'ดันคิวโดยแอดมิน';
      break;
    case 'tier':                        // เปลี่ยนฟรี↔โดเนทด้วยมือ
      if (!e) return { err: 'ไม่พบรายการ' };
      e.tier   = d.tier === 'paid' ? 'paid' : 'free';
      e.amount = e.tier === 'paid' ? Math.max(st.cfg.minPaid, Number(d.amount) || st.cfg.minPaid) : 0;
      break;
    case 'clear':
      st.list = []; st.round = []; st.seq = 0;
      break;
    case 'clearCd': st.played = {}; break;
    case 'cfg': {
      const c = d.cfg || {};
      const n = st.cfg;
      if (c.open     !== undefined) n.open     = !!c.open;
      if (c.showCode !== undefined) n.showCode = !!c.showCode;
      if (c.pattern) n.pattern = String(c.pattern).toUpperCase().replace(/[^PF]/g, '').slice(0, 12) || 'PF';
      if (c.mode && MODES[c.mode]) n.mode = c.mode;
      if (c.roomCode !== undefined) n.roomCode = String(c.roomCode).slice(0, 24);
      ['agingPerMin','minPaid','slots','maxFree','maxPaid',
       'cooldownMin','cooldownPaid','noShowSec','graceReq'].forEach(k => {
        if (c[k] !== undefined && Number.isFinite(+c[k]))
          n[k] = Math.max(0, Math.min(100000, +c[k]));
      });
      break;
    }
    case 'restore': {                   // กู้คิวหลัง server รีสตาร์ท
      if (st.list.length) return { err: 'มีคิวอยู่แล้ว ไม่เขียนทับ' };
      const src = Array.isArray(d.list) ? d.list.slice(0, 200) : [];
      st.list = src.filter(x => x && UID_RE.test(String(x.uid || '')))
                   .map(x => ({
                     id: String(x.id || crypto.randomBytes(8).toString('hex')).slice(0, 32),
                     seq: ++st.seq, ts: Number(x.ts) || Date.now(),
                     name: String(x.name || '').slice(0, 20),
                     uid : String(x.uid).replace(/\D/g, ''),
                     tier: x.tier === 'paid' ? 'paid' : 'free',
                     amount: Math.max(0, Number(x.amount) || 0),
                     note: 'กู้คืน', status: 'waiting',
                     grace: x.tier === 'paid' ? st.cfg.graceReq : 0, calledAt: 0
                   }));
      return { ok: true, restored: st.list.length };
    }
    default: return { err: 'คำสั่งไม่รู้จัก' };
  }
  st.updated = Date.now();
  return { ok: true };
}

function prune(ch) {
  const st = getQ(ch);
  const dead = st.list.filter(e => ['done', 'removed', 'noshow'].includes(e.status));
  if (dead.length > 300) {
    const drop = new Set(dead.sort((a, b) => a.ts - b.ts).slice(0, dead.length - 300).map(e => e.id));
    st.list = st.list.filter(e => !drop.has(e.id));
  }
  // คูลดาวน์เก่าเกิน 6 ชม. ไม่จำเป็นต้องเก็บ
  const cut = Date.now() - 6 * 3600 * 1000;
  for (const k of Object.keys(st.played)) if (st.played[k] < cut) delete st.played[k];
}

function channels() { return [...Q.keys()]; }
function dropRoom(ch) { Q.delete(ch); }

module.exports = { getQ, join, admin, callNext, sweepNoShow, snapshot, prune, channels,
                   buildOrder, dropRoom, MODES, DEFAULT_CFG };