'use strict';
// اختبار أماكن الطلب: يجرّب رابط المصدر من جهاز الأكشن عبر كل طريقة (مباشر + كل دولة) × أشكال الهيدرز، ويطبع النتيجة.
// الاستخدام: URL=... [REF=...] node test-egress.js     (يُشغَّل من workflow: Test CDN Reach)
const e = require('./egress');
const URL_ = process.env.URL_TEST || process.env.URL || '';
const REF = (process.env.REF || '').trim();
if (!/^https?:\/\//.test(URL_)) { console.error('حط رابط صحيح'); process.exit(1); }
const host = new URL(URL_).hostname;
const CHROME = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';
const VLC = 'VLC/3.0.20 LibVLC/3.0.20';
const variants = [
  ['بدون Referer', { 'User-Agent': VLC }],
  ['Referer=المصدر', { 'User-Agent': CHROME, Referer: `https://${host}/`, Origin: `https://${host}` }],
  ...(REF ? [['Referer=' + REF, { 'User-Agent': CHROME, Referer: REF, Origin: new URL(REF).origin }]] : []),
];

async function one(strat, headers) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await e.runStrategy(strat, URL_, { headers }, ctrl.signal, {});
    let body = '';
    try { body = (await r.text()).slice(0, 4000); } catch (_x) { /* */ }
    return { status: r.status, len: body.length, ok: r.status < 400 && /<MPD|#EXTM3U/.test(body), note: r.status >= 400 ? body.replace(/\s+/g, ' ').slice(0, 100) : (/<MPD/.test(body) ? 'MPD سليم' : /#EXTM3U/.test(body) ? 'm3u8 سليم' : 'رد غريب: ' + body.replace(/\s+/g, ' ').slice(0, 60)) };
  } catch (err) {
    return { status: 0, ok: false, skip: !!err.skip, note: err.skip ? 'تخطّي: ' + err.message : String(err.message || err).slice(0, 80) };
  } finally { clearTimeout(t); }
}

(async () => {
  try {
    const g = await (await e.nativeFetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(8000) })).json();
    console.log(`جهاز الأكشن: ${g.city}, ${g.country} | ${g.org}`);
  } catch (_x) { /* */ }
  console.log(`المصدر: ${host}`);
  console.log(`عناوين DNS العادي: ${(await e.directIps(host)).join(', ') || '—'}\n`);
  const good = [];
  for (const strat of e.ALL) {
    let ips = '';
    if (strat.startsWith('ecs:')) { const a = await e.ecsIps(host, strat.slice(4)); ips = a ? a.join(', ') : 'ما رجع جواب'; }
    console.log(`── ${strat}${ips ? '  (' + ips + ')' : ''}`);
    const res = await Promise.all(variants.map(([, h]) => one(strat, h)));
    res.forEach((r, i) => {
      const mark = r.ok ? '✅' : r.skip ? '⏭️' : '❌';
      console.log(`   ${mark} ${variants[i][0]}: ${r.status ? 'HTTP ' + r.status : 'خطأ'} — ${r.note}`);
      if (r.ok) good.push(`${strat} + ${variants[i][0]}`);
    });
  }
  console.log('\n== الاختيار التلقائي (نفس اللي يسويه الريلاي) ==');
  try {
    const r = await e.upFetch(URL_, { headers: variants[1][1] });
    console.log(`HTTP ${r.status} عبر: ${r.headers.get('x-egress') || (e.status().hosts[host] || {}).winner || 'غير معروف'}`);
    try { await r.body.cancel(); } catch (_x) { /* */ }
  } catch (err) { console.log('فشل: ' + err.message); }
  console.log('\n== الخلاصة ==');
  if (good.length) { console.log('✅ الطرق اللي نجحت:'); good.forEach((x) => console.log('  - ' + x)); }
  else console.log('❌ ما نجح ولا طريق. لو كل الردود 403 بنفس الرسالة حتى مع تغيير الدولة والـ Referer، فالمشكلة مو الدولة (توكن/مصدر الرابط نفسه).');
})();
