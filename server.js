require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
} = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// ==================== إعدادات عامة ====================
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const TEMP_DIR = path.resolve(process.env.TEMP_DIR || './temp');
const MAX_RECORDING_MS =
  (parseFloat(process.env.MAX_RECORDING_HOURS) || 5) * 60 * 60 * 1000;
// حد أقصى مطلق لا يُتجاوز حتى لو حدد المستخدم وقت إيقاف بعيد جدًا (حماية أخيرة)
const ABSOLUTE_MAX_RECORDING_MS = 24 * 60 * 60 * 1000;
// كم تسجيل ممكن يشتغل بنفس اللحظة (بين الناديين مجتمعين)
const MAX_CONCURRENT_RECORDINGS =
  parseInt(process.env.MAX_CONCURRENT_RECORDINGS, 10) || 2;
// مساحة B2 المجانية التقريبية (بالجيجا) لعرض شريط الاستهلاك
const B2_QUOTA_BYTES = (parseFloat(process.env.B2_QUOTA_GB) || 10) * 1024 ** 3;
// رابط RTMP كامل (يتضمن مفتاح البث) لـ OK.RU — لو معبّى، كل "بدء بث" يدفع تلقائيًا لهذا الرابط بالتوازي مع الـ HLS المحلي
const OKRU_RTMP_URL = (process.env.OKRU_RTMP_URL || '').trim() || null;
// قبل كم دقيقة من موعد التسجيل المجدول يُرسل تذكير تيليجرام
const REMINDER_BEFORE_MS =
  (parseFloat(process.env.TELEGRAM_REMINDER_MINUTES_BEFORE) || 10) * 60 * 1000;

const CLUBS = {
  club1: process.env.CLUB1_NAME || 'Club1',
  club2: process.env.CLUB2_NAME || 'Club2',
};

if (!API_KEY || API_KEY === 'change-this-secret-key') {
  console.warn(
    '⚠️  تحذير: غيّر API_KEY في ملف .env قبل ما تنشر السيرفر على الإنترنت.'
  );
}

if (!OKRU_RTMP_URL) {
  console.warn(
    'ℹ️  OKRU_RTMP_URL مو معبّى بـ .env — البث المباشر بيشتغل محليًا بس (بدون دفع لـ OK.RU).'
  );
}

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const LIVE_DIR = path.join(TEMP_DIR, 'live');
if (!fs.existsSync(LIVE_DIR)) fs.mkdirSync(LIVE_DIR, { recursive: true });

const logoUpload = multer({ dest: TEMP_DIR, limits: { fileSize: 5 * 1024 * 1024 } });
const PREVIEW_TIMEOUT_MS = 20000;

// ==================== إعداد Backblaze B2 (متوافق مع S3) ====================
const b2 = new S3Client({
  region: process.env.B2_REGION || 'us-east-005',
  endpoint: `https://${process.env.B2_ENDPOINT}`,
  credentials: {
    accessKeyId: process.env.B2_KEY_ID,
    secretAccessKey: process.env.B2_APPLICATION_KEY,
  },
});
const BUCKET = process.env.B2_BUCKET_NAME;
// الـ bucket خاص (Private) بدون بطاقة ائتمان، فالروابط تُوقّع مؤقتًا بدل رابط عام دائم
const SIGNED_URL_EXPIRY_SECONDS =
  (parseFloat(process.env.SIGNED_URL_EXPIRY_DAYS) || 14) * 24 * 60 * 60;

async function getSignedFileUrl(key) {
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(b2, command, { expiresIn: SIGNED_URL_EXPIRY_SECONDS });
}

async function objectExists(key) {
  try {
    await b2.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch (err) {
    if (err.$metadata?.httpStatusCode === 404 || err.name === 'NotFound') {
      return false;
    }
    throw err;
  }
}

// ==================== تيليجرام (اختياري) ====================
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_STATUS_INTERVAL_MS =
  (parseFloat(process.env.TELEGRAM_STATUS_INTERVAL_MINUTES) || 5) * 60 * 1000;

async function notifyTelegram(text, replyMarkup) {
  if (!TG_TOKEN || !TG_CHAT_ID) return; // ميزة اختيارية، لو ما مُعدّة نتجاهل بصمت
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text,
        parse_mode: 'HTML',
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
    });
  } catch (_) {
    // فشل إرسال التنبيه ما يوقف التسجيل — نتجاهله
  }
}

function stopKeyboard(id) {
  return { inline_keyboard: [[{ text: '⏹ إيقاف ورفع', callback_data: `stop:${id}` }]] };
}

function formatHMS(ms) {
  const s = Math.floor(ms / 1000);
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
}

// تحديث دوري لكل تسجيل شغال حاليًا: المدة، الحجم، وتحذير لو البث متوقف يستقبل بيانات
setInterval(() => {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  for (const [id, rec] of activeRecordings.entries()) {
    if (rec.status !== 'recording') continue;
    const elapsed = Date.now() - rec.startTime;
    const sizeMb = ((rec.fileSizeBytes || 0) / (1024 * 1024)).toFixed(0);
    const stalledForMs = rec.lastGrowthAt ? Date.now() - rec.lastGrowthAt : 0;
    const stalled = stalledForMs > 20000;
    const stalledNote = stalled
      ? `\n⚠️ تنبيه: ما وصلت بيانات جديدة من البث آخر ${Math.round(stalledForMs / 1000)} ثانية`
      : '';
    notifyTelegram(
      `⏱ <b>${rec.matchName}</b> (${CLUBS[rec.club]}) لسا يسجل بدون مشاكل\n` +
      `المدة: ${formatHMS(elapsed)} · الحجم: ${sizeMb} MB${stalledNote}`,
      stopKeyboard(id)
    );
  }
}, TELEGRAM_STATUS_INTERVAL_MS);

