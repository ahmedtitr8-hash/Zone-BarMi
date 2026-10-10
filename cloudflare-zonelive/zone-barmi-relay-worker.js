// Worker خاص بمشروع Zone-BarMi فقط — منفصل تمامًا عن أي مشروع ثاني (بلا أي علاقة بميلان).
// وظيفته: رابط ثابت للأبد يعيد توجيه/بث البث الحالي لجلسة GitHub Actions الشغّالة.
//
// ⚠️ تحديث مهم (دعم CORS كامل بكل مستوى، مو بس بالمانيفست الأول): النسخة القديمة كانت
// تضيف هيدرات CORS للمانيفست الأول بس، وتحوّل روابط الجودات/المقاطع جواه لروابط مطلقة
// تشير مباشرة للمصدر الأصلي (النفق المؤقت trycloudflare مثلاً) — وهذا المصدر ما يرجّع
// هيدرات CORS إطلاقًا. النتيجة: المتصفح يرفض تحميل المقاطع بصمت رغم إن المانيفست نفسه نجح،
// خصوصًا مع تعدد الجودات (master.m3u8 يشاور على قوائم فرعية، وكل وحدة فيها تشاور على
// مقاطعها الخاصة — لازم كل مستوى يمر عبر هذا الـWorker نفسه، مو مرة وحدة بالسطح فقط).
// الحل: أي رابط داخل أي مانيفست (رئيسي أو فرعي) يُعاد كتابته ليرجع لنفس هذا الـWorker
// (عبر /relay?url=...) بدل ما يشاور للمصدر مباشرة — فيصير كل مستوى، مهما كان عميق،
// يمر من هنا ويحصل على نفس هيدرات CORS.

const SHAKA_VERSION = "5.2.12"; // مثبّت — لا تغيّره بدون تجربة

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

// رابط صفحة GitHub Pages الثابتة تبع Zone-BarMi (فيها current-stream.json يتحدّث تلقائيًا)
const STATUS_URL = "https://ahmedtitr8-hash.github.io/Zone-BarMi/current-stream.json";

// يجلب أي رابط (مانيفست أو مقطع) ويعيد بثّه — يكتشف نوع الرد من محتواه الفعلي (أول بايتات)
// لا من امتداد الرابط، ويعيد كتابة أي رابط داخلي (بأي عمق: رئيسي ← فرعي ← مقطع) ليمر
// عبر نفس هذا الـWorker (relayBase) — بهالشكل كل مستوى، مهما كان عميق، يحصل على CORS.
// تأخير أمان: يشيل آخر مقاطع من قوائم البث الحي (مجموع مدتها >= delaySec) فالمشغّل يبدأ ورا الحافة
// بمخزون أكبر، وأي بطء بالنفق/الشبكة ما يوقف البث. يشتغل على قوائم المقاطع فقط (مو master) ومو على VOD.
// الاستخدام: أضف ?delay=20 لرابط البث (ثواني، من 0 إلى 120).
function delayOf(reqUrl) {
  const d = parseFloat(reqUrl.searchParams.get("delay"));
  return d > 0 ? Math.min(Math.round(d), 120) : 0;
}

function trimLiveDelay(text, delaySec) {
  if (!(delaySec > 0) || !text.includes("#EXTINF") || text.includes("#EXT-X-ENDLIST")) return text;
  const lines = text.split("\n");
  const durOf = (l) => parseFloat(l.slice(8)) || 0; // "#EXTINF:6.000,"
  let removed = 0;
  let segs = lines.filter((l) => l.startsWith("#EXTINF")).length;
  while (segs > 3 && removed < delaySec) {
    let k = -1;
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].startsWith("#EXTINF")) { k = i; break; }
    if (k < 0) break;
    let start = k;
    while (start > 0 && /^#EXT-X-(DISCONTINUITY|PROGRAM-DATE-TIME)/.test(lines[start - 1])) start--;
    removed += durOf(lines[k]);
    lines.splice(start);
    segs--;
  }
  return lines.join("\n").replace(/\s*$/, "\n");
}

