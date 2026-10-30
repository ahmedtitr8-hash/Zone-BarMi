'use strict';
// طبقة "طلعة" عامة لكل الروابط: أي طلب للمصدر (MPD / m3u8 / مقاطع / مفاتيح) يجرّب عدة طرق لين يلقى اللي يشتغل،
// وينحفظ الناجح لكل دومين (بالذاكرة) فالطلبات الجاية تمشي عليه مباشرة. لو وقع (403 مثلًا) يعيد البحث لحاله.
//
// الطرق (بهذا الترتيب الافتراضي، والناجح سابقًا يتقدّم):
//   direct      DNS عادي من جهاز الأكشن
//   ecs:<CC>    نسأل DNS بشبكة دولة (SA/AE/KW/QA/BH/OM/EG/JO…) فيرجع عناوين CDN اللي تخدم هالدولة، ونتصل فيها (نفس Host/SNI)
//
// أسلوب التجربة: متدرّج (hedged) — نبدأ بالأولى، ولو ما ردّت خلال STAGGER_MS أو فشلت نبدأ التالية بالتوازي، وأول نجاح يفوز ونلغي الباقي.
// الفشل = خطأ شبكة، مهلة، أو حالة من BAD_STATUS (افتراضيًا 401/403/429/451 وكل 5xx). 404 يعتبر رد سليم.
//
// متغيرات البيئة (كلها اختيارية):
//   EGRESS=0                  يعطّل الطبقة كلها (يرجع fetch العادي)
//   EGRESS_COUNTRIES=SA,AE,…  الدول وترتيبها (الافتراضي: SA,AE,KW,QA,BH,OM,EG,JO)
//   EGRESS_SUBNETS_SA=a/24,…  استبدال شبكات دولة (نفس الصيغة لباقي الدول)
//   EGRESS_STAGGER_MS=1500  EGRESS_TIMEOUT_MS=9000  EGRESS_TTL_MS=900000  EGRESS_BAD=401,403,429,451,5xx
const dns = require('dns');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const net = require('net');
const { Readable } = require('stream');

const nativeFetch = globalThis.fetch.bind(globalThis);
const ENABLED = process.env.EGRESS !== '0';
const STAGGER = +process.env.EGRESS_STAGGER_MS || 1500;
const TIMEOUT = +process.env.EGRESS_TIMEOUT_MS || 9000;
const TTL = +process.env.EGRESS_TTL_MS || 15 * 60 * 1000;
const BAD = new Set((process.env.EGRESS_BAD || '401,403,429,451').split(',').map((x) => +x.trim()).filter(Boolean));
const bad = (s) => BAD.has(s) || s >= 500;

// شبكات افتراضية لكل دولة (/24 داخل نطاقات مزوّدين محليين) — عدّلها بـ EGRESS_SUBNETS_<CC> لو ما اشتغلت لدولة
const SUBNETS = {
  SA: ['188.54.0.0/24', '178.87.0.0/24', '37.224.0.0/24', '46.153.0.0/24'],
  AE: ['86.96.0.0/24', '217.165.0.0/24', '2.50.0.0/24', '83.110.0.0/24'],
  KW: ['188.70.0.0/24', '37.39.0.0/24'],
  QA: ['78.100.0.0/24', '82.148.0.0/24'],
  BH: ['80.88.0.0/24', '77.69.0.0/24'],
  OM: ['5.32.0.0/24', '94.200.0.0/24'],
  EG: ['41.234.0.0/24', '156.160.0.0/24'],
  JO: ['176.29.0.0/24', '37.123.0.0/24'],
};
const COUNTRIES = (process.env.EGRESS_COUNTRIES || 'SA,AE,KW,QA,BH,OM,EG,JO').split(',').map((x) => x.trim().toUpperCase()).filter((c) => c);
const subnetsOf = (cc) => { const e = (process.env['EGRESS_SUBNETS_' + cc] || '').split(',').map((x) => x.trim()).filter(Boolean); return e.length ? e : SUBNETS[cc] || []; };
const ALL = ['direct', ...COUNTRIES.map((c) => 'ecs:' + c)];

