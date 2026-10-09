'use strict';
// ==================== دعم MPD (DASH) + ClearKey (kid:key) ====================
// الفكرة: السيرفر يفحص الـ MPD ويطلع منه قائمة الجودات/مسارات الصوت، والمستخدم يختار،
// وبعدها ffmpeg يقرأ "نسخة مفلترة" من الـ MPD فيها المسار المختار فقط (فيديو لحاله وصوت لحاله)
// وكل مسار ياخذ مفتاحه الخاص (حسب الـ KID). النتيجة تتفك وتتحوّل HLS بـ -c copy
// (بدون إعادة ترميز) ومنها تمر على نفس مسار الـ Worker الحالي.
// ما فيه أي مكتبة خارجية — محلل XML صغير يكفي لملفات MPD.

const UA =
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';

// ---------- XML صغير ----------
function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}
const escapeAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const escapeText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// عقدة عنصر: { name, attrs: {اسم: قيمة_خام_مهرّبة}, children: [] } — عقدة نص: { text }
function parseXml(src) {
  const root = { name: '#root', attrs: {}, children: [] };
  const stack = [root];
  const tokenRe =
    /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  const attrRe = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = tokenRe.exec(src)) !== null) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) {
      top.children.push({ text: escapeText(m[1]) });
    } else if (m[2] !== undefined) {
      // وسم إغلاق: نطلع لأقرب عنصر بنفس الاسم (يتسامح مع الأخطاء الصغيرة)
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === m[2]) {
          stack.length = i;
          break;
        }
      }
    } else if (m[3] !== undefined) {
      const node = { name: m[3], attrs: {}, children: [] };
      let a;
      attrRe.lastIndex = 0;
      const attrSrc = m[4] || '';
      while ((a = attrRe.exec(attrSrc)) !== null) {
        node.attrs[a[1]] = a[2] !== undefined ? a[2] : a[3].replace(/"/g, '&quot;');
      }
      top.children.push(node);
      if (m[5] !== '/') stack.push(node);
    } else if (m[6] !== undefined) {
      if (m[6].trim() !== '' || top !== root) top.children.push({ text: m[6] });
    }
  }
  return root;
}

function serialize(node) {
  if (node.text !== undefined) return node.text;
  const attrs = Object.entries(node.attrs)
    .map(([k, v]) => ` ${k}="${v}"`)
    .join('');
  if (!node.children.length) return `<${node.name}${attrs}/>`;
  return `<${node.name}${attrs}>${node.children.map(serialize).join('')}</${node.name}>`;
}

const isEl = (n) => n && n.name !== undefined;
const localName = (n) => n.name.split(':').pop();
const kids = (n, name) => n.children.filter((c) => isEl(c) && localName(c) === name);
const attr = (n, name) => (n.attrs[name] !== undefined ? unescapeXml(n.attrs[name]) : undefined);
const textOf = (n) => unescapeXml(n.children.map((c) => (c.text !== undefined ? c.text : '')).join(''));

// ---------- تحليل الـ MPD ----------
function frameRateOf(v) {
  if (!v) return null;
  const [a, b] = String(v).split('/').map(Number);
  if (!a) return null;
  return b ? Math.round((a / b) * 100) / 100 : a;
}

function codecFamily(codecs) {
  const c = (codecs || '').toLowerCase();
  if (c.startsWith('avc')) return 'H.264';
  if (c.startsWith('hvc') || c.startsWith('hev')) return 'HEVC';
  if (c.startsWith('av01')) return 'AV1';
  if (c.startsWith('vp09') || c.startsWith('vp9')) return 'VP9';
  if (c.startsWith('mp4a')) return 'AAC';
  if (c.startsWith('ec-3')) return 'E-AC3';
  if (c.startsWith('ac-3')) return 'AC3';
  if (c.startsWith('opus')) return 'Opus';
  return codecs || '';
}

function describeTrack(t) {
  const kbps = t.bandwidth ? `${Math.round(t.bandwidth / 1000)} kbps` : '';
  if (t.type === 'video') {
    const res = t.height ? `${t.height}p` : t.width ? `${t.width}px` : 'فيديو';
    const mb = t.bandwidth ? `${(t.bandwidth / 1e6).toFixed(2)} Mbps` : '';
    return [res, mb, t.fps ? `${t.fps}fps` : '', codecFamily(t.codecs)].filter(Boolean).join(' • ');
  }
  return [
    t.label || t.lang || `صوت ${t.id}`,
    kbps,
    codecFamily(t.codecs),
    t.channels ? `${t.channels}ch` : '',
  ]
    .filter(Boolean)
    .join(' • ');
}