// ref (اختياري): Referer/Origin مخصص يُرسل للمصدر (بعض المصادر ترفض بدون موقع معيّن) — يتكرر على كل رابط مُعاد كتابته
async function proxyResource(targetUrl, relayBase, delaySec = 0, ref = "") {
  const dq = (delaySec > 0 ? `&delay=${delaySec}` : "") + (ref ? `&ref=${encodeURIComponent(ref)}` : "");
  let upstream;
  try {
    upstream = await fetch(targetUrl.toString(), {
      headers: {
        "User-Agent": ref ? "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36" : "VLC/3.0.20 LibVLC/3.0.20",
        "Referer": ref || `${targetUrl.protocol}//${targetUrl.host}/`,
        ...(ref ? { "Origin": new URL(ref).origin } : {}),
      },
      redirect: "follow",
    });
  } catch (e) {
    return new Response(`تعذّر الوصول للمصدر: ${e}`, { status: 502, headers: CORS_HEADERS });
  }

  if (!upstream.ok) {
    return new Response(`المصدر رجّع خطأ: ${upstream.status}`, {
      status: upstream.status,
      headers: CORS_HEADERS,
    });
  }

  const reader = upstream.body?.getReader();
  if (!reader) {
    return new Response("رد المصدر بلا محتوى قابل للقراءة", { status: 502, headers: CORS_HEADERS });
  }
  const { value: firstChunk, done: firstDone } = await reader.read();
  const headSnippet = firstChunk
    ? new TextDecoder("utf-8", { fatal: false }).decode(firstChunk.slice(0, 64))
    : "";
  const isManifest = headSnippet.trimStart().startsWith("#EXTM3U");

  if (isManifest) {
    // مانيفست (رئيسي أو فرعي، ما يهم أي مستوى) — نص صغير، نجمعه كامل ونعيد كتابة روابطه
    const chunks = firstChunk ? [firstChunk] : [];
    if (!firstDone) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    }
    let totalLen = 0;
    for (const c of chunks) totalLen += c.length;
    const combined = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of chunks) { combined.set(c, offset); offset += c.length; }
    const text = trimLiveDelay(new TextDecoder("utf-8").decode(combined), delaySec);

    const rewritten = text
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return line;
        if (trimmed.startsWith("#")) {
          // أسطر الوصف (مثل EXT-X-KEY لمفاتيح التشفير) قد تحمل رابطًا داخل URI="..."
          return line.replace(/URI="([^"]+)"/i, (_m, uri) => {
            try {
              const abs = new URL(uri, targetUrl).toString();
              return `URI="${relayBase}?url=${encodeURIComponent(abs)}${dq}"`;
            } catch {
              return _m;
            }
          });
        }
        // سطر رابط عادي (قائمة جودة فرعية أو مقطع .ts) — يتحوّل لرابط مطلق ثم يمر بنفس الـWorker
        try {
          const abs = new URL(trimmed, targetUrl).toString();
          return `${relayBase}?url=${encodeURIComponent(abs)}${dq}`;
        } catch {
          return line;
        }
      })
      .join("\n");

    return new Response(rewritten, {
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-store",
      },
    });
  }

  // مقطع فيديو خام (.ts وغيره) — يُمرَّر كتدفق حقيقي بلا تجميع بالذاكرة
  const stream = new ReadableStream({
    async start(controller) {
      try {
        if (firstChunk) controller.enqueue(firstChunk);
        if (!firstDone) {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
    cancel() {
      try { reader.cancel(); } catch (_e) { /* ignore */ }
    },
  });

  return new Response(stream, {
    status: upstream.status,
    headers: {
      ...CORS_HEADERS,
      // بعض المصادر تخفي المقاطع بامتداد/نوع css — نصحّح النوع عشان المشغّل ما يرفضها
      "Content-Type": (() => {
        const ct = upstream.headers.get("content-type") || "";
        return !ct || /css|html|text\/plain/i.test(ct) ? "video/mp2t" : ct;
      })(),
      "Cache-Control": "no-store",
    },
  });
}


// ==================== دعم MPD (DASH) — بروكسي فقط، بدون ffmpeg ولا إعادة بث ====================
// /dash?url=<رابط mpd>  → يجيب المانيفست ويعيد كتابة مسارات المقاطع لتمر عبر هذا الـWorker
// /p/<token>/<مسار>     → يجيب المقطع من المصدر ويمرّره (يدعم Range)
// /player               → صفحة مشغّل (Shaka) تفك ClearKey بالمتصفح من kid:key
// المانيفست الحي (dynamic) يُجلب من جديد مع كل تحديث لأن اللاعب يطلبه من /dash كل مرة.

const UPSTREAM_HEADERS = (u) => ({
  "User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36",
  "Referer": `${u.protocol}//${u.host}/`,
});

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(tok) {
  const b64 = tok.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((tok.length + 3) % 4);
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// يبني بادئة بروكسي لمجلد أصلي: {origin}/p/<token>/  (التوكن يحمل المجلد الأصلي + أي query لازم يتكرر)
function proxyPrefix(origin, baseUrl, query) {
  return `${origin}/p/${b64urlEncode(JSON.stringify({ b: baseUrl, q: query || "" }))}/`;
}

function escapeXml(s) {
  return s.replace(/&/g, "&amp;");
}
function unescapeXml(s) {
  return s.replace(/&amp;/g, "&");
}

// يعيد كتابة الـMPD: كل رابط مقطع (نسبي أو مطلق) يمر عبر الـWorker
function rewriteMpd(xml, mpdUrl, origin) {
  const mpd = new URL(mpdUrl);
  const query = mpd.search ? mpd.search.slice(1) : ""; // توكن الـmpd يتكرر على المقاطع
  const dirOf = (u) => u.slice(0, u.lastIndexOf("/") + 1);
  const mpdDir = dirOf(mpd.origin + mpd.pathname);

  // 1) روابط مطلقة داخل الخصائص: media / initialization / sourceURL / index / BaseURL
  const absAttr = /\b(media|initialization|sourceURL|index)="(https?:\/\/[^"]+)"/g;
  xml = xml.replace(absAttr, (_m, attr, val) => {
    const full = unescapeXml(val);
    const cut = full.lastIndexOf("/") + 1;
    return `${attr}="${escapeXml(proxyPrefix(origin, full.slice(0, cut), query) + full.slice(cut))}"`;
  });

  // 2) عناصر BaseURL
  const firstPeriod = xml.search(/<Period[\s>]/);
  xml = xml.replace(/<BaseURL([^>]*)>([^<]*)<\/BaseURL>/g, (m, attrs, val, offset) => {
    const v = unescapeXml(val.trim());
    const isTop = firstPeriod === -1 || offset < firstPeriod;
    if (/^https?:\/\//i.test(v)) {
      const cut = v.lastIndexOf("/") + 1;
      return `<BaseURL${attrs}>${escapeXml(proxyPrefix(origin, v.slice(0, cut), query) + v.slice(cut))}</BaseURL>`;
    }
    if (isTop) {
      // BaseURL نسبي على مستوى الـMPD → نحلّه نسبةً لموقع الـmpd الأصلي
      const abs = new URL(v, mpdDir).toString();
      return `<BaseURL${attrs}>${escapeXml(proxyPrefix(origin, abs.endsWith("/") ? abs : dirOf(abs), query))}</BaseURL>`;
    }
    return m; // نسبي بمستوى أعمق: يبقى نسبي ويتحل فوق BaseURL الأعلى (اللي صار عندنا)
  });

  // 3) لو ما فيه BaseURL بالمستوى الأعلى → نضيف واحد يشاور على مجلد الـmpd عبر الـWorker
  const hasTopBase = (() => {
    const fp = xml.search(/<Period[\s>]/);
    const head = fp === -1 ? xml : xml.slice(0, fp);
    return /<BaseURL[\s>]/.test(head);
  })();
  if (!hasTopBase) {
    xml = xml.replace(/(<MPD\b[^>]*>)/, `$1<BaseURL>${escapeXml(proxyPrefix(origin, mpdDir, query))}</BaseURL>`);
  }
  return xml;
}

// ==================== ClearKey مدمج بالـ MPD (تمرير مباشر بدون إعادة بث) ====================
// /dash?url=<mpd>&k=kid:key&k=kid2:key2  → نفس الـ MPD بكل جوداته وصوتياته، مساراته تمر من الـWorker،
// ومعه إشارة ClearKey + رابط ترخيص (/license) يرجّع المفاتيح — فأي مشغّل DASH يدعم ClearKey
// (Shaka, dash.js, Kodi...) يفك التشفير بنفسه. الـWorker ما يفك ولا يعيد ترميز شي.
const CLEARKEY_UUID = "urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e";
const HEX32 = /^[0-9a-f]{32}$/;

function parseKeyParams(params) {
  const keys = [];
  for (const raw of params.getAll("k")) {
    for (const line of raw.split(/[\r\n,;]+/)) {
      const t = line.trim();
      if (!t) continue;
      const [kid, key, ...rest] = t.split(/[\s:]+/).map((x) => x.replace(/-/g, "").toLowerCase());
      if (rest.length || !HEX32.test(kid || "") || !HEX32.test(key || "")) {
        throw new Error("مفتاح غير صالح — الصيغة kid:key (كل واحد 32 hex)");
      }
      keys.push({ kid, key });
    }
  }
  return keys;
}

function hexToB64url(hex) {
  let bin = "";
  for (let i = 0; i < hex.length; i += 2) bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// يضيف عنصر ClearKey (مع رابط الترخيص) لكل AdaptationSet
function injectClearKey(xml, origin, keys) {
  const licUrl = `${origin}/license?` + keys.map((k) => "k=" + encodeURIComponent(`${k.kid}:${k.key}`)).join("&");
  const cp =
    `<ContentProtection schemeIdUri="${CLEARKEY_UUID}" value="ClearKey1.0">` +
    `<clearkey:Laurl Lic_type="EME-1.0">${escapeXml(licUrl)}</clearkey:Laurl></ContentProtection>`;
  if (!/xmlns:clearkey=/.test(xml)) {
    xml = xml.replace(/<MPD\b/, '<MPD xmlns:clearkey="http://dashif.org/guidelines/clearKey"');
  }
  return xml.replace(/<AdaptationSet\b[^>]*[^/]>/g, (tag) => tag + cp);
}

function handleLicense(req, reqUrl, bodyText) {
  let keys;
  try { keys = parseKeyParams(reqUrl.searchParams); } catch (e) {
    return new Response(String(e.message), { status: 400, headers: CORS_HEADERS });
  }
  const body = JSON.stringify({
    keys: keys.map((k) => ({ kty: "oct", kid: hexToB64url(k.kid), k: hexToB64url(k.key) })),
    type: "temporary",
  });
  return new Response(body, { headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

async function handleDash(reqUrl) {
  const mpdUrlStr = reqUrl.searchParams.get("url");
  let mpdUrl;
  try { mpdUrl = new URL(mpdUrlStr); } catch {
    return new Response("رابط mpd غير صالح", { status: 400, headers: CORS_HEADERS });
  }
  let upstream;
  try {
    upstream = await fetch(mpdUrl.toString(), { headers: UPSTREAM_HEADERS(mpdUrl), redirect: "follow" });
  } catch (e) {
    return new Response(`تعذّر الوصول للمصدر: ${e}`, { status: 502, headers: CORS_HEADERS });
  }
  if (!upstream.ok) {
    return new Response(`المصدر رجّع خطأ: ${upstream.status}`, { status: upstream.status, headers: CORS_HEADERS });
  }
  const text = await upstream.text();
  if (!/<MPD[\s>]/.test(text)) {
    return new Response("الرد مو ملف MPD صالح", { status: 502, headers: CORS_HEADERS });
  }
  // لو صار redirect، نعتمد الرابط النهائي كأساس للمسارات النسبية
  const finalUrl = upstream.url || mpdUrl.toString();
  const out = rewriteMpd(text, finalUrl.includes("?") || !mpdUrl.search ? finalUrl : finalUrl + mpdUrl.search, reqUrl.origin);
  let keys;
  try { keys = parseKeyParams(reqUrl.searchParams); } catch (e) {
    return new Response(String(e.message), { status: 400, headers: CORS_HEADERS });
  }
  const finalOut = keys.length ? injectClearKey(out, reqUrl.origin, keys) : out;
  return new Response(finalOut, {
    headers: { ...CORS_HEADERS, "Content-Type": "application/dash+xml", "Cache-Control": "no-store" },
  });
}

async function handleSegment(req, reqUrl) {
  const m = reqUrl.pathname.match(/^\/p\/([^/]+)\/(.*)$/);
  if (!m) return new Response("مسار غير صالح", { status: 400, headers: CORS_HEADERS });
  let info;
  try { info = JSON.parse(b64urlDecode(m[1])); } catch {
    return new Response("توكن غير صالح", { status: 400, headers: CORS_HEADERS });
  }
  let target;
  try {
    target = new URL(m[2] + reqUrl.search, info.b);
    if (info.q && !target.search.includes(info.q)) {
      target.search = target.search ? `${target.search}&${info.q}` : `?${info.q}`;
    }
  } catch {
    return new Response("رابط مقطع غير صالح", { status: 400, headers: CORS_HEADERS });
  }
  const headers = UPSTREAM_HEADERS(target);
  const range = req.headers.get("Range");
  if (range) headers["Range"] = range;
  let upstream;
  try {
    upstream = await fetch(target.toString(), { headers, redirect: "follow" });
  } catch (e) {
    return new Response(`تعذّر الوصول للمصدر: ${e}`, { status: 502, headers: CORS_HEADERS });
  }
  const outHeaders = { ...CORS_HEADERS, "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges", "Cache-Control": "no-store" };
  for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const v = upstream.headers.get(h);
    if (v) outHeaders[h] = v;
  }
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

const PLAYER_HTML = `<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>مشغّل MPD</title>
<style>
body{background:#0b0b0e;color:#eee;font-family:system-ui,sans-serif;margin:0;padding:12px}
input,textarea{width:100%;box-sizing:border-box;background:#17171d;color:#eee;border:1px solid #333;border-radius:8px;padding:10px;margin:4px 0 10px;font-size:14px}
button{background:#ff453a;color:#fff;border:0;border-radius:8px;padding:11px 18px;font-size:15px;font-weight:700}
video{width:100%;background:#000;border-radius:10px;margin-top:12px}
#msg{color:#ff9f0a;font-size:13px;margin-top:8px;white-space:pre-wrap}
small{color:#888}
</style></head><body>
<label>رابط MPD</label>
<input id="mpd" type="url" placeholder="https://.../manifest.mpd">
<label>المفاتيح (سطر لكل مفتاح: kid:key) — اتركها فاضية لو غير مشفّر</label>
<textarea id="keys" rows="3" placeholder="kid:key"></textarea>
<button id="go">▶ تشغيل</button> <button id="copy" style="background:#333">🔗 انسخ رابط المشاهدة</button>
<div id="msg"></div>
<video id="v" controls autoplay playsinline></video>
<small>تنبيه: المفتاح يوصل لمتصفح المشاهد. لا تشارك رابط المشاهدة مع ناس ما تبيهم يشوفون المفتاح.</small>
<script src="https://cdn.jsdelivr.net/npm/shaka-player@__SHAKA__/dist/shaka-player.compiled.js"></script>
<script>
const $=id=>document.getElementById(id), msg=t=>$('msg').textContent=t||'';
let player;
function parseKeys(txt){
  const out={};
  for(const line of txt.split(/\\n+/)){
    const p=line.trim().split(':'); if(p.length<2) continue;
    const kid=p[0].replace(/[-\\s]/g,'').toLowerCase(), key=p[1].replace(/[-\\s]/g,'').toLowerCase();
    if(/^[0-9a-f]{32}$/.test(kid)&&/^[0-9a-f]{32}$/.test(key)) out[kid]=key;
    else throw new Error('مفتاح غير صالح: لازم kid و key كل واحد 32 حرف hex');
  }
  return out;
}
async function play(){
  msg('');
  try{
    const mpd=$('mpd').value.trim(); if(!mpd) return msg('حط رابط الـ MPD');
    const clearKeys=parseKeys($('keys').value);
    shaka.polyfill.installAll();
    if(!shaka.Player.isBrowserSupported()) return msg('المتصفح ما يدعم المشغّل');
    if(!player){ player=new shaka.Player(); await player.attach($('v')); player.addEventListener('error',e=>msg('خطأ '+e.detail.code+'\\n'+(e.detail.message||''))); }
    player.configure({drm:{clearKeys}});
    await player.load(location.origin+'/dash?url='+encodeURIComponent(mpd));
  }catch(e){ msg(String(e.message||e)); }
}
$('go').onclick=play;
$('copy').onclick=()=>{
  const u=new URL(location.href); u.search='';
  u.searchParams.set('mpd',$('mpd').value.trim()); if($('keys').value.trim()) u.searchParams.set('k',$('keys').value.trim());
  navigator.clipboard.writeText(u.toString()).then(()=>msg('اننسخ الرابط'));
};
const q=new URLSearchParams(location.search);
if(q.get('mpd')){ $('mpd').value=q.get('mpd'); $('keys').value=q.get('k')||''; play(); }
</script></body></html>`;

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }
    // روابط الريلاي (كانت على Vercel): /relay و /live/* و /mh/*  — كلها تشتغل هنا مباشرة بدون أي نفق أو أكشن
    const routed = await RelayCore.route(req, env);
    if (routed) return routed;

    const reqUrl = new URL(req.url);
    const relayBase = `${reqUrl.origin}/relay`;

    // ===== مسارات MPD (جديدة) =====
    if (reqUrl.pathname === "/dash") return handleDash(reqUrl);
    if (reqUrl.pathname === "/license") return handleLicense(req, reqUrl);
    if (reqUrl.pathname.startsWith("/p/")) return handleSegment(req, reqUrl);
    if (reqUrl.pathname === "/player") {
      return new Response(PLAYER_HTML.replace("__SHAKA__", SHAKA_VERSION), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    // نقطة الدخول العامة: أي رابط (مانيفست فرعي أو مقطع) مُعاد كتابته من proxyResource
    // يرجع هنا دايمًا، بغض النظر عن عمقه (فرعي داخل فرعي داخل رئيسي... إلخ)
    const directUrl = reqUrl.searchParams.get("url");
    if (directUrl) {
      let target;
      try {
        target = new URL(directUrl);
      } catch {
        return new Response("رابط غير صالح", { status: 400, headers: CORS_HEADERS });
      }
      let ref = (reqUrl.searchParams.get("ref") || "").trim();
      try { if (ref) new URL(ref); } catch { ref = ""; }
      return proxyResource(target, relayBase, delayOf(reqUrl), ref);
    }

    // اسم البث ياخذه من مسار الرابط: /اسم_البث (نفس الاسم اللي حطيته بصفحة إعادة البث)
    // ولو الجزء الثاني من المسار "master.m3u8"، معناها طالب رابط تعدد الجودات الثابت
    // بدل الجودة الأصلية بس — مثال: /Bein1/master.m3u8
    const parts = reqUrl.pathname.replace(/^\/+/, "").split("/");
    const slot = parts[0];
    const wantsMultiQuality = parts[1] === "master.m3u8";
    if (!slot) {
      return new Response(
        "حط اسم البث بآخر الرابط، مثال:\nhttps://zone-barmi-relay.ahmedtitr8.workers.dev/match1\nأو تعدد الجودات: .../match1/master.m3u8",
        { status: 400, headers: CORS_HEADERS }
      );
    }

    let panelUrl, multiQualityUrl;
    try {
      const statusRes = await fetch(STATUS_URL, { cf: { cacheTtl: 0 } });
      if (!statusRes.ok) throw new Error("no-session-file");
      const status = await statusRes.json();
      const ageMinutes = (Date.now() - new Date(status.startedAt).getTime()) / 60000;
      if (ageMinutes > 360) throw new Error("session-too-old");
      panelUrl = status.panelUrl;
      multiQualityUrl = status.multiQuality && status.multiQuality[slot];
    } catch (e) {
      return new Response(
        "ما فيه جلسة أكشن شغّالة حالياً. شغّل الـ Action من GitHub أول.",
        { status: 503, headers: CORS_HEADERS }
      );
    }

    if (wantsMultiQuality && !multiQualityUrl) {
      return new Response(
        "ما فيه تعدد جودات شغّال حالياً لهذا البث (لازم تفعّله لحظة بدء البث باللوحة).",
        { status: 404, headers: CORS_HEADERS }
      );
    }

    const targetUrl = new URL(wantsMultiQuality ? multiQualityUrl : `${panelUrl}/live/${slot}/stream.m3u8`);
    return proxyResource(targetUrl, relayBase, delayOf(reqUrl));
  },
};

// ==================== نقل ريلاي Vercel إلى الـWorker (نفس الكود، نفس الروابط) ====================
const RelayCore = (() => {
// ---- 1) تمرير HLS (من relay.js) ----
// Vercel Edge Function — تمرير HLS (m3u8) مع Referer/Origin مخصص، بدون FFmpeg ولا تخزين.
// الاستخدام: https://<مشروعك>.vercel.app/relay?url=<رابط المصدر>&ref=<الـ Referer>[&delay=20]
// كل رابط داخل القوائم (جودات/صوتيات/مقاطع/مفاتيح) يُعاد كتابته ليمر من هنا بنفس الـ Referer.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};


// يجلب أي رابط (مانيفست أو مقطع) ويعيد بثّه — يكتشف نوع الرد من محتواه الفعلي (أول بايتات)
// لا من امتداد الرابط، ويعيد كتابة أي رابط داخلي (بأي عمق: رئيسي ← فرعي ← مقطع) ليمر
// عبر نفس هذا الـWorker (relayBase) — بهالشكل كل مستوى، مهما كان عميق، يحصل على CORS.
// تأخير أمان: يشيل آخر مقاطع من قوائم البث الحي (مجموع مدتها >= delaySec) فالمشغّل يبدأ ورا الحافة
// بمخزون أكبر، وأي بطء بالنفق/الشبكة ما يوقف البث. يشتغل على قوائم المقاطع فقط (مو master) ومو على VOD.
// الاستخدام: أضف ?delay=20 لرابط البث (ثواني، من 0 إلى 120).
function delayOf(reqUrl) {
  const d = parseFloat(reqUrl.searchParams.get("delay"));
  return d > 0 ? Math.min(Math.round(d), 120) : 0;
}

function trimLiveDelay(text, delaySec) {
  if (!(delaySec > 0) || !text.includes("#EXTINF") || text.includes("#EXT-X-ENDLIST")) return text;
  const lines = text.split("\n");
  const durOf = (l) => parseFloat(l.slice(8)) || 0; // "#EXTINF:6.000,"
  let removed = 0;
  let segs = lines.filter((l) => l.startsWith("#EXTINF")).length;
  while (segs > 3 && removed < delaySec) {
    let k = -1;
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].startsWith("#EXTINF")) { k = i; break; }
    if (k < 0) break;
    let start = k;
    while (start > 0 && /^#EXT-X-(DISCONTINUITY|PROGRAM-DATE-TIME)/.test(lines[start - 1])) start--;
    removed += durOf(lines[k]);
    lines.splice(start);
    segs--;
  }
  return lines.join("\n").replace(/\s*$/, "\n");
}

// ref (اختياري): Referer/Origin مخصص يُرسل للمصدر (بعض المصادر ترفض بدون موقع معيّن) — يتكرر على كل رابط مُعاد كتابته
async function proxyResource(targetUrl, relayBase, delaySec = 0, ref = "") {
  const dq = (delaySec > 0 ? `&delay=${delaySec}` : "") + (ref ? `&ref=${encodeURIComponent(ref)}` : "");
  let upstream;
  try {
    upstream = await fetch(targetUrl.toString(), {
      headers: {
        "User-Agent": ref ? "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36" : "VLC/3.0.20 LibVLC/3.0.20",
        "Referer": ref || `${targetUrl.protocol}//${targetUrl.host}/`,
        ...(ref ? { "Origin": new URL(ref).origin } : {}),
      },
      redirect: "follow",
    });
  } catch (e) {
    return new Response(`تعذّر الوصول للمصدر: ${e}`, { status: 502, headers: CORS_HEADERS });
  }

  if (!upstream.ok) {
    return new Response(`المصدر رجّع خطأ: ${upstream.status}`, {
      status: upstream.status,
      headers: CORS_HEADERS,
    });
  }

  const reader = upstream.body?.getReader();
  if (!reader) {
    return new Response("رد المصدر بلا محتوى قابل للقراءة", { status: 502, headers: CORS_HEADERS });
  }
  const { value: firstChunk, done: firstDone } = await reader.read();
  const headSnippet = firstChunk
    ? new TextDecoder("utf-8", { fatal: false }).decode(firstChunk.slice(0, 64))
    : "";
  const isManifest = headSnippet.trimStart().startsWith("#EXTM3U");

  if (isManifest) {
    // مانيفست (رئيسي أو فرعي، ما يهم أي مستوى) — نص صغير، نجمعه كامل ونعيد كتابة روابطه
    const chunks = firstChunk ? [firstChunk] : [];
    if (!firstDone) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    }
    let totalLen = 0;
    for (const c of chunks) totalLen += c.length;
    const combined = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of chunks) { combined.set(c, offset); offset += c.length; }
    const text = trimLiveDelay(new TextDecoder("utf-8").decode(combined), delaySec);

    const rewritten = text
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return line;
        if (trimmed.startsWith("#")) {
          // أسطر الوصف (مثل EXT-X-KEY لمفاتيح التشفير) قد تحمل رابطًا داخل URI="..."
          return line.replace(/URI="([^"]+)"/i, (_m, uri) => {
            try {
              const abs = new URL(uri, targetUrl).toString();
              return `URI="${relayBase}?url=${encodeURIComponent(abs)}${dq}"`;
            } catch {
              return _m;
            }
          });
        }
        // سطر رابط عادي (قائمة جودة فرعية أو مقطع .ts) — يتحوّل لرابط مطلق ثم يمر بنفس الـWorker
        try {
          const abs = new URL(trimmed, targetUrl).toString();
          return `${relayBase}?url=${encodeURIComponent(abs)}${dq}`;
        } catch {
          return line;
        }
      })
      .join("\n");

    return new Response(rewritten, {
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-store",
      },
    });
  }

  // مقطع فيديو خام (.ts وغيره) — يُمرَّر كتدفق حقيقي بلا تجميع بالذاكرة
  const stream = new ReadableStream({
    async start(controller) {
      try {
        if (firstChunk) controller.enqueue(firstChunk);
        if (!firstDone) {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
    cancel() {
      try { reader.cancel(); } catch (_e) { /* ignore */ }
    },
  });

  return new Response(stream, {
    status: upstream.status,
    headers: {
      ...CORS_HEADERS,
      // بعض المصادر تخفي المقاطع بامتداد/نوع css — نصحّح النوع عشان المشغّل ما يرفضها
      "Content-Type": (() => {
        const ct = upstream.headers.get("content-type") || "";
        return !ct || /css|html|text\/plain/i.test(ct) ? "video/mp2t" : ct;
      })(),
      "Cache-Control": "no-store",
    },
  });
}

// ===== وضع "تغيير الدومين فقط" (نفس بروكسي ترمكس) =====
// الرابط الأصلي:  https://smarter.majedcss.site/live/ch2/<توكن>/master.css
// رابطك الجديد:   https://<دومينك>/live/ch2/<توكن>/master.css    (نفس المسار بالضبط)
// السيرفر يطلب من المصدر مع الـ Referer/Origin، ويستبدل أي رابط مطلق للمصدر بدومينك. الباقي نسبي فيشتغل لحاله.
const UP_ORIGIN = (typeof process !== 'undefined' && process.env && process.env.UP_ORIGIN) || 'https://smarter.majedcss.site';
const REF_URL = (typeof process !== 'undefined' && process.env && process.env.REF_URL) || 'https://live.xn----zmcaegc7cl3msazv.com/';

async function passThrough(req, reqUrl, path) {
  const rest = new URLSearchParams(reqUrl.searchParams);
  rest.delete('p');
  const qs = rest.toString();
  const target = new URL('/' + path + (qs ? '?' + qs : ''), UP_ORIGIN);
  const h = {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
    'Referer': REF_URL,
    'Origin': new URL(REF_URL).origin,
  };
  const range = req.headers.get('range');
  if (range) h['Range'] = range;
  let up;
  try {
    up = await fetch(target.toString(), { headers: h, redirect: 'follow' });
  } catch (e) {
    return new Response(`تعذّر الوصول للمصدر: ${e}`, { status: 502, headers: CORS_HEADERS });
  }
  if (!up.ok && up.status !== 206) {
    return new Response(`المصدر رجّع خطأ: ${up.status}`, { status: up.status, headers: CORS_HEADERS });
  }
  const reader = up.body.getReader();
  const { value: first, done } = await reader.read();
  const head = first ? new TextDecoder().decode(first.slice(0, 16)).trimStart() : '';
  if (head.startsWith('#EXTM3U')) {
    const chunks = [first];
    while (!done) {
      const r = await reader.read();
      if (r.done) break;
      chunks.push(r.value);
    }
    const text = new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
    return new Response(text.split(UP_ORIGIN).join(reqUrl.origin), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' },
    });
  }
  const out = { ...CORS_HEADERS, 'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges', 'Cache-Control': 'no-store' };
  const ct = up.headers.get('content-type') || '';
  out['Content-Type'] = !ct || /css|html|text\/plain/i.test(ct) ? 'video/mp2t' : ct;
  for (const k of ['content-length', 'content-range', 'accept-ranges']) {
    const v = up.headers.get(k);
    if (v) out[k] = v;
  }
  const stream = new ReadableStream({
    async start(c) {
      try {
        if (first) c.enqueue(first);
        while (!done) {
          const r = await reader.read();
          if (r.done) break;
          c.enqueue(r.value);
        }
        c.close();
      } catch (e) { c.error(e); }
    },
    cancel() { try { reader.cancel(); } catch (_e) {} },
  });
  return new Response(stream, { status: up.status, headers: out });
}

async function relayHandler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  const reqUrl = new URL(req.url);
  const p = reqUrl.searchParams.get('p');
  if (p !== null) return passThrough(req, reqUrl, p);
  const direct = reqUrl.searchParams.get('url');
  let target;
  try {
    target = new URL(direct || '');
    if (!/^https?:$/.test(target.protocol)) throw new Error('bad');
  } catch {
    return new Response('حط ?url=رابط_المصدر (يبدأ بـ https://)', { status: 400, headers: CORS_HEADERS });
  }
  let ref = (reqUrl.searchParams.get('ref') || '').trim();
  try { if (ref) new URL(ref); } catch { ref = ''; }
  return proxyResource(target, `${reqUrl.origin}/relay`, delayOf(reqUrl), ref);
}


