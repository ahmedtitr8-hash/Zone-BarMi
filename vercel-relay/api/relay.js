// Vercel Edge Function — تمرير HLS (m3u8) مع Referer/Origin مخصص، بدون FFmpeg ولا تخزين.
// الاستخدام: https://<مشروعك>.vercel.app/relay?url=<رابط المصدر>&ref=<الـ Referer>[&delay=20]
// كل رابط داخل القوائم (جودات/صوتيات/مقاطع/مفاتيح) يُعاد كتابته ليمر من هنا بنفس الـ Referer.
export const config = { runtime: 'edge' };

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

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  const reqUrl = new URL(req.url);
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
