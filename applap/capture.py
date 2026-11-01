# إضافة mitmproxy: تسجّل كل طلب يمر من التطبيق، وتصنّف روابط البث.
import json, re, time
from mitmproxy import http

OUT = '/tmp/lab/flows.jsonl'
STREAM_PATH = re.compile(r'\.(m3u8|mpd|f4m|ism/manifest|isml?/manifest)(/|\?|$)', re.I)
STREAM_CT = ('mpegurl', 'dash+xml', 'vnd.ms-sstr')
VIDEO_PATH = re.compile(r'\.(mp4|mkv|webm|flv|mov|m4v|mp3|m4a)(\?|$)', re.I)
SEGMENT_PATH = re.compile(r'\.(ts|m4s|cmfv|cmfa|aac)(\?|$)', re.I)
SEGMENT_CT = ('mp2t', 'iso.segment')


def classify(flow: http.HTTPFlow) -> str:
    path = flow.request.path.split('?')[0].lower()
    ct = (flow.response.headers.get('content-type', '') if flow.response else '').lower()
    if STREAM_PATH.search(flow.request.path) or any(x in ct for x in STREAM_CT):
        return 'stream'
    # روابط بدون امتداد: نفحص بداية المحتوى لو صغير
    try:
        body = flow.response.content if flow.response else b''
        if body and len(body) < 2_000_000:
            head = body[:400].lstrip()
            if head.startswith(b'#EXTM3U') or b'<MPD' in head:
                return 'stream'
    except Exception:
        pass
    if SEGMENT_PATH.search(path) or any(x in ct for x in SEGMENT_CT):
        return 'segment'
    if VIDEO_PATH.search(path) or ct.startswith('video/') or ct.startswith('audio/'):
        return 'video'
    return 'other'


def response(flow: http.HTTPFlow) -> None:
    try:
        req = flow.request
        rec = {
            't': int(time.time()),
            'kind': classify(flow),
            'method': req.method,
            'status': flow.response.status_code if flow.response else 0,
            'url': req.pretty_url,
            'host': req.pretty_host,
            'ct': flow.response.headers.get('content-type', '') if flow.response else '',
            'headers': {k: v for k, v in req.headers.items()},
        }
        with open(OUT, 'a', encoding='utf-8') as f:
            f.write(json.dumps(rec, ensure_ascii=False) + '\n')
    except Exception:
        pass
