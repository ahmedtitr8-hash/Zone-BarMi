// Vercel Function (Node.js) — MPD مشفّر (ClearKey/CENC) → HLS عادي بدون تشفير، على دومينك مباشرة.
// بدون FFmpeg، بدون نفق، بدون Worker، وبدون تخزين: كل مقطع يُسحب من المصدر ويُفك تشفيره لحظتها ويرجع للمشغّل.
// الاستخدام: https://<دومينك>/mh/master.m3u8?url=<mpd>&k=kid:key[&k=...][&ref=<Referer>]
const crypto = require('crypto');

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': '*' };
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';
const WINDOW_SEGMENTS = 10; // آخر كم مقطع نعرضه بالقائمة الحية
const HEX32 = /^[0-9a-f]{32}$/;

const b64uEnc = (s) => Buffer.from(s, 'utf8').toString('base64url');
const b64uDec = (s) => Buffer.from(s, 'base64url').toString('utf8');
const unesc = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
const escAttr = (s) => String(s).replace(/"/g, '');

function send(res, status, body, headers = {}) {
  res.statusCode = status;
  for (const [k, v] of Object.entries({ ...CORS, ...headers })) res.setHeader(k, v);
  res.end(body);
}
const fail = (res, status, msg) => send(res, status, msg, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });

function parseKeys(sp) {
  const keys = [];
  for (const raw of sp.getAll('k')) {
    for (const line of raw.split(/[\r\n,;]+/)) {
      const t = line.trim();
      if (!t) continue;
      const [kid, key, ...rest] = t.split(/[\s:]+/).map((x) => x.replace(/-/g, '').toLowerCase());
      if (rest.length || !HEX32.test(kid || '') || !HEX32.test(key || '')) throw new Error('مفتاح غير صالح — الصيغة kid:key (كل واحد 32 hex)');
      keys.push({ kid, key });
    }
  }
  return keys;
}
function cleanRef(v) { v = (v || '').trim(); try { return v ? (new URL(v), v) : ''; } catch { return ''; } }
function upHeaders(u, ref) {
  return { 'User-Agent': UA, Referer: ref || `${u.protocol}//${u.host}/`, ...(ref ? { Origin: new URL(ref).origin } : {}) };
}
async function getBuf(url, ref, extra = {}) {
  const r = await fetch(url, { headers: { ...upHeaders(new URL(url), ref), ...extra }, redirect: 'follow' });
  if (!r.ok) { const e = new Error(`المصدر رجّع ${r.status}`); e.status = r.status; throw e; }
  return { buf: Buffer.from(await r.arrayBuffer()), url: r.url || url };
}

// ================= MPD =================
const attrsOf = (tag) => { const o = {}; tag.replace(/([\w:-]+)="([^"]*)"/g, (_m, k, v) => { o[k] = unesc(v); }); return o; };

