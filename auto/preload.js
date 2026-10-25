'use strict';
// يُحمَّل بـ: node -r ./auto/preload.js server.js  (بالأكشن التلقائي فقط). server.js نفسه ما يتعدّل.
//  1) يضيف ترويسة X-Zone-Next لكل رد لما تكون النسخة الجديدة معروضة (والمشغّل يقرأها ويجرّب الجديد وينتقل).
//  2) يعدّ طلبات المشاهدة (عشان القديم يعرف متى الكل انتقل).
//  3) يركّب مسارات الوضع التلقائي على تطبيق express قبل ما يبدأ الاستماع.
// أي خطأ هنا ما يوقف السيرفر: نسجّله ونكمل.
const http = require('http');

const VIEWER_RE = /^\/(live|d|mh|relay|u|uh|m|p)(\/|$)/;

try {
  const origWriteHead = http.ServerResponse.prototype.writeHead;
  http.ServerResponse.prototype.writeHead = function () {
    try {
      const nx = globalThis.__zoneNext;
      if (nx && !this.headersSent) {
        this.setHeader('X-Zone-Next', nx);
        const ex = this.getHeader('Access-Control-Expose-Headers');
        const cur = Array.isArray(ex) ? ex.join(', ') : (ex ? String(ex) : '');
        if (!/x-zone-next/i.test(cur)) this.setHeader('Access-Control-Expose-Headers', cur ? cur + ', X-Zone-Next' : 'X-Zone-Next');
      }
    } catch (_) {}
    return origWriteHead.apply(this, arguments);
  };

  const origEmit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (ev, req) {
    if (ev === 'request' && req && req.url) {
      try {
        const p = req.url.split('?')[0];
        if (VIEWER_RE.test(p)) {
          let v = globalThis.__zoneViewers;
          if (!v) v = globalThis.__zoneViewers = [];
          const ip = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim();
          v.push({ t: Date.now(), ip });
          if (v.length > 5000) v.splice(0, v.length - 5000);
        }
      } catch (_) {}
    }
    return origEmit.apply(this, arguments);
  };
} catch (e) { console.error('[auto] preload (headers/viewers) failed:', e); }

try {
  const express = require('express');
  const proto = express.application;
  const origListen = proto.listen;
  proto.listen = function () {
    if (!this.__zoneAutoMounted) {
      this.__zoneAutoMounted = true;
      try { require('./auto-mode').mount(this); } catch (e) { console.error('[auto] mount failed:', e); }
    }
    return origListen.apply(this, arguments);
  };
} catch (e) { console.error('[auto] preload (express) failed:', e); }
