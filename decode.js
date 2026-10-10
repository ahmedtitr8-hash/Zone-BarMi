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

const os = require('os');
const MAX_HOURS = Number(process.env.MAX_RECORDING_HOURS) || 5;
const MAX_JOBS = 2;
const CORES = Math.max(1, (os.cpus() || []).length || 1);
const CONCURRENCY = Number(process.env.DECODE_CONCURRENCY) || (CORES >= 4 ? 2 : 1);   // كم مقطع يتفك بنفس اللحظة
const THREADS = Math.max(1, Math.floor(CORES / CONCURRENCY));                          // خيوط كل ffmpeg
const PREFETCH = 3;             // أحدث كم مقطع يتجهز مسبقًا أول ما المشغّل يفتح القائمة
const MAX_QUEUE = 6;            // أقصى طابور انتظار للتجهيز المسبق (فوقه نتجاهل القديم عشان ما نتأخر)
const CACHE_MAX = 40;           // عدد المقاطع المفكوكة بالذاكرة
const CACHE_BYTES = 300 * 1024 * 1024;
const POLL_IDLE_MS = 25000;     // نوقف المتابعة التلقائية للجودة إذا ما أحد يطلبها
const FETCH_TIMEOUT_MS = 20000;
const ENC_TIMEOUT_MS = 90000;
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36';
const HEVC_RE = /^(hvc1|hev1|dvh1|dvhe)\./i;

// أي ارتفاع يُقبل (مو بس 720/1080/1440/4K): نختار أقرب شريحة بالمعدل
const TIERS = [   // [أقصى ارتفاع, Mbps, مستوى avc]
  [360, 1.2, '64001e'], [480, 2, '64001e'], [576, 2.5, '64001f'], [720, 3.5, '64001f'],
  [1080, 6.5, '64002a'], [1440, 11, '640032'], [2160, 18, '640033'], [4320, 45, '640034'],
];
function ladderFor(h, srcBw) {
  const t = TIERS.find(x => h <= x[0]) || TIERS[TIERS.length - 1];
  const heavy = h > 1080;
  // ultrafast أسرع بكثير لكنه يحتاج معدل أعلى شوي لنفس الجودة
  let mbps = heavy ? t[1] * 1.25 : t[1];
  // لا نضخّم المعدل فوق المصدر: ملفات أكبر = تقطّع بالنفق والشبكة. H.264 يكفيه ~1.15x من HEVC بهذا النوع من البث
  if (srcBw > 0) mbps = Math.min(mbps, Math.max(mbps * 0.5, (srcBw / 1e6) * 1.15));
  const f = n => (Math.round(n * 10) / 10) + 'M';
  return { b: f(mbps), max: f(mbps * 1.2), buf: f(mbps * 2), bw: Math.round(mbps * 1.05e6), avc: t[2], heavy };
}