// ---------- DNS ----------
const ecsCache = new Map();
async function ecsIps(host, cc) {
  const key = host + '|' + cc, c = ecsCache.get(key);
  if (c && c.exp > Date.now()) return c.ips;
  let ips = null;
  for (const subnet of subnetsOf(cc)) {
    try {
      const r = await nativeFetch(`https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A&edns_client_subnet=${encodeURIComponent(subnet)}`, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) continue;
      const a = ((await r.json()).Answer || []).filter((x) => x.type === 1).map((x) => x.data);
      if (a.length) { ips = a; break; }
    } catch (_e) { /* الشبكة التالية */ }
  }
  ecsCache.set(key, { ips, exp: Date.now() + (ips ? 60000 : 20000) });
  return ips;
}
const sig = (ips) => (ips || []).slice().sort().join(',');
async function directIps(host) {
  try { return (await dns.promises.lookup(host, { all: true, family: 4 })).map((x) => x.address); } catch { return []; }
}

// ---------- طلب Node → Response ----------
const flat = (h) => { const o = {}; if (!h) return o; if (typeof h.forEach === 'function' && !Array.isArray(h)) h.forEach((v, k) => { o[k] = v; }); else if (Array.isArray(h)) h.forEach(([k, v]) => { o[k] = v; }); else Object.assign(o, h); return o; };

function nodeRequest(urlStr, init, signal, ips, hops = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    let n = 0;
    const lookup = ips && ips.length ? (_h, o, cb) => (o && o.all ? cb(null, ips.map((a) => ({ address: a, family: 4 }))) : cb(null, ips[n++ % ips.length], 4)) : undefined;
    const headers = { 'Accept-Encoding': 'gzip, deflate', ...flat(init.headers) };
    const req = lib.request(u, { method: init.method || 'GET', headers, lookup, agent: false, servername: net.isIP(u.hostname) ? undefined : u.hostname }, (res) => {
      const st = res.statusCode;
      if ([301, 302, 303, 307, 308].includes(st) && res.headers.location && (init.redirect || 'follow') === 'follow') {
        res.resume();
        if (hops >= 5) return reject(new Error('redirect loop'));
        let next; try { next = new URL(res.headers.location, u).toString(); } catch (e) { return reject(e); }
        return nodeRequest(next, init, signal, ips && net.isIP(new URL(next).hostname) ? null : ips, hops + 1).then(resolve, reject);
      }
      let body = res;
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      if (enc === 'gzip') body = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') body = res.pipe(zlib.createInflate());
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (enc && /^content-(encoding|length)$/i.test(k)) continue;
        if (Array.isArray(v)) v.forEach((x) => h.append(k, x)); else h.set(k, v);
      }
      const nobody = st === 204 || st === 205 || st === 304 || (init.method || 'GET') === 'HEAD';
      const out = new Response(nobody ? null : Readable.toWeb(body), { status: st, statusText: res.statusMessage || '', headers: h });
      if (nobody) res.resume();
      Object.defineProperty(out, 'url', { value: u.toString() });
      resolve(out);
    });
    req.on('error', reject);
    const onAbort = () => req.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
    req.end();
  });
}

// ---------- تنفيذ طريقة واحدة ----------
async function runStrategy(strat, url, init, signal, ctx) {
  const u = new URL(url);
  if (strat === 'direct') return nodeRequest(url, init, signal, null);
  if (strat.startsWith('ecs:')) {
    if (net.isIP(u.hostname)) { const e = new Error('ip-literal'); e.skip = true; throw e; }
    const ips = await ecsIps(u.hostname, strat.slice(4));
    if (!ips) { const e = new Error('no-ecs-answer'); e.skip = true; throw e; }
    if (!ctx.direct) ctx.direct = directIps(u.hostname);
    if (sig(ips) === sig(await ctx.direct)) { const e = new Error('same-ips-as-direct'); e.skip = true; throw e; }
    return nodeRequest(url, init, signal, ips);
  }
  throw new Error('unknown strategy');
}