// ==================== حالة التسجيلات (بالذاكرة) ====================
// id -> { process, club, matchName, url, status, startTime, ... }
// status: scheduled | recording | stopping | uploading | done | error
const activeRecordings = new Map();

// club -> { process, url, logoPath, logoPos, status, startedAt, currentRecordingId }
const activeLiveStreams = new Map();

// ==================== أدوات مساعدة ====================

/** يتحقق أن الرابط يبدأ ببروتوكول مدعوم فقط (يمنع حقن أوامر أو مسارات محلية) */
function isValidStreamUrl(url) {
  if (typeof url !== 'string') return false;
  return /^(https?|rtmp|rtmps|rtsp):\/\/\S+$/i.test(url.trim());
}

/** يحوّل نص حر لاسم ملف آمن (عربي/إنجليزي)، بدون رموز تكسر المسار */
function safeSlug(text, fallback) {
  const cleaned = (text || fallback || 'match')
    .toString()
    .trim()
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 80);
  return cleaned || fallback || 'match';
}

function todayStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(
    date.getHours()
  )}${pad(date.getMinutes())}`;
}

/** يحوّل تاريخ ISO لرقم ms، أو null لو فاضي، أو NaN لو غير صالح */
function parseFutureDate(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : NaN;
}

function runWithTimeout(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('انتهت المهلة'));
    }, timeoutMs);
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.slice(-300) || `فشل (code ${code})`));
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function countBusyRecordings() {
  let n = 0;
  for (const rec of activeRecordings.values()) {
    if (['recording', 'stopping', 'uploading'].includes(rec.status)) n++;
  }
  return n;
}

function requireApiKey(req, res, next) {
  const provided = req.headers['x-api-key'];
  if (!API_KEY || provided !== API_KEY) {
    return res.status(401).json({ error: 'مفتاح API غير صحيح أو مفقود' });
  }
  next();
}

function requireValidClub(req, res, next) {
  const club = req.body.club || req.query.club || req.params.club;
  if (!club || !CLUBS[club]) {
    return res.status(400).json({ error: 'قيمة النادي غير صحيحة' });
  }
  req.clubKey = club;
  next();
}

/** الشكل اللي يشوفه الفرونت إند لتسجيل واحد */
function serializeRecording(id, rec) {
  return {
    id,
    club: rec.club,
    matchName: rec.matchName,
    status: rec.status,
    startTime: rec.startTime || null,
    scheduledStart: rec.scheduledStart || null,
    scheduledStop: rec.scheduledStop || null,
    elapsedMs: rec.startTime ? Date.now() - rec.startTime : 0,
    fileSizeBytes: rec.fileSizeBytes || 0,
    uploadedBytes: rec.uploadedBytes || 0,
    totalUploadBytes: rec.totalUploadBytes || 0,
    errorMessage: rec.errorMessage || null,
    resultUrl: rec.resultUrl || null,
  };
}

// ==================== منطق ffmpeg ====================

function buildFfmpegArgs(streamUrl, logo, outputPath) {
  const isHttp = /^https?:\/\//i.test(streamUrl);
  const args = ['-y'];

  if (isHttp) {
    args.push(
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5'
    );
  }

  args.push('-i', streamUrl);

  if (logo) {
    const w = Math.max(2, Math.round(logo.videoWidth * logo.wPct));
    const h = Math.max(2, Math.round(logo.videoHeight * logo.hPct));
    const x = Math.max(0, Math.round(logo.videoWidth * logo.xPct));
    const y = Math.max(0, Math.round(logo.videoHeight * logo.yPct));
    args.push(
      '-i', logo.path,
      '-filter_complex', `[0:v]scale=iw*sar:ih,setsar=1[base];[1:v]scale=${w}:${h}[lg];[base][lg]overlay=${x}:${y}[vout]`,
      '-map', '[vout]',
      '-map', '0:a?',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-c:a', 'copy'
    );
  } else {
    args.push('-c', 'copy');
  }

  args.push('-movflags', '+faststart', '-f', 'mp4', outputPath);

  return args;
}

/** بث HLS محلي مستمر (بدون حد زمني) — يقرأ المصدر مرة وحدة، يحط اللوقو مرة وحدة،/** بث HLS محلي مستمر (بدون حد زمني) — يقرأ المصدر مرة وحدة، يحط اللوقو مرة وحدة،
 *  ولو معطى rtmpUrl يدفع نفس البث بالتوازي (نفس الاتصال بالمصدر) لمنصة خارجية زي OK.RU */
function buildLiveFfmpegArgs(streamUrl, hlsDir, logo, rtmpUrl) {
  const isHttp = /^https?:\/\//i.test(streamUrl);
  const args = ['-y'];

  if (isHttp) {
    args.push(
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5'
    );
  }

  args.push('-i', streamUrl);

  const useLogo = !!logo;
  const needsSplit = useLogo && !!rtmpUrl; // فلتر الفيديو (اللوقو) لازم يتقسّم بفلتر split عشان يتحط بمخرجين (HLS + RTMP) بدون ما ffmpeg يرفضه
  if (useLogo) {
    const w = Math.max(2, Math.round(logo.videoWidth * logo.wPct));
    const h = Math.max(2, Math.round(logo.videoHeight * logo.hPct));
    const x = Math.max(0, Math.round(logo.videoWidth * logo.xPct));
    const y = Math.max(0, Math.round(logo.videoHeight * logo.yPct));
    const filterChain = needsSplit
      ? `[0:v]scale=iw*sar:ih,setsar=1[base];[1:v]scale=${w}:${h}[lg];[base][lg]overlay=${x}:${y}[ov];[ov]split=2[vout1][vout2]`
      : `[0:v]scale=iw*sar:ih,setsar=1[base];[1:v]scale=${w}:${h}[lg];[base][lg]overlay=${x}:${y}[vout1]`;
    args.push('-i', logo.path, '-filter_complex', filterChain);
  }

  // ---- المخرج الأول: HLS محلي (يقرأه التسجيل والمعاينة) ----
  if (useLogo) {
    args.push(
      '-map', '[vout1]',
      '-map', '0:a?',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-c:a', 'aac'
    );
  } else {
    args.push('-map', '0:v', '-map', '0:a?', '-c:v', 'copy', '-c:a', 'copy');
  }
  args.push(
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+append_list+omit_endlist',
    '-hls_segment_filename', path.join(hlsDir, 'seg_%05d.ts'),
    path.join(hlsDir, 'stream.m3u8')
  );

  // ---- المخرج الثاني (اختياري): دفع RTMP مباشر لـ OK.RU بالتوازي، بدون اتصال ثاني بالمصدر ----
  if (rtmpUrl) {
    if (useLogo) {
      args.push(
        '-map', '[vout2]',
        '-map', '0:a?',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-c:a', 'aac'
      );
    } else {
      args.push('-map', '0:v', '-map', '0:a?', '-c:v', 'copy', '-c:a', 'aac');
    }
    args.push(
      '-f', 'flv',
      '-flvflags', 'no_duration_filesize',
      rtmpUrl
    );
  }

  return args;
}

function liveHlsDir(club) {
  return path.join(LIVE_DIR, club);
}

function startLiveProcess(club, streamUrl, hlsDir, logo, rtmpUrl) {
  const args = buildLiveFfmpegArgs(streamUrl, hlsDir, logo, rtmpUrl);
  const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });

  let stderrTail = '';
  proc.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
  });
  proc.getStderrTail = () => stderrTail;

  proc.on('close', (code) => {
    const live = activeLiveStreams.get(club);
    if (!live || live.process !== proc) return; // تم إيقافه يدويًا مسبقًا، تجاهل

    const wasManualStop = live.stoppingManually;
    activeLiveStreams.delete(club);
    fs.rm(hlsDir, { recursive: true, force: true }, () => {});
    if (live.logoPath) fs.unlink(live.logoPath, () => {});

    if (!wasManualStop) {
      const reason = code === 0 ? 'انتهى البث من طرف المصدر' : `ffmpeg توقف بشكل غير متوقع (code ${code})`;
      notifyTelegram(`⚠️ توقف البث المباشر لـ <b>${CLUBS[club]}</b>: ${reason}\n${stderrTail.slice(-300)}`);
      // لو فيه تسجيل شوط شغال يعتمد على هذا البث، نوقفه ونرفعه بدل ما يضيع
      if (live.currentRecordingId) {
        finalizeRecording(live.currentRecordingId).catch(() => {});
      }
    }
  });

  return proc;
}

/** يبدأ ffmpeg ويرفع خرجه (stdout) مباشرة لـ B2 أول بأول — بدون كتابة أي ملف فيديو على القرص المحلي.
 *  الرفع يبدأ فور توفر أول بايتات، فما يتراكم شيء على الجهاز أثناء التسجيل. */
function startRecordingPipeline(id, rec, streamUrl, logo) {
  const key = `${rec.club}/${rec.matchName}.mp4`;
  rec.resultKey = key;
  rec.tempFilePath = path.join(TEMP_DIR, `rec_${id}.mp4`);

  const args = buildFfmpegArgs(streamUrl, logo, rec.tempFilePath);
  const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });

  let stderrTail = '';
  proc.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
  });
  proc.getStderrTail = () => stderrTail;

  rec.sizeCheckInterval = setInterval(() => {
    fs.stat(rec.tempFilePath, (err, stats) => {
      if (!err) {
        rec.fileSizeBytes = stats.size;
        rec.lastGrowthAt = Date.now();
      }
    });
  }, 3000);

  proc.on('error', (err) => {
    if (['error', 'done'].includes(rec.status)) return;
    clearInterval(rec.sizeCheckInterval);
    rec.status = 'error';
    rec.errorMessage = `تعذر تشغيل ffmpeg: ${err.message}`;
    fs.unlink(rec.tempFilePath, () => {});
    notifyTelegram(`❌ <b>${rec.matchName}</b> (${CLUBS[rec.club]})\nتعذر تشغيل ffmpeg: ${err.message}`);
  });

  proc.on('close', (code) => {
    clearInterval(rec.sizeCheckInterval);
    if (['stopping', 'uploading', 'done', 'error'].includes(rec.status)) return;
    if (code !== 0) {
      rec.status = 'error';
      rec.errorMessage = `ffmpeg توقف بشكل غير متوقع (code ${code}). ${stderrTail.slice(-300)}`;
      fs.unlink(rec.tempFilePath, () => {});
      notifyTelegram(`❌ <b>${rec.matchName}</b> (${CLUBS[rec.club]})\nانقطع التسجيل: ${rec.errorMessage}`);
    } else {
      notifyTelegram(`ℹ️ انتهى بث <b>${rec.matchName}</b> من طرف المصدر — جاري رفع الملف لـ B2`);
      finalizeRecording(id).catch(() => {});
    }
  });

  rec.process = proc;
  return proc;
}

/** يطبّق الحد الأقصى لمدة التسجيل (تلقائي أو مجدول) */
function attachRecordingMonitor(id, rec) {
  let stopDelayMs = MAX_RECORDING_MS;
  if (rec.scheduledStop) {
    stopDelayMs = rec.scheduledStop - Date.now();
  }
  stopDelayMs = Math.max(1000, Math.min(stopDelayMs, ABSOLUTE_MAX_RECORDING_MS));

  rec.stopTimeoutHandle = setTimeout(() => {
    const current = activeRecordings.get(id);
    if (current && current.status === 'recording') {
      finalizeRecording(id).catch(() => {});
    }
  }, stopDelayMs);
}

/** يبدأ التسجيل فعليًا الآن (يُستدعى فورًا أو من مؤقّت الجدولة) *//** يبدأ التسجيل فعليًا الآن (يُستدعى فورًا أو من مؤقّت الجدولة) */
function beginRecordingNow(id) {
  const rec = activeRecordings.get(id);
  if (!rec) return;

  rec.status = 'recording';
  rec.startTime = Date.now();
  const logo = rec.logoPath && rec.logoPos ? { path: rec.logoPath, ...rec.logoPos } : null;
  startRecordingPipeline(id, rec, rec.url, logo);
  attachRecordingMonitor(id, rec);

  notifyTelegram(`🔴 بدأ تسجيل <b>${rec.matchName}</b> (${CLUBS[rec.club]})`, stopKeyboard(id));
}

/** يوقف ffmpeg (لو شغال) وينتظر اكتمال الرفع المباشر لـ B2 (اللي بدأ من أول لحظة تسجيل) */
async function finalizeRecording(id) {
  const rec = activeRecordings.get(id);
  if (!rec) return;
  if (rec.status === 'uploading' || rec.status === 'done') return;

  if (rec.linkedLiveClub) {
    const live = activeLiveStreams.get(rec.linkedLiveClub);
    if (live && live.currentRecordingId === id) live.currentRecordingId = null;
  }

  if (rec.stopTimeoutHandle) clearTimeout(rec.stopTimeoutHandle);

  rec.status = 'stopping';

  if (rec.process && rec.process.exitCode === null) {
    await new Promise((resolve) => {
      rec.process.once('close', resolve);
      try {
        rec.process.stdin.write('q');
      } catch (_) {
        rec.process.kill('SIGINT');
      }
      setTimeout(() => {
        if (rec.process.exitCode === null) rec.process.kill('SIGKILL');
      }, 15000);
    });
  }

  if (rec.sizeCheckInterval) clearInterval(rec.sizeCheckInterval);

  let stats = null;
  try {
    stats = fs.statSync(rec.tempFilePath);
  } catch (_) {
    stats = null;
  }

  if (!stats || !stats.size) {
    rec.status = 'error';
    rec.errorMessage = 'لم يُنتج أي بيانات تسجيل — تأكد أن رابط البث صحيح ويعمل.';
    if (rec.tempFilePath) fs.unlink(rec.tempFilePath, () => {});
    notifyTelegram(`❌ <b>${rec.matchName}</b> (${CLUBS[rec.club]})\n${rec.errorMessage}`);
    if (rec.logoPath) fs.unlink(rec.logoPath, () => {});
    setTimeout(() => activeRecordings.delete(id), 15 * 60 * 1000);
    return;
  }

  rec.fileSizeBytes = stats.size;
  rec.totalUploadBytes = stats.size;
  rec.status = 'uploading';

  try {
    const upload = new Upload({
      client: b2,
      params: {
        Bucket: BUCKET,
        Key: rec.resultKey,
        Body: fs.createReadStream(rec.tempFilePath),
        ContentType: 'video/mp4',
      },
      partSize: 8 * 1024 * 1024,
      queueSize: 3,
    });
    upload.on('httpUploadProgress', (progress) => {
      rec.uploadedBytes = progress.loaded || 0;
    });
    rec.uploadInstance = upload;
    await upload.done();

    const publicUrl = await getSignedFileUrl(rec.resultKey);
    rec.status = 'done';
    rec.resultUrl = publicUrl;
    rec.durationMs = Date.now() - rec.startTime;
    notifyTelegram(
      `✅ اكتمل تسجيل <b>${rec.matchName}</b> (${CLUBS[rec.club]})\n${publicUrl}`
    );
  } catch (err) {
    rec.status = 'error';
    rec.errorMessage = `فشل الرفع لـ B2: ${err.message}`;
    notifyTelegram(`❌ فشل رفع <b>${rec.matchName}</b> (${CLUBS[rec.club]})\n${rec.errorMessage}`);
  } finally {
    if (rec.tempFilePath) fs.unlink(rec.tempFilePath, () => {});
    if (rec.logoPath) fs.unlink(rec.logoPath, () => {});
  }

  setTimeout(() => activeRecordings.delete(id), 15 * 60 * 1000);
}

// ==================== تطبيق Express ====================// ==================== تطبيق Express ====================

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  cacheControl: true,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));
app.use('/live', express.static(LIVE_DIR));

app.get('/api/clubs', requireApiKey, (req, res) => {
  res.json({ clubs: CLUBS });
});

// كل التسجيلات النشطة/المجدولة حاليًا (الاثنين) — تُستخدم لعرض الحالة اللحظية ولاسترجاع الواجهة بعد إعادة تحميل الصفحة
app.get('/api/record/active', requireApiKey, (req, res) => {
  const items = [...activeRecordings.entries()].map(([id, rec]) => serializeRecording(id, rec));
  res.json({ recordings: items });
});

// معاينة فريم واحد من البث (بدون بدء تسجيل) — تُستخدم لتحديد موضع اللوقو
app.post('/api/preview/frame', requireApiKey, async (req, res) => {
  const { url } = req.body;
  if (!isValidStreamUrl(url)) {
    return res.status(400).json({ error: 'رابط غير صالح' });
  }

  const framePath = path.join(TEMP_DIR, `preview-${uuidv4()}.jpg`);
  try {
    // اتصال واحد فقط بالبث (بعض بوانل IPTV تسمح باتصال واحد متزامن) — نطلع الأبعاد من stderr حق ffmpeg نفسه
    // -vf scale=iw*sar:ih,setsar=1 : بعض بثوث IPTV/الأقمار تستخدم بكسلات غير مربعة (anamorphic)
    // لو ما صححنا النسبة هنا، الصورة تطلع مشدودة (بيضاوي بدل مستطيل عريض)
    const frameArgs = [
      '-y', '-i', url.trim(),
      '-frames:v', '1',
      '-vf', 'scale=iw*sar:ih,setsar=1',
      '-q:v', '3', framePath,
    ];
    const { stderr } = await runWithTimeout('ffmpeg', frameArgs, PREVIEW_TIMEOUT_MS);

    const outputSection = stderr.split('Output #0')[1] || stderr;
    const dimMatch = outputSection.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
    const width = dimMatch ? parseInt(dimMatch[1], 10) : null;
    const height = dimMatch ? parseInt(dimMatch[2], 10) : null;

    const imageBase64 = fs.readFileSync(framePath).toString('base64');
    res.json({ image: `data:image/jpeg;base64,${imageBase64}`, width, height });
  } catch (err) {
    res.status(500).json({ error: `تعذر أخذ معاينة: ${err.message}` });
  } finally {
    fs.unlink(framePath, () => {});
  }
});

// ==================== البث المباشر (مستمر) + تسجيل شوط داخله ====================

// حالة البث المباشر لكل الأندية
app.get('/api/live/status', requireApiKey, (req, res) => {
  const out = {};
  for (const [club, live] of activeLiveStreams.entries()) {
    out[club] = {
      status: live.status,
      startedAt: live.startedAt,
      hlsUrl: `/live/${club}/stream.m3u8`,
      recording: !!live.currentRecordingId,
      recordingId: live.currentRecordingId || null,
      pushingToOkru: !!live.pushingToOkru,
    };
  }
  res.json({ live: out });
});

// بدء بث مباشر مستمر لنادي (يقرأ المصدر مرة وحدة، يحط اللوقو إن وجد)
app.post('/api/live/start', requireApiKey, logoUpload.single('logo'), requireValidClub, (req, res) => {
  const { url, logoX, logoY, logoW, logoH, videoWidth, videoHeight } = req.body;
  const okruUrlRaw = (req.body.okruUrl || '').trim();

  if (!isValidStreamUrl(url)) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'رابط غير صالح. مسموح فقط: http, https, rtmp, rtmps, rtsp' });
  }
  // رابط OK.RU يتغيّر كل مرة، فيُقرأ من الفورم؛ لو ما انحط نرجع لقيمة .env كاحتياط
  let okruUrl = OKRU_RTMP_URL;
  if (okruUrlRaw) {
    if (!/^rtmps?:\/\/\S+$/i.test(okruUrlRaw)) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'رابط OK.RU غير صالح — لازم يبدأ بـ rtmp:// أو rtmps://' });
    }
    okruUrl = okruUrlRaw;
  }
  if (activeLiveStreams.has(req.clubKey)) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(409).json({ error: 'فيه بث مباشر شغال أصلاً لهذا النادي' });
  }

  const logoPos = (req.file && logoX && logoY && logoW && logoH && videoWidth && videoHeight)
    ? {
        xPct: parseFloat(logoX),
        yPct: parseFloat(logoY),
        wPct: parseFloat(logoW),
        hPct: parseFloat(logoH),
        videoWidth: parseInt(videoWidth, 10),
        videoHeight: parseInt(videoHeight, 10),
      }
    : null;

  const hlsDir = liveHlsDir(req.clubKey);
  fs.rmSync(hlsDir, { recursive: true, force: true });
  fs.mkdirSync(hlsDir, { recursive: true });

  const logo = req.file && logoPos ? { path: req.file.path, ...logoPos } : null;
  const live = {
    url: url.trim(),
    logoPath: req.file ? req.file.path : null,
    logoPos,
    status: 'live',
    startedAt: Date.now(),
    currentRecordingId: null,
    process: null,
    stoppingManually: false,
    pushingToOkru: !!okruUrl,
  };
  live.process = startLiveProcess(req.clubKey, live.url, hlsDir, logo, okruUrl);
  activeLiveStreams.set(req.clubKey, live);

  const okruNote = okruUrl ? ' — وبث مباشر على OK.RU' : '';
  notifyTelegram(`📡 بدأ بث مباشر لـ <b>${CLUBS[req.clubKey]}</b>${okruNote}`);
  res.json({
    success: true,
    hlsUrl: `/live/${req.clubKey}/stream.m3u8`,
    pushingToOkru: !!okruUrl,
  });
});

// إيقاف البث المباشر (يوقف تسجيل الشوط الحالي معه لو فيه، ويرفعه)
app.post('/api/live/stop', requireApiKey, requireValidClub, async (req, res) => {
  const live = activeLiveStreams.get(req.clubKey);
  if (!live) return res.status(404).json({ error: 'مافيه بث مباشر شغال لهذا النادي' });

  live.stoppingManually = true;

  if (live.currentRecordingId) {
    await finalizeRecording(live.currentRecordingId).catch(() => {});
  }

  if (live.process && live.process.exitCode === null) {
    live.process.kill('SIGINT');
    setTimeout(() => {
      if (live.process.exitCode === null) live.process.kill('SIGKILL');
    }, 5000);
  }

  activeLiveStreams.delete(req.clubKey);
  fs.rm(liveHlsDir(req.clubKey), { recursive: true, force: true }, () => {});
  if (live.logoPath) fs.unlink(live.logoPath, () => {});

  notifyTelegram(`⏹ تم إيقاف البث المباشر لـ <b>${CLUBS[req.clubKey]}</b>`);
  res.json({ success: true });
});

// بدء تسجيل شوط جديد من البث المباشر الشغال (بدون رابط أو لوقو — يقرأ من البث المحلي)
app.post('/api/live/recording/start', requireApiKey, requireValidClub, (req, res) => {
  const live = activeLiveStreams.get(req.clubKey);
  if (!live) return res.status(400).json({ error: 'لازم تبدأ البث المباشر أول' });
  if (live.currentRecordingId) {
    return res.status(409).json({ error: 'فيه تسجيل شغال أصلاً على هذا البث' });
  }
  if (countBusyRecordings() >= MAX_CONCURRENT_RECORDINGS) {
    return res.status(409).json({
      error: `فيه ${MAX_CONCURRENT_RECORDINGS} تسجيل شغال حاليًا (الحد الأقصى المسموح بنفس الوقت)`,
    });
  }

  const { matchName } = req.body;
  const id = uuidv4();
  const slug = safeSlug(matchName, `match-${todayStamp()}`);
  const finalName = `${todayStamp()}_${slug}`;
  const localHlsUrl = `http://127.0.0.1:${PORT}/live/${req.clubKey}/stream.m3u8`;

  const rec = {
    club: req.clubKey,
    matchName: finalName,
    url: localHlsUrl,
    status: 'recording',
    scheduledStart: null,
    scheduledStop: null,
    startTime: Date.now(),
    process: null,
    errorMessage: null,
    fileSizeBytes: 0,
    lastGrowthAt: Date.now(),
    logoPath: null,
    logoPos: null,
    linkedLiveClub: req.clubKey,
  };
  startRecordingPipeline(id, rec, localHlsUrl, null);
  attachRecordingMonitor(id, rec);

  activeRecordings.set(id, rec);
  live.currentRecordingId = id;

  notifyTelegram(`🔴 بدأ تسجيل شوط <b>${finalName}</b> (${CLUBS[req.clubKey]})`, stopKeyboard(id));
  res.json(serializeRecording(id, rec));
});

