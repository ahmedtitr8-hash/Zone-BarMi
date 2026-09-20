// Worker خاص بمشروع Zone-BarMi فقط — منفصل تمامًا عن أي مشروع ثاني (بلا أي علاقة بميلان).
// وظيفته الوحيدة: رابط ثابت للأبد يعيد توجيه/بث البث الحالي لجلسة GitHub Actions الشغّالة.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

// رابط صفحة GitHub Pages الثابتة تبع Zone-BarMi (فيها current-stream.json يتحدّث تلقائيًا)
const STATUS_URL = "https://ahmedtitr8-hash.github.io/Zone-BarMi/current-stream.json";

export default {
  async fetch(req) {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const reqUrl = new URL(req.url);
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

    const targetUrl = wantsMultiQuality ? multiQualityUrl : `${panelUrl}/live/${slot}/stream.m3u8`;

    let upstream;
    try {
      upstream = await fetch(targetUrl, { redirect: "follow" });
    } catch (e) {
      return new Response(`تعذّر الوصول للجلسة الحالية: ${e}`, { status: 502, headers: CORS_HEADERS });
    }

    if (!upstream.ok) {
      return new Response(`السيرفر الحالي رجّع خطأ: ${upstream.status}`, {
        status: upstream.status,
        headers: CORS_HEADERS,
      });
    }

    const contentType = upstream.headers.get("content-type") || "application/vnd.apple.mpegurl";

    // لو مانيفست HLS، لازم نعيد كتابة الروابط الداخلية (المقاطع) عشان تشير لنفس السيرفر
    // المؤقت الحالي (Zone-BarMi tunnel) مباشرة، مو لهذا الـ Worker (ما نعقّدها بإعادة بث كل مقطع)
    if (contentType.includes("mpegurl") || targetUrl.endsWith(".m3u8")) {
      const text = await upstream.text();
      const base = targetUrl.replace(/\/[^/]*$/, "/");
      const rewritten = text
        .split("\n")
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) return line;
          try {
            return new URL(trimmed, base).toString();
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

    return new Response(upstream.body, {
      headers: { ...CORS_HEADERS, "Content-Type": contentType, "Cache-Control": "no-store" },
    });
  },
};
