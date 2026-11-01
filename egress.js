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
//   hop:<url>   جوالك/جهازك: يشغّل hop-server.js ويطلب الأكشن منه الرابط، فيطلع الطلب من IP بيتك (للمصادر اللي تربط التوكن بالـ IP)
//   EGRESS_HOPS=https://xxxx.trycloudflare.com   رابط/روابط hop-server (مفصولة بفاصلة)
//   EGRESS_HOPS=gist:<GIST_ID>   الأفضل: hop-agent.js على جوالك ينشر رابط نفقه الحالي بـ Gist، والأكشن يقرأه تلقائي (ما تحدّث سر لما يتغير)
//   HOP_KEY=...               مفتاح سري نفسه في الأكشن وفي hop-server
//   EGRESS_COUNTRIES=SA,AE,…  الدول وترتيبها (الافتراضي: SA,AE,KW,QA,BH,OM,EG,JO)
//   EGRESS_SUBNETS_SA=a/24,…  استبدال شبكات دولة (نفس الصيغة لباقي الدول)
//   EGRESS_STAGGER_MS=1500  EGRESS_TIMEOUT_MS=30000  EGRESS_TTL_MS=900000  EGRESS_BAD=401,403,429,451,5xx
const dns = require('dns');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const net = require('net');
const { Readable } = require('stream');