// ---- 2) MPD المشفّر → HLS (من mpd2hls.js) ----
// Vercel Function (Node.js) — MPD مشفّر (ClearKey/CENC) → HLS عادي بدون تشفير، على دومينك مباشرة.
// بدون FFmpeg، بدون نفق، بدون Worker، وبدون تخزين: كل مقطع يُسحب من المصدر ويُفك تشفيره لحظتها ويرجع للمشغّل.
// الاستخدام: https://<دومينك>/mh/master.m3u8?url=<mpd>&k=kid:key[&k=...][&ref=<Referer>]
const subtle = crypto.subtle;

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': '*' };
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';
const WINDOW_SEGMENTS = 10; // آخر كم مقطع نعرضه بالقائمة الحية
const HEX32 = /^[0-9a-f]{32}$/;

const b64uEnc = (s) => Buffer.from(s, 'utf8').toString('base64url');
const b64uDec = (s) => Buffer.from(s, 'base64url').toString('utf8');
const unesc = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
const escAttr = (s) => String(s).replace(/"/g, '');

function send(status, body, headers = {}) {
  return new Response(body, { status, headers: { ...CORS, ...headers } });
}
const fail = (status, msg) => send(status, msg, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });

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
const tokenUrl = async (origin, o, env) => `${origin}/mh/s/${await seal(o, env)}/seg.mp4`;

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
  let kid = '', scheme = '';
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
      if (te > 0 && te < sinfEnd) kid = buf.subarray(te + 12, te + 28).toString('hex');
      buf.write(orig, entryStart + 4, 'latin1');
      buf.write('free', sinfStart + 4, 'latin1');
    }
  }
  stripEncInfo(buf, moov.body, moov.end);
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

