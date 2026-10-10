// فك HEVC → H.264 للبث الحي، يشتغل داخل server.js على الأكشن (GitHub) عبر النفق.
//   POST /api/decode/start  { url, qualities:[720,1080,1440,2160], ref? }  → يبدأ التحويل
//   GET  /api/decode/jobs                                                  → الحالة والسرعة
//   POST /api/decode/stop   { id }                                         → يوقف
//   GET  /dec/<id>/master.m3u8                                             → الرابط الجاهز (HLS بكل الجودات والصوتيات)
// الجودات والصوتيات تنقرأ من المصدر نفسه بـffprobe (بدون أرقام ثابتة)، والصوت يُنسخ كما هو بدون تحويل.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

const DEC_DIR = path.join(os.tmpdir(), 'zbm-dec');
const MAX_HOURS = Number(process.env.MAX_RECORDING_HOURS) || 5;
const MAX_JOBS = 2;
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36';

// معدلات الترميز لكل دقة (H.264 يحتاج بت ريت أعلى من HEVC لنفس الجودة)
const LADDER = {
  720:  { b: '3M',  max: '4M',  buf: '8M'  },
  1080: { b: '6M',  max: '7M',  buf: '12M' },
  1440: { b: '10M', max: '12M', buf: '20M' },
  2160: { b: '16M', max: '19M', buf: '32M' },
};

// خيار امتدادات المقاطع (.js/.css للتمويه) موجود فقط بنسخ ffmpeg الحديثة — نفعّله لو مدعوم
let hlsExtOpts = null;
function supportsHlsExt() {
  if (hlsExtOpts === null) {
    try {
      const out = require('child_process').execFileSync('ffmpeg', ['-hide_banner', '-h', 'demuxer=hls'], { encoding: 'utf8' });
      hlsExtOpts = out.includes('allowed_segment_extensions');
    } catch (_) { hlsExtOpts = false; }
  }
  return hlsExtOpts;
}
// نمنع ffmpeg من فتح file:// أو أي بروتوكول غير http من داخل قائمة المصدر
function inFlags() {
  const a = ['-protocol_whitelist', 'http,https,tcp,tls,crypto'];
  if (supportsHlsExt()) a.push('-allowed_segment_extensions', 'ALL', '-extension_picky', '0');
  return a;
}

const jobs = new Map();

function inputHeaderArgs(ref) {
  const a = ['-user_agent', UA];
  if (ref) a.push('-headers', `Referer: ${ref}\r\n`);
  return a;
}

function probe(url, ref) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', ...inFlags(), ...inputHeaderArgs(ref),
      '-print_format', 'json',
      '-show_entries', 'stream=index,codec_type,codec_name,width,height:stream_tags=language',
      url];
    const p = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} reject(new Error('انتهت مهلة فحص الرابط (25 ثانية)')); }, 25000);
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('error', e => { clearTimeout(t); reject(e); });
    p.on('close', () => {
      clearTimeout(t);
      try {
        const j = JSON.parse(out);
        if (!j.streams || !j.streams.length) throw new Error('empty');
        resolve(j.streams);
      } catch (_) {
        reject(new Error('تعذر قراءة الرابط: ' + (err.trim().split('\n').pop() || 'لا يوجد ستريمات')));
      }
    });
  });
}