// إيقاف تسجيل الشوط الحالي ورفعه — البث المباشر يفضل شغال
app.post('/api/live/recording/stop', requireApiKey, requireValidClub, async (req, res) => {
  const live = activeLiveStreams.get(req.clubKey);
  if (!live || !live.currentRecordingId) {
    return res.status(400).json({ error: 'مافيه تسجيل شغال حاليًا لهذا البث' });
  }
  const id = live.currentRecordingId;
  const result = requestStopRecording(id);
  if (!result.ok) return res.status(404).json({ error: result.error });
  res.json({ success: true, id });
});

// بدء تسجيل جديد (فوري أو مجدول)
app.post('/api/record/start', requireApiKey, logoUpload.single('logo'), requireValidClub, (req, res) => {
  const { url, matchName, startAt, stopAt, logoX, logoY, logoW, logoH, videoWidth, videoHeight } = req.body;

  if (!isValidStreamUrl(url)) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({
      error: 'رابط غير صالح. مسموح فقط: http, https, rtmp, rtmps, rtsp',
    });
  }

  const scheduledStart = parseFutureDate(startAt);
  const scheduledStop = parseFutureDate(stopAt);
  if (Number.isNaN(scheduledStart) || Number.isNaN(scheduledStop)) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'صيغة وقت غير صالحة' });
  }
  const startsInFuture = scheduledStart && scheduledStart > Date.now() + 2000;
  if (scheduledStop && scheduledStop <= (scheduledStart || Date.now())) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'وقت الإيقاف لازم يكون بعد وقت البدء' });
  }

  if (countBusyRecordings() >= MAX_CONCURRENT_RECORDINGS && !startsInFuture) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(409).json({
      error: `فيه ${MAX_CONCURRENT_RECORDINGS} تسجيل شغال حاليًا (الحد الأقصى المسموح بنفس الوقت)`,
    });
  }

  const id = uuidv4();
  const slug = safeSlug(matchName, `match-${todayStamp()}`);
  const finalName = `${todayStamp(scheduledStart ? new Date(scheduledStart) : new Date())}_${slug}`;

  const logoPos = (req.file && logoX && logoY && logoW && logoH && videoWidth && videoHeight)
    ? {
        xPct: parseFloat(logoX),
        yPct: parseFloat(logoY),
        wPct: parseFloat(logoW),
        hPct: parseFloat(logoH),
        videoWidth: parseInt(videoWidth, 10),
        videoHeight: parseInt(videoHeight, 10),
      }
    : null;

  const rec = {
    club: req.clubKey,
    matchName: finalName,
    url: url.trim(),
    status: startsInFuture ? 'scheduled' : 'recording',
    scheduledStart: scheduledStart || null,
    scheduledStop: scheduledStop || null,
    startTime: null,
    tempFilePath: null,
    process: null,
    errorMessage: null,
    fileSizeBytes: 0,
    lastGrowthAt: Date.now(),
    logoPath: req.file ? req.file.path : null,
    logoPos,
  };
  activeRecordings.set(id, rec);

  if (startsInFuture) {
    rec.scheduleHandle = setTimeout(() => {
      const current = activeRecordings.get(id);
      if (!current || current.status !== 'scheduled') return;
      if (countBusyRecordings() >= MAX_CONCURRENT_RECORDINGS) {
        current.status = 'error';
        current.errorMessage = 'وصل الحد الأقصى للتسجيلات المتزامنة وقت موعد البدء المجدول';
        notifyTelegram(`❌ فشل بدء <b>${current.matchName}</b> المجدول: ${current.errorMessage}`);
        return;
      }
      beginRecordingNow(id);
    }, scheduledStart - Date.now());

    const reminderDelay = scheduledStart - REMINDER_BEFORE_MS - Date.now();
    if (reminderDelay > 0) {
      rec.reminderHandle = setTimeout(() => {
        const current = activeRecordings.get(id);
        if (!current || current.status !== 'scheduled') return;
        const minsLeft = Math.round(REMINDER_BEFORE_MS / 60000);
        notifyTelegram(
          `⏰ تذكير: تسجيل <b>${current.matchName}</b> (${CLUBS[current.club]}) يبدأ بعد ${minsLeft} دقايق — تأكد إن ترمكس والتونيل شغالين`
        );
      }, reminderDelay);
    }
  } else {
    beginRecordingNow(id);
  }

  res.json(serializeRecording(id, rec));
});

