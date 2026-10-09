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

export default async function handler(req) {
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
