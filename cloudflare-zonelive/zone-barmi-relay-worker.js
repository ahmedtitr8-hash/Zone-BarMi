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
  async fetch(req) {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

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
