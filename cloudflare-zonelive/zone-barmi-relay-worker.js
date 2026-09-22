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
async function proxyResource(targetUrl, relayBase) {
  let upstream;
  try {
    upstream = await fetch(targetUrl.toString(), {
      headers: {
        "User-Agent": "VLC/3.0.20 LibVLC/3.0.20",
        "Referer": `${targetUrl.protocol}//${targetUrl.host}/`,
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
    const text = new TextDecoder("utf-8").decode(combined);

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
              return `URI="${relayBase}?url=${encodeURIComponent(abs)}"`;
            } catch {
              return _m;
            }
          });
        }
        // سطر رابط عادي (قائمة جودة فرعية أو مقطع .ts) — يتحوّل لرابط مطلق ثم يمر بنفس الـWorker
        try {
          const abs = new URL(trimmed, targetUrl).toString();
          return `${relayBase}?url=${encodeURIComponent(abs)}`;
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
      "Content-Type": upstream.headers.get("content-type") || "video/mp2t",
      "Cache-Control": "no-store",
    },
  });
}

export default {
  async fetch(req) {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const reqUrl = new URL(req.url);
    const relayBase = `${reqUrl.origin}/relay`;

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
      return proxyResource(target, relayBase);
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
    return proxyResource(targetUrl, relayBase);
  },
};