async function decryptSegment(src, keyHex) {
  const buf = Buffer.from(src);
  const ctr = await subtle.importKey('raw', Buffer.from(keyHex, 'hex'), { name: 'AES-CTR' }, false, ['decrypt']);
  const ctrDec = (iv16, data) => subtle.decrypt({ name: 'AES-CTR', counter: iv16, length: 128 }, ctr, data);
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
      const entries = parseSenc(buf, senc);
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
          if (e && size > 0) {
            const iv16 = new Uint8Array(16); iv16.set(e.iv, 0);
            if (!e.subs.length) {
              buf.set(new Uint8Array(await ctrDec(iv16, buf.subarray(pos, pos + size))), pos);
            } else {
              const parts = []; let q = pos;
              for (const [clr, enc] of e.subs) { q += clr; parts.push([q, enc]); q += enc; }
              const joined = Buffer.concat(parts.map(([o, l]) => buf.subarray(o, o + l)));
              const out = new Uint8Array(await ctrDec(iv16, joined));
              let w = 0; for (const [o, l] of parts) { buf.set(out.subarray(w, w + l), o); w += l; }
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


// ===== ختم الروابط: الرابط الأصلي والمفاتيح ما تنكشف بأي رابط يطلع للمشاهد =====
// المتغير السري SEAL_SECRET (Vercel → Settings → Environment Variables). نفسه كلمة سر إنشاء الروابط.
function secretOf(env) { const v = env && env.SEAL_SECRET; if (!v || v.length < 8) throw new Error('حط SEAL_SECRET (8 حروف على الأقل) بإعدادات Worker ثم أعد النشر'); return v; }
async function aesGcmKey(env) {
  const raw = await subtle.digest('SHA-256', new TextEncoder().encode(secretOf(env)));
  return { raw: new Uint8Array(raw), key: await subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']) };
}
async function seal(obj, env) {
  const { raw, key: aes } = await aesGcmKey(env);
  const pt = new TextEncoder().encode(JSON.stringify(obj));
  const hmacKey = await subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const iv = new Uint8Array(await subtle.sign('HMAC', hmacKey, pt)).subarray(0, 12); // ثابت لنفس المحتوى → نفس الرابط
  const out = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, aes, pt)); // ct || tag
  const ct = out.subarray(0, out.length - 16), tag = out.subarray(out.length - 16);
  return Buffer.concat([iv, tag, ct]).toString('base64url');
}
async function unseal(tok, env) {
  const { key: aes } = await aesGcmKey(env);
  const raw = Buffer.from(String(tok || ''), 'base64url');
  const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), ct = raw.subarray(28);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, aes, Buffer.concat([ct, tag]));
  return JSON.parse(new TextDecoder().decode(pt));
}

