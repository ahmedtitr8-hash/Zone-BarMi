// فك HEVC → H.264 "مباشر" بنفس الرابط: بدون كتابة ملفات ولا إعادة بناء HLS.
// تعطيه رابط الـmaster، ويرجع لك نفس الرابط بنفس المسارات على دومين الأكشن:
//   - القوائم (master / الجودات) تمر كما هي (نفس الأسماء والمسارات)، والفرق الوحيد أن CODECS تنقلب لـH.264
//     وتنحذف الجودات اللي ما اخترتها.
//   - الصوت يمر بدون أي لمس.
//   - مقاطع الفيديو بس تنفك لحظة ما المشغّل يطلبها (بذاكرة مؤقتة، بدون ملفات)، وتنحفظ نفس التوقيتات الأصلية.
//
//   POST /api/decode/start  { url, qualities:[720,1080,1440,2160], ref? }
//   GET  /api/decode/jobs
//   POST /api/decode/stop   { id }
//   GET  /d/<id>/<نفس المسار>  ← الرابط الجاهز

const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

const MAX_HOURS = Number(process.env.MAX_RECORDING_HOURS) || 5;
const MAX_JOBS = 2;
const CONCURRENCY = 2;          // كم مقطع يتفك بنفس اللحظة
const PREFETCH = 3;             // أحدث كم مقطع يتجهز مسبقًا لما المشغّل يحمّل القائمة
const CACHE_MAX = 40;           // عدد المقاطع المفكوكة بالذاكرة
const FETCH_TIMEOUT_MS = 20000;
const ENC_TIMEOUT_MS = 60000;
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36';

const LADDER = {
  720:  { b: '3M',  max: '4M',  buf: '8M',  bw: 3200000,  avc: '64001f' },
  1080: { b: '6M',  max: '7M',  buf: '12M', bw: 6200000,  avc: '64002a' },
  1440: { b: '10M', max: '12M', buf: '20M', bw: 10200000, avc: '640032' },
  2160: { b: '16M', max: '19M', buf: '32M', bw: 16200000, avc: '640033' },
};

const jobs = new Map();

// ---------- أدوات ----------
function parseAttrs(s) {
  const out = [];
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) out.push([m[1], m[2]]);
  return out;
}
const attrsToStr = a => a.map(([k, v]) => `${k}=${v}`).join(',');
const getAttr = (a, k) => { const x = a.find(p => p[0] === k); return x ? x[1] : null; };
const setAttr = (a, k, v) => { const x = a.find(p => p[0] === k); if (x) x[1] = v; else a.push([k, v]); };
const unq = s => (s || '').replace(/^"|"$/g, '');

async function fetchUp(job, url) {
  const headers = { 'User-Agent': UA };
  if (job.ref) headers.Referer = job.ref;
  const r = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, buf, type: r.headers.get('content-type') || '' };
}

const isPlaylist = buf => buf.length > 7 && buf.slice(0, 7).toString('latin1') === '#EXTM3U';

// رابط داخل قائمة → رابط على الأكشن (نسبي يبقى نسبي، مطلق ينحوّل لمعرّف)
function mapUri(job, uri, playlistUrl) {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(uri) && !uri.startsWith('//')) return uri;   // نسبي: يشتغل كما هو
  const abs = new URL(uri, playlistUrl).href;
  let k = job.absRev.get(abs);
  if (!k) { k = String(job.absMap.size + 1); job.absMap.set(k, abs); job.absRev.set(abs, k); }
  return `${job.mountPath}/~/${k}`;
}

