// تحويل بث SDR (عادي) إلى HDR بـffmpeg: HDR10 (PQ) أو HLG، ترميز HEVC 10-bit.
//
// كيف يشتغل:
//   1) الصورة تتحول من BT.709 (غاما SDR) إلى ضوء خطي، ثم إلى نطاق ألوان BT.2020.
//   2) تتشفّر بمنحنى PQ أو HLG مع مستوى مرجعي: أبيض SDR = 203 nits (معيار BT.2408)،
//      يعني الصورة تبقى بنفس شكلها المعتاد لكن داخل حاوية HDR، فتتعرف عليها الشاشة كـHDR.
//   3) الترميز HEVC Main10 (NVENC لو فيه كرت NVIDIA، وإلا x265)، والإخراج HLS بمقاطع fMP4
//      (لأن HEVC بمقاطع TS ما تقبله أجهزة Apple).
//
// تنبيه صريح: هذا تحويل SDR→HDR، مو HDR حقيقي من المصدر. ما يضيف تفاصيل جديدة بالإضاءات الساطعة
// أو الظلال، لأن المعلومة مو موجودة بالمصدر. لو المصدر أصلًا HDR نتركه يمر بدون تحويل.
//
// متغيرات بيئة اختيارية:
//   HDR_PRESET=ultrafast   preset الـx265 (ultrafast|superfast|veryfast...) — الأسرع افتراضيًا
//   HDR_HW=off             تعطيل NVENC حتى لو موجود
//   HDR_MBPS=8             معدل الفيديو بالميغابت لـ1080 (يتناسب تلقائيًا مع الدقة الأقل)

const { spawn, spawnSync } = require('child_process');
const os = require('os');
const path = require('path');

const CORES = Math.max(1, (os.cpus() || []).length || 1);
const HDR_TRANSFERS = /^(smpte2084|arib-std-b67)$/i;
const isHdrTransfer = (t) => HDR_TRANSFERS.test(String(t || ''));

// ---------- قدرات ffmpeg على هذا الجهاز (تُفحص مرة وحدة) ----------
let caps = null;
function ffmpegList(arg, re) {
  try {
    const r = spawnSync('ffmpeg', ['-hide_banner', arg], { encoding: 'utf8', timeout: 15000 });
    return r.status === 0 && re.test(r.stdout || '');
  } catch (_) { return false; }
}
function support() {
  if (caps) return caps;
  const zscale = ffmpegList('-filters', /\bzscale\b/);
  const x265 = ffmpegList('-encoders', /\blibx265\b/);
  let nvenc = false;
  if (process.env.HDR_HW !== 'off' && ffmpegList('-encoders', /\bhevc_nvenc\b/)) {
    try {
      const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'nullsrc=s=256x256:d=0.2',
        '-vf', 'format=p010le', '-c:v', 'hevc_nvenc', '-profile:v', 'main10', '-f', 'null', '-'], { timeout: 12000 });
      nvenc = r.status === 0;
    } catch (_) { nvenc = false; }
  }
  const encoder = nvenc ? 'nvenc' : (x265 ? 'x265' : null);
  caps = { zscale, x265, nvenc, encoder, cores: CORES, ok: !!(zscale && encoder) };
  console.log('[hdr] zscale=' + zscale + ' x265=' + x265 + ' nvenc=' + nvenc + ' cores=' + CORES);
  return caps;
}