async function loadMpd(url, given) {
  const mpdUrl = new URL(url);
  if (!/^https?:$/.test(mpdUrl.protocol)) throw new Error('bad');
  given = cleanRef(given);
  // لو المصدر رفض (403/401) بالـ Referer المعطى، نجرّب Referer دومين المصدر نفسه، وبعدها بدون Referer
  const tries = given ? [given, '', null] : ['', null];
  let last;
  for (const ref of tries) {
    try {
      const hdr = ref === null ? { 'User-Agent': UA } : upHeaders(mpdUrl, ref);
      const r = await fetch(mpdUrl.toString(), { headers: hdr, redirect: 'follow' });
      if (!r.ok) { const e = new Error(`المصدر رجّع ${r.status}`); e.status = r.status; throw e; }
      const xml = Buffer.from(await r.arrayBuffer()).toString('utf8');
      if (!/<MPD[\s>]/.test(xml)) throw new Error('الرد مو ملف MPD صالح');
      const u2 = r.url || mpdUrl.toString();
      const finalUrl = u2.includes('?') || !mpdUrl.search ? u2 : u2 + mpdUrl.search;
      return { parsed: parseMpd(xml, finalUrl), ref: ref || '' };
    } catch (e) { last = e; if (e.status !== 403 && e.status !== 401) break; }
  }
  throw last;
}