// ---------- ترميز بالعتاد إن وُجد (NVENC / VAAPI) وإلا x264 ----------
let HW = null;
function detectHW() {
  if (process.env.DECODE_HW === 'off') return;
  const test = (args) => new Promise(res => {
    try {
      const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { stdio: 'ignore' });
      const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} res(false); }, 8000);
      p.on('error', () => { clearTimeout(t); res(false); });
      p.on('close', c => { clearTimeout(t); res(c === 0); });
    } catch (_) { res(false); }
  });
  (async () => {
    if (await test(['-f', 'lavfi', '-i', 'nullsrc=s=256x256:d=0.2', '-c:v', 'h264_nvenc', '-f', 'null', '-'])) { HW = { name: 'nvenc' }; }
    else if (await test(['-vaapi_device', '/dev/dri/renderD128', '-f', 'lavfi', '-i', 'nullsrc=s=256x256:d=0.2', '-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi', '-f', 'null', '-'])) { HW = { name: 'vaapi' }; }
    console.log('[decode] cores=' + CORES + ' concurrency=' + CONCURRENCY + ' threads=' + THREADS + ' hw=' + (HW ? HW.name : 'none (x264)'));
  })();
}

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
  job.passthrough = [];
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
      const codecs = unq(getAttr(attrs, 'CODECS'));
      const isHevc = !codecs || codecs.split(',').some(c => HEVC_RE.test(c.trim()));   // بدون CODECS نفترض يحتاج فك
      if (isHevc) {
        const L = ladderFor(h, Number(getAttr(attrs, 'BANDWIDTH')) || 0);
        job.ladder.set(h, L);
        if (codecs) setAttr(attrs, 'CODECS', '"' + codecs.split(',').map(c => HEVC_RE.test(c.trim()) ? 'avc1.' + L.avc : c.trim()).join(',') + '"');
        setAttr(attrs, 'BANDWIDTH', String(L.bw));
        const avg = attrs.findIndex(p => p[0] === 'AVERAGE-BANDWIDTH'); if (avg >= 0) attrs.splice(avg, 1);
        job.videoPlaylists.add(new URL(uri, masterUrl).href);
      } else job.passthrough.push(h);   // أصلًا H.264: يمر كما هو بدون فك
      out.push('#EXT-X-STREAM-INF:' + attrsToStr(attrs));
      out.push(mapUri(job, uri, masterUrl));
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
  const blockStart = [];
  let dur = 0, nextStart = 0;
  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) { dur = parseFloat(line.slice(8)) || 0; out.push(line); continue; }
    if (line.startsWith('#')) {
      if (/URI="/.test(line)) out.push(line.replace(/URI="([^"]*)"/g, (_, u) => 'URI="' + mapUri(job, u, playlistUrl) + '"'));
      else out.push(line);
      continue;
    }
    if (line.trim() === '') { out.push(line); continue; }
    blockStart.push(nextStart);
    out.push(mapUri(job, line.trim(), playlistUrl));
    nextStart = out.length;
    if (isVideo) segs.push({ url: new URL(line.trim(), playlistUrl).href, dur });
    dur = 0;
  }
  return { out, blockStart, segs, isVideo, body: out.join('\n') };
}

// ---------- فك المقاطع ----------
let running = 0;
const waiters = [];
function slot(urgent) {
  return new Promise(res => { const go = () => { running++; res(); }; running < CONCURRENCY ? go() : (urgent ? waiters.unshift(go) : waiters.push(go)); });
}
function release() { running--; const n = waiters.shift(); if (n) n(); }

function encArgs(L, fast) {
  if (HW && HW.name === 'nvenc') return ['-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'll', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-g', '250', '-forced-idr', '1', '-b:v', L.b, '-maxrate', L.max, '-bufsize', L.buf];
  if (HW && HW.name === 'vaapi') return ['-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi', '-profile:v', 'high', '-b:v', L.b, '-maxrate', L.max];
  // أعلى من 1080: ultrafast (أسرع بـ2-3 أضعاف) — وإلا veryfast
  const preset = process.env.DECODE_PRESET || ((L.heavy || fast) ? 'ultrafast' : 'veryfast');
  return ['-c:v', 'libx264', '-preset', preset, '-tune', 'zerolatency', '-threads', String(THREADS),
    '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-sc_threshold', '0',
    '-b:v', L.b, '-maxrate', L.max, '-bufsize', L.buf];
}