// ---------- فحص المصدر (دقة، مدى الألوان، المعدل...) ----------
function probeInput(url, preArgs = [], timeoutMs = 15000) {
  return new Promise((resolve) => {
    try {
      const args = ['-v', 'error', ...preArgs, '-select_streams', 'v:0', '-show_entries',
        'stream=codec_name,width,height,pix_fmt,color_range,color_space,color_transfer,color_primaries,r_frame_rate,avg_frame_rate,sample_aspect_ratio,field_order',
        '-of', 'json', url];
      const p = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks = [];
      const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} resolve(null); }, timeoutMs);
      p.stdout.on('data', (d) => chunks.push(d));
      p.on('error', () => { clearTimeout(t); resolve(null); });
      p.on('close', () => {
        clearTimeout(t);
        try {
          const st = JSON.parse(Buffer.concat(chunks).toString('utf8')).streams[0];
          resolve(st ? {
            codec: st.codec_name, width: st.width || 0, height: st.height || 0, pix: st.pix_fmt,
            range: st.color_range, matrix: st.color_space, transfer: st.color_transfer, primaries: st.color_primaries,
            fps: parseFps(st.avg_frame_rate) || parseFps(st.r_frame_rate), sar: st.sample_aspect_ratio, field: st.field_order,
          } : null);
        } catch (_) { resolve(null); }
      });
    } catch (_) { resolve(null); }
  });
}
function parseFps(s) {
  const m = String(s || '').match(/^(\d+)\/(\d+)$/);
  if (m && Number(m[2]) > 0) { const f = Number(m[1]) / Number(m[2]); return f >= 5 && f <= 120 ? f : 0; }
  const n = Number(s);
  return n >= 5 && n <= 120 ? n : 0;
}

