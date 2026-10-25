'use strict';
// يشتغل بالأكشن الجديد بعد ما يجهز النفق: ينقل الحالة من القديم، يتأكد، ينشر، ويخبر القديم.
// لو أي شيء فشل قبل النشر: ما يتغير شيء عند المشاهدين، ويوصلك تنبيه.
const fs = require('fs');
const path = require('path');
const L = require('./lib');

const LOCAL = `http://127.0.0.1:${L.PORT}`;
const RETRY_TOTAL_MS = Number(process.env.AUTO_HANDOFF_RETRY_MS || 25 * 60 * 1000);
const RETRY_EVERY_MS = Number(process.env.AUTO_HANDOFF_RETRY_EVERY_MS || 2 * 60 * 1000);
const TUNNEL_WAIT_MS = Number(process.env.AUTO_TUNNEL_WAIT_MS || 3 * 60 * 1000);

async function waitFor(fn, ms, every = 3000) {
  const t = Date.now() + ms; let last;
  while (Date.now() < t) { last = await fn(); if (last && last.ok) return last; await L.sleep(every); }
  return last || { ok: false };
}

async function verifyItems(base, items) {
  const out = [];
  for (const it of items) {
    const r = await L.req(base + it.path, { headers: { 'user-agent': 'zone-auto-verify' } }, 20000);
    const m3u8 = /\.m3u8(\?|$)/i.test(it.path);
    out.push({ ...it, ok: r.ok && (!m3u8 || /^\s*#EXTM3U/.test(r.text)), status: r.status || r.error });
  }
  return out;
}

async function run() {
  const tunnel = String(process.env.TUNNEL_URL || '').replace(/\/+$/, '');
  if (!L.okTunnel(tunnel)) { await L.tg('❌ ما لقيت عنوان نفق صالح — التبديل ملغي'); return 1; }

  await L.tg(`🚇 النفق الجديد: ${tunnel}\nأتأكد إنه جاهز…`);
  const local = await waitFor(() => L.api(LOCAL, '/api/auto/status'), 90000);
  if (!local.ok) { await L.tg(`❌ السيرفر المحلي ما رد على /api/auto/status (${local.status || local.error}) — راجع server.log`); return 1; }
  const set = await L.api(LOCAL, '/api/auto/tunnel', 'POST', { url: tunnel });
  if (!set.ok) { await L.tg(`❌ تعذّر تسجيل عنوان النفق بالسيرفر: ${JSON.stringify(set.json || set.text).slice(0, 200)}`); return 1; }
  const viaTunnel = await waitFor(() => L.api(tunnel, '/api/auto/status'), TUNNEL_WAIT_MS);
  if (!viaTunnel.ok) { await L.tg(`❌ النفق ما صار يوصل للسيرفر خلال ${Math.round(TUNNEL_WAIT_MS / 60000)} دقايق (${viaTunnel.status || viaTunnel.error})`); return 1; }
  await L.tg('✅ النفق الجديد شغّال ويوصل للسيرفر');

  // النسخة القديمة (آخر ما نُشر)
  await L.gitSync();
  let oldUrl = '';
  try { oldUrl = String(JSON.parse(fs.readFileSync(path.join(L.ROOT, 'docs', 'current-stream.json'), 'utf8')).panelUrl || '').replace(/\/+$/, ''); } catch (_) {}
  let old = null;
  if (oldUrl && oldUrl !== tunnel) {
    const s = await L.api(oldUrl, '/api/auto/status', 'GET', undefined, 12000);
    if (s.ok && s.json && s.json.auto) old = { url: oldUrl, status: s.json };
    else await L.tg(`ℹ️ النسخة السابقة (${oldUrl}) ${s.status === 404 ? 'تشتغل باليدوي (ما فيها نقل حالة)' : 'ما ترد'} — أبدأ نظيف بدون نقل`);
  } else await L.tg('ℹ️ ما فيه نسخة سابقة — هذا أول تشغيل، أبدأ نظيف');

  const started = Date.now();
  let attempt = 0, lastReport = '';
  for (;;) {
    attempt++;
    let imported = null, items = [];
    if (old) {
      const ex = await L.api(old.url, '/api/auto/export', 'GET', undefined, 20000);
      if (!ex.ok) lastReport = `تعذّر سحب الحالة من القديم (${ex.status || ex.error})`;
      else {
        const snap = ex.json;
        await L.tg(`📥 سحبت الحالة من القديم (محاولة ${attempt})\nأسماء ممررة: ${(snap.relayNames || []).length} | مصادر: ${(snap.relayUps || []).length} | فك: ${(snap.decode || []).length} | روابط ثابتة: ${(snap.pointers || []).length}`);
        const im = await L.api(LOCAL, '/api/auto/import', 'POST', snap, 240000);
        if (!im.ok) lastReport = `فشل الاستيراد (${im.status || im.error}) ${JSON.stringify(im.json || '').slice(0, 200)}`;
        else {
          imported = im.json;
          const dec = imported.decode || [];
          const failed = dec.filter((d) => d.status === 'failed');
          await L.tg(`📤 استوردت للجديد\nأسماء ممررة +${imported.relayNames.added} (موجودة ${imported.relayNames.skipped}) | مصادر ${imported.relayUps} | روابط ثابتة ${imported.pointers}\nفك: بدأ ${dec.filter((d) => d.status === 'started').length} | موجود ${dec.filter((d) => d.status === 'already').length} | فشل ${failed.length}${failed.length ? '\n' + failed.map((d) => `• ${d.id}: ${d.error}`).join('\n') : ''}`);
          for (const n of snap.relayNames || []) items.push({ kind: 'ممرر', name: n.id, path: `/live/${n.id}/master.m3u8` });
          for (const d of snap.decode || []) items.push({ kind: 'فك', name: d.id, path: d.path });
          for (const p of snap.pointers || []) if (!items.some((i) => i.path === p.path)) items.push({ kind: 'رابط ثابت', name: p.name, path: p.path });
          lastReport = '';
          // فحص حقيقي: كل مسار على النفق الجديد، ولو فشل نقارنه بالقديم (لو القديم فاشل هو بعد، فالمصدر نفسه معطّل مو الجديد)
          const vNew = await verifyItems(tunnel, items);
          const blocking = [], warnings = [];
          for (const v of vNew.filter((x) => !x.ok)) {
            const vOld = (await verifyItems(old.url, [v]))[0];
            (vOld.ok ? blocking : warnings).push(v);
          }
          const failedDec = failed.map((d) => d.id);
          await L.tg(`🔎 فحص المسارات على النفق الجديد: ${vNew.filter((x) => x.ok).length}/${vNew.length} سليم${warnings.length ? '\n⚠️ فاشلة عند القديم بعد (المصدر معطّل، ما تمنع التبديل):\n' + warnings.map((w) => `• ${w.kind} ${w.name} (${w.status})`).join('\n') : ''}${blocking.length ? '\n❌ تمنع التبديل:\n' + blocking.map((w) => `• ${w.kind} ${w.name} (${w.status})`).join('\n') : ''}`);
          if (blocking.length || failedDec.length) lastReport = `فيه ${blocking.length + failedDec.length} عنصر ما اشتغل على الجديد`;
        }
      }
    }
    if (!lastReport) break;
    const left = RETRY_TOTAL_MS - (Date.now() - started);
    await L.tg(`⚠️ التبديل ما تم (محاولة ${attempt}): ${lastReport}\n${left > RETRY_EVERY_MS ? 'أعيد المحاولة بعد ' + Math.round(RETRY_EVERY_MS / 60000) + ' دقيقة. المشاهدين لسا على القديم وما تأثروا.' : ''}`);
    if (left <= RETRY_EVERY_MS) {
      await L.tg(`🛑 فشل التبديل نهائيًا بعد ${attempt} محاولات.\nالمشاهدين باقين على النسخة القديمة وهي تشتغل لين ينتهي وقتها، والجديدة شغّالة بدون نشر.\nتدخّل: شغّل الأكشن اليدوي، أو افتح اللوحة وراجع سجل الأكشن.`);
      return 2;
    }
    await L.sleep(RETRY_EVERY_MS);
  }

  // نشر: الروابط الثابتة + ملف الجلسة بكوميت واحد
  const pub = await L.api(LOCAL, '/api/auto/publish', 'POST', { panel: true, reason: `تشغيل #${L.CHAIN + 1}` }, 120000);
  if (!pub.ok) { await L.tg(`❌ فشل النشر على الصفحة (${(pub.json && pub.json.step) || pub.status})\n${String((pub.json && (pub.json.detail || pub.json.error)) || pub.text).slice(0, 300)}\nالمشاهدين لسا على القديم`); return 3; }
  const names = (pub.json && pub.json.names) || [];
  await L.tg(`📌 نشرت على الصفحة${pub.json.commit ? ' (كوميت ' + pub.json.commit + ')' : ''}\nالصفحة فيها عنوان النفق فقط. الأسماء (${names.length ? names.join('، ') : 'لا يوجد'}) تُحلّ من النفق نفسه، وما ينكتب أي رابط بث بالصفحة${pub.json.cleaned ? '\n🧹 حذفت ' + pub.json.cleaned + ' ملف ptr قديم (كان فيه روابط كاملة)' : ''}\nاللوحة تقرأ النفق الجديد لما تتحدّث الصفحة (دقيقة تقريبًا)`);

  // نتأكد إن الصفحة صارت تعرض النفق الجديد (للتقرير فقط، ما يمنع شيء)
  const base = L.pagesBase();
  if (base && process.env.AUTO_SKIP_PAGES_CHECK !== '1') {
    const seen = await waitFor(async () => {
      const r = await L.req(`${base}/current-stream.json?_=${Date.now()}`, {}, 10000);
      return { ok: !!(r.json && String(r.json.panelUrl || '').replace(/\/+$/, '') === tunnel) };
    }, 6 * 60 * 1000, 10000);
    await L.tg(seen.ok ? '🌐 صفحة GitHub صارت تعرض النفق الجديد' : '⚠️ صفحة GitHub لسا ما تحدّثت بعد 6 دقايق — القديم باقي وما ينتهي قبل ما أخبره، لكن راقب');
  }

  // نخبر القديم يعرض الجديد للمشاهدين
  if (old) {
    const nx = await L.api(old.url, '/api/auto/next', 'POST', { url: tunnel }, 30000);
    if (nx.ok) await L.tg('📣 أخبرت القديم: يعرض النفق الجديد للمشاهدين الحين. أي رابط تسويه من الحين ينروح للجديد (اللوحة تقرأه من الصفحة)، وأي شيء أُنشئ بالقديم أثناء التبديل ينتقل للجديد أول بأول.');
    else await L.tg(`❌ ما قدرت أخبر القديم (${nx.status || nx.error}) ${JSON.stringify(nx.json || '').slice(0, 200)}\nالمشاهدين ما يتنقلون تلقائيًا؛ اللي رابطه ثابت يتحدّث بعد الانقطاع`);
  } else await L.tg('✅ جاهز. اللوحة والروابط الثابتة تشير لهذا النفق.');
  return 0;
}

if (require.main === module) run().then((c) => process.exit(c)).catch(async (e) => { await L.tg('💥 خطأ غير متوقع بالتبديل: ' + ((e && e.stack) || e).toString().slice(0, 600)); process.exit(1); });
module.exports = { run, verifyItems };