// فحص حالة تسجيل واحد
app.get('/api/record/status/:id', requireApiKey, (req, res) => {
  const rec = activeRecordings.get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'غير موجود' });
  const stalledForMs = rec.lastGrowthAt ? Date.now() - rec.lastGrowthAt : 0;
  const stalled = rec.status === 'recording' && stalledForMs > 20000;
  res.json({
    ...serializeRecording(req.params.id, rec),
    stalledForMs,
    stalled,
    lastLog: rec.process?.getStderrTail ? rec.process.getStderrTail().slice(-500) : '',
  });
});

// يوقف تسجيل أو يلغي جدولة — تُستخدم من مسار HTTP ومن زر تيليجرام معًا
function requestStopRecording(id) {
  const rec = activeRecordings.get(id);
  if (!rec) return { ok: false, error: 'التسجيل غير موجود أو انتهى مسبقًا' };

  if (rec.status === 'scheduled') {
    if (rec.scheduleHandle) clearTimeout(rec.scheduleHandle);
    if (rec.reminderHandle) clearTimeout(rec.reminderHandle);
    activeRecordings.delete(id);
    return { ok: true, cancelled: true };
  }

  if (['stopping', 'uploading', 'done', 'error'].includes(rec.status)) {
    return { ok: true, already: true, rec };
  }

  finalizeRecording(id).catch(() => {});
  return { ok: true, stopping: true };
}

