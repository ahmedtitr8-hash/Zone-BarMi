'use strict';
// ==================== فك تشفير cbcs (AES-128-CBC) لمقاطع DASH/CMAF ====================
// ffmpeg ما يفك cbcs (يدعم cenc فقط)، فالنفق يفك المقاطع بنفسه ويعطي ffmpeg مقاطع نظيفة.
// الاستخدام من server.js: مسار /internal/cbcs/... يجلب المقطع، يفكه، ويرجّعه.
const crypto = require('crypto');

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

// معلومات التشفير الإضافية (sample groups من نوع seig، وuuid بصيغة PIFF senc، وpssh) — لو بقيت بعد فك التشفير
// كروم يعتبر العيّنات "مشفّرة" ويطلب senc → CHUNK_DEMUXER_ERROR_APPEND_FAILED: Sample encryption info is not available.
const PIFF_SENC = 'a2394f525a9b4f14a2446c427c648df4';
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'moof', 'traf']);
function stripEncInfo(buf, start, end) {
  for (const b of boxes(buf, start, end)) {
    if (CONTAINERS.has(b.type)) { stripEncInfo(buf, b.body, b.end); continue; }
    if (b.type === 'pssh') setType(buf, b, 'free');
    else if ((b.type === 'sgpd' || b.type === 'sbgp') && b.size >= b.hdr + 8 && buf.toString('latin1', b.body + 4, b.body + 8) === 'seig') setType(buf, b, 'free');
    else if (b.type === 'uuid' && b.size >= b.hdr + 16 && buf.subarray(b.body, b.body + 16).toString('hex') === PIFF_SENC) setType(buf, b, 'free');
  }
}

// يشيل التشفير من الـ init: encv/enca → الصيغة الأصلية، sinf/pssh → free. يرجّع KID والنظام.
function cleanInit(src) {
  const buf = Buffer.from(src);
  let kid = '', scheme = '', crypt = 0, skip = 0, ivSize = 8, constIv = null;
  const moov = [...boxes(buf, 0, buf.length)].find((b) => b.type === 'moov');
  if (!moov) throw new Error('init غير صالح (ما فيه moov)');
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
      if (te > 0 && te < sinfEnd) {
        kid = buf.subarray(te + 12, te + 28).toString('hex');
        crypt = buf[te + 9] >> 4; skip = buf[te + 9] & 15;          // نمط التشفير (cbcs: عادةً 1:9 للفيديو و0:0 للصوت)
        ivSize = buf[te + 11];                                      // 0 = IV ثابت لكل المسار
        if (ivSize === 0 && buf[te + 10] === 1) { const cl = buf[te + 28]; constIv = Buffer.from(buf.subarray(te + 29, te + 29 + cl)); }
      }
      buf.write(orig, entryStart + 4, 'latin1');
      buf.write('free', sinfStart + 4, 'latin1');
    }
  }
  stripEncInfo(buf, moov.body, moov.end);
  return { buf, kid, scheme, crypt, skip, ivSize, constIv };
}

function parseSenc(buf, b, forceIvSize) {
  const flags = buf.readUInt32BE(b.body) & 0xffffff;
  const count = buf.readUInt32BE(b.body + 4);
  for (const ivSize of (forceIvSize === undefined ? [8, 16] : [forceIvSize])) {
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

// cbcs = AES-128-CBC بنمط (crypt:skip) على كتل 16 بايت، IV ثابت (أو من senc)، والسلسلة تبدأ من الـIV عند بداية كل subsample.
// الكتل المشفّرة بس تتسلسل مع بعض (الكتل المتخطّاة ما تأثر بالسلسلة). الباقي أقل من 16 بايت يبقى بدون تشفير.
function cbcsRange(buf, off, len, key, iv, crypt, skip) {
  const nBlocks = Math.floor(len / 16);
  if (!nBlocks) return;
  const idx = [];
  if (!crypt && !skip) for (let i = 0; i < nBlocks; i++) idx.push(i);
  else { const cyc = crypt + skip; for (let i = 0; i < nBlocks; i++) if ((i % cyc) < crypt) idx.push(i); }
  if (!idx.length) return;
  const joined = Buffer.alloc(idx.length * 16);
  idx.forEach((bi, k) => buf.copy(joined, k * 16, off + bi * 16, off + bi * 16 + 16));
  const d = crypto.createDecipheriv('aes-128-cbc', key, iv); d.setAutoPadding(false);
  const out = Buffer.concat([d.update(joined), d.final()]);
  idx.forEach((bi, k) => out.copy(buf, off + bi * 16, k * 16, k * 16 + 16));
}
function cbcsSample(buf, pos, size, e, key, enc) {
  const iv16 = Buffer.alloc(16);
  const srcIv = (e.iv && e.iv.length) ? e.iv : Buffer.from(enc.v || '', 'hex');
  srcIv.copy(iv16, 0, 0, Math.min(16, srcIv.length));
  if (!e.subs.length) return cbcsRange(buf, pos, size, key, iv16, enc.c, enc.p);
  let q = pos;
  for (const [clr, encLen] of e.subs) { q += clr; cbcsRange(buf, q, encLen, key, iv16, enc.c, enc.p); q += encLen; }
}

function decryptSegment(src, keyHex, enc) {
  const buf = Buffer.from(src);
  const key = Buffer.from(keyHex, 'hex');
  let did = false;
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
        else if (c.type === 'uuid' && c.size >= c.hdr + 16 && buf.subarray(c.body, c.body + 16).toString('hex') === PIFF_SENC) senc = { ...c, body: c.body + 16 };
      }
      if (!senc) continue; // مقطع بدون تشفير (أو صيغة غير مدعومة، يُكشف بالهيدر X-Decrypted)
      const isCbcs = !!(enc && enc.s === 'cbcs');
      const entries = parseSenc(buf, senc, isCbcs ? enc.z : undefined);
      let si = 0, prevEnd = baseOff; did = true;
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
          if (e && isCbcs) cbcsSample(buf, pos, size, e, key, enc);
          else if (e) {
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
      for (const c of boxes(buf, traf.body, traf.end)) if (['senc', 'saiz', 'saio', 'uuid'].includes(c.type) && (c.type !== 'uuid' || buf.subarray(c.body, c.body + 16).toString('hex') === PIFF_SENC)) setType(buf, c, 'free');
    }
    stripEncInfo(buf, moof.body, moof.end); // seig/sbgp/sgpd/pssh المتبقية
  }
  buf.did = did;
  return buf;
}


/** يفك مقطع واحد (init أو مقطع وسائط). enc = { s:'cbcs', c, p, z, v } من init.
 *  init  → يرجّع init نظيف + enc المستخرج. مقطع وسائط → يرجّع المقطع مفكوك. */
function processSegment(buf, keyHex, enc) {
  const hasMoov = [...boxes(buf, 0, buf.length)].some((b) => b.type === 'moov');
  if (hasMoov) {
    const c = cleanInit(buf);
    if (c.scheme && c.scheme !== 'cbcs') return { out: buf, enc: null, scheme: c.scheme };
    return {
      out: c.buf,
      scheme: c.scheme,
      enc: c.scheme === 'cbcs' ? { s: 'cbcs', c: c.crypt, p: c.skip, z: c.ivSize, v: c.constIv ? c.constIv.toString('hex') : '' } : null,
    };
  }
  if (!enc) throw new Error('مقطع وسائط وصل قبل الـ init');
  return { out: decryptSegment(buf, keyHex, enc), enc, scheme: 'cbcs' };
}

module.exports = { processSegment, cleanInit, decryptSegment };
