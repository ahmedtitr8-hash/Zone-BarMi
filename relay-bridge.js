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
  app.all(/^\/live\//, async (req, res) => {
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