// ---------- ذاكرة لكل دومين ----------
const hosts = new Map(); // host → { winner, exp, ok:{strat:ts}, fail:{strat:ts}, log:[...] }
const stOf = (h) => { let s = hosts.get(h); if (!s) { s = { winner: null, exp: 0, ok: {}, fail: {}, last: null }; hosts.set(h, s); } return s; };
function rank(st) {
  const now = Date.now();
  const w = st.winner && st.exp > now ? st.winner : null;
  const rest = ALL.filter((s) => s !== w);
  const recentBad = (s) => st.fail[s] && now - st.fail[s] < 120000;
  rest.sort((a, b) => (recentBad(a) ? 1 : 0) - (recentBad(b) ? 1 : 0) || (st.ok[b] || 0) - (st.ok[a] || 0) || ALL.indexOf(a) - ALL.indexOf(b));
  return w ? [w, ...rest] : rest;
}

function race(order, url, init, host, st) {
  return new Promise((resolve, reject) => {
    const ctx = {}; const ctrls = []; const timers = new Set();
    let i = 0, pending = 0, done = false, best = null, lastErr = null, nextTimer = null;
    const finish = (fn) => { if (done) return; done = true; clearTimeout(nextTimer); timers.forEach(clearTimeout); fn(); };
    const launch = () => {
      if (done || i >= order.length) return;
      const strat = order[i++]; pending++;
      const ctrl = new AbortController(); ctrls.push([strat, ctrl]);
      if (init.signal) init.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
      const tm = setTimeout(() => ctrl.abort(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), TIMEOUT); timers.add(tm);
      clearTimeout(nextTimer); if (i < order.length) nextTimer = setTimeout(launch, STAGGER);
      runStrategy(strat, url, init, ctrl.signal, ctx).then((res) => {
        clearTimeout(tm);
        if (done) { try { res.body && res.body.cancel(); } catch (_e) { /* */ } return; }
        if (!bad(res.status)) {
          st.ok[strat] = Date.now(); delete st.fail[strat];
          if (st.winner !== strat) console.log(`[egress] ${host} → ${strat} (${res.status})`);
          st.winner = strat; st.exp = Date.now() + TTL; st.last = { strat, status: res.status, at: new Date().toISOString() };
          return finish(() => { ctrls.forEach(([s, c]) => { if (s !== strat) c.abort(); }); if (best) { try { best.res.body && best.res.body.cancel(); } catch (_e) { /* */ } } try { res.headers.set('x-egress', strat); } catch (_e) { /* */ } resolve(res); });
        }
        st.fail[strat] = Date.now();
        if (!best) best = { res, strat }; else { try { res.body && res.body.cancel(); } catch (_e) { /* */ } }
        next();
      }, (err) => {
        clearTimeout(tm);
        if (done) return;
        if (!err.skip) st.fail[strat] = Date.now();
        lastErr = err; next();
      });
    };
    const next = () => {
      pending--;
      if (done) return;
      if (i < order.length) return launch();
      if (pending === 0) finish(() => (best ? resolve(best.res) : reject(lastErr || new Error('كل طرق الطلعة فشلت'))));
    };
    launch();
  });
}

async function upFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : String(input && input.url ? input.url : input);
  let u; try { u = new URL(url); } catch { return nativeFetch(input, init); }
  if (!ENABLED || !/^https?:$/.test(u.protocol) || init.body || u.hostname === 'localhost' || u.hostname === '127.0.0.1') return nativeFetch(input, init);
  const st = stOf(u.hostname);
  return race(rank(st), url, init, u.hostname, st);
}

function status() {
  const o = { enabled: ENABLED, strategies: ALL, hosts: {} };
  for (const [h, s] of hosts) o.hosts[h] = { winner: s.winner, fresh: s.exp > Date.now(), last: s.last, failedRecently: Object.keys(s.fail).filter((k) => Date.now() - s.fail[k] < 120000) };
  return o;
}

if (ENABLED) globalThis.__upFetch = upFetch;

module.exports = { upFetch, status, nativeFetch };
