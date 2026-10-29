'use strict';
// الوضع التلقائي داخل السيرفر: نقل الحالة بين النسخ، الروابط الثابتة (ptr)، المزامنة أثناء التبديل، وإنهاء النسخة القديمة بأمان.
// يتركّب من preload.js فقط لما يشتغل الأكشن التلقائي — server.js وdecode.js ما انلمسوا.
const fs = require('fs');
const path = require('path');
const L = require('./lib');

// الرابط الثابت = رابط صفحة GitHub:  <الصفحة>/?p=<الاسم>
// ما ينكتب أي ملف لكل ممرر: الأسماء والروابط الكاملة تبقى بالسيرفر فقط (ونتنقل للنسخة الجديدة عند التبديل).
// الشيء الوحيد المنشور بالصفحة هو docs/current-stream.json (عنوان النفق الحالي) عند التشغيل/التبديل.
// المشغّل: يقرأ current-stream.json من الصفحة ← يسأل النفق /api/p/<الاسم> ← يرجع له الرابط الكامل.
// للنشر العلني القديم (ملف لكل ممرر فيه الرابط الكامل): PTR_PUBLIC=1
const HIDE_PTR = process.env.PTR_PUBLIC !== '1';

const MIN_GRACE_MS = Number(process.env.AUTO_MIN_GRACE_MS || 5 * 60 * 1000);    // أقل مدة يبقى فيها القديم بعد عرض الجديد
const IDLE_MS = Number(process.env.AUTO_IDLE_MS || 2 * 60 * 1000);             // لازم ما يجي أي طلب مشاهدة للقديم هذي المدة
const MAX_GRACE_MS = Number(process.env.AUTO_MAX_GRACE_MS || 15 * 60 * 1000);  // أقصى مدة، بعدها ينتهي مهما صار
const STATUS_EVERY_MS = Number(process.env.AUTO_STATUS_EVERY_MS || 2 * 60 * 1000);