function parseMpd(xml, mpdUrl) {
  const mpdTag = (xml.match(/<MPD\b[^>]*>/) || [''])[0];
  const mpd = attrsOf(mpdTag);
  const head = xml.slice(0, xml.search(/<Period[\s>]/) >= 0 ? xml.search(/<Period[\s>]/) : xml.length);
  const bu = head.match(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/);
  const base = bu ? new URL(unesc(bu[1].trim()), mpdUrl).toString() : mpdUrl;
  const reps = [];
  const asRe = /<AdaptationSet\b[^>]*>[\s\S]*?<\/AdaptationSet>/g;
  let am;
  while ((am = asRe.exec(xml))) {
    const asXml = am[0];
    const asAttr = attrsOf(asXml.match(/<AdaptationSet\b[^>]*>/)[0]);
    const kind = /video/.test(asAttr.mimeType || asAttr.contentType || '') ? 'video' : /audio/.test(asAttr.mimeType || asAttr.contentType || '') ? 'audio' : null;
    if (!kind) continue;
    const label = (asXml.match(/<Label>([^<]*)<\/Label>/) || [])[1] || asAttr.lang || '';
    const asTpl = (asXml.replace(/<Representation\b[\s\S]*?<\/Representation>/g, '').match(/<SegmentTemplate\b[^>]*\/>|<SegmentTemplate\b[^>]*>[\s\S]*?<\/SegmentTemplate>/) || [])[0];
    const rpRe = /<Representation\b[^>]*>[\s\S]*?<\/Representation>/g;
    let rm;
    while ((rm = rpRe.exec(asXml))) {
      const rXml = rm[0];
      const rAttr = attrsOf(rXml.match(/<Representation\b[^>]*>/)[0]);
      const tplXml = (rXml.match(/<SegmentTemplate\b[^>]*\/>|<SegmentTemplate\b[^>]*>[\s\S]*?<\/SegmentTemplate>/) || [asTpl])[0];
      if (!tplXml) continue;
      const tpl = attrsOf(tplXml.match(/<SegmentTemplate\b[^>]*>/)[0]);
      const segs = [];
      const tl = tplXml.match(/<SegmentTimeline>([\s\S]*?)<\/SegmentTimeline>/);
      if (tl) {
        let t = 0, first = true;
        tl[1].replace(/<S\b([^>]*)\/?>/g, (_m, a) => {
          const s = attrsOf(a);
          if (s.t !== undefined) t = Number(s.t); else if (first) t = 0;
          first = false;
          const d = Number(s.d), r = s.r !== undefined ? Number(s.r) : 0;
          for (let i = 0; i <= Math.max(r, 0); i++) { segs.push({ t, d }); t += d; }
        });
      }
      reps.push({ kind, id: rAttr.id, label, lang: asAttr.lang || '', bandwidth: Number(rAttr.bandwidth || 0), width: rAttr.width, height: rAttr.height, frameRate: rAttr.frameRate, codecs: rAttr.codecs || asAttr.codecs || '', tpl, segs });
    }
  }
  return { dynamic: mpd.type === 'dynamic', base, query: new URL(mpdUrl).search.slice(1), reps };
}

function fillTemplate(tpl, id, bandwidth, num, time) {
  return tpl.replace(/\$(RepresentationID|Bandwidth|Number|Time)(?:%0(\d+)d)?\$/g, (_m, name, pad) => {
    const v = name === 'RepresentationID' ? id : name === 'Bandwidth' ? bandwidth : name === 'Number' ? num : time;
    return pad ? String(v).padStart(Number(pad), '0') : String(v);
  }).replace(/\$\$/g, '$');
}
function absUrl(rel, parsed) {
  const u = new URL(rel, parsed.base);
  if (parsed.query && !u.search.includes(parsed.query)) u.search = u.search ? `${u.search}&${parsed.query}` : `?${parsed.query}`;
  return u.toString();
}
const tokenUrl = (origin, o) => `${origin}/mh/s/${b64uEnc(JSON.stringify(o))}`;

// ================= MP4 =================
function* boxes(buf, start, end) {
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p), hdr = 8;
    const type = buf.toString('latin1', p + 4, p + 8);
    if (size === 1) { size = Number(buf.readBigUInt64BE(p + 8)); hdr = 16; } else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) return;
    yield { type, start: p, hdr, size, end: p + size, body: p + hdr };
    p += size;
  }
}
const setType = (buf, box, t) => buf.write(t, box.start + 4, 'latin1');

