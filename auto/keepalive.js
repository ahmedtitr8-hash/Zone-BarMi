'use strict';
// يبقي الجلسة شغّالة، ويجدد السلسلة عند RENEW_AT، ويرسل نبضة كل نص ساعة، وينتهي لما القديم يخلص شغله.
const fs = require('fs');
const path = require('path');
const L = require('./lib');

const RENEW_AT_MS = Number(process.env.AUTO_RENEW_AT_MS || 300 * 60 * 1000);
const HARD_END_MS = Number(process.env.AUTO_HARD_END_MS || 336 * 60 * 1000);
const HEARTBEAT_MS = Number(process.env.AUTO_HEARTBEAT_MS || 30 * 60 * 1000);
const POLL_MS = Number(process.env.AUTO_POLL_MS || 15000);
const WORKFLOW = process.env.AUTO_WORKFLOW_FILE || 'live-relay-auto.yml';
const GH = process.env.AUTO_GH_API || 'https://api.github.com';   // للاختبار المحلي فقط

function pidAlive() {
  try { const pid = Number(fs.readFileSync(path.join(L.ROOT, 'server.pid'), 'utf8')); process.kill(pid, 0); return true; } catch (_) { return false; }
}
function startedAt() {
  try { const t = Number(fs.readFileSync(path.join(L.ROOT, 'start_ts'), 'utf8')) * 1000; if (t) return t; } catch (_) {}
  return Date.now();
}
async function autoEnabled() {
  const r = await L.req(`${GH}/repos/${L.REPO}/actions/variables/ZONE_AUTO`, { headers: { authorization: `Bearer ${L.E.GH_PAT}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } }, 15000);
  if (r.status === 404) return { on: true, note: 'المتغير ZONE_AUTO غير موجود (يعني مفعّل)' };
  if (!r.ok) return { on: false, note: `ما قدرت أقرأ ZONE_AUTO (HTTP ${r.status || r.error}) — أوقف التجديد للأمان` };
  const v = String((r.json && r.json.value) || '').trim().toLowerCase();
  return { on: v !== 'off', note: `ZONE_AUTO=${v || '(فاضي)'}` };
}
async function dispatchNext() {
  const r = await L.req(`${GH}/repos/${L.REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: 'POST',
    headers: { authorization: `Bearer ${L.E.GH_PAT}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' },
    body: JSON.stringify({ ref: L.REF, inputs: { chain: String(L.CHAIN + 1), max_chain: String(L.MAX_CHAIN) } }),
  }, 20000);
  return r;
}

async function main() {
  const t0 = startedAt();
  const local = `http://127.0.0.1:${L.PORT}`;
  let renewed = false, renewGaveUp = false, lastBeat = Date.now(), nextDispatchTry = 0, tries = 0;
  await L.tg(`⏱️ بدأت المراقبة. التجديد عند ${Math.round(RENEW_AT_MS / 60000)} دقيقة من بداية التشغيل، والنهاية القصوى ${Math.round(HARD_END_MS / 60000)}`);
  for (;;) {
    await L.sleep(POLL_MS);
    const age = Date.now() - t0;
    if (!pidAlive()) { await L.tg('💥 السيرفر وقف! (العملية ماتت) — الأكشن ينتهي. راجع server.log وشغّل من جديد'); return 1; }
    if (fs.existsSync(path.join(L.ROOT, 'auto_done'))) { await L.tg('✅ انتهى دور هذي النسخة بعد ما انتقل المشاهدين. الأكشن يقفل.'); return 0; }

    if (!renewed && !renewGaveUp && age >= RENEW_AT_MS && Date.now() >= nextDispatchTry) {
      const en = await autoEnabled();
      if (!en.on) { renewGaveUp = true; await L.tg(`⛔ ما جدّدت: ${en.note}\nهذي النسخة تكمل لين ينتهي وقتها (${Math.round((HARD_END_MS - age) / 60000)} دقيقة تقريبًا) بدون خليفة.`); }
      else if (L.CHAIN >= L.MAX_CHAIN) { renewGaveUp = true; await L.tg(`⛔ وصلنا حد التجديدات (${L.MAX_CHAIN}) — ما جدّدت. هذي آخر نسخة، تنتهي بعد ${Math.round((HARD_END_MS - age) / 60000)} دقيقة تقريبًا.`); }
      else {
        tries++;
        const r = await dispatchNext();
        if (r.status === 204) { renewed = true; await L.tg(`🚀 شغّلت النسخة التالية (#${L.CHAIN + 2} من ${L.MAX_CHAIN + 1})\n${en.note}\nتجهز خلال ~5 دقايق وتبدأ التبديل.`); }
        else {
          nextDispatchTry = Date.now() + 60000;
          await L.tg(`❌ فشل تشغيل النسخة التالية (محاولة ${tries}): HTTP ${r.status || r.error}\n${String(r.text || '').slice(0, 250)}\nأعيد كل دقيقة. غالبًا الـGH_PAT ينقصه صلاحية workflow.`);
          if (tries >= 20) { renewGaveUp = true; await L.tg('🛑 تركت التجديد بعد 20 محاولة. هذي النسخة تنتهي بدون خليفة — شغّل الأكشن بيدك.'); }
        }
      }
    }
    if (Date.now() - lastBeat >= HEARTBEAT_MS) {
      lastBeat = Date.now();
      const s = await L.api(local, '/api/auto/status', 'GET', undefined, 8000);
      const j = s.json || {};
      await L.tg(`💓 شغّال من ${Math.round(age / 60000)} دقيقة${renewed ? ' (النسخة التالية انطلقت)' : ''}\nأسماء ${j.counts ? j.counts.relayNames : '?'} | فك ${j.counts ? j.counts.decode : '?'} | روابط ثابتة ${j.counts ? j.counts.pointers : '?'} | مشاهدين آخر دقيقة ${j.viewers60 ? j.viewers60.clients : '?'}`);
    }
    if (age >= HARD_END_MS) {
      await L.tg(renewed ? '⌛ وصلنا آخر الوقت المسموح — ينتهي الأكشن (النسخة التالية المفروض شغّالة).' : '⌛ وصلنا آخر الوقت المسموح وما فيه نسخة تالية — الأكشن ينتهي والبث يقف. شغّله بيدك.');
      return 0;
    }
  }
}
if (require.main === module) main().then((c) => process.exit(c)).catch(async (e) => { await L.tg('💥 خطأ بالمراقبة: ' + ((e && e.stack) || e).toString().slice(0, 500)); process.exit(1); });
module.exports = { main };