// ---------- المعالجة ----------
function processMaster(job, text, masterUrl) {
  const lines = text.split(/\r?\n/);
  const out = [];
  const avail = new Set();
  const keep = new Set(job.wanted);
  job.videoPlaylists = new Set();
  job.audioLangs = [];
  job.picked = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF')) continue;
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = parseAttrs(line.slice(18));
      const res = (getAttr(attrs, 'RESOLUTION') || '').match(/x(\d+)/);
      const h = res ? Number(res[1]) : 0;
      let j = i + 1;
      while (j < lines.length && (lines[j].trim() === '' || lines[j].startsWith('#'))) j++;
      const uri = (lines[j] || '').trim();
      i = j;
      if (h) avail.add(h);
      if (!keep.has(h) || !uri) continue;
      const L = LADDER[h];
      const codecs = unq(getAttr(attrs, 'CODECS'));
      if (codecs) setAttr(attrs, 'CODECS', '"' + codecs.split(',').map(c => /^(hvc1|hev1|dvh1|dvhe)\./i.test(c.trim()) ? 'avc1.' + L.avc : c.trim()).join(',') + '"');
      setAttr(attrs, 'BANDWIDTH', String(L.bw));
      const avg = attrs.findIndex(p => p[0] === 'AVERAGE-BANDWIDTH'); if (avg >= 0) attrs.splice(avg, 1);
      out.push('#EXT-X-STREAM-INF:' + attrsToStr(attrs));
      out.push(mapUri(job, uri, masterUrl));
      job.videoPlaylists.add(new URL(uri, masterUrl).href);
      job.picked.push(h);
      continue;
    }
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseAttrs(line.slice(13));
      if (getAttr(attrs, 'TYPE') === 'AUDIO') job.audioLangs.push(unq(getAttr(attrs, 'LANGUAGE')) || unq(getAttr(attrs, 'NAME')) || '?');
      const u = getAttr(attrs, 'URI');
      if (u) { setAttr(attrs, 'URI', '"' + mapUri(job, unq(u), masterUrl) + '"'); out.push('#EXT-X-MEDIA:' + attrsToStr(attrs)); continue; }
    }
    out.push(line);
  }
  job.skipped = job.wanted.filter(q => !job.picked.includes(q));
  if (!job.picked.length) {
    const have = [...avail].sort((a, b) => a - b).join(', ');
    throw new Error(`المصدر ما فيه الجودات المطلوبة. المتوفر: ${have || 'لا شي'}`);
  }
  job.picked.sort((a, b) => a - b);
  return out.join('\n');
}

function processMedia(job, text, playlistUrl) {
  const isVideo = job.videoPlaylists.has(playlistUrl);
  if (isVideo && /#EXT-X-MAP:/.test(text)) throw new Error('المصدر fMP4/CMAF (فيه EXT-X-MAP) — الفك المباشر يدعم مقاطع TS فقط');
  const lines = text.split(/\r?\n/);
  const out = [];
  const segs = [];
  let dur = 0;
  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) { dur = parseFloat(line.slice(8)) || 0; out.push(line); continue; }
    if (line.startsWith('#')) {
      if (/URI="/.test(line)) out.push(line.replace(/URI="([^"]*)"/g, (_, u) => 'URI="' + mapUri(job, u, playlistUrl) + '"'));
      else out.push(line);
      continue;
    }
    if (line.trim() === '') { out.push(line); continue; }
    out.push(mapUri(job, line.trim(), playlistUrl));
    if (isVideo) segs.push({ url: new URL(line.trim(), playlistUrl).href, dur });
    dur = 0;
  }
  return { body: out.join('\n'), segs, isVideo };
}

// ---------- فك المقاطع ----------
let running = 0;
const waiters = [];
function slot() {
  return new Promise(res => { const go = () => { running++; res(); }; running < CONCURRENCY ? go() : waiters.push(go); });
}
function release() { running--; const n = waiters.shift(); if (n) n(); }

function transcode(buf, height) {
  const L = LADDER[height];
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-copyts', '-i', 'pipe:0',
      '-map', '0:v:0', '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
      '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-sc_threshold', '0',
      '-b:v', L.b, '-maxrate', L.max, '-bufsize', L.buf,
      '-f', 'mpegts', '-mpegts_copyts', '1', '-muxdelay', '0', '-muxpreload', '0', 'pipe:1'];
    const p = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; let err = '';
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} reject(new Error('انتهت مهلة فك المقطع')); }, ENC_TIMEOUT_MS);
    p.stdout.on('data', d => chunks.push(d));
    p.stderr.on('data', d => { err += d; });
    p.stdin.on('error', () => {});
    p.on('error', e => { clearTimeout(t); reject(e); });
    p.on('close', code => {
      clearTimeout(t);
      const out = Buffer.concat(chunks);
      if (code !== 0 || !out.length) return reject(new Error('ffmpeg: ' + (err.trim().split('\n').pop() || 'code ' + code)));
      resolve(out);
    });
    p.stdin.end(buf);
  });
}

