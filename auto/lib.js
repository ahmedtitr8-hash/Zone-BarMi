'use strict';
// أدوات مشتركة للوضع التلقائي: إشعارات تيليجرام، git، طلبات HTTP. (ملف جديد — اليدوي ما يستخدمه)
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = process.env.AUTO_ROOT || path.resolve(__dirname, '..');
try { require('dotenv').config({ path: path.join(ROOT, '.env') }); } catch (_) {}
const E = process.env;

const CHAIN = Number(E.AUTO_CHAIN || 0) || 0;
const MAX_CHAIN = Number(E.AUTO_MAX_CHAIN || 4) || 0;
const REPO = E.AUTO_REPO || '';          // owner/name
const REF = E.AUTO_REF || 'main';
const API_KEY = E.API_KEY || '';
const PORT = Number(E.PORT || 3000);

function pagesBase() {
  const m = REPO.match(/^([^/]+)\/(.+)$/);
  return m ? `https://${m[1].toLowerCase()}.github.io/${m[2]}` : '';
}

const clock = () => new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Riyadh', hour12: false });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = () => `🔁 تلقائي #${CHAIN + 1}`;

// إشعار تيليجرام — ما يرمي خطأ أبدًا (الإشعار ما يوقف الشغل)
async function tg(text) {
  const line = `${tag()} | ${clock()}\n${text}`;
  console.log('[tg] ' + line.replace(/\n/g, ' ⏎ '));
  try { if (E.AUTO_TG_FILE) fs.appendFileSync(E.AUTO_TG_FILE, line + '\n---\n'); } catch (_) {}
  const token = E.TELEGRAM_BOT_TOKEN, chat = E.TELEGRAM_CHAT_ID;
  if (!token || !chat || E.AUTO_TG_OFF === '1') return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: line.slice(0, 4000), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000),
    });
    return r.ok;
  } catch (e) { console.error('[tg] فشل الإرسال:', e && e.message); return false; }
}

// طلب HTTP بمهلة، يرجّع { ok, status, text, json } ولا يرمي أبدًا
async function req(url, opt = {}, ms = 10000) {
  try {
    const r = await fetch(url, { ...opt, signal: AbortSignal.timeout(ms), cache: 'no-store' });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (_) {}
    return { ok: r.ok, status: r.status, text, json };
  } catch (e) { return { ok: false, status: 0, text: '', json: null, error: (e && e.message) || String(e) }; }
}
const authHeaders = (extra) => ({ 'x-api-key': API_KEY, 'content-type': 'application/json', ...(extra || {}) });
const api = (base, p, method = 'GET', body, ms = 15000) =>
  req(base + p, { method, headers: authHeaders(), body: body === undefined ? undefined : JSON.stringify(body) }, ms);

function git(args, cwd = ROOT) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout || ''), err: String(stderr || '') }));
  });
}

let gitChain = Promise.resolve();
// ينشر ملفات (null = حذف) بكوميت واحد. متسلسل (قفل)، مع إعادة محاولة عند تعارض الرفع.
function gitPublish(files, message) {
  const job = gitChain.then(() => gitPublishInner(files, message));
  gitChain = job.catch(() => {});
  return job;
}
async function gitPublishInner(files, message) {
  const paths = [];
  for (const f of files) {
    const abs = path.join(ROOT, f.path);
    if (f.content === null) { try { fs.unlinkSync(abs); } catch (_) {} }
    else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, f.content); }
    paths.push(f.path);
  }
  await git(['config', 'user.name', 'github-actions[bot]']);
  await git(['config', 'user.email', 'github-actions[bot]@users.noreply.github.com']);
  const add = await git(['add', '-A', '--', ...paths]);
  if (add.code !== 0) return { ok: false, step: 'add', detail: add.err };
  const diff = await git(['diff', '--cached', '--quiet']);
  if (diff.code === 0) return { ok: true, changed: false };
  const c = await git(['commit', '-m', message]);
  if (c.code !== 0) return { ok: false, step: 'commit', detail: c.err || c.out };
  let last = null;
  for (let i = 1; i <= 5; i++) {
    const pl = await git(['pull', '--rebase', '--autostash', 'origin', REF]);
    if (pl.code !== 0) { last = { step: 'pull', detail: pl.err || pl.out }; await git(['rebase', '--abort']); await sleep(1500 * i); continue; }
    const ps = await git(['push', 'origin', 'HEAD:' + REF]);
    if (ps.code === 0) { const h = await git(['rev-parse', '--short', 'HEAD']); return { ok: true, changed: true, commit: h.out.trim(), attempts: i }; }
    last = { step: 'push', detail: ps.err || ps.out };
    await sleep(1500 * i);
  }
  return { ok: false, ...last };
}
async function gitSync() {
  const r = await git(['pull', '--rebase', '--autostash', 'origin', REF]);
  return r.code === 0;
}

const NAME_RE = /^[a-zA-Z0-9_-]{1,40}$/;
const TUNNEL_RE = /^https:\/\/(?:[a-z0-9-]+\.)+trycloudflare\.com$/i;
const okTunnel = (u) => {
  try {
    const x = new URL(u);
    if (x.origin !== String(u).replace(/\/+$/, '')) return false;
    if (E.AUTO_ALLOW_LOCAL === '1' && /^http:\/\/127\.0\.0\.1:\d+$/.test(x.origin)) return true;   // للاختبار المحلي فقط
    return TUNNEL_RE.test(x.origin);
  } catch (_) { return false; }
};

module.exports = { ROOT, E, CHAIN, MAX_CHAIN, REPO, REF, API_KEY, PORT, pagesBase, clock, sleep, tag, tg, req, api, authHeaders, git, gitPublish, gitSync, NAME_RE, okTunnel };