// يشيل التشفير من الـ init: encv/enca → الصيغة الأصلية، sinf/pssh → free. يرجّع KID والنظام.
function cleanInit(src) {
  const buf = Buffer.from(src);
  let kid = '', scheme = '';
  const moov = [...boxes(buf, 0, buf.length)].find((b) => b.type === 'moov');
  if (!moov) throw new Error('init غير صالح (ما فيه moov)');
  for (const b of boxes(buf, moov.body, moov.end)) {
    if (b.type === 'pssh') setType(buf, b, 'free');
  }
  const region = buf.subarray(moov.start, moov.end);
  for (const tag of ['encv', 'enca']) {
    let from = 0, i;
    while ((i = region.indexOf(tag, from, 'latin1')) >= 0) {
      from = i + 4;
      const entryStart = moov.start + i - 4;
      const entrySize = buf.readUInt32BE(entryStart);
      const entryEnd = entryStart + entrySize;
      const s = buf.indexOf('sinf', entryStart + 8, 'latin1');
      if (s < 0 || s > entryEnd) continue;
      const sinfStart = s - 4, sinfEnd = sinfStart + buf.readUInt32BE(sinfStart);
      const fr = buf.indexOf('frma', sinfStart, 'latin1');
      if (fr < 0 || fr > sinfEnd) continue;
      const orig = buf.toString('latin1', fr + 4, fr + 8);
      const sc = buf.indexOf('schm', sinfStart, 'latin1');
      if (sc > 0 && sc < sinfEnd) scheme = buf.toString('latin1', sc + 8, sc + 12);
      const te = buf.indexOf('tenc', sinfStart, 'latin1');
      if (te > 0 && te < sinfEnd) kid = buf.subarray(te + 12, te + 28).toString('hex');
      buf.write(orig, entryStart + 4, 'latin1');
      buf.write('free', sinfStart + 4, 'latin1');
    }
  }
  return { buf, kid, scheme };
}

function parseSenc(buf, b) {
  const flags = buf.readUInt32BE(b.body) & 0xffffff;
  const count = buf.readUInt32BE(b.body + 4);
  for (const ivSize of [8, 16]) {
    let p = b.body + 8; const out = []; let ok = true;
    for (let i = 0; i < count && ok; i++) {
      if (p + ivSize > b.end) { ok = false; break; }
      const iv = buf.subarray(p, p + ivSize); p += ivSize;
      const subs = [];
      if (flags & 2) {
        if (p + 2 > b.end) { ok = false; break; }
        const n = buf.readUInt16BE(p); p += 2;
        if (p + n * 6 > b.end) { ok = false; break; }
        for (let j = 0; j < n; j++) { subs.push([buf.readUInt16BE(p), buf.readUInt32BE(p + 2)]); p += 6; }
      }
      out.push({ iv, subs });
    }
    if (ok && p === b.end) return out;
  }
  throw new Error('تعذّر قراءة senc');
}

function decryptSegment(src, keyHex) {
  const buf = Buffer.from(src);
  const key = Buffer.from(keyHex, 'hex');
  for (const moof of boxes(buf, 0, buf.length)) {
    if (moof.type !== 'moof') continue;
    for (const traf of boxes(buf, moof.body, moof.end)) {
      if (traf.type !== 'traf') continue;
      let defSize = 0, baseOff = moof.start, senc = null; const truns = [];
      for (const c of boxes(buf, traf.body, traf.end)) {
        if (c.type === 'tfhd') {
          const fl = buf.readUInt32BE(c.body) & 0xffffff; let p = c.body + 8;
          if (fl & 1) { baseOff = Number(buf.readBigUInt64BE(p)); p += 8; }
          if (fl & 2) p += 4; if (fl & 8) p += 4;
          if (fl & 0x10) defSize = buf.readUInt32BE(p);
        } else if (c.type === 'trun') truns.push(c);
        else if (c.type === 'senc') senc = c;
        if (c.type === 'senc' || c.type === 'saiz' || c.type === 'saio') c.rename = true;
      }
      if (!senc) continue; // مقطع بدون تشفير
      const entries = parseSenc(buf, senc);
      let si = 0, prevEnd = baseOff;
      for (const tr of truns) {
        const fl = buf.readUInt32BE(tr.body) & 0xffffff;
        const n = buf.readUInt32BE(tr.body + 4); let p = tr.body + 8;
        let pos = prevEnd;
        if (fl & 1) { pos = baseOff + buf.readInt32BE(p); p += 4; }
        if (fl & 4) p += 4;
        for (let i = 0; i < n; i++) {
          if (fl & 0x100) p += 4;
          let size = defSize;
          if (fl & 0x200) { size = buf.readUInt32BE(p); p += 4; }
          if (fl & 0x400) p += 4; if (fl & 0x800) p += 4;
          const e = entries[si++];
          if (e) {
            const iv16 = Buffer.alloc(16); e.iv.copy(iv16);
            const d = crypto.createDecipheriv('aes-128-ctr', key, iv16);
            if (!e.subs.length) {
              d.update(buf.subarray(pos, pos + size)).copy(buf, pos);
            } else {
              const parts = []; let q = pos;
              for (const [clr, enc] of e.subs) { q += clr; parts.push([q, enc]); q += enc; }
              const out = d.update(Buffer.concat(parts.map(([o, l]) => buf.subarray(o, o + l))));
              let w = 0; for (const [o, l] of parts) { out.copy(buf, o, w, w + l); w += l; }
            }
          }
          pos += size;
        }
        prevEnd = pos;
      }
      for (const c of boxes(buf, traf.body, traf.end)) if (['senc', 'saiz', 'saio'].includes(c.type)) setType(buf, c, 'free');
    }
  }
  return buf;
}