function findMpdRoot(doc) {
  const mpd = doc.children.find((c) => isEl(c) && localName(c) === 'MPD');
  if (!mpd) throw new Error('الرد مو ملف MPD صالح');
  return mpd;
}

/** يرجع قائمة المسارات (فيديو/صوت) بأول Period — id كل مسار = "رقم_المجموعة.رقم_التمثيل" */
function analyzeMpd(xml) {
  const doc = parseXml(xml);
  const mpd = findMpdRoot(doc);
  const periods = kids(mpd, 'Period');
  if (!periods.length) throw new Error('الـ MPD ما فيه Period');
  const period = periods[0];

  const tracks = [];
  kids(period, 'AdaptationSet').forEach((as, i) => {
    kids(as, 'Representation').forEach((rep, j) => {
      const g = (name) => attr(rep, name) ?? attr(as, name);
      const mime = g('mimeType') || '';
      let type = (g('contentType') || mime.split('/')[0] || '').toLowerCase();
      if (type !== 'video' && type !== 'audio') {
        // بعض الـ MPD ما تحط contentType/mimeType بوضوح — نستدل من الكودك بدل ما نتجاهل المسار
        const c = (g('codecs') || '').toLowerCase();
        if (/^(avc|hvc|hev|av01|vp0?9|vp8)/.test(c) || attr(rep, 'width') || attr(as, 'width')) type = 'video';
        else if (/^(mp4a|ec-3|ac-3|opus|flac)/.test(c) || g('audioSamplingRate')) type = 'audio';
        else return; // ترجمة وغيرها
      }

      let kid = null;
      for (const cp of [...kids(rep, 'ContentProtection'), ...kids(as, 'ContentProtection')]) {
        const k = Object.keys(cp.attrs).find((n) => /(^|:)default_KID$/i.test(n));
        if (k) {
          kid = attr(cp, k).replace(/-/g, '').toLowerCase();
          break;
        }
      }
      const acc = [...kids(rep, 'AudioChannelConfiguration'), ...kids(as, 'AudioChannelConfiguration')][0];
      const labelEl = kids(as, 'Label')[0];
      const track = {
        id: `${i}.${j}`,
        type,
        repId: attr(rep, 'id') || '',
        bandwidth: Number(g('bandwidth')) || 0,
        width: Number(g('width')) || 0,
        height: Number(g('height')) || 0,
        fps: frameRateOf(g('frameRate')),
        codecs: g('codecs') || '',
        lang: g('lang') || '',
        label: labelEl ? textOf(labelEl).trim() : '',
        channels: acc ? attr(acc, 'value') || '' : '',
        kid,
      };
      track.title = describeTrack(track);
      tracks.push(track);
    });
  });

  return {
    isLive: attr(mpd, 'type') === 'dynamic',
    periodCount: periods.length,
    video: tracks.filter((t) => t.type === 'video'),
    audio: tracks.filter((t) => t.type === 'audio'),
  };
}

function bestVideo(video) {
  return [...video].sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth)[0] || null;
}

// ---------- نسخة MPD تحتوي مسار واحد فقط ----------
/** يبني MPD فيه المسار المختار فقط، مع BaseURL مطلق (محلول من كل المستويات)، ويكرر query الـ MPD
 *  على روابط المقاطع (نفس سلوك الـ Worker) لأن كثير من الـ CDN يطلب التوكن مع كل طلب. */