// ================= المسارات (Web Request/Response) =================
// يرجّع Response دايمًا. المسارات: /mh/new  ،  /mh/s/<t>/seg.mp4  ،  /mh/<t>/master.m3u8  ،  /mh/<t>/<rep>.m3u8
async function handleMpd(req, env) {
  if (req.method === 'OPTIONS') return send(204, '');
  const u = new URL(req.url);
  const sp = u.searchParams;
  const origin = u.origin;
  const parts = u.pathname.split('/').filter(Boolean); // ["mh", ...]
  if (parts[0] !== 'mh') return null;

  try { secretOf(env); } catch (e) { return fail(500, e.message); }

  let mode, T = '', repId = '';
  if (parts.length === 2 && parts[1] === 'new') mode = 'new';
  else if (parts.length === 3 && parts[1] === 's' && parts[2] === 'seg.mp4') mode = 'seg-bad';
  else if (parts.length === 4 && parts[1] === 's' && parts[3] === 'seg.mp4') { mode = 'seg'; T = parts[2]; }
  else if (parts.length === 3 && parts[2] === 'master.m3u8') { mode = 'master'; T = parts[1]; }
  else if (parts.length === 3 && parts[2].endsWith('.m3u8')) { mode = 'media'; T = parts[1]; repId = decodeURIComponent(parts[2].slice(0, -5)); }
  else return fail(404, 'مسار غير معروف');

  if (mode === 'new') {
    if (sp.get('pw') !== env.SEAL_SECRET) return fail(401, 'كلمة السر غلط');
    let keys;
    try { keys = parseKeys(sp); new URL(sp.get('url') || ''); } catch (e) { return fail(400, e.message.includes('Invalid') ? 'رابط غير صالح' : e.message); }
    const tok = await seal({ u: sp.get('url'), k: keys, r: cleanRef(sp.get('ref')) }, env);
    return send(200, `${origin}/mh/${tok}/master.m3u8`, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  }

  let tok;
  try { tok = await unseal(T, env); } catch { return fail(400, 'الرابط غير صالح أو انتهى ختمه'); }

  if (mode === 'seg') {
    try {
      new URL(tok.u);
      const ref = cleanRef(tok.r);
      const { buf } = await getBuf(tok.u, ref);
      let out = buf;
      if (tok.i) { const c = cleanInit(buf); if (c.scheme && c.scheme !== 'cenc') throw new Error(`نظام التشفير ${c.scheme} غير مدعوم (المدعوم cenc فقط)`); out = c.buf; }
      else if (tok.k) out = await decryptSegment(buf, tok.k);
      return send(200, out, { 'Content-Type': 'video/mp4', 'Content-Length': String(out.length), 'Cache-Control': 'public, max-age=30, s-maxage=30', 'X-Decrypted': tok.i ? 'init' : out.did ? '1' : '0', 'Access-Control-Expose-Headers': 'X-Decrypted' });
    } catch (e) { return fail(e.status || 502, String(e.message || e)); }
  }

  const keys = tok.k || [];
  let m;
  try { m = await loadMpd(tok.u, tok.r); } catch (e) { return fail(e.status || 400, `تعذّر جلب البث: ${e.message}`); }
  const { parsed, ref } = m;
  const M = (x) => String(x).replace(/"/g, "'");
  const repUrl = (id) => `${origin}/mh/${T}/${encodeURIComponent(id)}.m3u8`;

  if (mode === 'master') {
    const vids = parsed.reps.filter((r) => r.kind === 'video').sort((a, b) => a.bandwidth - b.bandwidth);
    const auds = parsed.reps.filter((r) => r.kind === 'audio');
    if (!vids.length) return fail(502, 'ما لقيت مسارات فيديو');
    let o = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n';
    auds.forEach((a, i) => {
      o += `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="${M(a.label || a.lang || 'audio' + (i + 1))}",${a.lang ? `LANGUAGE="${M(a.lang)}",` : ''}DEFAULT=${i === 0 ? 'YES' : 'NO'},AUTOSELECT=YES,URI="${repUrl(a.id)}"\n`;
    });
    for (const v of vids) {
      const fr = v.frameRate ? (v.frameRate.includes('/') ? v.frameRate.split('/').reduce((x, y) => x / y) : Number(v.frameRate)) : 0;
      const codecs = [v.codecs, auds[0] && auds[0].codecs].filter(Boolean).join(',');
      o += `#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth + (auds[0] ? auds[0].bandwidth : 0)}${v.width ? `,RESOLUTION=${v.width}x${v.height}` : ''}${fr ? `,FRAME-RATE=${fr.toFixed(3)}` : ''}${codecs ? `,CODECS="${codecs}"` : ''}${auds.length ? ',AUDIO="aud"' : ''}\n${repUrl(v.id)}\n`;
    }
    return send(200, o, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
  }

  if (mode === 'media') {
    const rep = parsed.reps.find((r) => String(r.id) === repId);
    if (!rep) return fail(404, 'المسار غير موجود');
    if (!rep.segs.length) return fail(501, 'هذا البث ما فيه SegmentTimeline (غير مدعوم حاليًا)');
    const initUrl = absUrl(fillTemplate(rep.tpl.initialization || '', rep.id, rep.bandwidth, 0, 0), parsed);
    let keyHex = '';
    if (keys.length) { try { keyHex = await pickKey(initUrl, keys, ref); } catch (e) { return fail(502, e.message); } }
    const start = Number(rep.tpl.startNumber || 1), ts = Number(rep.tpl.timescale || 1);
    const all = rep.segs.map((s2, i) => ({ ...s2, n: start + i }));
    const win = parsed.dynamic ? all.slice(-WINDOW_SEGMENTS) : all;
    const target = Math.ceil(Math.max(...win.map((s2) => s2.d / ts)));
    let o = `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-TARGETDURATION:${target}\n#EXT-X-MEDIA-SEQUENCE:${win[0].n}\n`;
    if (!parsed.dynamic) o += '#EXT-X-PLAYLIST-TYPE:VOD\n';
    o += `#EXT-X-MAP:URI="${await tokenUrl(origin, { u: initUrl, r: ref, i: 1 }, env)}"\n`;
    for (const s2 of win) {
      const url = absUrl(fillTemplate(rep.tpl.media, rep.id, rep.bandwidth, s2.n, s2.t), parsed);
      o += `#EXTINF:${(s2.d / ts).toFixed(3)},\n${await tokenUrl(origin, { u: url, k: keyHex, r: ref }, env)}\n`;
    }
    if (!parsed.dynamic) o += '#EXT-X-ENDLIST\n';
    return send(200, o, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
  }
  return fail(404, 'مسار غير معروف');
}


// ---- 3) التوجيه ----
return {
  async route(req, env) {
    const u = new URL(req.url);
    const p = u.pathname;
    if (p === "/relay") return relayHandler(req);
    if (p.startsWith("/live/")) return passThrough(req, u, p.slice(1));
    if (p === "/mh" || p.startsWith("/mh/")) return handleMpd(req, env);
    return null;
  },
};
})();
