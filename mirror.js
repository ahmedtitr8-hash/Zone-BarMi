'use strict';
// ==================== نسخ رابط كامل (Mirror) ====================
// تعطيه رابط (MPD / HLS m3u8 / ملف عادي) فيسحب المانيفست + كل الجودات والصوتيات والمقاطع،
// ويعيد كتابة المانيفست بمسارات نسبية، ويسلّم كل ملف لدالة put(مسار_نسبي, محتوى, نوع_المحتوى)
// (السيرفر يرفعها لـ B2 ويقدّمها من دومينك على /m/<الاسم>/...).
// ملاحظة: الملفات المشفّرة تنسخ كما هي (بدون فك تشفير) — نفس المفاتيح تشتغل على النسخة.

const { Readable } = require('stream');
const mpdLib = require('./mpd');
const X = mpdLib._xml;

const CONCURRENCY = 6;
const RETRIES = 3;
const REQ_TIMEOUT_MS = 90000;

const CT = {
  mpd: 'application/dash+xml',
  m3u8: 'application/vnd.apple.mpegurl',
  m4s: 'video/iso.segment',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  m4a: 'audio/mp4',
  ts: 'video/mp2t',
  aac: 'audio/aac',
  mp3: 'audio/mpeg',
  vtt: 'text/vtt',
  webvtt: 'text/vtt',
  srt: 'application/x-subrip',
  ttml: 'application/ttml+xml',
  xml: 'application/xml',
  key: 'application/octet-stream',
  json: 'application/json',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  jpg: 'image/jpeg',
  png: 'image/png',
};
const contentTypeOf = (name) => CT[(name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** يشغّل مهام بتوازي محدود، ويتوقف عند أول فشل نهائي */
async function pool(tasks, limit) {
  let i = 0;
  let failed = null;
  const worker = async () => {
    while (!failed && i < tasks.length) {
      const t = tasks[i++];
      try {
        await t();
      } catch (e) {
        failed = failed || e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  if (failed) throw failed;
}

function extOf(url, fallback) {
  try {
    const m = new URL(url).pathname.match(/\.([a-zA-Z0-9]{1,6})$/);
    return m ? '.' + m[1].toLowerCase() : fallback;
  } catch (_) {
    return fallback;
  }
}

function withQuery(url, query) {
  return query && !url.includes('?') ? `${url}?${query}` : url;
}

function parseIsoDuration(s) {
  if (!s) return null;
  const m = String(s).match(/^P(?:(\d+)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!m) return null;
  return (Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) + (Number(m[3] || 0) * 60) + Number(m[4] || 0);
}
function toIsoDuration(sec) {
  return `PT${Math.max(0, sec).toFixed(3)}S`;
}

// ---------- منفّذ الجلب ----------
function makeCtx({ headers, put, progress }) {
  const stats = { total: 0, done: 0, bytes: 0, failed: 0 };
  const report = (extra) => progress && progress({ ...stats, ...(extra || {}) });

  /** يجلب رابط ويرفعه (بث مباشر بدون تخزين محلي). range = "bytes=a-b" اختياري */
  async function fetchRaw(url, range) {
    const h = { ...headers };
    if (range) h.Range = range.startsWith('bytes=') ? range : `bytes=${range}`;
    const res = await fetch(url, { headers: h, redirect: 'follow', signal: AbortSignal.timeout(REQ_TIMEOUT_MS) });
    if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} من ${url.slice(0, 120)}`);
    return res;
  }

  async function withRetry(label, fn) {
    let lastErr;
    for (let a = 1; a <= RETRIES; a++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (a < RETRIES) await sleep(800 * a);
      }
    }
    stats.failed++;
    throw new Error(`فشل ${label}: ${lastErr && lastErr.message ? lastErr.message : lastErr}`);
  }

  /** ملف ثنائي: ينزّل من url ويحفظ بالمسار النسبي rel */
  function download(url, rel, range) {
    return withRetry(rel, async () => {
      const res = await fetchRaw(url, range);
      let n = 0;
      const body = Readable.fromWeb(res.body);
      body.on('data', (c) => { n += c.length; });
      await put(rel, body, contentTypeOf(rel));
      stats.bytes += n;
      stats.done++;
      report();
    });
  }

  async function fetchText(url) {
    return withRetry(url.slice(0, 80), async () => {
      const res = await fetchRaw(url);
      return { text: await res.text(), finalUrl: res.url || url, contentType: res.headers.get('content-type') || '' };
    });
  }

  async function putText(rel, text, type) {
    await put(rel, Buffer.from(text, 'utf8'), type || contentTypeOf(rel));
    stats.done++;
    report();
  }

  return { stats, report, download, fetchText, putText };
}

// ==================== DASH ====================
const { parseXml, serialize, isEl, localName, kids, attr, textOf, escapeText, escapeAttr, findMpdRoot } = X;

function fillTemplate(tpl, v) {
  return tpl.replace(/\$(RepresentationID|Number|Bandwidth|Time)(?:%0(\d+)d)?\$|\$\$/g, (m, key, pad) => {
    if (m === '$$') return '$';
    let val = v[key];
    if (val === undefined || val === null) return m;
    val = String(val);
    return pad ? val.padStart(Number(pad), '0') : val;
  });
}

const nearest = (nodes, name) => {
  // أقرب مستوى (Representation > AdaptationSet > Period) فيه عنصر بهذا الاسم
  for (let i = nodes.length - 1; i >= 0; i--) {
    const k = kids(nodes[i], name)[0];
    if (k) return k;
  }
  return null;
};
const mergedAttrs = (nodes, name) => {
  const out = {};
  for (const n of nodes) {
    const k = kids(n, name)[0];
    if (k) for (const a of Object.keys(k.attrs)) out[a] = attr(k, a);
  }
  return out;
};

/** يبني قائمة {t,d} من SegmentTimeline */
function expandTimeline(tl, periodDurTicks) {
  const out = [];
  let t = 0;
  let first = true;
  const ss = kids(tl, 'S');
  ss.forEach((s, idx) => {
    if (attr(s, 't') !== undefined) t = Number(attr(s, 't'));
    else if (first) t = 0;
    first = false;
    const d = Number(attr(s, 'd'));
    let r = Number(attr(s, 'r') || 0);
    if (r < 0) {
      // تكرار لنهاية الـ Period (أو لبداية العنصر التالي)
      const next = ss[idx + 1];
      const end = next && attr(next, 't') !== undefined ? Number(attr(next, 't')) : periodDurTicks;
      if (end === null || end === undefined) throw new Error('SegmentTimeline فيه r=-1 ومدة الـ Period غير معروفة');
      r = Math.max(0, Math.ceil((end - t) / d) - 1);
    }
    for (let i = 0; i <= r; i++) {
      out.push({ t, d });
      t += d;
    }
  });
  return out;
}

function compressTimeline(list) {
  const nodes = [];
  let expected = null;
  let cur = null;
  for (const seg of list) {
    if (cur && seg.d === cur.d && seg.t === expected) {
      cur.r++;
    } else {
      cur = { t: seg.t, d: seg.d, r: 0, explicitT: expected === null || seg.t !== expected };
      nodes.push(cur);
    }
    expected = seg.t + seg.d;
  }
  return nodes.map((n) => ({
    name: 'S',
    attrs: { ...(n.explicitT ? { t: String(n.t) } : {}), d: String(n.d), ...(n.r ? { r: String(n.r) } : {}) },
    children: [],
  }));
}

async function mirrorDash(ctx, mpdUrlIn, xml) {
  const doc = parseXml(xml);
  const mpd = findMpdRoot(doc);
  const mpdUrl = mpdUrlIn;
  const query = (() => { try { return new URL(mpdUrl).search.slice(1); } catch (_) { return ''; } })();
  const isDynamic = attr(mpd, 'type') === 'dynamic';
  const totalDur = parseIsoDuration(attr(mpd, 'mediaPresentationDuration'));
  const periods = kids(mpd, 'Period');
  if (!periods.length) throw new Error('الـ MPD ما فيه Period');

  const jobs = []; // { url, rel, range }
  const warnings = [];
  let maxEnd = 0;

  const baseOf = (nodes) => {
    let base = mpdUrl;
    for (const n of nodes) {
      const b = kids(n, 'BaseURL')[0];
      const t = b ? textOf(b).trim() : '';
      if (t) base = new URL(t, base).toString();
    }
    return base;
  };

  // ---- مرحلة 1: التخطيط (بدون تعديل الشجرة) ----
  const plans = []; // { rep, rel (BaseURL جديد), template?:node, list?:node, keepSegBase?:bool }
  const stripNodes = []; // عقد المستوى الأعلى اللي لازم تنشال من Period/AdaptationSet
  const periodStarts = periods.map((p) => parseIsoDuration(attr(p, 'start')) || 0);

  periods.forEach((period, pi) => {
    let pDur = parseIsoDuration(attr(period, 'duration'));
    if (pDur === null) {
      const nextStart = pi + 1 < periods.length ? periodStarts[pi + 1] : null;
      if (nextStart !== null && (periodStarts[pi + 1] || pi + 1 > 0)) pDur = nextStart - periodStarts[pi];
      else if (totalDur !== null) pDur = totalDur - periodStarts[pi];
    }

    kids(period, 'AdaptationSet').forEach((as, ai) => {
      kids(as, 'Representation').forEach((rep, ri) => {
        const chain = [period, as, rep];
        const repId = attr(rep, 'id') || String(ri);
        const bandwidth = attr(rep, 'bandwidth') || attr(as, 'bandwidth') || '';
        const dir = `p${pi}/a${ai}r${ri}`;
        const base = baseOf([mpd, ...chain]);
        const tplNode = nearest(chain, 'SegmentTemplate');
        const listNode = nearest(chain, 'SegmentList');
        const segBase = nearest(chain, 'SegmentBase');

        if (tplNode) {
          const a = mergedAttrs(chain, 'SegmentTemplate');
          const timescale = Number(a.timescale || 1);
          const media = a.media;
          if (!media) throw new Error(`SegmentTemplate بدون media للتمثيل ${repId}`);
          const initTpl = a.initialization;
          const vars = { RepresentationID: repId, Bandwidth: bandwidth };
          const plan = { rep, kind: 'template', dir, timescale, attrs: a };
          let initRel = null;
          if (initTpl) {
            const url = withQuery(new URL(fillTemplate(initTpl, vars), base).toString(), query);
            initRel = `${dir}/init${extOf(url, '.mp4')}`;
            jobs.push({ url, rel: initRel });
          }
          plan.initRel = initRel;

          const tl = [...chain].reverse().map((n) => kids(n, 'SegmentTemplate')[0]).filter(Boolean)
            .map((t) => kids(t, 'SegmentTimeline')[0]).find(Boolean) || null;
          const startNumber = a.startNumber !== undefined ? Number(a.startNumber) : 1;
          let segs; // [{t,d}] أو عدد فقط
          if (tl) {
            segs = expandTimeline(tl, pDur !== null ? pDur * timescale : null);
          } else {
            const dur = Number(a.duration);
            if (!dur) throw new Error(`SegmentTemplate للتمثيل ${repId} بلا SegmentTimeline ولا duration`);
            if (pDur === null) {
              throw new Error('بث مباشر بقوالب بدون SegmentTimeline — ما أقدر أحدد عدد المقاطع');
            }
            const count = Math.ceil((pDur * timescale) / dur);
            segs = Array.from({ length: count }, (_, i) => ({ t: i * dur, d: dur, number: true }));
          }
          const hasTime = /\$Time(?:%0\d+d)?\$/.test(media);
          let ext = null;
          const mediaFiles = segs.map((s, i) => {
            const number = startNumber + i;
            const url = withQuery(new URL(fillTemplate(media, { ...vars, Number: number, Time: s.t }), base).toString(), query);
            ext = ext || extOf(url, '.m4s');
            return { url, number };
          });
          mediaFiles.forEach((f, i) => {
            const rel = `${dir}/seg-${String(i + 1).padStart(5, '0')}${ext}`;
            jobs.push({ url: f.url, rel });
          });
          plan.segs = segs;
          plan.ext = ext || '.m4s';
          plan.hasTime = hasTime;
          plan.tl = !!tl;
          plan.pto = a.presentationTimeOffset;
          plan.timeline = tl ? segs : null;
          plan.dur = a.duration;
          const lastEnd = segs.length ? (segs[segs.length - 1].t + segs[segs.length - 1].d) / timescale : 0;
          maxEnd = Math.max(maxEnd, periodStarts[pi] + (tl ? lastEnd - (Number(a.presentationTimeOffset || 0) / timescale) : lastEnd));
          plans.push(plan);
        } else if (listNode) {
          const a = mergedAttrs(chain, 'SegmentList');
          const plan = { rep, kind: 'list', dir, listNode, attrs: a };
          const initEl = kids(listNode, 'Initialization')[0];
          plan.mappings = [];
          if (initEl && attr(initEl, 'sourceURL')) {
            const url = withQuery(new URL(attr(initEl, 'sourceURL'), base).toString(), query);
            const rel = `${dir}/init${extOf(url, '.mp4')}`;
            jobs.push({ url, rel, range: attr(initEl, 'range') });
            plan.initRel = rel;
            plan.initEl = initEl;
          }
          const urls = kids(listNode, 'SegmentURL');
          urls.forEach((su, i) => {
            const m = attr(su, 'media');
            if (!m) return;
            const url = withQuery(new URL(m, base).toString(), query);
            const rel = `${dir}/seg-${String(i + 1).padStart(5, '0')}${extOf(url, '.m4s')}`;
            jobs.push({ url, rel, range: attr(su, 'mediaRange') });
            plan.mappings.push({ node: su, rel });
          });
          plans.push(plan);
        } else {
          // ملف واحد (BaseURL + SegmentBase مع indexRange) — يُنسخ كامل والفهرس يبقى صالح
          const hasBase = [mpd, ...chain].some((n) => kids(n, 'BaseURL')[0]);
          if (!hasBase) {
            warnings.push(`التمثيل ${repId} بلا مقاطع ولا BaseURL — تم تجاهله`);
            return;
          }
          const url = withQuery(base, query);
          const rel = `p${pi}/a${ai}r${ri}${extOf(url, '.mp4')}`;
          jobs.push({ url, rel });
          plans.push({ rep, kind: 'single', rel, segBase });
        }
      });
    });
    // عقد القوالب/BaseURL على مستوى Period و AdaptationSet تُشال بعد التخطيط
    const strip = new Set(['BaseURL', 'SegmentTemplate', 'SegmentList', 'SegmentBase']);
    [period, ...kids(period, 'AdaptationSet')].forEach((n) => stripNodes.push({ n, strip }));
  });

  if (!plans.length) throw new Error('ما لقيت أي مسار قابل للنسخ داخل الـ MPD');

  ctx.stats.total += jobs.length + 1; // +1 للـ MPD المعاد كتابته
  ctx.report({ phase: 'download' });

  // ---- مرحلة 2: التنزيل ----
  await pool(jobs.map((j) => () => ctx.download(j.url, j.rel, j.range)), CONCURRENCY);

  // ---- مرحلة 3: إعادة كتابة الـ MPD ----
  const stripTypes = new Set(['BaseURL', 'SegmentTemplate', 'SegmentList', 'SegmentBase']);
  for (const { n } of stripNodes) {
    n.children = n.children.filter((c) => !isEl(c) || !stripTypes.has(localName(c)));
  }
  const mkEl = (name, attrs, children) => ({ name, attrs: attrs || {}, children: children || [] });
  const baseEl = (v) => mkEl('BaseURL', {}, [{ text: escapeText(v) }]);

  for (const plan of plans) {
    const rep = plan.rep;
    rep.children = rep.children.filter((c) => !isEl(c) || !stripTypes.has(localName(c)));
    if (plan.kind === 'single') {
      rep.children.push(baseEl(plan.rel));
      if (plan.segBase) rep.children.push(JSON.parse(JSON.stringify(plan.segBase)));
    } else if (plan.kind === 'template') {
      const at = { timescale: String(plan.timescale), startNumber: '1', media: `seg-$Number%05d$${plan.ext}` };
      if (plan.initRel) at.initialization = plan.initRel.slice(plan.dir.length + 1);
      if (plan.pto) at.presentationTimeOffset = plan.pto;
      const ch = [];
      if (plan.tl) ch.push(mkEl('SegmentTimeline', {}, compressTimeline(plan.timeline)));
      else at.duration = String(plan.dur);
      rep.children.push(baseEl(plan.dir + '/'), mkEl('SegmentTemplate', at, ch));
    } else {
      // قائمة: نعيد استخدام SegmentList الأصلي بعد تبديل الروابط لأسماء محلية
      const sl = JSON.parse(JSON.stringify(plan.listNode));
      const origUrls = kids(plan.listNode, 'SegmentURL');
      const cloneUrls = kids(sl, 'SegmentURL');
      origUrls.forEach((o, i) => {
        const hit = plan.mappings.find((m) => m.node === o);
        if (hit) {
          cloneUrls[i].attrs.media = escapeAttr(hit.rel.slice(plan.dir.length + 1));
          delete cloneUrls[i].attrs.mediaRange;
        }
      });
      const cInit = kids(sl, 'Initialization')[0];
      if (cInit && plan.initRel) {
        cInit.attrs.sourceURL = escapeAttr(plan.initRel.slice(plan.dir.length + 1));
        delete cInit.attrs.range;
      }
      rep.children.push(baseEl(plan.dir + '/'), sl);
    }
  }

  // عناصر MPD العليا اللي تشير لمصدر خارجي
  mpd.children = mpd.children.filter((c) => !isEl(c) || !['BaseURL', 'Location', 'PatchLocation'].includes(localName(c)));

  if (isDynamic) {
    mpd.attrs.type = 'static';
    for (const a of ['minimumUpdatePeriod', 'timeShiftBufferDepth', 'publishTime', 'availabilityStartTime', 'suggestedPresentationDelay', 'availabilityEndTime']) {
      delete mpd.attrs[a];
    }
    if (!mpd.attrs.mediaPresentationDuration && maxEnd > 0) mpd.attrs.mediaPresentationDuration = toIsoDuration(maxEnd);
    warnings.push('الرابط بث مباشر — تم نسخ ما هو متاح الآن فقط وتحويله لملف ثابت (VOD)');
  }

  const out = `<?xml version="1.0" encoding="UTF-8"?>\n${serialize(mpd)}`;
  await ctx.putText('index.mpd', out, CT.mpd);
  return { entry: 'index.mpd', kind: 'dash', files: jobs.length + 1, warnings };
}

// ==================== HLS ====================
async function mirrorHls(ctx, entryUrl, entryText) {
  const warnings = [];
  const seenPlaylists = new Map(); // url -> rel
  let plCounter = 0;

  /** يعالج قائمة تشغيل ويرجع نصها المعاد كتابته. dir = مجلدها النسبي ("" للجذر) */
  async function handlePlaylist(url, text, dir) {
    const lines = text.split(/\r?\n/);
    const localFiles = new Map(); // رابط مطلق -> اسم ملف محلي (داخل dir)
    const tasks = [];
    let segN = 0;
    let keyN = 0;
    let mapN = 0;

    const claim = (abs, kind, ext) => {
      if (localFiles.has(abs)) return localFiles.get(abs);
      let name;
      if (kind === 'seg') name = `${String(++segN).padStart(5, '0')}${ext}`;
      else if (kind === 'key') name = `key${++keyN}.key`;
      else name = `init${++mapN}${ext}`;
      localFiles.set(abs, name);
      const rel = (dir ? dir + '/' : '') + name;
      ctx.stats.total++;
      tasks.push(() => ctx.download(abs, rel));
      return name;
    };

    const subPlaylist = async (abs) => {
      if (seenPlaylists.has(abs)) return seenPlaylists.get(abs);
      const n = ++plCounter;
      const subDir = `v${n}`;
      const rel = `${subDir}/index.m3u8`;
      seenPlaylists.set(abs, rel);
      const { text: t, finalUrl } = await ctx.fetchText(abs);
      const out = await handlePlaylist(finalUrl, t, subDir);
      ctx.stats.total++;
      await ctx.putText(rel, out, CT.m3u8);
      return rel;
    };

    const relFromDir = (rel) => (dir ? rel.slice(dir.length + 1) : rel);
    const out = [];
    const isMaster = /#EXT-X-STREAM-INF/.test(text);
    let expectVariant = false;

    for (let line of lines) {
      const trimmed = line.trim();
      if (!trimmed) { out.push(line); continue; }

      if (trimmed.startsWith('#')) {
        // وسوم فيها URI="..."
        const m = trimmed.match(/URI="([^"]+)"/i);
        if (m) {
          const abs = new URL(m[1], url).toString();
          const tag = trimmed.split(/[:,]/)[0];
          let local;
          if (/#EXT-X-(MEDIA|I-FRAME-STREAM-INF)$/.test(tag)) {
            local = relFromDir(await subPlaylist(abs));
            // المسار الناتج نسبي للجذر؛ نحوّله نسبيًا لمجلد هذه القائمة (دايمًا الجذر هنا لأن master بالجذر)
          } else if (/#EXT-X-(KEY|SESSION-KEY)$/.test(tag)) {
            if (/METHOD=NONE/i.test(trimmed)) { out.push(line); continue; }
            local = claim(abs, 'key', '.key');
          } else if (/#EXT-X-MAP$/.test(tag)) {
            local = claim(abs, 'map', extOf(abs, '.mp4'));
          } else {
            out.push(line);
            continue;
          }
          line = line.replace(/URI="[^"]+"/i, `URI="${local}"`);
        }
        if (/^#EXT-X-STREAM-INF/.test(trimmed)) expectVariant = true;
        out.push(line);
        continue;
      }

      // سطر رابط
      const abs = new URL(trimmed, url).toString();
      if (isMaster && expectVariant) {
        expectVariant = false;
        out.push(relFromDir(await subPlaylist(abs)));
      } else if (/\.m3u8(\?|$)/i.test(abs)) {
        out.push(relFromDir(await subPlaylist(abs)));
      } else {
        out.push(claim(abs, 'seg', extOf(abs, '.ts')));
      }
    }

    await pool(tasks, CONCURRENCY);
    let result = out.join('\n');
    if (!isMaster && !/#EXT-X-ENDLIST/.test(result)) {
      result = result.replace(/\s*$/, '\n#EXT-X-ENDLIST\n');
      warnings.push('القائمة بث مباشر — تم نسخ ما هو متاح الآن وإقفالها كـ VOD');
    }
    return result;
  }

  ctx.stats.total++;
  const out = await handlePlaylist(entryUrl, entryText, '');
  await ctx.putText('index.m3u8', out, CT.m3u8);
  return { entry: 'index.m3u8', kind: 'hls', files: ctx.stats.total, warnings: [...new Set(warnings)] };
}

// ==================== نقطة الدخول ====================
/**
 * @param {object} o { url, headers, put(rel, body, contentType), progress(stats) }
 * @returns {Promise<{entry:string, kind:string, files:number, bytes:number, warnings:string[]}>}
 */
async function mirrorUrl(o) {
  const url = String(o.url || '').trim();
  if (!/^https?:\/\/\S+$/i.test(url)) throw new Error('الرابط لازم يبدأ بـ http:// أو https://');
  const ctx = makeCtx({ headers: o.headers || mpdLib.upstreamHeaders(url), put: o.put, progress: o.progress });

  // نجلب أول بايتات لنكتشف النوع من المحتوى مو من الامتداد
  const res = await fetch(url, { headers: ctx_headers(o, url), redirect: 'follow', signal: AbortSignal.timeout(REQ_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`المصدر رجّع خطأ ${res.status}`);
  const finalUrl = (() => {
    const f = res.url || url;
    try {
      const orig = new URL(url);
      return f.includes('?') || !orig.search ? f : f + orig.search;
    } catch (_) {
      return f;
    }
  })();
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  const looksText =
    /mpegurl|dash\+xml|xml|text\/|json|octet-stream/.test(ctype) || /\.(mpd|m3u8?)(\?|$)/i.test(url);
  let head = '';
  let buf = null;
  let fullText = null;
  if (looksText && !/video\/|audio\/(?!mpegurl)/.test(ctype)) {
    const len = Number(res.headers.get('content-length') || 0);
    if (!len || len < 5 * 1024 * 1024) {
      buf = Buffer.from(await res.arrayBuffer());
      fullText = buf.toString('utf8');
      head = fullText.slice(0, 8192);
    }
  }

  let result;
  if (buf && /<MPD[\s>]/.test(head)) {
    result = await mirrorDash(ctx, finalUrl, fullText);
  } else if (buf && /^\s*#EXTM3U/.test(head)) {
    result = await mirrorHls(ctx, finalUrl, fullText);
  } else {
    // ملف عادي: ننزّله كما هو (بايتات خام بدون أي تحويل نصي)
    const name = fileNameOf(url);
    ctx.stats.total = 1;
    if (buf) {
      await o.put(name, buf, contentTypeOf(name));
      ctx.stats.bytes += buf.length;
    } else {
      let n = 0;
      const body = Readable.fromWeb(res.body);
      body.on('data', (c) => { n += c.length; });
      await o.put(name, body, contentTypeOf(name));
      ctx.stats.bytes += n;
    }
    ctx.stats.done = 1;
    result = { entry: name, kind: 'file', files: 1, warnings: [] };
  }
  ctx.report({ phase: 'done' });
  return { ...result, bytes: ctx.stats.bytes };
}

function ctx_headers(o, url) {
  return o.headers || mpdLib.upstreamHeaders(url);
}

function fileNameOf(url) {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
    const safe = last.replace(/[^\w.\-]+/g, '_').slice(0, 80);
    return safe || 'file.bin';
  } catch (_) {
    return 'file.bin';
  }
}

module.exports = { mirrorUrl, contentTypeOf };