function buildTrackMpd(xml, mpdUrl, trackId) {
  const doc = parseXml(xml);
  const mpd = findMpdRoot(doc);
  const period = kids(mpd, 'Period')[0];
  if (!period) throw new Error('الـ MPD ما فيه Period');

  const [ai, ri] = String(trackId).split('.').map(Number);
  const wholeSet = ri === undefined || Number.isNaN(ri); // "i" بدون رقم تمثيل = كل جودات المجموعة
  const as = kids(period, 'AdaptationSet')[ai];
  const rep = as && (wholeSet ? kids(as, 'Representation')[0] : kids(as, 'Representation')[ri]);
  if (!rep) throw new Error('المسار المختار ما عاد موجود بالـ MPD — افحص الرابط من جديد');

  // حل BaseURL المتداخل (MPD ← Period ← AdaptationSet ← Representation)
  let base = mpdUrl;
  for (const n of wholeSet ? [mpd, period, as] : [mpd, period, as, rep]) {
    const b = kids(n, 'BaseURL')[0];
    const t = b ? textOf(b).trim() : '';
    if (t) base = new URL(t, base).toString();
  }
  const query = (() => {
    try {
      return new URL(mpdUrl).search.slice(1);
    } catch (_) {
      return '';
    }
  })();

  const notBase = (c) => !(isEl(c) && localName(c) === 'BaseURL');
  if (wholeSet) kids(as, 'Representation').forEach((r) => { r.children = r.children.filter(notBase); });
  else rep.children = rep.children.filter(notBase);
  as.children = as.children.filter((c) => notBase(c) && (!isEl(c) || localName(c) !== 'Representation' || wholeSet || c === rep));
  period.children = period.children.filter(
    (c) => notBase(c) && (!isEl(c) || localName(c) !== 'AdaptationSet' || c === as)
  );
  const dropTop = new Set(['BaseURL', 'Location', 'PatchLocation', 'Period']);
  mpd.children = mpd.children.filter((c) => !isEl(c) || !dropTop.has(localName(c)));
  mpd.children.unshift({ name: 'BaseURL', attrs: {}, children: [{ text: escapeText(base) }] });
  mpd.children.push(period);

  if (query) {
    const add = (v) => (v && !v.includes('?') ? `${v}?${escapeAttr(query)}` : v);
    const walk = (n) => {
      if (!isEl(n)) return;
      const ln = localName(n);
      if (ln === 'SegmentTemplate') {
        for (const a of ['media', 'initialization']) if (n.attrs[a]) n.attrs[a] = add(n.attrs[a]);
      } else if (ln === 'SegmentURL') {
        if (n.attrs.media) n.attrs.media = add(n.attrs.media);
      } else if (ln === 'Initialization') {
        if (n.attrs.sourceURL) n.attrs.sourceURL = add(n.attrs.sourceURL);
      }
      n.children.forEach(walk);
    };
    walk(period);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n${serialize(mpd)}`;
}

// ---------- جلب الـ MPD ----------
function upstreamHeaders(url) {
  const u = new URL(url);
  return { 'User-Agent': UA, Referer: `${u.protocol}//${u.host}/` };
}

async function fetchMpd(url, headers) {
  const res = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`المصدر رجّع خطأ ${res.status}`);
  const text = await res.text();
  if (!/<MPD[\s>]/.test(text)) throw new Error('الرد مو ملف MPD صالح');
  // لو صار redirect وضاع الـ query، نرجعه (التوكن يتكرر على المقاطع)
  const orig = new URL(url);
  const final = res.url || url;
  const finalUrl = final.includes('?') || !orig.search ? final : final + orig.search;
  return { text, finalUrl };
}

// ---------- المفاتيح ----------
const HEX32 = /^[0-9a-f]{32}$/;

/** يقبل: سطر لكل مفتاح "kid:key" (أو kid key)، أو مفتاح وحيد 32 hex بدون kid.
 *  الفواصل , و ; تُعتبر فاصل أسطر. */
function parseKeys(text) {
  const map = {};
  const anon = [];
  for (const raw of String(text || '').split(/[\r\n,;]+/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/[\s:]+/).map((p) => p.replace(/-/g, '').toLowerCase());
    if (parts.length === 1 && HEX32.test(parts[0])) anon.push(parts[0]);
    else if (parts.length === 2 && HEX32.test(parts[0]) && HEX32.test(parts[1])) map[parts[0]] = parts[1];
    else {
      throw new Error(
        'مفتاح غير صالح — الصيغة: kid:key (كل واحد 32 حرف hex) سطر لكل مفتاح، أو مفتاح واحد 32 hex'
      );
    }
  }
  return { map, anon };
}

/** يختار المفتاح المناسب للمسار:
 *  1) مطابقة الـ KID (الأدق).
 *  2) مفتاح بدون kid (32 hex لحاله) يُستخدم لكل المسارات — المستخدم قصده كذا.
 *  3) المسار ما له KID بالـ MPD وفيه مفتاح وحيد: يُستخدم له.
 *  لو المسار له KID معروف وما طابقه أي مفتاح kid:key → null (يرفض بدل ما يفك بمفتاح غلط). */