// ---------- الخطة: فلتر التحويل + معاملات الترميز ----------
// opts: { mode:'hlg'|'pq', probe, maxHeight:720|1080, gopSeconds, fps }
function plan(opts) {
  const c = support();
  if (!c.zscale) throw new Error('ffmpeg عندك ما فيه فلتر zscale (libzimg) — لازم نسخة ffmpeg كاملة عشان تحويل HDR');
  if (!c.encoder) throw new Error('ffmpeg عندك ما فيه libx265 ولا hevc_nvenc — لازم أحدهم عشان تحويل HDR');
  const mode = opts.mode === 'pq' ? 'pq' : 'hlg';
  const probe = opts.probe || null;
  if (probe && isHdrTransfer(probe.transfer)) {
    return { skip: true, reason: `المصدر أصلًا HDR (${probe.transfer}) — يمر بدون تحويل` };
  }
  // noScale: يحافظ على دقة المصدر كما هي (يُستخدم بتبويب الفك لأن القائمة تحدد الدقة)
  const cap = opts.noScale ? 0 : (Number(opts.maxHeight) === 720 ? 720 : 1080);
  const srcH = (probe && probe.height) || 0;
  const outH = srcH ? (cap ? Math.min(srcH, cap) : srcH) : (cap || 1080);
  const fps = (probe && probe.fps) || opts.fps || 30;
  const gop = opts.gop || Math.max(10, Math.round(fps * (opts.gopSeconds || 2)));

  // مدخل الألوان: دقة SD تستخدم مصفوفة BT.601، الباقي BT.709. نحترم وسوم المصدر لو معروفة.
  const sd = srcH > 0 && srcH <= 576;
  const known = (v, list, def) => (list.includes(String(v || '').toLowerCase()) ? String(v).toLowerCase() : def);
  const matrix = known(probe && probe.matrix, ['bt709', 'smpte170m', 'bt470bg'], sd ? 'smpte170m' : 'bt709');
  const prim = known(probe && probe.primaries, ['bt709', 'smpte170m', 'bt470bg'], sd ? 'smpte170m' : 'bt709');
  const trc = known(probe && probe.transfer, ['bt709', 'smpte170m'], sd ? 'smpte170m' : 'bt709');
  const rng = probe && probe.range === 'pc' ? 'pc' : 'tv';

  const pre = [];
  const field = probe && probe.field;
  if (field && !/^(progressive|unknown)$/i.test(field)) pre.push('yadif=0:-1:0');             // مصدر interlaced
  const sar = probe && probe.sar;
  if (sar && !/^(0:1|1:1|N\/A)$/i.test(sar)) pre.push('scale=iw*sar:ih', 'setsar=1');          // بكسل غير مربع
  if (cap) pre.push(`scale=-2:min(${cap}\\,ih)`);                                               // لا يتجاوز الحد المختار

  const tcode = mode === 'pq' ? 'smpte2084' : 'arib-std-b67';
  const hw = c.encoder === 'nvenc';
  const filter = [
    ...pre,
    `zscale=tin=${trc}:min=${matrix}:pin=${prim}:rin=${rng}:t=linear:npl=100:p=${prim}`,
    'format=gbrpf32le',
    'zscale=p=bt2020:t=linear',
    `zscale=t=${tcode}:m=bt2020nc:r=tv:p=bt2020:npl=203`,
    `format=${hw ? 'p010le' : 'yuv420p10le'}`,
  ].join(',');

  // معدل الفيديو: يتناسب مع الدقة (HEVC 10-bit)
  const base = Number(process.env.HDR_MBPS) > 0 ? Number(process.env.HDR_MBPS) : 8;
  const ratio = (outH * outH) / (1080 * 1080);
  let mbps = base * (ratio <= 1 ? ratio : Math.sqrt(ratio)) * (outH >= 1080 ? 1 : 1.35);        // الدقة الأقل تحتاج بت أكثر لكل بكسل
  mbps = Math.max(1.5, Math.round(mbps * 10) / 10);
  const f = (n) => (Math.round(n * 10) / 10) + 'M';
  const b = f(mbps), mx = f(mbps * 1.25), bf = f(mbps * 2);

  const color = ['-color_primaries', 'bt2020', '-color_trc', tcode, '-colorspace', 'bt2020nc', '-color_range', 'tv'];
  let codec;
  if (hw) {
    codec = ['-c:v', 'hevc_nvenc', '-preset', 'p4', '-tune', 'll', '-profile:v', 'main10', '-pix_fmt', 'p010le',
      '-b:v', b, '-maxrate', mx, '-bufsize', bf, '-g', String(gop), '-forced-idr', '1', ...color, '-tag:v', 'hvc1'];
  } else {
    let xp = `keyint=${gop}:min-keyint=${gop}:scenecut=0:repeat-headers=1:log-level=error`;
    if (mode === 'pq') {
      // بيانات HDR10 الثابتة: شاشة ماستر BT.2020 بسطوع 1000 nits، وأعلى سطوع بالمحتوى ≈ 203 nits
      xp += ':hdr10=1:master-display=G(8500,39850)B(6550,2300)R(35400,14600)WP(15635,16450)L(10000000,1):max-cll=203,100';
    }
    codec = ['-c:v', 'libx265', '-preset', process.env.HDR_PRESET || 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p10le',
      '-profile:v', 'main10', '-b:v', b, '-maxrate', mx, '-bufsize', bf, ...color, '-tag:v', 'hvc1', '-x265-params', xp];
  }
  // نسخة لمقاطع MPEG-TS (بدون وسم hvc1 الخاص بـMP4)
  const codecTs = codec.filter((x, i) => !(x === '-tag:v' || codec[i - 1] === '-tag:v'));
  return {
    skip: false, mode, encoder: c.encoder, filter, codec, codecTs, outHeight: outH, mbps, gop, bw: Math.round(mbps * 1.05e6),
    audio: ['-c:a', 'aac', '-b:a', '160k'],
    inTags: { matrix, prim, trc, range: rng },
  };
}

// مخرج HLS بمقاطع fMP4 (HEVC بمقاطع TS ما تقبله أجهزة Apple)
function hlsOutput(hlsDir, seconds, listSize, deleteThreshold) {
  return [
    '-f', 'hls', '-hls_time', String(seconds), '-hls_list_size', String(listSize),
    ...(deleteThreshold ? ['-hls_delete_threshold', String(deleteThreshold)] : []),
    '-hls_flags', 'delete_segments+append_list+omit_endlist+independent_segments',
    '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', path.join(hlsDir, 'seg_%05d.m4s'),
    path.join(hlsDir, 'stream.m3u8'),
  ];
}

// وسم CODECS لقوائم HLS (HEVC Main10 بمستوى حسب الدقة) — يستخدمه تبويب الفك لما يعيد كتابة القوائم
function hevcCodecString(height) {
  const lvl = height <= 720 ? 120 : height <= 1080 ? 123 : height <= 2160 ? 150 : 180;
  return `hvc1.2.4.L${lvl}.B0`;
}

module.exports = { support, probeInput, plan, hlsOutput, isHdrTransfer, hevcCodecString };
