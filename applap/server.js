// سيرفر App Lab: رفع APK وتثبيته على الجهاز الافتراضي + عرض الروابط المرصودة.
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const KEY = process.env.API_KEY || '';
const VNCPASS = process.env.VNCPASS || '';
const SDK = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '/usr/local/lib/android/sdk';
const ADB = process.env.ADB || path.join(SDK, 'platform-tools', 'adb');
const L = '/tmp/lab';
const UP = path.join(L, 'uploads');
const FLOWS = path.join(L, 'flows.jsonl');
fs.mkdirSync(UP, { recursive: true });
if (!fs.existsSync(FLOWS)) fs.writeFileSync(FLOWS, '');

function adb(args, timeout = 60000) {
  return new Promise((resolve) => {
    execFile(ADB, args, { timeout, maxBuffer: 20 * 1024 * 1024 }, (e, out, err) => {
      resolve({ ok: !e, out: ((out || '') + (err || '')).trim() });
    });
  });
}
async function thirdParty() {
  const r = await adb(['shell', 'pm', 'list', 'packages', '-3']);
  return r.out.split('\n').map((s) => s.replace('package:', '').trim()).filter(Boolean);
}
async function launch(pkg) {
  return adb(['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']);
}
function readState() {
  try { return JSON.parse(fs.readFileSync(path.join(L, 'state.json'), 'utf8')); }
  catch (e) { return { stage: 'starting', detail: '' }; }
}

const app = express();
app.use(cors({ origin: true, allowedHeaders: ['x-api-key', 'content-type'] }));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/api', (req, res, next) => {
  if (KEY && req.headers['x-api-key'] === KEY) return next();
  res.status(401).json({ error: 'مفتاح الـ API غير صحيح.' });
});

app.get('/api/lab/status', (_req, res) => {
  const s = readState();
  res.json({ stage: s.stage, detail: s.detail || '', vncPass: VNCPASS });
});

// رفع على قطع (عشان حد 100MB بنفق كلاودفلير)
const nextChunk = {};
app.post('/api/lab/chunk', express.raw({ type: '*/*', limit: '30mb' }), (req, res) => {
  const id = String(req.query.id || '');
  const i = parseInt(req.query.i, 10);
  if (!/^[a-z0-9]{6,40}$/.test(id) || !(i >= 0)) return res.status(400).json({ error: 'طلب غير صحيح.' });
  const file = path.join(UP, id + '.apk');
  if (i === 0) { fs.writeFileSync(file, ''); nextChunk[id] = 0; }
  if (nextChunk[id] !== i) return res.status(409).json({ error: 'قطعة خارج الترتيب، أعد الرفع.' });
  fs.appendFileSync(file, req.body);
  nextChunk[id] = i + 1;
  res.json({ ok: true, next: i + 1 });
});

app.post('/api/lab/install', express.json(), async (req, res) => {
  const id = String((req.body && req.body.id) || '');
  const file = path.join(UP, id + '.apk');
  if (!/^[a-z0-9]{6,40}$/.test(id) || !fs.existsSync(file)) return res.status(400).json({ error: 'ما لقيت الملف المرفوع.' });
  if (readState().stage !== 'ready') return res.status(409).json({ error: 'الجهاز لسا يتجهز، انتظر لين يصير جاهز.' });
  const before = await thirdParty();
  const r = await adb(['install', '-r', '-g', '-t', file], 300000);
  fs.unlink(file, () => {});
  if (!/Success/i.test(r.out)) {
    let hint = '';
    if (/NO_MATCHING_ABIS/.test(r.out)) hint = ' التطبيق ما يدعم معالج الجهاز الافتراضي (x86_64)، غالبًا نسخته ARM فقط.';
    if (/INSTALL_FAILED_OLDER_SDK/.test(r.out)) hint = ' التطبيق يحتاج أندرويد أحدث من نسخة الجهاز (11).';
    return res.status(400).json({ error: 'فشل التثبيت: ' + r.out.slice(0, 300) + hint });
  }
  const after = await thirdParty();
  const added = after.filter((p) => !before.includes(p));
  const pkg = added[0] || after[after.length - 1] || '';
  let launched = false;
  if (pkg) launched = (await launch(pkg)).ok;
  res.json({ ok: true, package: pkg, launched });
});

app.get('/api/lab/apps', async (_req, res) => res.json({ apps: await thirdParty() }));
app.post('/api/lab/launch', express.json(), async (req, res) => {
  const pkg = String((req.body && req.body.package) || '');
  if (!/^[A-Za-z0-9._]+$/.test(pkg)) return res.status(400).json({ error: 'اسم حزمة غير صحيح.' });
  res.json({ ok: (await launch(pkg)).ok });
});

app.get('/api/lab/flows', (req, res) => {
  const kind = req.query.kind === 'all' ? 'all' : 'stream';
  let text = '';
  try {
    const st = fs.statSync(FLOWS);
    const max = 20 * 1024 * 1024;
    const fd = fs.openSync(FLOWS, 'r');
    const len = Math.min(st.size, max);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch (e) {}
  const out = [];
  const seen = new Set();
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < 300; i--) {
    if (!lines[i]) continue;
    let r; try { r = JSON.parse(lines[i]); } catch (e) { continue; }
    if (kind === 'stream' && r.kind !== 'stream' && r.kind !== 'video') continue;
    if (kind === 'all' && r.kind === 'segment') continue;
    const k = r.method + ' ' + r.url;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  res.json({ flows: out });
});
app.post('/api/lab/flows/clear', (_req, res) => { fs.writeFileSync(FLOWS, ''); res.json({ ok: true }); });

app.listen(3100, '127.0.0.1', () => console.log('app-lab server on 3100'));
