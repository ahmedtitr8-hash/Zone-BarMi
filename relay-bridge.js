// يشغّل نفس ريلاي Vercel (vercel-relay/api) داخل server.js — فيشتغل على الأكشن (GitHub) عبر النفق.
// ما فيه كود مكرر: نفس ملفات vercel-relay/api تُستخدم هنا وهناك، فأي تعديل عليها يسري على الاثنين.
//   /relay?url=...&ref=...   → تمرير HLS (relay.js، Edge بصيغة Web Request/Response)
//   /mh/new, /mh/<token>/... → MPD مشفّر → HLS مفكوك (mpd2hls.js، Node)
// المتغير السري SEAL_SECRET لازم يكون نفسه المستخدم بـ Vercel (تنفع الروابط على الاثنين).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { pathToFileURL } = require('url');

// طبقة الطلعة العامة (egress.js): كل مصدر يجرّب عدة طرق (مباشر / DNS بدولة / وسطاء) ويتذكر الناجح — بديل dns-pin.js
let egress = null;
try { egress = require('./egress'); } catch (e) { console.error('[egress] ما اشتغل:', e && e.message); }

const API_DIR = path.join(__dirname, 'vercel-relay', 'api');

// relay.js مكتوب ESM بدون "type": "module" — ننسخه مؤقتًا بامتداد .mjs ونستورده (مصدر واحد للكود).
let edgeHandlerPromise = null;
function loadEdgeHandler() {
  if (!edgeHandlerPromise) {
    edgeHandlerPromise = (async () => {
      const tmp = path.join(os.tmpdir(), `zbm-relay-${process.pid}.mjs`);
      fs.copyFileSync(path.join(API_DIR, 'relay.js'), tmp);
      const mod = await import(pathToFileURL(tmp).href);
      return mod.default;
    })();
  }
  return edgeHandlerPromise;
}

function originOf(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host).split(',')[0].trim();
  return `${proto}://${host}`;
}