function mount(app) {
  const started = Date.now();
  const st = {
    tunnel: null,            // عنوان هذا السيرفر العام
    next: null,              // عنوان النسخة الجديدة (لما نكون القديم وتم التبديل)
    nextAt: 0,
    pointers: new Map(),     // name → { path, src, at }
    seenRelay: new Set(), seenDecode: new Set(),
    published: false,        // نشرنا الروابط الثابتة مرة على الأقل (هذا السيرفر هو الأساسي)
    lastHash: '', lastSyncFail: 0, lastStatusAt: 0, done: false, publishTimer: null,
  };
  const stableOf = (name) => HIDE_PTR ? `${L.pagesBase()}/?p=${name}` : `${L.pagesBase()}/ptr/${name}.json`;
  const relayNames = () => globalThis.__relayNames || (globalThis.__relayNames = new Map());
  const relayUps = () => globalThis.__relayUps || (globalThis.__relayUps = new Map());
  const decodeJobs = () => { try { return require('../decode')._internal.jobs; } catch (_) { return new Map(); } };

  const auth = (req, res, next) => {
    if (!L.API_KEY || req.headers['x-api-key'] !== L.API_KEY) return res.status(401).json({ error: 'مفتاح API غير صحيح أو مفقود' });
    next();
  };
  const jobUrl = (j) => (j.baseDir || '') + (j.masterName || '') + (j.masterQuery || '');
  const jobPath = (j) => `${j.mountPath}/${j.masterName}${j.masterQuery || ''}`;
  const relayPointerName = (id) => String(id).replace(/-[a-z0-9]{4}$/, '') || String(id);

  // ===== الحالة الكاملة (تُنقل للنسخة الجديدة) =====
  function snapshot() {
    const now = Date.now();
    return {
      version: 1, at: now,
      relayNames: [...relayNames().entries()].filter(([, v]) => v && v.exp > now).map(([id, v]) => ({ id, v })),
      relayUps: [...relayUps().entries()],
      decode: [...decodeJobs().values()].filter((j) => !j.stopped).map((j) => ({ id: j.id, url: jobUrl(j), qualities: j.wanted, ref: j.ref || '', path: jobPath(j) })),
      pointers: [...st.pointers.entries()].map(([name, p]) => ({ name, path: p.path, src: p.src })),
    };
  }
  const hashOf = (s) => require('crypto').createHash('sha1').update(JSON.stringify({ ...s, at: 0 })).digest('hex');

  async function importState(s) {
    const rep = { relayNames: { added: 0, skipped: 0 }, relayUps: 0, decode: [], pointers: 0 };
    const now = Date.now();
    for (const it of (s.relayNames || [])) {
      if (!it || !it.id || !it.v || it.v.exp <= now) continue;
      if (relayNames().has(it.id)) { rep.relayNames.skipped++; } else { relayNames().set(it.id, it.v); rep.relayNames.added++; }
      st.seenRelay.add(it.id);
    }
    for (const [o, r] of (s.relayUps || [])) { relayUps().set(o, r); rep.relayUps++; }
    for (const d of (s.decode || [])) {
      const cur = decodeJobs().get(d.id);
      if (cur && !cur.stopped) { rep.decode.push({ id: d.id, status: 'already' }); st.seenDecode.add(d.id); continue; }
      const r = await L.api(`http://127.0.0.1:${L.PORT}`, '/api/decode/start', 'POST', { url: d.url, qualities: d.qualities, ref: d.ref, name: d.id }, 120000);
      rep.decode.push({ id: d.id, status: r.ok ? 'started' : 'failed', error: r.ok ? undefined : ((r.json && r.json.error) || r.error || ('HTTP ' + r.status)) });
      if (r.ok) st.seenDecode.add(d.id);
    }
    for (const p of (s.pointers || [])) {
      if (!p || !L.NAME_RE.test(p.name) || !String(p.path || '').startsWith('/')) continue;
      st.pointers.set(p.name, { path: p.path, src: p.src || 'import', at: Date.now() }); rep.pointers++;
    }
    return rep;
  }

  // ===== نشر الروابط الثابتة (docs/ptr/*.json) + (اختياريًا) ملف الجلسة =====
  async function publishAll({ panel = false, reason = '' } = {}) {
    if (!st.tunnel) return { ok: false, error: 'لسا ما انحدد عنوان النفق' };
    const files = [];
    const names = [];
    for (const [name, p] of st.pointers) {
      const rel = `docs/ptr/${name}.json`;
      if (HIDE_PTR) { if (fs.existsSync(path.join(L.ROOT, rel))) files.push({ path: rel, content: null }); }   // يمسح أي ملف ممرر قديم (فيه الرابط الكامل)
      else files.push({ path: rel, content: JSON.stringify({ name, url: st.tunnel + p.path, updatedAt: new Date().toISOString(), chain: L.CHAIN }, null, 2) + '\n' });
      names.push(name);
    }
    if (panel) files.push({ path: 'docs/current-stream.json', content: JSON.stringify({ panelUrl: st.tunnel, startedAt: new Date().toISOString(), mode: 'auto', chain: L.CHAIN }, null, 2) + '\n' });
    if (!files.length) return { ok: true, changed: false, names };
    const r = await L.gitPublish(files, `تحديث الروابط الثابتة${reason ? ' — ' + reason : ''} [skip ci]`);
    if (r.ok) st.published = true;
    return { ...r, names };
  }
  function schedulePublish(reason) {
    if (HIDE_PTR) return;      // الوضع الافتراضي: ما فيه ملف لكل ممرر، فما فيه شيء ينشر عند إضافة/تغيير ممرر
    if (!st.published || st.next || !st.tunnel) return;     // القديم بعد التبديل ما ينشر؛ الجديد هو الأساسي
    clearTimeout(st.publishTimer);
    st.publishTimer = setTimeout(async () => {
      const r = await publishAll({ reason });
      if (r.ok) L.tg(`📌 تحدّثت الروابط الثابتة (${(r.names || []).length}): ${(r.names || []).join('، ') || '—'}${r.commit ? '\nكوميت ' + r.commit : ''}`);
      else L.tg(`❌ فشل نشر الروابط الثابتة (${r.step || ''})\n${String(r.detail || r.error || '').slice(0, 300)}`);
    }, 5000);
  }
  function addPointer(name, p, src) {
    const prev = st.pointers.get(name);
    st.pointers.set(name, { path: p, src, at: Date.now() });
    return prev;
  }

  // ===== مراقبة الأسماء الجديدة: ممرر مسمّى + عمليات الفك → رابط ثابت تلقائي =====
  function scanNew() {
    try {
      for (const [id, v] of relayNames()) {
        if (st.seenRelay.has(id) || !v || v.exp <= Date.now()) continue;
        st.seenRelay.add(id);
        const name = relayPointerName(id);
        if (!L.NAME_RE.test(name)) continue;
        const prev = addPointer(name, `/live/${id}/master.m3u8`, 'relay');
        L.tg(`➕ ممرر مسمّى جديد: ${id}\nالرابط الثابت: ${stableOf(name)}${prev ? '\n(استبدل ممرر قديم بنفس الاسم)' : ''}`);
        schedulePublish('ممرر ' + name);
      }
      for (const j of decodeJobs().values()) {
        if (j.stopped || st.seenDecode.has(j.id) || !j.ready) continue;
        st.seenDecode.add(j.id);
        if (!L.NAME_RE.test(j.id)) continue;
        if (jobPath(j).includes('?')) {
          L.tg(`⚠️ عملية الفك ${j.id}: رابطها فيه توكن بعد علامة ؟ (ممكن يكون توكن المصدر)\nما نشرت لها رابطًا ثابتًا عشان ما ينكشف بالصفحة العامة. تقدر تنشره يدويًا من pointers.html لو تقبل.`);
          continue;
        }
        const prev = addPointer(j.id, jobPath(j), 'decode');
        L.tg(`➕ عملية فك جديدة: ${j.id} (جودات ${(j.wanted || []).join('/')})\nالرابط الثابت: ${stableOf(j.id)}${prev ? '\n(استبدلت رابطًا قديمًا بنفس الاسم)' : ''}`);
        schedulePublish('فك ' + j.id);
      }
    } catch (e) { console.error('[auto] scanNew', e); }
  }
  setInterval(scanNew, 3000).unref();

  // ===== عدّاد المشاهدين (من preload) =====
  function viewers(ms) {
    const arr = globalThis.__zoneViewers || [];
    const t = Date.now() - ms;
    const recent = arr.filter((x) => x.t >= t);
    return { requests: recent.length, clients: new Set(recent.map((x) => x.ip)).size, lastAt: arr.length ? arr[arr.length - 1].t : 0 };
  }

  // ===== المزامنة للنسخة الجديدة + إنهاء القديم =====
  async function syncToNext(force) {
    if (!st.next || st.done) return true;
    const snap = snapshot();
    const h = hashOf(snap);
    if (!force && h === st.lastHash) return true;
    const r = await L.api(st.next, '/api/auto/import', 'POST', snap, 150000);
    if (r.ok) {
      const rep = r.json || {};
      const changed = st.lastHash !== '';
      st.lastHash = h;
      if (changed) L.tg(`🔄 نقلت للجديد شيء أُنشئ أثناء التبديل\nأسماء ممررة +${(rep.relayNames || {}).added || 0} | فك: ${(rep.decode || []).filter((d) => d.status === 'started').length} جديد | روابط ثابتة ${rep.pointers || 0}`);
      return true;
    }
    if (Date.now() - st.lastSyncFail > 60000) { st.lastSyncFail = Date.now(); L.tg(`⚠️ تعذّر نقل الجديد للنسخة الجديدة (${r.status || r.error})\nأعيد المحاولة كل 3 ثواني`); }
    return false;
  }

  function finish(reason) {
    if (st.done) return;
    st.done = true;
    const v = viewers(IDLE_MS);
    L.tg(`🏁 النسخة القديمة تنتهي الحين\nالسبب: ${reason}\nمشاهدين نشطين عليها آخر ${Math.round(IDLE_MS / 1000)} ثانية: ${v.clients} (طلبات ${v.requests})`);
    try { fs.writeFileSync(path.join(L.ROOT, 'auto_done'), String(Date.now())); } catch (_) {}
  }

  let graceTimer = null;
  function startGrace() {
    graceTimer = setInterval(async () => {
      if (st.done) return clearInterval(graceTimer);
      const synced = await syncToNext(false);
      const elapsed = Date.now() - st.nextAt;
      const v = viewers(IDLE_MS);
      const idle = v.requests === 0;
      if (Date.now() - st.lastStatusAt >= STATUS_EVERY_MS) {
        st.lastStatusAt = Date.now();
        const v1 = viewers(60000);
        L.tg(`⏳ انتظار انتقال المشاهدين (${Math.round(elapsed / 60000)} دقيقة)\nمتصلين بالقديم آخر دقيقة: ${v1.clients} جهاز (${v1.requests} طلب)\nالمزامنة: ${synced ? 'سليمة' : 'فيها مشكلة'}`);
      }
      if (elapsed >= MAX_GRACE_MS) return finish(`وصلنا أقصى مدة (${Math.round(MAX_GRACE_MS / 60000)} دقيقة)`);
      if (elapsed >= MIN_GRACE_MS && idle && synced) return finish('الكل انتقل للجديد (ما فيه طلبات مشاهدة، والمزامنة تمت)');
    }, 3000);
    graceTimer.unref();
  }

  // ===== المسارات =====
  app.get('/api/auto/status', auth, (req, res) => {
    res.json({
      ok: true, auto: true, chain: L.CHAIN, uptimeSec: Math.round((Date.now() - started) / 1000), tunnel: st.tunnel, next: st.next, done: st.done, published: st.published,
      counts: { relayNames: [...relayNames().values()].filter((v) => v.exp > Date.now()).length, relayUps: relayUps().size, decode: [...decodeJobs().values()].filter((j) => !j.stopped).length, pointers: st.pointers.size },
      viewers60: viewers(60000), viewers120: viewers(120000),
    });
  });
  app.get('/api/auto/export', auth, (req, res) => res.json(snapshot()));
  app.post('/api/auto/import', auth, async (req, res) => {
    try {
      const rep = await importState(req.body || {});
      if (st.published) schedulePublish('مزامنة');
      res.json({ ok: true, ...rep });
    } catch (e) { res.status(500).json({ error: String((e && e.message) || e) }); }
  });
  app.post('/api/auto/tunnel', auth, (req, res) => {
    const u = String((req.body && req.body.url) || '').trim().replace(/\/+$/, '');
    if (!L.okTunnel(u)) return res.status(400).json({ error: 'عنوان النفق غير صالح' });
    st.tunnel = u; res.json({ ok: true, tunnel: u });
  });
  app.post('/api/auto/publish', auth, async (req, res) => {
    const r = await publishAll({ panel: !!(req.body && req.body.panel), reason: String((req.body && req.body.reason) || 'تبديل') });
    res.status(r.ok ? 200 : 500).json(r);
  });
  app.post('/api/auto/next', auth, async (req, res) => {
    const u = String((req.body && req.body.url) || '').trim().replace(/\/+$/, '');
    if (!L.okTunnel(u)) return res.status(400).json({ error: 'عنوان النفق الجديد غير صالح' });
    const chk = await L.api(u, '/api/auto/status', 'GET', undefined, 8000);
    if (!chk.ok || !chk.json || !chk.json.auto) return res.status(400).json({ error: 'النفق الجديد ما رد كسيرفر تلقائي' });
    if (st.next && st.next !== u) return res.status(409).json({ error: 'فيه نسخة جديدة معروضة أصلًا' });
    if (!st.next) {
      st.next = u; st.nextAt = Date.now(); st.lastStatusAt = Date.now();
      globalThis.__zoneNext = u;           // preload يضيف ترويسة X-Zone-Next لكل رد
      L.tg(`📣 بدأت أعرض النفق الجديد للمشاهدين (ترويسة X-Zone-Next)\n${u}\nأنتظر انتقالهم: على الأقل ${Math.round(MIN_GRACE_MS / 60000)} دقايق وهدوء ${Math.round(IDLE_MS / 60000)} دقيقة، وأقصى ${Math.round(MAX_GRACE_MS / 60000)}`);
      syncToNext(true); startGrace();
    }
    res.json({ ok: true, next: st.next });
  });

  // ===== المشغّل يسأل عن الرابط الكامل (بدل ملف علني) =====
  app.get('/api/p/:name', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const p = st.pointers.get(String(req.params.name || ''));
    if (!p || !st.tunnel) return res.status(404).json({ error: 'غير موجود' });
    res.json({ name: req.params.name, url: st.tunnel + p.path, updatedAt: new Date().toISOString(), chain: L.CHAIN });
  });

  // ===== الروابط الثابتة اليدوية (للروابط اللي بدون اسم: /mh و /relay و /u) =====
  app.get('/api/pointer/list', auth, (req, res) => {
    res.json({ items: [...st.pointers.entries()].map(([name, p]) => ({ name, path: p.path, src: p.src, stable: `${stableOf(name)}` })), tunnel: st.tunnel });
  });
  app.post('/api/pointer/set', auth, (req, res) => {
    const name = String((req.body && req.body.name) || '').trim();
    if (!L.NAME_RE.test(name)) return res.status(400).json({ error: 'الاسم: حروف إنجليزية وأرقام و - و _ فقط (حتى 40)' });
    let p = '';
    try {
      const u = new URL(String((req.body && req.body.link) || ''));
      if (!/^https?:$/.test(u.protocol) || !/^\/(live|d|mh|relay|u|uh|m|p)(\/|$)/.test(u.pathname)) throw new Error('x');
      p = u.pathname + u.search;
    } catch (_) { return res.status(400).json({ error: 'الصق رابط الممرر كامل (من نفق هذا السيرفر): /live أو /d أو /mh أو /relay أو /u' }); }
    if (p.includes('?') && !(req.body && req.body.allowQuery)) {
      return res.status(400).json({ error: 'الرابط فيه ؟ وما بعدها (ممكن يكون توكن المصدر) والصفحة عامة — لو متأكد وتبي تنشره فعّل خيار "أوافق ينكتب علنًا"', needsConsent: true });
    }
    const prev = addPointer(name, p, 'manual');
    L.tg(`➕ رابط ثابت يدوي: ${name}\n${stableOf(name)}${prev ? '\n(استبدل رابطًا قديمًا بنفس الاسم)' : ''}`);
    schedulePublish('يدوي ' + name);
    res.json({ ok: true, name, path: p, stable: `${stableOf(name)}` });
  });
  app.delete('/api/pointer/:name', auth, async (req, res) => {
    const name = String(req.params.name || '');
    if (!st.pointers.delete(name)) return res.status(404).json({ error: 'غير موجود' });
    const rel = `docs/ptr/${name}.json`;
    const r = fs.existsSync(path.join(L.ROOT, rel)) ? await L.gitPublish([{ path: rel, content: null }], `حذف رابط ثابت ${name} [skip ci]`) : { ok: true };
    L.tg(r.ok ? `🗑️ انحذف الرابط الثابت: ${name}` : `⚠️ انحذف من السيرفر لكن فشل حذف ملفه من الصفحة: ${name}`);
    res.json({ ok: true });
  });

  console.log('[auto] الوضع التلقائي شغّال (سلسلة #' + (L.CHAIN + 1) + ')');
  L.tg(`🟢 السيرفر شغّال بالوضع التلقائي\nحد التجديدات: ${L.MAX_CHAIN} | هذا التشغيل رقم ${L.CHAIN + 1}`);
  return { st, snapshot, importState, publishAll };
}

module.exports = { mount };