// إيقاف تسجيل (أو إلغاء مجدول) — يرجع فورًا، الرفع يكمل بالخلفية
app.post('/api/record/stop', requireApiKey, (req, res) => {
  const { id } = req.body;
  const result = requestStopRecording(id);
  if (!result.ok) return res.status(404).json({ error: result.error });
  if (result.cancelled) return res.json({ success: true, cancelled: true });
  if (result.already) return res.json(serializeRecording(id, result.rec));
  res.json({ success: true, status: 'stopping' });
});

// قائمة التسجيلات المرفوعة لنادي معيّن (كل مرة تولّد روابط موقّعة جديدة صالحة)
app.get('/api/recordings/:club', requireApiKey, requireValidClub, async (req, res) => {
  try {
    const out = await b2.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${req.clubKey}/` })
    );
    const items = await Promise.all(
      (out.Contents || [])
        .filter((o) => o.Key.endsWith('.mp4'))
        .sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified))
        .map(async (o) => ({
          key: o.Key,
          name: o.Key.split('/').pop().replace(/\.mp4$/, ''),
          url: await getSignedFileUrl(o.Key),
          sizeBytes: o.Size,
          lastModified: o.LastModified,
        }))
    );
    res.json({ recordings: items, linkValidDays: SIGNED_URL_EXPIRY_SECONDS / 86400 });
  } catch (err) {
    res.status(500).json({ error: `تعذر جلب القائمة من B2: ${err.message}` });
  }
});

// حذف تسجيل مرفوع — نبني الاسم صراحة ونتحقق فعليًا قبل وبعد الحذف
app.delete('/api/recordings/:club/:name', requireApiKey, requireValidClub, async (req, res) => {
  const name = decodeURIComponent(req.params.name).replace(/\.mp4$/i, '');
  const key = `${req.clubKey}/${name}.mp4`;
  try {
    const exists = await objectExists(key);
    if (!exists) {
      return res.status(404).json({ error: 'الملف غير موجود بالتخزين أصلًا' });
    }
    await b2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    const stillExists = await objectExists(key);
    if (stillExists) {
      return res.status(500).json({ error: 'الحذف ما اكتمل فعليًا، حاول مرة ثانية' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: `تعذر الحذف: ${err.message}` });
  }
});

// استهلاك مساحة B2 الإجمالي (كل الأنديه)
app.get('/api/storage/usage', requireApiKey, async (req, res) => {
  try {
    let usedBytes = 0;
    let continuationToken;
    do {
      const out = await b2.send(
        new ListObjectsV2Command({ Bucket: BUCKET, ContinuationToken: continuationToken })
      );
      usedBytes += (out.Contents || []).reduce((sum, o) => sum + o.Size, 0);
      continuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (continuationToken);

    res.json({ usedBytes, quotaBytes: B2_QUOTA_BYTES });
  } catch (err) {
    res.status(500).json({ error: `تعذر جلب الاستهلاك: ${err.message}` });
  }
});

// ==================== أوامر تيليجرام (اختياري) ====================
// استطلاع بسيط بدل webhook — أسهل بإعداد جهاز شخصي ولا يحتاج دومين ثابت
let telegramOffset = 0;

function buildStatusReportText() {
  const entries = [...activeRecordings.entries()];
  if (!entries.length) return '⚪ ما فيه أي تسجيل شغال أو مجدول حاليًا';

  return entries
    .map(([, rec]) => {
      const clubName = CLUBS[rec.club] || rec.club;
      if (rec.status === 'recording') {
        const sizeMb = ((rec.fileSizeBytes || 0) / (1024 * 1024)).toFixed(0);
        return `🔴 <b>${rec.matchName}</b> (${clubName}) — ${formatHMS(Date.now() - rec.startTime)} · ${sizeMb} MB`;
      }
      if (rec.status === 'scheduled') {
        return `⏳ <b>${rec.matchName}</b> (${clubName}) — يبدأ ${new Date(rec.scheduledStart).toLocaleString('ar')}`;
      }
      if (rec.status === 'uploading' || rec.status === 'stopping') {
        return `⬆️ <b>${rec.matchName}</b> (${clubName}) — جاري الرفع`;
      }
      return `❌ <b>${rec.matchName}</b> (${clubName}) — ${rec.errorMessage || 'خطأ'}`;
    })
    .join('\n');
}

async function answerCallbackQuery(callbackId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackId, text, show_alert: false }),
    });
  } catch (_) {}
}

async function pollTelegramUpdates() {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${telegramOffset}&timeout=0`
    );
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.result)) return;

    for (const update of data.result) {
      telegramOffset = update.update_id + 1;

      const msg = update.message;
      if (msg && String(msg.chat.id) === String(TG_CHAT_ID) && msg.text === '/status') {
        notifyTelegram(buildStatusReportText());
      }

      const cb = update.callback_query;
      if (cb && String(cb.message?.chat?.id) === String(TG_CHAT_ID) && cb.data?.startsWith('stop:')) {
        const id = cb.data.slice('stop:'.length);
        const result = requestStopRecording(id);
        const reply = result.ok
          ? (result.cancelled ? 'تم إلغاء الجدولة' : 'جاري الإيقاف والرفع...')
          : (result.error || 'تعذر الإيقاف');
        await answerCallbackQuery(cb.id, reply);
      }
    }
  } catch (_) {
    // فشل مؤقت بالاتصال بتيليجرام — نتجاهله ونحاول بالدورة الجاية
  }
}

setInterval(pollTelegramUpdates, 3000);

app.listen(PORT, () => {
  console.log(`✅ Stream Recorder شغال على المنفذ ${PORT}`);
});