function ensureSeg(job, seg) {
  let e = job.cache.get(seg.url);
  if (e) return e.promise;
  e = {};
  e.promise = (async () => {
    await slot();
    try {
      const t0 = Date.now();
      const up = await fetchUp(job, seg.url);
      if (up.status !== 200) throw new Error('المصدر رجّع ' + up.status);
      const height = job.segHeight.get(seg.url);
      const out = await transcode(up.buf, height);
      const sec = (Date.now() - t0) / 1000;
      if (seg.dur > 0) { job.speeds.push(seg.dur / sec); if (job.speeds.length > 5) job.speeds.shift(); }
      job.segments++;
      return out;
    } finally { release(); }
  })();
  e.promise.catch(err => { job.errors++; job.lastError = err.message; job.cache.delete(seg.url); });
  job.cache.set(seg.url, e);
  while (job.cache.size > CACHE_MAX) job.cache.delete(job.cache.keys().next().value);
  return e.promise;
}

// ---------- الطلبات ----------
async function handle(req, res, id) {
  const job = jobs.get(id);
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' }); res.end(body); };
  if (!job || job.stopped) return send(404, 'text/plain; charset=utf-8', 'العملية غير موجودة أو متوقفة');
  try {
    const qi = req.url.indexOf('?');
    const pathPart = qi >= 0 ? req.url.slice(0, qi) : req.url;
    const query = qi >= 0 ? req.url.slice(qi) : '';
    const rest = pathPart.slice(job.mountPath.length + 1);
    let target;
    if (rest.startsWith('~/')) {
      target = job.absMap.get(rest.slice(2));
      if (!target) return send(404, 'text/plain', 'not found');
    } else {
      target = new URL(rest + query, job.baseDir).href;
      if (new URL(target).origin !== job.origin) return send(403, 'text/plain', 'forbidden');
    }

    // مقطع فيديو معروف → فك
    const known = job.segHeight.has(target) ? job.segIndex.get(target) : null;
    if (known) {
      const out = await ensureSeg(job, known);
      res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': out.length, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
      return res.end(out);
    }

    const up = await fetchUp(job, target);
    if (up.status !== 200) return send(up.status, 'text/plain; charset=utf-8', 'المصدر رجّع ' + up.status);
    if (!isPlaylist(up.buf)) {      // صوت أو أي ملف ثاني: يمر كما هو
      res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': up.buf.length, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
      return res.end(up.buf);
    }
    const text = up.buf.toString('utf8');
    if (text.includes('#EXT-X-STREAM-INF')) {
      job.ready = true;
      return send(200, 'application/vnd.apple.mpegurl', processMaster(job, text, target));
    }
    const m = processMedia(job, text, target);
    if (m.isVideo) {
      const h = job.playlistHeight.get(target);
      for (const s of m.segs) { job.segHeight.set(s.url, h); job.segIndex.set(s.url, s); }
      while (job.segIndex.size > 200) { const k = job.segIndex.keys().next().value; job.segIndex.delete(k); job.segHeight.delete(k); }
      m.segs.slice(-PREFETCH).forEach(s => ensureSeg(job, s).catch(() => {}));
    }
    return send(200, 'application/vnd.apple.mpegurl', m.body);
  } catch (e) {
    job.errors++; job.lastError = e.message;
    send(502, 'text/plain; charset=utf-8', e.message);
  }
}

