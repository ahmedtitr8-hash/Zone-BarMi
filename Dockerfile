FROM node:20-slim

# ffmpeg مطلوب لتشغيل البث المباشر (اللوقو + دفع RTMP لـ OK.RU)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# Render يحدد PORT تلقائيًا عبر متغير بيئة، والسيرفر أصلاً يقرأه
EXPOSE 3000

CMD ["node", "server.js"]
