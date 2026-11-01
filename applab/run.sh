#!/usr/bin/env bash
# يشتغل داخل خطوة المحاكي بعد ما يكمل الإقلاع.
set -u
L=/tmp/lab
tg() { [ -n "${TG_TOKEN:-}" ] && curl -s -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" -d chat_id="${TG_CHAT:-}" --data-urlencode "text=$1" >/dev/null || true; }
state() { printf '{"stage":"%s","detail":"%s"}' "$1" "$2" > $L/state.json; }
fail() { state error "$1"; tg "❌ App Lab: $1"; echo "FAIL: $1"; exit 1; }

state setup "تجهيز الجهاز"
adb wait-for-device
adb root >/dev/null 2>&1; sleep 3; adb wait-for-device
nohup adb logcat -v time > $L/logcat.txt 2>&1 &

# 1) شهادة mitmproxy كشهادة نظام (طبقة tmpfs فوق مجلد الشهادات)
CERT="$HOME/.mitmproxy/mitmproxy-ca-cert.pem"
[ -f "$CERT" ] || fail "شهادة mitmproxy غير موجودة"
H=$(openssl x509 -inform PEM -subject_hash_old -in "$CERT" -noout)
cp "$CERT" "$L/$H.0"
adb push "$L/$H.0" "/data/local/tmp/$H.0" >/dev/null
adb shell "rm -rf /data/local/tmp/cacerts; mkdir -p /data/local/tmp/cacerts; cp /system/etc/security/cacerts/* /data/local/tmp/cacerts/; cp /data/local/tmp/$H.0 /data/local/tmp/cacerts/$H.0"
adb shell "mount -t tmpfs tmpfs /system/etc/security/cacerts && cp /data/local/tmp/cacerts/* /system/etc/security/cacerts/ && chown root:root /system/etc/security/cacerts/* && chmod 644 /system/etc/security/cacerts/* && chcon u:object_r:system_file:s0 /system/etc/security/cacerts /system/etc/security/cacerts/*"
adb shell "ls /system/etc/security/cacerts/$H.0" | grep -q "$H" || fail "ما انثبتت الشهادة"
tg "🔐 App Lab: الشهادة انثبتت، جاري إعادة تشغيل النظام."

# 2) إعادة تشغيل الواجهة عشان كل التطبيقات تشوف الشهادة الجديدة
adb shell "stop; sleep 2; start"
sleep 8
for i in $(seq 1 60); do
  if adb shell "pm path android" 2>/dev/null | grep -q package; then break; fi
  sleep 3
done
sleep 10
tg "🔄 App Lab: النظام رجع بعد إعادة التشغيل."

# 3) منع QUIC (UDP 443) عشان التطبيقات ترجع لـ TCP ونقدر نرصدها
adb shell "iptables -I OUTPUT -p udp --dport 443 -j REJECT" >/dev/null 2>&1 || true

# 4) كل الاتصال يمر على mitmproxy (10.0.2.2 = جهاز الأكشن من داخل المحاكي)
adb shell settings put global http_proxy 10.0.2.2:8080

state ready "الجهاز جاهز"
tg "✅ App Lab جاهز. افتح الصفحة وتبويب (جهاز) وارفع التطبيق."

# 5) إبقاء الجلسة شغالة
END=$(( $(date +%s) + 5*3600 + 50*60 ))
while [ "$(date +%s)" -lt "$END" ]; do
  if ! adb get-state >/dev/null 2>&1; then
    tg "⚠️ App Lab: الجهاز الافتراضي توقف."
    tg "آخر سجل الجهاز:
$(tail -n 40 $L/logcat.txt | cut -c1-160 | tail -c 1800)"
    tg "آخر سجل الرصد:
$(tail -n 12 $L/mitm.log | cut -c1-160 | tail -c 1200)"
    break
  fi
  sleep 10
done
state ended "انتهت الجلسة"