function mount(app) {
  const mpd2hls = require(path.join(API_DIR, 'mpd2hls.js'));

  // ---- إحصائيات الروابط (تظهر برسالة تليجرام الدورية) ----
  const hits = new Map(); // مفتاح → { label, host, ev:[{t,s,ip}] }
  const clientIp = (req) => String(req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || req.ip || '').trim();
  const hostOfTok = (t) => { try { return new URL(mpd2hls.unseal(t).u).hostname; } catch (_e) { return null; } };
  app.use((req, res, next) => {
    const p = req.path; let m, key, label, host = null;
    if ((m = p.match(/^\/mh\/s\/([A-Za-z0-9_-]+)\//)) || (m = p.match(/^\/mh\/([A-Za-z0-9_-]{20,})\//))) { host = hostOfTok(m[1]); if (!host) return next(); key = 'mh:' + host; label = host; }
    else if ((m = p.match(/^\/live\/([a-z0-9_-]+)\//i))) {
      key = 'live:' + m[1]; label = m[1];
      try { const v = (globalThis.__relayNames || new Map()).get(m[1]); if (v && v.o) host = new URL(v.o).hostname; } catch (_e) { /* */ }
    } else if ((m = p.match(/^\/u\/([^/]+)\//))) { host = m[1]; key = 'u:' + host; label = host; }
    else return next();
    const ip = clientIp(req);
    res.on('finish', () => {
      let h = hits.get(key); if (!h) { h = { label, host, ev: [] }; hits.set(key, h); }
      if (host && !h.host) h.host = host;
      h.ev.push({ t: Date.now(), s: res.statusCode, ip });
      if (h.ev.length > 3000) h.ev.splice(0, h.ev.length - 3000);
    });
    next();
  });
  globalThis.__linkStats = async () => {
    const now = Date.now();
    const ips = egress ? await egress.myIps().catch(() => ({})) : {};
    const ptrs = typeof globalThis.__pointers === 'function' ? globalThis.__pointers() : [];
    const rows = [];
    for (const [key, h] of hits) {
      h.ev = h.ev.filter((e) => now - e.t < 30 * 60 * 1000);
      const w = h.ev.filter((e) => now - e.t < 10 * 60 * 1000);
      if (!w.length) continue;
      const errs = w.filter((e) => e.s >= 400);
      const tail = w.slice(-5);
      const bad = (errs.length >= 5 && errs.length / w.length >= 0.5) || (tail.length === 5 && tail.every((e) => e.s >= 400));
      let names = [];
      if (key.startsWith('mh:')) names = ptrs.filter(([, p]) => { const m = String(p.path || '').match(/^\/mh\/([A-Za-z0-9_-]{20,})\//); return m && hostOfTok(m[1]) === h.host; }).map(([n]) => n);
      let manifest = null, segments = null;
      if (egress && h.host) { const i = egress.hostInfo(h.host); manifest = i.manifest && i.manifest.via; segments = i.segments && i.segments.via; }
      const kind = (v) => (!v ? null : v.startsWith('hop:') ? 'phone' : 'action');
      rows.push({
        name: names.length ? names.join('،') : h.label, host: h.host, reqs: w.length, errs: errs.length, bad,
        lastErr: errs.length ? errs[errs.length - 1].s : null, clients: new Set(h.ev.filter((e) => now - e.t < 120000).map((e) => e.ip)).size,
        manifest: kind(manifest), segments: kind(segments),
      });
    }
    rows.sort((a, b) => (b.bad - a.bad) || (b.clients - a.clients));
    return { rows, actionIp: ips.actionIp || null, phoneIp: ips.phoneIp || null };
  };

  // ---- /api/linkinfo: على أي طريق/IP يمشي رابط (للوحة) ----
  app.get('/api/linkinfo', async (req, res) => {
    const key = req.headers['x-api-key'] || req.query.key;
    if (!process.env.API_KEY || key !== process.env.API_KEY) return res.status(401).json({ error: 'مفتاح غير صالح' });
    if (!egress) return res.json({ enabled: false });
    let host = null;
    try {
      const m = String(req.query.link || '').match(/\/mh\/([A-Za-z0-9_-]{20,})\//);
      if (m) host = new URL(mpd2hls.unseal(m[1]).u).hostname;
    } catch (_e) { /* ما انفك */ }
    if (!host) return res.status(404).json({ error: 'نوع الرابط ما أقدر أعرف مصدره (يدعم روابط /mh)' });
    res.json({ ...egress.hostInfo(host), ...(await egress.myIps()) });
  });

  // ---- /relay (HLS) ----
  app.all('/relay', async (req, res) => {
    try {
      const handler = await loadEdgeHandler();
      const url = originOf(req) + req.originalUrl;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const r = await handler(new Request(url, { method: req.method, headers }));
      res.status(r.status);
      r.headers.forEach((v, k) => res.setHeader(k, v));
      if (!r.body || req.method === 'HEAD') return res.end();
      const stream = Readable.fromWeb(r.body);
      res.on('close', () => stream.destroy());
      stream.on('error', () => res.end());
      stream.pipe(res);
    } catch (e) {
      if (!res.headersSent) res.status(502).type('text/plain').send(String((e && e.message) || e));
      else res.end();
    }
  });

  // ---- /live/* ← نفس قاعدة vercel.json: /live/:rest → /relay?p=live/:rest (بدون هذي يطلع 404 على الأكشن) ----
  // استثناء مهم: لو أول جزء بعد /live هو اسم بث شغّال محليًا (مجلده موجود بـTEMP_DIR/live)، نمرره
  // لخدمة الملفات (express.static) بدل الريلاي — وإلا ملفات البث نفسه (stream.m3u8 والمقاطع) تنحول للريلاي وتفشل.
  const LIVE_ROOT = path.join(path.resolve(process.env.TEMP_DIR || './temp'), 'live');
  app.all(/^\/live\//, async (req, res, next) => {
    const slot = req.path.split('/')[2];
    if (slot && /^[\w-]+$/.test(slot) && fs.existsSync(path.join(LIVE_ROOT, slot))) return next();
    try {
      const handler = await loadEdgeHandler();
      const qi = req.originalUrl.indexOf('?');
      const qs = qi >= 0 ? req.originalUrl.slice(qi + 1) : '';
      const url = originOf(req) + '/relay?' + (qs ? qs + '&' : '') + 'p=' + encodeURIComponent(req.path.slice(1));
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const r = await handler(new Request(url, { method: req.method, headers }));
      res.status(r.status);
      r.headers.forEach((v, k) => res.setHeader(k, v));
      if (!r.body || req.method === 'HEAD') return res.end();
      const stream = Readable.fromWeb(r.body);
      res.on('close', () => stream.destroy());
      stream.on('error', () => res.end());
      stream.pipe(res);
    } catch (e) {
      if (!res.headersSent) res.status(502).type('text/plain').send(String((e && e.message) || e));
      else res.end();
    }
  });

  // ---- /u/<دومين>/... و /uh/<دومين>/... (وضع عام: أي مصدر، نفس مساره، تغيير الدومين فقط) — نفس قاعدة vercel.json ----
  app.all(/^\/uh?\//, async (req, res) => {
    try {
      const handler = await loadEdgeHandler();
      const qi = req.originalUrl.indexOf('?');
      const qs = qi >= 0 ? req.originalUrl.slice(qi + 1) : '';
      const url = originOf(req) + '/relay?' + (qs ? qs + '&' : '') + 'p=' + encodeURIComponent(req.path.slice(1));
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const r = await handler(new Request(url, { method: req.method, headers }));
      res.status(r.status);
      r.headers.forEach((v, k) => res.setHeader(k, v));
      if (!r.body || req.method === 'HEAD') return res.end();
      const stream = Readable.fromWeb(r.body);
      res.on('close', () => stream.destroy());
      stream.on('error', () => res.end());
      stream.pipe(res);
    } catch (e) {
      if (!res.headersSent) res.status(502).type('text/plain').send(String((e && e.message) || e));
      else res.end();
    }
  });

  // ---- /mh (MPD مشفّر → HLS) — نفس قواعد vercel.json ----
  const run = (mode, extra) => (req, res) => {
    const q = new URLSearchParams(req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1) : '');
    q.set('__m', mode);
    for (const [k, v] of Object.entries(extra ? extra(req) : {})) q.set(k, v);
    req.url = '/api/mpd2hls?' + q.toString();
    mpd2hls(req, res);
  };
  app.all('/mh/new', run('new'));
  app.all('/mh/s/:t/seg.mp4', run('seg', (req) => ({ __t: req.params.t })));
  app.all('/mh/:t/master.m3u8', run('master', (req) => ({ __t: req.params.t })));
  app.all('/mh/:t/:rep.m3u8', run('media', (req) => ({ __t: req.params.t, rep: req.params.rep })));
}

module.exports = { mount };