function buildArgs(job) {
  const args = ['-hide_banner', '-loglevel', 'info', '-stats',
    ...inFlags(), ...inputHeaderArgs(job.ref),
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', job.url];

  job.picked.forEach(p => args.push('-map', `0:${p.idx}`));
  job.audios.forEach(a => args.push('-map', `0:${a.index}`));

  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-force_key_frames', 'expr:gte(t,n_forced*2)', '-sc_threshold', '0', '-c:a', 'copy');
  job.picked.forEach((p, i) => {
    const L = LADDER[p.q];
    args.push(`-b:v:${i}`, L.b, `-maxrate:v:${i}`, L.max, `-bufsize:v:${i}`, L.buf);
  });

  const map = [];
  job.picked.forEach((p, i) => map.push(`v:${i},agroup:aud,name:${p.q}p`));
  job.audios.forEach((a, i) => {
    const lang = a.tags && a.tags.language && /^[a-z]{2,3}$/i.test(a.tags.language) ? `language:${a.tags.language},` : '';
    map.push(`a:${i},agroup:aud,${lang}name:a${i}${i === 0 ? ',default:yes' : ''}`);
  });

  args.push('-f', 'hls', '-hls_time', '4', '-hls_list_size', '12',
    '-hls_flags', 'delete_segments+independent_segments+append_list+omit_endlist',
    '-hls_segment_filename', path.join(job.dir, '%v_%05d.ts'),
    '-master_pl_name', 'master.m3u8',
    '-var_stream_map', map.join(' '),
    path.join(job.dir, '%v.m3u8'));
  return args;
}

function runFfmpeg(job) {
  if (job.stopped) return;
  const proc = spawn('ffmpeg', buildArgs(job), { stdio: ['ignore', 'ignore', 'pipe'] });
  job.proc = proc;
  job.state = 'running';
  proc.stderr.on('data', d => {
    for (const line of String(d).split(/[\r\n]+/)) {
      if (!line.trim()) continue;
      const m = line.match(/speed=\s*([\d.]+)x/);
      if (m) job.speed = Number(m[1]);
      else { job.tail.push(line.slice(0, 220)); if (job.tail.length > 12) job.tail.shift(); }
    }
  });
  proc.on('error', e => { job.tail.push('spawn error: ' + e.message); });
  proc.on('close', code => {
    job.proc = null;
    if (job.stopped) { job.state = 'stopped'; return; }
    job.restarts++;
    job.state = 'restarting';
    job.speed = null;
    job.tail.push(`ffmpeg توقف (كود ${code}) — إعادة تشغيل بعد 3 ثواني`);
    job.timer = setTimeout(() => runFfmpeg(job), 3000);
  });
}

async function startJob({ url, qualities, ref }) {
  if (!/^https?:\/\/\S+$/i.test(url || '')) throw new Error('الرابط لازم يبدأ بـ https://');
  if (ref && !/^https?:\/\/\S+$/i.test(ref)) throw new Error('الـ Referer لازم رابط كامل');
  const active = [...jobs.values()].filter(j => j.state !== 'stopped').length;
  if (active >= MAX_JOBS) throw new Error(`فيه ${active} عمليات شغّالة، أوقف وحدة أول`);

  const wanted = [...new Set((qualities && qualities.length ? qualities : [720, 1080]).map(Number))]
    .filter(q => LADDER[q]).sort((a, b) => a - b);
  if (!wanted.length) throw new Error('اختر جودة وحدة على الأقل');

  const streams = await probe(url, ref || '');
  const vids = streams.filter(s => s.codec_type === 'video');
  const audios = streams.filter(s => s.codec_type === 'audio');
  const picked = [], skipped = [];
  for (const q of wanted) {
    const v = vids.find(s => s.height === q);
    if (v) picked.push({ q, idx: v.index }); else skipped.push(q);
  }
  if (!picked.length) {
    const have = [...new Set(vids.map(v => v.height))].sort((a, b) => a - b).join(', ');
    throw new Error(`المصدر ما فيه الجودات المطلوبة. المتوفر: ${have || 'لا شي'}`);
  }

  const id = randomUUID().replace(/-/g, '').slice(0, 12);
  const dir = path.join(DEC_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const job = {
    id, url, ref: ref || '', dir, picked, skipped, audios,
    audioInfo: audios.map(a => (a.tags && a.tags.language) || '?'),
    codecIn: [...new Set(vids.map(v => v.codec_name))].join(','),
    state: 'starting', speed: null, restarts: 0, tail: [],
    startedAt: Date.now(), stopped: false, proc: null, timer: null,
  };
  jobs.set(id, job);
  job.killTimer = setTimeout(() => stopJob(id), MAX_HOURS * 3600 * 1000);
  runFfmpeg(job);
  return job;
}

function stopJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  job.stopped = true;
  clearTimeout(job.timer); clearTimeout(job.killTimer);
  if (job.proc) { try { job.proc.kill('SIGTERM'); } catch (_) {} }
  job.state = 'stopped';
  setTimeout(() => { try { fs.rmSync(job.dir, { recursive: true, force: true }); } catch (_) {} }, 5000);
  return true;
}

function publicView(j) {
  let host = '';
  try { host = new URL(j.url).host; } catch (_) {}
  return {
    id: j.id, state: j.state, speed: j.speed, restarts: j.restarts,
    source: host, qualities: j.picked.map(p => p.q), skipped: j.skipped,
    audio: j.audioInfo, codecIn: j.codecIn,
    ready: fs.existsSync(path.join(j.dir, 'master.m3u8')),
    path: `/dec/${j.id}/master.m3u8`,
    startedAt: j.startedAt, tail: j.tail.slice(-4),
  };
}

function mount(app, requireApiKey) {
  const express = require('express');
  fs.mkdirSync(DEC_DIR, { recursive: true });

  app.use('/dec', express.static(DEC_DIR, {
    setHeaders: res => res.setHeader('Cache-Control', 'no-cache'),
  }));

  app.post('/api/decode/start', requireApiKey, async (req, res) => {
    try {
      const b = req.body || {};
      const job = await startJob({ url: String(b.url || '').trim(), qualities: Array.isArray(b.qualities) ? b.qualities : [], ref: String(b.ref || '').trim() });
      res.json(publicView(job));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get('/api/decode/jobs', requireApiKey, (req, res) => {
    res.json({ jobs: [...jobs.values()].filter(j => j.state !== 'stopped').map(publicView) });
  });

  app.post('/api/decode/stop', requireApiKey, (req, res) => {
    const id = String((req.body && req.body.id) || '');
    if (!stopJob(id)) return res.status(404).json({ error: 'العملية غير موجودة' });
    res.json({ ok: true });
  });
}

process.on('exit', () => { for (const j of jobs.values()) { try { if (j.proc) j.proc.kill('SIGKILL'); } catch (_) {} } });

module.exports = { mount, _internal: { probe, startJob, stopJob, publicView, jobs, DEC_DIR } };