const nativeFetch = globalThis.fetch.bind(globalThis);
const ENABLED = process.env.EGRESS !== '0';
const STAGGER = +process.env.EGRESS_STAGGER_MS || 1500;
const TIMEOUT = +process.env.EGRESS_TIMEOUT_MS || 30000; // مهلة انتظار أول رد (قبل الطبقة ما كان فيه قطع مبكر، فلا نقطع المصدر البطيء)
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
const HOP_KEY = process.env.HOP_KEY || '';
const HOP_ENTRIES = (process.env.EGRESS_HOPS || '').split(',').map((x) => x.trim()).filter(Boolean);
const STATIC_HOPS = HOP_ENTRIES.filter((x) => /^https?:\/\//.test(x)).map((x) => x.replace(/\/+$/, ''));
const GISTS = HOP_ENTRIES.filter((x) => /^gist:/i.test(x)).map((x) => x.slice(5).trim()).filter(Boolean);
const GIST_API = (process.env.GIST_API || 'https://api.github.com').replace(/\/+$/, '');
const ALL = ['direct', ...COUNTRIES.map((c) => 'ecs:' + c), ...STATIC_HOPS.map((h) => 'hop:' + h)];

// روابط الوسيط الحالية من Gist (ينشرها hop-agent.js من الجوال). كاش 90 ثانية، وتحديث أسرع (30ث) لو آخر طلب للوسيط فشل.
const gistCache = new Map(); let hopFailAt = 0;
async function gistHops(id) {
  const c = gistCache.get(id);
  const age = c ? Date.now() - c.at : Infinity;
  if (c && age < (hopFailAt > c.at ? 30000 : 90000)) return c.urls;
  let urls = c ? c.urls : [];
  try {
    const r = await nativeFetch(`${GIST_API}/gists/${encodeURIComponent(id)}`, { headers: { 'User-Agent': 'zone-relay', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const j = await r.json(); const f = j.files && (j.files['hop.json'] || Object.values(j.files)[0]);
      const d = JSON.parse((f && f.content) || '{}');
      urls = [].concat(d.urls || d.url || []).filter((x) => /^https?:\/\//.test(x)).map((x) => x.replace(/\/+$/, ''));
    }
  } catch (_e) { /* نبقى على آخر روابط معروفة */ }
  gistCache.set(id, { urls, at: Date.now() });
  return urls;
}
async function strategies() {
  const dyn = [];
  for (const id of GISTS) for (const u of await gistHops(id)) if (!ALL.includes('hop:' + u) && !dyn.includes('hop:' + u)) dyn.push('hop:' + u);
  return dyn.length ? [...ALL, ...dyn] : ALL;
}

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
  // مباشر = fetch العادي (اتصالات مُعاد استخدامها) مثل ما كان قبل الطبقة — الاتصال المخصص يُستخدم لـ DNS الدول بس
  if (strat === 'direct') return nativeFetch(url, { headers: init.headers, method: init.method, redirect: init.redirect || 'follow', signal });
  if (strat.startsWith('ecs:')) {
    if (net.isIP(u.hostname)) { const e = new Error('ip-literal'); e.skip = true; throw e; }
    const ips = await ecsIps(u.hostname, strat.slice(4));
    if (!ips) { const e = new Error('no-ecs-answer'); e.skip = true; throw e; }
    if (!ctx.direct) ctx.direct = directIps(u.hostname);
    if (sig(ips) === sig(await ctx.direct)) { const e = new Error('same-ips-as-direct'); e.skip = true; throw e; }
    return nodeRequest(url, init, signal, ips);
  }
  if (strat.startsWith('hop:')) {
    const r = await nativeFetch(`${strat.slice(4)}/raw?u=${encodeURIComponent(url)}`, {
      headers: { 'x-hop-key': HOP_KEY, 'x-hop-h': Buffer.from(JSON.stringify(flat(init.headers))).toString('base64url') },
      signal,
    });
    if (r.headers.get('x-hop-denied')) { const e = new Error('hop-denied (HOP_KEY غلط)'); e.skip = true; throw e; }
    if (r.headers.get('x-hop-error')) { const e = new Error('hop: ' + (await r.text()).slice(0, 80)); throw e; }
    const fin = r.headers.get('x-hop-url');
    if (fin) Object.defineProperty(r, 'url', { value: fin });
    return r;
  }
  throw new Error('unknown strategy');
}

// ---------- ذاكرة لكل دومين ----------
const hosts = new Map(); // host → { winner, exp, ok:{strat:ts}, fail:{strat:ts}, log:[...] }
const stOf = (h) => { let s = hosts.get(h); if (!s) { s = { winner: null, exp: 0, ok: {}, fail: {}, last: null }; hosts.set(h, s); } return s; };
function rank(st, list) {
  const now = Date.now();
  const w = st.winner && st.exp > now && list.includes(st.winner) ? st.winner : null;
  const rest = list.filter((s) => s !== w);
  const recentBad = (s) => st.fail[s] && now - st.fail[s] < 120000;
  rest.sort((a, b) => (recentBad(a) ? 1 : 0) - (recentBad(b) ? 1 : 0) || (st.ok[b] || 0) - (st.ok[a] || 0) || list.indexOf(a) - list.indexOf(b));
  return w ? [w, ...rest] : rest;
}

// إلغاء جسم رد ما نحتاجه — بدون ما يطلع Promise مرفوض (كان يوصل تيليجرام كـ 'This operation was aborted')
const drop = (r) => { try { const p = r && r.body && r.body.cancel(); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch (_e) { /* */ } };

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
        if (done) { drop(res); return; }
        if (!bad(res.status)) {
          st.ok[strat] = Date.now(); delete st.fail[strat];
          if (st.winner !== strat) console.log(`[egress] ${host} → ${strat} (${res.status})`);
          st.winner = strat; st.exp = Date.now() + TTL; st.last = { strat, status: res.status, at: new Date().toISOString() };
          return finish(() => { ctrls.forEach(([s, c]) => { if (s !== strat) c.abort(); }); if (best) drop(best.res); try { res.headers.set('x-egress', strat); } catch (_e) { /* */ } resolve(res); });
        }
        st.fail[strat] = Date.now(); if (strat.startsWith('hop:')) hopFailAt = Date.now();
        if (!best) best = { res, strat }; else drop(res);
        next();
      }, (err) => {
        clearTimeout(tm);
        if (done) return;
        if (!err.skip) { st.fail[strat] = Date.now(); if (strat.startsWith('hop:')) hopFailAt = Date.now(); }
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

// ---------- تنبيهات تليجرام: أي مصدر يتعطل أو ينتهي رابطه ----------
// يستخدم TELEGRAM_BOT_TOKEN و TELEGRAM_CHAT_ID الموجودين أصلًا بالأكشن. EGRESS_ALERTS=0 يوقفها.
// ما يرسل إلا لو الفشل استمر EGRESS_ALERT_MIN_MS (30ث) بدون ولا نجاح وبعد EGRESS_ALERT_AFTER (5) فشلات متتالية،
// رسالة وحدة لكل مشكلة (بدون رسالة رجوع)، ولا تتكرر لنفس المصدر قبل 30 دقيقة، وحد أقصى 4 رسائل كل 10 دقائق للكل.
const ALERT_AFTER = +process.env.EGRESS_ALERT_AFTER || 5;
const ALERT_MIN_MS = +process.env.EGRESS_ALERT_MIN_MS || 30000;
const ALERT_COOLDOWN = 30 * 60 * 1000;
const RECOVER_GOOD = 10;
const TG_API = (process.env.TELEGRAM_API || 'https://api.telegram.org').replace(/\/+$/, '');
const tgSent = [];
async function tg(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat || process.env.EGRESS_ALERTS === '0') return;
  const now = Date.now();
  while (tgSent.length && now - tgSent[0] > 10 * 60 * 1000) tgSent.shift();
  if (tgSent.length >= 4) { console.log('[egress] تنبيه محجوب (كثرة رسائل):', text.split('\n')[0]); return; }
  tgSent.push(now);
  try { await nativeFetch(`${TG_API}/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text }), signal: AbortSignal.timeout(8000) }); } catch (_e) { /* التنبيه ما يوقف البث */ }
}
const alertBad = (s) => s === 0 || s === 401 || s === 403 || s === 404 || s === 410 || s === 429 || s === 451 || s >= 500;
function reasonOf(status, st) {
  const viaHopBefore = Object.keys(st.ok).some((k) => k.startsWith('hop:') && Date.now() - st.ok[k] < 30 * 60 * 1000);
  const hopLine = viaHopBefore ? '\n📱 كان شغّال عن طريق جوالك: تأكد ترمكس شغّال والجوال على الواي فاي.' : '';
  if (status === 401 || status === 403 || status === 451) return `🚫 المصدر رفض الطلب (${status}) — غالبًا توكن الرابط انتهى أو الـ IP محجوب. جب رابط جديد.${hopLine}`;
  if (status === 404 || status === 410) return `📭 المقاطع ما عادت تنجاب (${status}) — غالبًا البث وقف أو انتهى.${hopLine}`;
  if (status === 429) return `⏳ المصدر يحدّ الطلبات (429) — قلّل الضغط أو انتظر.`;
  if (status >= 500) return `🛠️ المصدر معطّل (${status}).${hopLine}`;
  return `📡 ما قدرت أوصل للمصدر (شبكة أو مهلة).${hopLine}`;
}
function track(host, status, st) {
  const a = st.alert || (st.alert = { bad: 0, good: 0, since: 0, alerted: false, lastAlertAt: 0, alertSince: 0 });
  if (!alertBad(status)) {
    a.bad = 0; a.since = 0;
    if (a.alerted && ++a.good >= RECOVER_GOOD) {
      a.alerted = false; a.good = 0; // رجع يشتغل: بدون رسالة (يظهر بإحصائيات تليجرام)
    }
    return;
  }
  a.good = 0;
  if (!a.bad) a.since = Date.now();
  a.bad++;
  if (!a.alerted && a.bad >= ALERT_AFTER && Date.now() - a.since >= ALERT_MIN_MS && Date.now() - a.lastAlertAt > ALERT_COOLDOWN) {
    a.alerted = true; a.lastAlertAt = Date.now(); a.alertSince = a.since;
    tg(`⚠️ Zone-BarMi: مشكلة في رابط\nالمصدر: ${host}\n${reasonOf(status, st)}`);
  }
}

async function upFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : String(input && input.url ? input.url : input);
  let u; try { u = new URL(url); } catch { return nativeFetch(input, init); }
  if (!ENABLED || !/^https?:$/.test(u.protocol) || init.body || u.hostname === 'localhost' || u.hostname === '127.0.0.1') return nativeFetch(input, init);
  // نذاكر الطريق الناجح لكل (دومين + نوع): الـ MPD/m3u8 نوع، والمقاطع والمفاتيح نوع ثاني. فلو الـ MPD احتاج جوالك، المقاطع تظل تجرّب الأكشن أول وما تروح لجوالك إلا لو انرفضت.
  const isManifest = /\.(mpd|m3u8?)$/i.test(u.pathname);
  const wantHop = !!init.hop; // ترمكس خيار تختاره لكل رابط (زر بالصفحة)؛ بدونه ما يروح لجوالك أبدًا
  const st = stOf(u.hostname + (isManifest ? '|m' : '') + (wantHop ? '|h' : ''));
  let list = await strategies();
  if (!wantHop) list = list.filter((x) => !x.startsWith('hop:'));
  else if (isManifest) list = [...list.filter((x) => x.startsWith('hop:')), ...list.filter((x) => !x.startsWith('hop:'))]; // الـ MPD أول شي من جوالك، والمقاطع من الأكشن أول
  let res;
  try {
    // المصدر اللي له طريق شغّال: نمشي عليه لحاله (بدون طلبات إضافية موازية للمصدر)، ولو فشل ندخل السباق على كل الطرق
    const order = rank(st, list), w = st.winner && st.exp > Date.now() && order[0] === st.winner ? st.winner : null;
    if (w) {
      const ctrl = new AbortController(); const tm = setTimeout(() => ctrl.abort(), TIMEOUT);
      if (init.signal) init.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
      try {
        const r0 = await runStrategy(w, url, init, ctrl.signal, {});
        clearTimeout(tm);
        if (!bad(r0.status)) { st.ok[w] = Date.now(); st.exp = Date.now() + TTL; st.last = { strat: w, status: r0.status, at: new Date().toISOString() }; track(u.hostname, r0.status, st); return r0; }
        drop(r0); st.fail[w] = Date.now();
      } catch (_e) { clearTimeout(tm); st.fail[w] = Date.now(); }
    }
    res = await race(order, url, init, u.hostname, st);
  }
  catch (e) { track(u.hostname, 0, st); throw e; }
  track(u.hostname, res.status, st);
  return res;
}


// ---------- معلومات للوحة: على أي طريق/IP يمشي كل مصدر ----------
const ipCache = new Map();
async function cachedIp(key, ttl, getter) {
  const c = ipCache.get(key);
  if (c && Date.now() - c.at < ttl) return c.ip;
  let ip = null;
  try { ip = (await getter()).trim().slice(0, 64) || null; } catch (_e) { /* */ }
  ipCache.set(key, { ip, at: Date.now() - (ip ? 0 : ttl - 15000) });
  return ip;
}
async function myIps() {
  const actionIp = await cachedIp('action', 10 * 60 * 1000, async () => (await nativeFetch('https://api.ipify.org', { signal: AbortSignal.timeout(6000) })).text());
  let phoneIp = null;
  const hop = (await strategies()).find((x) => x.startsWith('hop:'));
  if (hop) phoneIp = await cachedIp('phone|' + hop, 5 * 60 * 1000, async () => (await runStrategy(hop, 'https://api.ipify.org', {}, AbortSignal.timeout(8000), {})).text());
  return { actionIp, phoneIp, hasHop: !!hop };
}
function hostInfo(host) {
  const pickAny = (keys) => keys.map((k) => hosts.get(host + k)).filter((st) => st && st.last).map((st) => st.last).sort((a, b) => (a.at < b.at ? 1 : -1))[0] || null;
  const f = (l) => (l ? { via: l.strat, status: l.status, at: l.at } : null);
  return { host, manifest: f(pickAny(['|m|h', '|m'])), segments: f(pickAny(['|h', ''])) };
}
function status() {
  const o = { enabled: ENABLED, strategies: ALL, hops: STATIC_HOPS.length + GISTS.length, hosts: {} };
  for (const [h, s] of hosts) o.hosts[h] = { winner: s.winner, fresh: s.exp > Date.now(), last: s.last, failedRecently: Object.keys(s.fail).filter((k) => Date.now() - s.fail[k] < 120000) };
  return o;
}

if (ENABLED) globalThis.__upFetch = upFetch;

module.exports = { upFetch, status, nativeFetch, runStrategy, ecsIps, directIps, ALL, strategies, hostInfo, myIps };
