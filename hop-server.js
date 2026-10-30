'use strict';
// سيرفر صغير تشغّله على جوالك (ترمكس) أو أي جهاز ببيتك: الأكشن يطلب منه الرابط فيجيبه من IP بيتك ويرجّعه.
// بدون أي مكتبات. التشغيل:   HOP_KEY=سرك PORT=8787 node hop-server.js
// ثم افتح نفق له:            cloudflared tunnel --url http://localhost:8787     (يعطيك رابط https://xxxx.trycloudflare.com)
const http = require('http');
const { Readable } = require('stream');
const KEY = process.env.HOP_KEY || '';
if (!KEY || KEY.length < 8) { console.error('حط HOP_KEY (8 حروف على الأقل)'); process.exit(1); }
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const deny = (c, m) => { res.writeHead(c, { 'x-hop-denied': '1' }); res.end(m); };
  if (u.pathname !== '/raw') return deny(404, 'not found');
  if (req.headers['x-hop-key'] !== KEY) return deny(401, 'denied');
  let target; try { target = new URL(u.searchParams.get('u') || ''); if (!/^https?:$/.test(target.protocol)) throw 0; } catch { return deny(400, 'bad url'); }
  let h = {}; try { h = JSON.parse(Buffer.from(req.headers['x-hop-h'] || '', 'base64url').toString() || '{}'); } catch (_e) { /* */ }
  for (const k of Object.keys(h)) if (/^(host|content-length|connection|x-hop-.*)$/i.test(k)) delete h[k];
  const ctrl = new AbortController();
  res.on('close', () => ctrl.abort());
  try {
    const r = await fetch(target, { headers: h, redirect: 'follow', signal: ctrl.signal });
    const out = { 'x-hop-url': r.url || target.toString() };
    for (const k of ['content-type', 'content-range', 'accept-ranges']) { const v = r.headers.get(k); if (v) out[k] = v; }
    res.writeHead(r.status, out);
    if (!r.body) return res.end();
    Readable.fromWeb(r.body).on('error', () => res.end()).pipe(res);
    console.log(r.status, target.host + target.pathname.slice(0, 40));
  } catch (e) { if (!res.headersSent) res.writeHead(502, { 'x-hop-error': '1' }); res.end('hop: ' + (e.message || e)); }
}).listen(+process.env.PORT || 8787, () => console.log('hop-server شغّال على', +process.env.PORT || 8787));