// ================= المسارات =================
const kidCache = new Map(); // رابط init → { kid, scheme } (يقلل الجلب)
async function pickKey(initUrl, keys, ref) {
  if (keys.length === 1) return keys[0].key;
  let info = kidCache.get(initUrl);
  if (!info) {
    const { buf } = await getBuf(initUrl, ref);
    const c = cleanInit(buf); info = { kid: c.kid, scheme: c.scheme };
    kidCache.set(initUrl, info);
    if (kidCache.size > 200) kidCache.delete(kidCache.keys().next().value);
  }
  const hit = keys.find((k) => k.kid === info.kid);
  if (!hit) throw new Error(`ما فيه مفتاح للـ KID ${info.kid}`);
  return hit.key;
}

async function loadMpd(sp) {
  const mpdUrl = new URL(sp.get('url') || '');
  if (!/^https?:$/.test(mpdUrl.protocol)) throw new Error('bad');
  const ref = cleanRef(sp.get('ref'));
  const { buf, url } = await getBuf(mpdUrl.toString(), ref);
  const xml = buf.toString('utf8');
  if (!/<MPD[\s>]/.test(xml)) throw new Error('الرد مو ملف MPD صالح');
  const finalUrl = url.includes('?') || !mpdUrl.search ? url : url + mpdUrl.search;
  return { parsed: parseMpd(xml, finalUrl), ref };
}

