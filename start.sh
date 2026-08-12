#!/data/data/com.termux/files/usr/bin/bash
# يشغّل سيرفر التسجيل + تونيل ngrok مع بعض بأمر وحد: ./start.sh
set -e
cd "$(dirname "$0")"

# يقرأ NGROK_DOMAIN و PORT من .env
export $(grep -v '^#' .env | grep -v '^$' | xargs)

if [ -z "$NGROK_DOMAIN" ] || [ "$NGROK_DOMAIN" = "your-name-123.ngrok-free.app" ]; then
  echo "⚠️  حط دومين ngrok الحقيقي حقك بـ NGROK_DOMAIN داخل .env قبل التشغيل"
  exit 1
fi

echo "🚀 تشغيل السيرفر..."
node server.js &
SERVER_PID=$!

cleanup() {
  echo "⏹ إيقاف السيرفر..."
  kill "$SERVER_PID" 2>/dev/null
}
trap cleanup EXIT

sleep 2
echo "🌐 تشغيل تونيل ngrok على ${NGROK_DOMAIN}..."
ngrok http --url="$NGROK_DOMAIN" "${PORT:-3000}"