function pickKey(track, keys) {
  if (track.kid && keys.map[track.kid]) return keys.map[track.kid];
  if (keys.anon.length === 1 && !Object.keys(keys.map).length) return keys.anon[0];
  if (track.kid) return null;
  const all = [...Object.values(keys.map), ...keys.anon];
  return all.length === 1 ? all[0] : null;
}

function keyStatus(track, keys) {
  const key = pickKey(track, keys);
  if (key) return 'ok';
  return track.kid ? 'missing' : 'none';
}

// ---------- جلسة MPD (تُستخدم أثناء البث) ----------
/** يجهّز جلسة: يجلب الـ MPD، يختار المسارات، يطابق المفاتيح.
 *  videoId/audioId: معرّف مسار، أو 'none' بدون، أو فاضي = تلقائي (أعلى جودة / أول صوت). */
async function prepareSession({ url, keysText, videoId, audioId, wantAudio = true, id }) {
  const headers = upstreamHeaders(url);
  const { text } = await fetchMpd(url, headers);
  const info = analyzeMpd(text);
  const keys = parseKeys(keysText);

  const find = (list, wanted, fallback) => {
    if (wanted === 'none') return null;
    if (!wanted || wanted === 'auto') return fallback;
    const t = list.find((x) => x.id === wanted);
    if (!t) throw new Error('المسار المختار ما عاد موجود بالـ MPD — افحص الرابط من جديد');
    return t;
  };
  const video = find(info.video, videoId, bestVideo(info.video));
  const audio = wantAudio ? find(info.audio, audioId, info.audio[0] || null) : null;
  if (!video && !audio) throw new Error('ما فيه فيديو ولا صوت مختار');

  const keyOf = {};
  for (const [kind, t] of [['video', video], ['audio', audio]]) {
    if (!t) continue;
    const key = pickKey(t, keys);
    if (t.kid && !key) {
      throw new Error(`ما لقيت مفتاح للـ KID ${t.kid} (${kind === 'video' ? 'الفيديو' : 'الصوت'}) — أضفه بصيغة kid:key`);
    }
    keyOf[kind] = key;
  }
  return { id, url, headers, info, tracks: { video, audio }, keyOf };
}

/** وضع "كل شي": كل جودات الفيديو وكل مسارات الصوت. نجمعها بمجموعات (AdaptationSet) — كل مجموعة input
 *  لـ ffmpeg بمفتاحها الخاص (حسب الـ KID). */
async function prepareAllSession({ url, keysText, id }) {
  const headers = upstreamHeaders(url);
  const { text } = await fetchMpd(url, headers);
  const info = analyzeMpd(text);
  const keys = parseKeys(keysText);
  if (!info.video.length) throw new Error('ما لقيت مسارات فيديو بالـ MPD');

  const bySet = new Map();
  for (const t of [...info.video, ...info.audio]) {
    const si = Number(t.id.split('.')[0]);
    if (!bySet.has(si)) bySet.set(si, { idx: si, type: t.type, tracks: [] });
    bySet.get(si).tracks.push(t);
  }
  const allSets = [...bySet.values()].sort((a, b) => a.idx - b.idx);
  const keyList = [...new Set([...Object.values(keys.map), ...keys.anon])];
  const sets = [];
  const dropped = [];
  for (const set of allSets) {
    const withKid = set.tracks.find((t) => t.kid) || set.tracks[0];
    set.kid = withKid.kid || null;
    set.key = pickKey(withKid, keys);
    if (set.kid && !set.key) {
      // مجموعة لها KID ما عندنا مفتاحه: نتجاوزها بدل ما نفشل البث كله
      dropped.push({ type: set.type, idx: set.idx, reason: `ما لقيت مفتاح للـ KID ${set.kid}` });
      continue;
    }
    sets.push(set);
  }
  if (!sets.some((x) => x.type === 'video')) {
    const why = dropped.find((d) => d.type === 'video');
    throw new Error(why ? `${why.reason} (الفيديو) — أضفه بصيغة kid:key` : 'ما لقيت مسارات فيديو بالـ MPD');
  }
  return { id, url, headers, info, all: true, sets, dropped, keyList };
}

module.exports = {
  prepareAllSession,
  analyzeMpd,
  buildTrackMpd,
  fetchMpd,
  upstreamHeaders,
  parseKeys,
  pickKey,
  keyStatus,
  bestVideo,
  prepareSession,
  parseXml,
  serialize,
  UA,
};