async function startJob({ url, qualities, ref }) {
  if (!/^https?:\/\/\S+$/i.test(url || '')) throw new Error('الرابط لازم يبدأ بـ https://');
  if (ref && !/^https?:\/\/\S+$/i.test(ref)) throw new Error('الـ Referer لازم رابط كامل');
  const active = [...jobs.values()].filter(j => !j.stopped).length;
  if (active >= MAX_JOBS) throw new Error(`فيه ${active} عمليات شغّالة، أوقف وحدة أول`);
  const wanted = [...new Set((qualities && qualities.length ? qualities : [720, 1080]).map(Number))].filter(q => LADDER[q]).sort((a, b) => a - b);
  if (!wanted.length) throw new Error('اختر جودة وحدة على الأقل');

  const u = new URL(url);
  const id = randomUUID().replace(/-/g, '').slice(0, 12);
  const job = {
    id, ref: ref || '', wanted, mountPath: `/d/${id}`,
    origin: u.origin, baseDir: new URL('./', u.origin + u.pathname).href,
    masterName: u.pathname.split('/').pop() || 'master.m3u8', masterQuery: u.search,
    source: u.host, videoPlaylists: new Set(), playlistHeight: new Map(), picked: [], skipped: [], audioLangs: [],
    segHeight: new Map(), segIndex: new Map(), cache: new Map(), absMap: new Map(), absRev: new Map(),
    speeds: [], segments: 0, errors: 0, lastError: '', ready: false, stopped: false, startedAt: Date.now(),
  };
  // نتأكد من الرابط ونقرأ الجودات قبل ما نرجع الرابط
  const up = await fetchUp(job, url);
  if (up.status !== 200) throw new Error('المصدر رجّع ' + up.status);
  if (!isPlaylist(up.buf)) throw new Error('الرابط مو قائمة HLS');
  const text = up.buf.toString('utf8');
  if (!text.includes('#EXT-X-STREAM-INF')) throw new Error('الرابط قائمة جودة وحدة مو master — حط رابط الـ master');
  processMaster(job, text, new URL(url).href);          // يرمي خطأ لو ما فيه الجودات المطلوبة
  // نربط كل قائمة فيديو بارتفاعها (لاختيار معدل الترميز)
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const res = (getAttr(parseAttrs(lines[i].slice(18)), 'RESOLUTION') || '').match(/x(\d+)/);
    let j = i + 1; while (j < lines.length && (lines[j].trim() === '' || lines[j].startsWith('#'))) j++;
    if (res && lines[j]) job.playlistHeight.set(new URL(lines[j].trim(), url).href, Number(res[1]));
  }
  job.ready = true;
  job.killTimer = setTimeout(() => stopJob(id), MAX_HOURS * 3600 * 1000);
  jobs.set(id, job);
  return job;
}

function stopJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  job.stopped = true;
  clearTimeout(job.killTimer);
  job.cache.clear(); job.segIndex.clear(); job.segHeight.clear();
  return true;
}

function publicView(j) {
  const sp = j.speeds.length ? j.speeds.reduce((a, b) => a + b, 0) / j.speeds.length : null;
  return {
    id: j.id, state: j.stopped ? 'stopped' : 'running', speed: sp, errors: j.errors, lastError: j.lastError,
    segments: j.segments, source: j.source, qualities: j.picked, skipped: j.skipped, audio: j.audioLangs,
    ready: j.ready, path: `${j.mountPath}/${j.masterName}${j.masterQuery}`, startedAt: j.startedAt,
  };
}

function mount(app, requireApiKey) {
  app.get('/d/:id/*', (req, res) => handle(req, res, req.params.id));

  app.post('/api/decode/start', requireApiKey, async (req, res) => {
    try {
      const b = req.body || {};
      const job = await startJob({ url: String(b.url || '').trim(), qualities: Array.isArray(b.qualities) ? b.qualities : [], ref: String(b.ref || '').trim() });
      res.json(publicView(job));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.get('/api/decode/jobs', requireApiKey, (req, res) => {
    res.json({ jobs: [...jobs.values()].filter(j => !j.stopped).map(publicView) });
  });
  app.post('/api/decode/stop', requireApiKey, (req, res) => {
    if (!stopJob(String((req.body && req.body.id) || ''))) return res.status(404).json({ error: 'العملية غير موجودة' });
    res.json({ ok: true });
  });
}

module.exports = { mount, _internal: { startJob, stopJob, publicView, handle, jobs } };