function qsKeep(sp) { // نفس البارامترات الأصلية تنعاد بروابط القوائم الفرعية
  const o = new URLSearchParams();
  for (const k of ['url', 'ref']) if (sp.get(k)) o.set(k, sp.get(k));
  for (const v of sp.getAll('k')) o.append('k', v);
  return o.toString();
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, '');
  const u = new URL(req.url, 'http://x');
  const sp = u.searchParams;
  const mode = sp.get('__m');
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const origin = `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;

  if (mode === 'seg') {
    let t;
    try { t = JSON.parse(b64uDec(sp.get('__t'))); new URL(t.u); } catch { return fail(res, 400, 'توكن غير صالح'); }
    try {
      const ref = cleanRef(t.r);
      const { buf } = await getBuf(t.u, ref);
      let out = buf;
      if (t.i) { const c = cleanInit(buf); if (c.scheme && c.scheme !== 'cenc') throw new Error(`نظام التشفير ${c.scheme} غير مدعوم (المدعوم cenc فقط)`); out = c.buf; }
      else if (t.k) out = decryptSegment(buf, t.k);
      return send(res, 200, out, { 'Content-Type': 'video/mp4', 'Content-Length': out.length, 'Cache-Control': 'public, max-age=30, s-maxage=30' });
    } catch (e) { return fail(res, e.status || 502, String(e.message || e)); }
  }

  let keys;
  try { keys = parseKeys(sp); } catch (e) { return fail(res, 400, e.message); }
  let m;
  try { m = await loadMpd(sp); } catch (e) { return fail(res, e.status || 400, e.message === 'bad' ? 'حط ?url=رابط_mpd' : `تعذّر جلب الـ MPD: ${e.message}`); }
  const { parsed, ref } = m;
  const q = qsKeep(sp);
  const M = (s) => String(s).replace(/"/g, "'");

  if (mode === 'master') {
    const vids = parsed.reps.filter((r) => r.kind === 'video').sort((a, b) => a.bandwidth - b.bandwidth);
    const auds = parsed.reps.filter((r) => r.kind === 'audio');
    if (!vids.length) return fail(res, 502, 'ما لقيت مسارات فيديو بالـ MPD');
    let o = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n';
    auds.forEach((a, i) => {
      o += `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="${M(a.label || a.lang || 'audio' + (i + 1))}",${a.lang ? `LANGUAGE="${M(a.lang)}",` : ''}DEFAULT=${i === 0 ? 'YES' : 'NO'},AUTOSELECT=YES,URI="${origin}/mh/media.m3u8?${q}&rep=${encodeURIComponent(a.id)}"\n`;
    });
    for (const v of vids) {
      const fr = v.frameRate ? (v.frameRate.includes('/') ? v.frameRate.split('/').reduce((x, y) => x / y) : Number(v.frameRate)) : 0;
      const codecs = [v.codecs, auds[0] && auds[0].codecs].filter(Boolean).join(',');
      o += `#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth + (auds[0] ? auds[0].bandwidth : 0)}${v.width ? `,RESOLUTION=${v.width}x${v.height}` : ''}${fr ? `,FRAME-RATE=${fr.toFixed(3)}` : ''}${codecs ? `,CODECS="${codecs}"` : ''}${auds.length ? ',AUDIO="aud"' : ''}\n${origin}/mh/media.m3u8?${q}&rep=${encodeURIComponent(v.id)}\n`;
    }
    return send(res, 200, o, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
  }

  if (mode === 'media') {
    const rep = parsed.reps.find((r) => String(r.id) === sp.get('rep'));
    if (!rep) return fail(res, 404, 'المسار غير موجود');
    if (!rep.segs.length) return fail(res, 501, 'هذا الـ MPD ما فيه SegmentTimeline (غير مدعوم حاليًا)');
    const initUrl = absUrl(fillTemplate(rep.tpl.initialization || '', rep.id, rep.bandwidth, 0, 0), parsed);
    let keyHex = '';
    if (keys.length) { try { keyHex = await pickKey(initUrl, keys, ref); } catch (e) { return fail(res, 502, e.message); } }
    const start = Number(rep.tpl.startNumber || 1), ts = Number(rep.tpl.timescale || 1);
    const all = rep.segs.map((s, i) => ({ ...s, n: start + i }));
    const win = parsed.dynamic ? all.slice(-WINDOW_SEGMENTS) : all;
    const target = Math.ceil(Math.max(...win.map((s) => s.d / ts)));
    let o = `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-TARGETDURATION:${target}\n#EXT-X-MEDIA-SEQUENCE:${win[0].n}\n`;
    if (!parsed.dynamic) o += '#EXT-X-PLAYLIST-TYPE:VOD\n';
    o += `#EXT-X-MAP:URI="${tokenUrl(origin, { u: initUrl, r: ref, i: 1 })}"\n`;
    for (const s of win) {
      const url = absUrl(fillTemplate(rep.tpl.media, rep.id, rep.bandwidth, s.n, s.t), parsed);
      o += `#EXTINF:${(s.d / ts).toFixed(3)},\n${tokenUrl(origin, { u: url, k: keyHex, r: ref })}\n`;
    }
    if (!parsed.dynamic) o += '#EXT-X-ENDLIST\n';
    return send(res, 200, o, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
  }
  return fail(res, 404, 'مسار غير معروف');
}

module.exports = (req, res) => { handle(req, res).catch((e) => fail(res, 500, String(e && e.message || e))); };