function transcode(buf, height, L, fast) {
  L = L || ladderFor(height, 0);
  return new Promise((resolve, reject) => {
    const pre = HW && HW.name === 'vaapi' ? ['-vaapi_device', '/dev/dri/renderD128'] : [];
    const args = ['-hide_banner', '-loglevel', 'error', '-copyts', ...pre, '-threads', String(THREADS), '-i', 'pipe:0',
      '-map', '0:v:0', ...encArgs(L, fast),
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

let activeRuns = new Set();
function ensureSeg(job, seg, prefetch) {
  let e = job.cache.get(seg.url);
  if (e) return e.promise;
  if (prefetch && waiters.length >= MAX_QUEUE) return Promise.resolve(null);   // مزدحم: لا نكدّس مقاطع قديمة
  e = {};
  e.promise = (async () => {
    await slot(!prefetch);
    const run = { par: running };
    activeRuns.add(run);
    for (const r of activeRuns) r.par = Math.max(r.par, running);
    try {
      const t0 = Date.now();
      const up = await fetchUp(job, seg.url);
      if (up.status !== 200) throw new Error('المصدر رجّع ' + up.status);
      const height = job.segHeight.get(seg.url);
      const avg = job.speeds.length ? job.speeds.reduce((x, y) => x + y, 0) / job.speeds.length : null;
      const fast = avg !== null && avg < 1.5;   // الجهاز بطيء: نرمّز المقاطع الجاية أسرع بدون ما نغيّر القائمة
      const out = await transcode(up.buf, height, job.ladder.get(height), fast);
      const sec = (Date.now() - t0) / 1000;
      // السعة الفعلية ≈ سرعة المقطع × عدد المقاطع اللي تشتغل معه بنفس الوقت
      if (seg.dur > 0) { job.speeds.push((seg.dur / sec) * run.par); if (job.speeds.length > 6) job.speeds.shift(); }
      job.segments++;
      e.size = out.length; e.done = true;
      return out;
    } finally { activeRuns.delete(run); release(); }
  })();
  e.promise.catch(err => { job.errors++; job.lastError = err.message; job.cache.delete(seg.url); });
  job.cache.set(seg.url, e);
  let bytes = 0; for (const v of job.cache.values()) bytes += v.size || 0;
  for (const [k, v] of job.cache) {
    if (job.cache.size <= CACHE_MAX && bytes <= CACHE_BYTES) break;
    if (k === seg.url) continue;
    bytes -= v.size || 0; job.cache.delete(k);
  }
  return e.promise;
}

// يسجّل مقاطع قائمة فيديو ويجهّز الأحدث مسبقًا
function registerVideo(job, target, segs, firstTime) {
  const h = job.playlistHeight.get(target);
  for (const s of segs) { if (!job.segHeight.has(s.url)) { job.segHeight.set(s.url, h); job.segIndex.set(s.url, s); } }
  while (job.segIndex.size > 200) { const k = job.segIndex.keys().next().value; job.segIndex.delete(k); job.segHeight.delete(k); }
  const st = job.polls.get(target) || {};
  // الأحدث فقط (نافذة صغيرة)، من الأقدم للأحدث، ونعيد المحاولة لأي مقطع ما اتجهز
  const win = segs.slice(-(PREFETCH + 3));
  win.forEach(s => ensureSeg(job, s, true).catch(() => {}));
  job.polls.set(target, st);
}

// متابعة تلقائية للقائمة: أول ما ينزل مقطع جديد نبدأ نفكه قبل ما المشغّل يطلبه (يرفع السرعة الفعلية)
function ensurePoller(job, target) {
  const st = job.polls.get(target);
  if (!st || st.timer) return;
  st.last = Date.now();
  const tick = async () => {
    if (job.stopped || Date.now() - st.last > POLL_IDLE_MS) { clearTimeout(st.timer); st.timer = null; return; }
    try {
      const up = await fetchUp(job, target);
      if (up.status === 200 && isPlaylist(up.buf)) {
        const m = processMedia(job, up.buf.toString('utf8'), target);
        if (m.isVideo) registerVideo(job, target, m.segs, false);
        if (/#EXT-X-ENDLIST/.test(up.buf.toString('utf8'))) { st.timer = null; return; }
      }
    } catch (_) {}
    st.timer = setTimeout(tick, st.every || 2000);
  };
  st.timer = setTimeout(tick, st.every || 2000);
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
      const out = await ensureSeg(job, known, false);
      if (!out) throw new Error('تعذر فك المقطع');
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
      const td = Number((text.match(/#EXT-X-TARGETDURATION:(\d+)/) || [])[1]) || 4;
      const first = !job.polls.has(target);
      registerVideo(job, target, m.segs, first);
      const st = job.polls.get(target);
      st.every = Math.max(1000, Math.min(3000, td * 400)); st.last = Date.now();
      ensurePoller(job, target);
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
  const wanted = [...new Set((qualities && qualities.length ? qualities : [720, 1080]).map(Number))].filter(q => q >= 120 && q <= 4320).sort((a, b) => a - b);
  if (!wanted.length) throw new Error('اختر جودة وحدة على الأقل');

  const u = new URL(url);
  const id = randomUUID().replace(/-/g, '').slice(0, 12);
  const job = {
    id, ref: ref || '', wanted, mountPath: `/d/${id}`,
    origin: u.origin, baseDir: new URL('./', u.origin + u.pathname).href,
    masterName: u.pathname.split('/').pop() || 'master.m3u8', masterQuery: u.search,
    source: u.host, videoPlaylists: new Set(), playlistHeight: new Map(), picked: [], skipped: [], audioLangs: [],
    segHeight: new Map(), segIndex: new Map(), polls: new Map(), ladder: new Map(), passthrough: [], cache: new Map(), absMap: new Map(), absRev: new Map(),
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

// يقرأ الـmaster ويرجّع الجودات الموجودة فعليًا (عشان الواجهة تعرضها بدل قائمة ثابتة)
async function probe({ url, ref }) {
  if (!/^https?:\/\/\S+$/i.test(url || '')) throw new Error('الرابط لازم يبدأ بـ https://');
  const up = await fetchUp({ ref: ref || '' }, url);
  if (up.status !== 200) throw new Error('المصدر رجّع ' + up.status);
  if (!isPlaylist(up.buf)) throw new Error('الرابط مو قائمة HLS');
  const text = up.buf.toString('utf8');
  if (!text.includes('#EXT-X-STREAM-INF')) throw new Error('الرابط قائمة جودة وحدة مو master — حط رابط الـ master');
  const lines = text.split(/\r?\n/);
  const variants = []; const audio = [];
  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttrs(line.slice(18));
      const r = (getAttr(a, 'RESOLUTION') || '').match(/(\d+)x(\d+)/);
      const codecs = unq(getAttr(a, 'CODECS'));
      const hevc = !codecs || codecs.split(',').some(c => HEVC_RE.test(c.trim()));
      variants.push({ height: r ? Number(r[2]) : 0, width: r ? Number(r[1]) : 0, bandwidth: Number(getAttr(a, 'BANDWIDTH')) || 0, codecs, codec: !codecs ? 'unknown' : (hevc ? 'hevc' : 'h264') });
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttrs(line.slice(13));
      if (getAttr(a, 'TYPE') === 'AUDIO') audio.push(unq(getAttr(a, 'LANGUAGE')) || unq(getAttr(a, 'NAME')) || '?');
    }
  }
  const byH = new Map();
  for (const v of variants) if (v.height && (!byH.has(v.height) || v.bandwidth > byH.get(v.height).bandwidth)) byH.set(v.height, v);
  return { variants: [...byH.values()].sort((a, b) => a.height - b.height), audio, cores: CORES, hw: HW ? HW.name : null };
}

function stopJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  job.stopped = true;
  clearTimeout(job.killTimer);
  for (const st of job.polls.values()) clearTimeout(st.timer);
  job.polls.clear();
  job.cache.clear(); job.segIndex.clear(); job.segHeight.clear();
  return true;
}

function publicView(j) {
  const sp = j.speeds.length ? j.speeds.reduce((a, b) => a + b, 0) / j.speeds.length : null;
  return {
    id: j.id, state: j.stopped ? 'stopped' : 'running', speed: sp, errors: j.errors, lastError: j.lastError,
    segments: j.segments, source: j.source, qualities: j.picked, skipped: j.skipped, audio: j.audioLangs,
    passthrough: j.passthrough || [], hw: HW ? HW.name : null, cores: CORES, ready: j.ready, path: `${j.mountPath}/${j.masterName}${j.masterQuery}`, startedAt: j.startedAt,
  };
}

function mount(app, requireApiKey) {
  detectHW();
  app.post('/api/decode/probe', requireApiKey, async (req, res) => {
    try { const b = req.body || {}; res.json(await probe({ url: String(b.url || '').trim(), ref: String(b.ref || '').trim() })); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
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
