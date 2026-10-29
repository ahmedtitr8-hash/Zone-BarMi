'use strict';
// يوجّه اتصالات الريلاي لدومينات معيّنة (افتراضيًا starzplayarabia.com) عبر طريق CloudFront بدل Akamai.
// السبب: DNS المصدر يوجّه جهاز GitHub (أمريكا) لـ Akamai اللي يرفضه بـ 403، ويوجّه الإمارات لـ CloudFront اللي يقبل.
// الطريقة: نسأل DNS (dns.google) مع عنوان سعودي (ECS) ونأخذ عناوين CloudFront، ونتصل فيها (نفس الدومين/الشهادة/Host، العنوان بس يتغير).
// أي دومين ثاني ما يتأثر. أي فشل (DNS ما رد، ما لقى CloudFront...) → يرجع للـDNS العادي بالضبط.
//
// إعدادات اختيارية (متغيرات بيئة):
//   DNS_PIN_HOSTS    دومينات (تنتهي بها) مفصولة بفاصلة            الافتراضي: starzplayarabia.com
//   DNS_PIN_SUBNETS  شبكات إماراتية للتوجيه مفصولة بفاصلة            الافتراضي: 86.96.0.0/24,217.165.0.0/24,2.50.0.0/24,83.110.0.0/24
//   DNS_PIN_PREFER   كلمة لازم تظهر بسلسلة CNAME عشان نقبل الجواب   الافتراضي: cloudfront
//   DNS_PIN_IPS      عناوين ثابتة تُستخدم بدل الاستعلام (للطوارئ)   الافتراضي: فاضي
//   DNS_PIN=0        يعطّل كل شي
const dns = require('dns');
const util = require('util');

const ENABLED = process.env.DNS_PIN !== '0';
const HOSTS = (process.env.DNS_PIN_HOSTS || 'starzplayarabia.com').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const SUBNETS = (process.env.DNS_PIN_SUBNETS || '86.96.0.0/24,217.165.0.0/24,2.50.0.0/24,83.110.0.0/24').split(',').map((x) => x.trim()).filter(Boolean);
const PREFER = (process.env.DNS_PIN_PREFER || 'cloudfront').toLowerCase();
const STATIC_IPS = (process.env.DNS_PIN_IPS || '').split(',').map((x) => x.trim()).filter(Boolean);
const TTL_OK = 60 * 1000;   // نعيد السؤال كل دقيقة (عناوين CloudFront تتغير)
const TTL_BAD = 20 * 1000;  // لو فشل السؤال، نرجع للعادي ونعيد المحاولة بعد 20 ثانية

const matches = (h) => {
  h = String(h || '').toLowerCase();
  return HOSTS.some((d) => h === d || h.endsWith('.' + d));
};

const cache = new Map();     // host → { ips, exp }
const inflight = new Map();  // host → Promise

async function query(host) {
  if (STATIC_IPS.length) return STATIC_IPS;
  for (const subnet of SUBNETS) {
    try {
      const url = `https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A&edns_client_subnet=${encodeURIComponent(subnet)}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) continue;
      const j = await r.json();
      const ans = j.Answer || [];
      const viaPreferred = ans.some((a) => a.type === 5 && String(a.data).toLowerCase().includes(PREFER));
      const ips = ans.filter((a) => a.type === 1).map((a) => a.data);
      if (viaPreferred && ips.length) return ips;
    } catch (_e) { /* جرّب الشبكة التالية */ }
  }
  return null;
}

function resolvePinned(host) {
  const c = cache.get(host);
  if (c && c.exp > Date.now()) return Promise.resolve(c.ips);
  if (inflight.has(host)) return inflight.get(host);
  const p = query(host).then((ips) => {
    const had = c && c.ips;
    cache.set(host, { ips, exp: Date.now() + (ips ? TTL_OK : TTL_BAD) });
    if (ips && (!had || had.join() !== ips.join())) console.log(`[dns-pin] ${host} -> ${ips.join(', ')}`);
    if (!ips && !(c && c.fail)) console.log(`[dns-pin] ${host}: ما لقيت طريق ${PREFER}، أرجع للـDNS العادي`);
    if (!ips) cache.get(host).fail = true;
    return ips;
  }).catch(() => null).finally(() => inflight.delete(host));
  inflight.set(host, p);
  return p;
}

if (ENABLED && HOSTS.length && !dns.lookup.__zonePinned) {
  const orig = dns.lookup;
  let rr = 0;
  const patched = function lookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    else if (typeof options === 'number') options = { family: options };
    options = options || {};
    if (!matches(hostname) || options.family === 6) return orig.call(dns, hostname, options, callback);
    resolvePinned(String(hostname).toLowerCase()).then((ips) => {
      if (!ips || !ips.length) return orig.call(dns, hostname, options, callback);
      if (options.all) return callback(null, ips.map((a) => ({ address: a, family: 4 })));
      callback(null, ips[rr++ % ips.length], 4);
    }, () => orig.call(dns, hostname, options, callback));
  };
  patched.__zonePinned = true;
  if (orig[util.promisify.custom]) patched[util.promisify.custom] = orig[util.promisify.custom];
  dns.lookup = patched;
  console.log(`[dns-pin] مفعّل لـ: ${HOSTS.join(', ')}`);
}

module.exports = { matches };
