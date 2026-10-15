// فحص روابط HLS المتعددة (master.m3u8): يطلع الجودات (variants) ومسارات الصوت المنفصلة.
// بعدها السيرفر يبني master مبسّط (جودة وحدة + صوتها، أو كل الجودات) يقرأه ffmpeg من /internal/hls/...
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';

function attrsOf(line) {
  const o = {};
  const body = line.replace(/^#EXT[^:]*:/, '');
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(body))) o[m[1]] = m[2].replace(/^"|"$/g, '');
  return o;
}

async function fetchText(url, headers = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, redirect: 'follow', signal: ctl.signal });
    if (!r.ok) throw new Error(`المصدر رجّع ${r.status}`);
    return { text: await r.text(), finalUrl: r.url || url };
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'المصدر ما رد (15 ثانية)' : `تعذّر جلب الرابط: ${e.message}`);
  } finally { clearTimeout(t); }
}

/** يحلل master. isMaster=false لو الرابط قائمة جودة وحدة (مقاطع). */
function parseMaster(text, base) {
  const lines = String(text).replace(/\r/g, '').split('\n').map((l) => l.trim());
  if (!lines[0] || !lines[0].startsWith('#EXTM3U')) throw new Error('الرابط مو m3u8 صالح');
  const abs = (u) => new URL(u, base).toString();
  const variants = [];
  const audios = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('#EXT-X-STREAM-INF:')) {
      const a = attrsOf(l);
      let j = i + 1;
      while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
      if (j >= lines.length) continue;
      const codecs = a.CODECS || '';
      if (codecs && !/avc|hvc|hev|vp0?9|av01|mp4v|mpeg/i.test(codecs)) continue; // قائمة صوت فقط
      const res = a.RESOLUTION || '';
      const height = parseInt((res.split('x')[1] || '0'), 10) || 0;
      variants.push({
        idx: variants.length, uri: abs(lines[j]), bandwidth: parseInt(a.BANDWIDTH, 10) || 0,
        resolution: res, height, codecs, audio: a.AUDIO || null,
      });
    } else if (l.startsWith('#EXT-X-MEDIA:')) {
      const a = attrsOf(l);
      if (a.TYPE !== 'AUDIO' || !a.URI) continue; // بدون URI = الصوت مدمج بالجودة
      audios.push({
        idx: audios.length, group: a['GROUP-ID'] || '', name: a.NAME || '', lang: a.LANGUAGE || '',
        default: a.DEFAULT === 'YES', uri: abs(a.URI),
      });
    }
  }
  return { isMaster: variants.length > 0, variants, audios };
}

const q = (s) => String(s || '').replace(/"/g, '').replace(/[\r\n]/g, ' ');

/** master مبسّط. mode: 'all' (كل شي) | 'variant' (جودة وحدة + صوت اختياري). */
function buildSimpleMaster(info, mode, vIdx, aIdx) {
  const vs = mode === 'all' ? info.variants : [info.variants[vIdx]];
  let as = [];
  if (mode === 'all') as = info.audios;
  else if (aIdx !== null && aIdx !== undefined && info.audios[aIdx]) as = [info.audios[aIdx]];
  let o = '#EXTM3U\n';
  as.forEach((a, k) => {
    o += `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="${q(a.name || 'audio' + k)}"` +
      `${a.lang ? `,LANGUAGE="${q(a.lang)}"` : ''},DEFAULT=${k === 0 ? 'YES' : 'NO'},AUTOSELECT=YES,URI="${a.uri}"\n`;
  });
  vs.forEach((v) => {
    o += `#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth || 1000000}${v.resolution ? `,RESOLUTION=${v.resolution}` : ''}` +
      `${as.length ? ',AUDIO="a"' : ''}\n${v.uri}\n`;
  });
  return o;
}

module.exports = { fetchText, parseMaster, buildSimpleMaster, UA };
