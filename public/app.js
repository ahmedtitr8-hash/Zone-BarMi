const API_KEY = localStorage.getItem('recorder_api_key') || prompt('أدخل مفتاح API (نفس القيمة اللي حطيتها بـ .env):');
if (API_KEY) localStorage.setItem('recorder_api_key', API_KEY);

const state = {
  clubs: {},          // { club1: 'milan', club2: 'barcelona' }
  activeTab: null,
  dismissedIds: new Set(), // بطاقات خطأ تم إغلاقها يدويًا
  handledDoneIds: new Set(), // تسجيلات مكتملة تعاملنا معها (حدّثنا القائمة والتخزين لها مرة وحدة)
};

// ==================== أدوات مساعدة ====================

async function api(path, options = {}) {
  const res = await fetch('/api' + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'حدث خطأ غير متوقع');
  return data;
}

function fmtDuration(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
}

function fmtSize(bytes) {
  if (!bytes) return '0 MB';
  const mb = bytes / (1024 * 1024);
  return mb > 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(0)} MB`;
}

function fmtClock(ts) {
  return new Date(ts).toLocaleString('ar', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
}

// يعد ثانية بثانية محليًا اعتمادًا على وقت البدء الحقيقي من السيرفر (بدون طلب شبكة)
// هذا يفصل العداد عن دورة التحديث كل 4 ثواني، فما يقفز ويبقى دقيق حتى لو تأخر رد السيرفر
function tickLiveTimers() {
  document.querySelectorAll('.live-timer[data-start]').forEach((el) => {
    const start = parseInt(el.dataset.start, 10);
    if (Number.isFinite(start)) el.textContent = fmtDuration(Date.now() - start);
  });
}

function toIsoOrNull(datetimeLocalValue) {
  if (!datetimeLocalValue) return null;
  const d = new Date(datetimeLocalValue);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

// ==================== بناء الهيكل العام ====================

async function init() {
  const { clubs } = await api('/clubs');
  state.clubs = clubs;

  const tabsEl = document.getElementById('tabs');
  const panelsEl = document.getElementById('panels');
  tabsEl.innerHTML = '';
  panelsEl.innerHTML = '';

  Object.entries(clubs).forEach(([key, name]) => {
    tabsEl.appendChild(buildTabButton(key, name));
    panelsEl.appendChild(buildClubPanel(key, name));
  });
  tabsEl.appendChild(buildTabButton('overview', 'نظرة عامة'));
  panelsEl.appendChild(buildOverviewPanel());

  const firstKey = Object.keys(clubs)[0];
  selectTab(firstKey);

  Object.keys(clubs).forEach(loadSavedRecordings);
  refreshActive();
  refreshStorageUsage();
  refreshLiveStreams();

  setInterval(refreshActive, 4000);
  setInterval(refreshStorageUsage, 60000);
  setInterval(tickLiveTimers, 1000);
  setInterval(refreshLiveStreams, 5000);
}

function buildTabButton(key, label) {
  const btn = document.createElement('div');
  btn.className = 'tab';
  btn.textContent = label;
  btn.dataset.key = key;
  btn.onclick = () => selectTab(key);
  return btn;
}

function selectTab(key) {
  state.activeTab = key;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.key === key));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.key === key));
}

function buildClubPanel(key, name) {
  const panel = document.createElement('div');
  panel.className = 'tab-panel';
  panel.dataset.key = key;
  panel.innerHTML = `
    <div class="card">
      <label>رابط البث (m3u8 / mpd / mp4 / rtmp)</label>
      <input type="url" class="f-url" placeholder="https://...">
      <label>مفتاح فك التشفير ClearKey (اختياري — فقط لروابط mpd المشفّرة)</label>
      <input type="text" class="f-decryption-key" placeholder="32 حرف hex">
      <label>اسم المباراة (اختياري)</label>
      <input type="text" class="f-name" placeholder="مثال: ${name} vs الخصم">

      <button type="button" class="btn btn-preview f-preview-btn">🖼 معاينة</button>
      <div class="preview-box f-preview-box" style="display:none;">
        <div class="preview-frame f-preview-frame">
          <img class="f-preview-img">
          <div class="logo-box f-logo-box" style="display:none;">
            <img class="f-logo-img">
            <div class="resize-handle f-resize-handle"></div>
          </div>
        </div>
        <label>شعار (لوقو) لهذا التسجيل</label>
        <input type="file" accept="image/*" class="f-logo-input" disabled>
        <button type="button" class="btn btn-confirm-pos f-confirm-pos-btn" disabled>✅ تأكيد الموضع</button>
      </div>
      <div class="toast f-preview-toast"></div>

      <div class="schedule-toggle"><input type="checkbox" class="f-sched-toggle"> جدولة وقت البدء/الإيقاف (اختياري)</div>
      <div class="schedule-fields f-sched-fields">
        <label>يبدأ الساعة</label>
        <input type="datetime-local" class="f-start-at">
        <label>يوقف ويرفع الساعة (اختياري)</label>
        <input type="datetime-local" class="f-stop-at">
      </div>

      <button class="btn btn-start f-start-btn">▶ ابدأ التسجيل</button>
      <div class="toast f-toast"></div>
    </div>

    <div class="card">
      <div class="section-title">📡 بث مباشر + تسجيل</div>
      <label>رابط البث</label>
      <input type="url" class="p-url" placeholder="https://...">

      <label>مفتاح فك التشفير ClearKey (اختياري — فقط لروابط mpd المشفّرة)</label>
      <input type="text" class="p-decryption-key" placeholder="32 حرف hex">

      <label>رابط RTMP + مفتاح البث تبع OK.RU (يتغيّر كل مرة)</label>
      <input type="text" class="p-okru-url" placeholder="rtmp://vd.trbnr.ok.ru/input/المفتاح">

      <button type="button" class="btn btn-preview p-preview-btn">🖼 معاينة</button>
      <div class="preview-box p-preview-box" style="display:none;">
        <div class="preview-frame p-preview-frame">
          <img class="p-preview-img">
          <div class="logo-box p-logo-box" style="display:none;">
            <img class="p-logo-img">
            <div class="resize-handle p-resize-handle"></div>
          </div>
        </div>
        <label>شعار (لوقو) للبث</label>
        <input type="file" accept="image/*" class="p-logo-input" disabled>
        <button type="button" class="btn btn-confirm-pos p-confirm-pos-btn" disabled>✅ تأكيد الموضع</button>
      </div>
      <div class="toast p-preview-toast"></div>

      <button class="btn btn-start p-live-start-btn">▶ ابدأ البث</button>
      <button class="btn btn-danger p-live-stop-btn" style="display:none;">⏹ إيقاف البث</button>
      <div class="toast p-live-toast"></div>

      <div class="live-status p-live-status" style="display:none;">
        <div class="live-badge p-live-badge">🔴 البث شغال</div>
        <label>اسم الشوط/الجزء (اختياري)</label>
        <input type="text" class="p-rec-name" placeholder="مثال: الشوط الأول">
        <button class="btn btn-rec-toggle p-rec-toggle-btn" data-recording="0">⏺ ابدأ تسجيل</button>
      </div>
    </div>

    <div class="card">
      <div class="section-title">جاري الآن</div>
      <div class="f-active-list"><div class="empty">لا يوجد تسجيل جارٍ حاليًا لهذا النادي</div></div>
    </div>

    <div class="card">
      <div class="section-title">التسجيلات المحفوظة</div>
      <div class="section-title f-expiry" style="margin-top:-6px;"></div>
      <div class="f-saved-list"><div class="empty">جاري التحميل...</div></div>
    </div>
  `;

  panel.querySelector('.f-sched-toggle').onchange = (e) => {
    panel.querySelector('.f-sched-fields').classList.toggle('open', e.target.checked);
  };

  panel.querySelector('.f-start-btn').onclick = () => startRecording(key, panel);
  initPreviewForPanel(key, panel);

  const liveCard = panel.querySelector('.p-live-start-btn').closest('.card');
  liveCard.querySelector('.p-live-start-btn').onclick = () => startLive(key, liveCard);
  liveCard.querySelector('.p-live-stop-btn').onclick = () => stopLive(key, liveCard);
  liveCard.querySelector('.p-rec-toggle-btn').onclick = () => toggleLiveRecording(key, liveCard);
  initLivePreviewController(liveCard, key);

  return panel;
}

function buildOverviewPanel() {
  const panel = document.createElement('div');
  panel.className = 'tab-panel';
  panel.dataset.key = 'overview';
  panel.innerHTML = `
    <div class="card">
      <div class="section-title">حالة الناديين الآن</div>
      <div id="overviewList"></div>
    </div>
  `;
  return panel;
}

function panelFor(clubKey) {
  return document.querySelector(`.tab-panel[data-key="${clubKey}"]`);
}

function setToast(panel, msg, type) {
  const el = panel.querySelector('.f-toast');
  el.textContent = msg || '';
  el.className = 'toast' + (type ? ' ' + type : '');
}

// ==================== معاينة الفريم وتحديد موضع اللوقو ====================

const previewState = {}; // clubKey -> { videoWidth, videoHeight, logoFile, confirmed, xPct, yPct, wPct, hPct }

function defaultPreviewState() {
  return { videoWidth: null, videoHeight: null, logoFile: null, confirmed: false, xPct: 0.05, yPct: 0.05, wPct: 0.2, hPct: 0.2 };
}

function applyLogoBoxStyle(clubKey, panel) {
  const st = previewState[clubKey];
  const logoBox = panel.querySelector('.f-logo-box');
  const frameRect = panel.querySelector('.f-preview-frame').getBoundingClientRect();
  logoBox.style.left = (st.xPct * frameRect.width) + 'px';
  logoBox.style.top = (st.yPct * frameRect.height) + 'px';
  logoBox.style.width = (st.wPct * frameRect.width) + 'px';
  logoBox.style.height = (st.hPct * frameRect.height) + 'px';
}

function resetPreview(clubKey, panel) {
  previewState[clubKey] = defaultPreviewState();
  panel.querySelector('.f-preview-box').style.display = 'none';
  panel.querySelector('.f-logo-box').style.display = 'none';
  const logoInput = panel.querySelector('.f-logo-input');
  logoInput.value = '';
  logoInput.disabled = true;
  panel.querySelector('.f-confirm-pos-btn').disabled = true;
  panel.querySelector('.f-preview-toast').textContent = '';
}

function initPreviewForPanel(clubKey, panel) {
  previewState[clubKey] = defaultPreviewState();

  const previewBtn = panel.querySelector('.f-preview-btn');
  const previewBox = panel.querySelector('.f-preview-box');
  const previewImg = panel.querySelector('.f-preview-img');
  const previewFrame = panel.querySelector('.f-preview-frame');
  const logoBox = panel.querySelector('.f-logo-box');
  const logoImg = panel.querySelector('.f-logo-img');
  const logoInput = panel.querySelector('.f-logo-input');
  const confirmBtn = panel.querySelector('.f-confirm-pos-btn');
  const resizeHandle = panel.querySelector('.f-resize-handle');
  const toastEl = panel.querySelector('.f-preview-toast');

  previewBtn.onclick = async () => {
    const url = panel.querySelector('.f-url').value.trim();
    const decryptionKey = panel.querySelector('.f-decryption-key').value.trim();
    if (!url) { toastEl.textContent = 'حط رابط البث أول'; toastEl.className = 'toast error'; return; }
    previewBtn.disabled = true;
    toastEl.textContent = 'جاري أخذ المعاينة...';
    toastEl.className = 'toast';
    try {
      const { image, width, height } = await api('/preview/frame', { method: 'POST', body: JSON.stringify({ url, decryptionKey: decryptionKey || undefined }) });
      previewImg.src = image;
      previewState[clubKey].videoWidth = width;
      previewState[clubKey].videoHeight = height;
      previewState[clubKey].confirmed = false;
      previewBox.style.display = 'block';
      logoInput.disabled = false;
      toastEl.textContent = '';
      if (previewState[clubKey].logoFile) {
        logoBox.style.display = 'block';
        applyLogoBoxStyle(clubKey, panel);
      }
    } catch (err) {
      toastEl.textContent = err.message;
      toastEl.className = 'toast error';
    } finally {
      previewBtn.disabled = false;
    }
  };

  logoInput.onchange = () => {
    const file = logoInput.files[0];
    if (!file) return;
    previewState[clubKey].logoFile = file;
    previewState[clubKey].confirmed = false;
    logoImg.src = URL.createObjectURL(file);
    logoBox.style.display = 'block';
    applyLogoBoxStyle(clubKey, panel);
    confirmBtn.disabled = false;
  };

  confirmBtn.onclick = () => {
    const rect = logoBox.getBoundingClientRect();
    const frameRect = previewFrame.getBoundingClientRect();
    const st = previewState[clubKey];
    st.xPct = (rect.left - frameRect.left) / frameRect.width;
    st.yPct = (rect.top - frameRect.top) / frameRect.height;
    st.wPct = rect.width / frameRect.width;
    st.hPct = rect.height / frameRect.height;
    st.confirmed = true;
    toastEl.textContent = '✅ تم حفظ موضع اللوقو';
    toastEl.className = 'toast ok';
  };

  let dragging = null;
  logoBox.addEventListener('pointerdown', (e) => {
    if (e.target === resizeHandle) return;
    dragging = { startX: e.clientX, startY: e.clientY, startLeft: logoBox.offsetLeft, startTop: logoBox.offsetTop };
    logoBox.setPointerCapture(e.pointerId);
  });
  logoBox.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const frameRect = previewFrame.getBoundingClientRect();
    let newLeft = dragging.startLeft + (e.clientX - dragging.startX);
    let newTop = dragging.startTop + (e.clientY - dragging.startY);
    // نسمح للوقو يطلع جزئيًا برا حدود الفريم (يمين/يسار/فوق/تحت) بدل ما يكون محصور بالكامل جواه —
    // بس نبقي 20px منه ظاهرة جوا الفريم عشان تقدر تمسكه وتكمل تحريكه
    newLeft = Math.max(-(logoBox.offsetWidth - 20), Math.min(newLeft, frameRect.width - 20));
    newTop = Math.max(-(logoBox.offsetHeight - 20), Math.min(newTop, frameRect.height - 20));
    logoBox.style.left = newLeft + 'px';
    logoBox.style.top = newTop + 'px';
  });
  logoBox.addEventListener('pointerup', () => { dragging = null; });

  let resizing = null;
  resizeHandle.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    resizing = { startX: e.clientX, startY: e.clientY, startW: logoBox.offsetWidth, startH: logoBox.offsetHeight };
    resizeHandle.setPointerCapture(e.pointerId);
  });
  resizeHandle.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    const frameRect = previewFrame.getBoundingClientRect();
    let newW = resizing.startW + (e.clientX - resizing.startX);
    let newH = resizing.startH + (e.clientY - resizing.startY);
    // ما عاد نحصر الحجم بحدود الفريم — نخليه يكبر حتى لو جزء منه يطلع برا، بس بحد أقصى معقول
    newW = Math.max(24, Math.min(newW, frameRect.width * 3));
    newH = Math.max(24, Math.min(newH, frameRect.height * 3));
    logoBox.style.width = newW + 'px';
    logoBox.style.height = newH + 'px';
  });
  resizeHandle.addEventListener('pointerup', () => { resizing = null; });
}

// ==================== بدء تسجيل ====================

async function startRecording(clubKey, panel) {
  const url = panel.querySelector('.f-url').value.trim();
  const decryptionKey = panel.querySelector('.f-decryption-key').value.trim();
  const matchName = panel.querySelector('.f-name').value.trim();
  const scheduled = panel.querySelector('.f-sched-toggle').checked;
  const startAt = scheduled ? toIsoOrNull(panel.querySelector('.f-start-at').value) : null;
  const stopAt = scheduled ? toIsoOrNull(panel.querySelector('.f-stop-at').value) : null;

  if (!url) return setToast(panel, 'حط رابط البث أول', 'error');
  if (scheduled && !startAt) return setToast(panel, 'حدد وقت البدء أو ألغِ الجدولة', 'error');

  const st = previewState[clubKey];
  if (st && st.logoFile && !st.confirmed) {
    return setToast(panel, 'أكّد موضع اللوقو قبل بدء التسجيل', 'error');
  }

  const btn = panel.querySelector('.f-start-btn');
  btn.disabled = true;
  setToast(panel, 'جاري الإرسال...');

  try {
    const form = new FormData();
    form.append('club', clubKey);
    form.append('url', url);
    if (decryptionKey) form.append('decryptionKey', decryptionKey);
    form.append('matchName', matchName);
    if (startAt) form.append('startAt', startAt);
    if (stopAt) form.append('stopAt', stopAt);
    if (st && st.logoFile && st.confirmed) {
      form.append('logo', st.logoFile);
      form.append('logoX', st.xPct);
      form.append('logoY', st.yPct);
      form.append('logoW', st.wPct);
      form.append('logoH', st.hPct);
      form.append('videoWidth', st.videoWidth);
      form.append('videoHeight', st.videoHeight);
    }

    const res = await fetch('/api/record/start', { method: 'POST', headers: { 'x-api-key': API_KEY }, body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'حدث خطأ غير متوقع');

    panel.querySelector('.f-url').value = '';
    panel.querySelector('.f-decryption-key').value = '';
    panel.querySelector('.f-name').value = '';
    resetPreview(clubKey, panel);
    setToast(panel, scheduled ? '✅ تمت الجدولة' : '🔴 التسجيل بدأ', 'ok');
    refreshActive();
  } catch (err) {
    setToast(panel, err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ==================== البث المباشر + تسجيل الأشواط ====================

function setLiveToast(container, msg, type) {
  const el = container.querySelector('.p-live-toast');
  el.textContent = msg || '';
  el.className = 'toast' + (type ? ' ' + type : '');
}

function initLivePreviewController(container, clubKey) {
  const stateKey = `${clubKey}:live`;
  previewState[stateKey] = defaultPreviewState();

  const previewBtn = container.querySelector('.p-preview-btn');
  const previewBox = container.querySelector('.p-preview-box');
  const previewImg = container.querySelector('.p-preview-img');
  const previewFrame = container.querySelector('.p-preview-frame');
  const logoBox = container.querySelector('.p-logo-box');
  const logoImg = container.querySelector('.p-logo-img');
  const logoInput = container.querySelector('.p-logo-input');
  const confirmBtn = container.querySelector('.p-confirm-pos-btn');
  const resizeHandle = container.querySelector('.p-resize-handle');
  const toastEl = container.querySelector('.p-preview-toast');

  function applyBoxStyle() {
    const st = previewState[stateKey];
    const frameRect = previewFrame.getBoundingClientRect();
    logoBox.style.left = (st.xPct * frameRect.width) + 'px';
    logoBox.style.top = (st.yPct * frameRect.height) + 'px';
    logoBox.style.width = (st.wPct * frameRect.width) + 'px';
    logoBox.style.height = (st.hPct * frameRect.height) + 'px';
  }

  previewBtn.onclick = async () => {
    const url = container.querySelector('.p-url').value.trim();
    const decryptionKey = container.querySelector('.p-decryption-key').value.trim();
    if (!url) { toastEl.textContent = 'حط رابط البث أول'; toastEl.className = 'toast error'; return; }
    previewBtn.disabled = true;
    toastEl.textContent = 'جاري أخذ المعاينة...';
    toastEl.className = 'toast';
    try {
      const { image, width, height } = await api('/preview/frame', { method: 'POST', body: JSON.stringify({ url, decryptionKey: decryptionKey || undefined }) });
      previewImg.src = image;
      previewState[stateKey].videoWidth = width;
      previewState[stateKey].videoHeight = height;
      previewState[stateKey].confirmed = false;
      previewBox.style.display = 'block';
      logoInput.disabled = false;
      toastEl.textContent = '';
      if (previewState[stateKey].logoFile) {
        logoBox.style.display = 'block';
        applyBoxStyle();
      }
    } catch (err) {
      toastEl.textContent = err.message;
      toastEl.className = 'toast error';
    } finally {
      previewBtn.disabled = false;
    }
  };

  logoInput.onchange = () => {
    const file = logoInput.files[0];
    if (!file) return;
    previewState[stateKey].logoFile = file;
    previewState[stateKey].confirmed = false;
    logoImg.src = URL.createObjectURL(file);
    logoBox.style.display = 'block';
    applyBoxStyle();
    confirmBtn.disabled = false;
  };

  confirmBtn.onclick = () => {
    const rect = logoBox.getBoundingClientRect();
    const frameRect = previewFrame.getBoundingClientRect();
    const st = previewState[stateKey];
    st.xPct = (rect.left - frameRect.left) / frameRect.width;
    st.yPct = (rect.top - frameRect.top) / frameRect.height;
    st.wPct = rect.width / frameRect.width;
    st.hPct = rect.height / frameRect.height;
    st.confirmed = true;
    toastEl.textContent = '✅ تم حفظ موضع اللوقو';
    toastEl.className = 'toast ok';
  };

  let dragging = null;
  logoBox.addEventListener('pointerdown', (e) => {
    if (e.target === resizeHandle) return;
    dragging = { startX: e.clientX, startY: e.clientY, startLeft: logoBox.offsetLeft, startTop: logoBox.offsetTop };
    logoBox.setPointerCapture(e.pointerId);
  });
  logoBox.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const frameRect = previewFrame.getBoundingClientRect();
    let newLeft = dragging.startLeft + (e.clientX - dragging.startX);
    let newTop = dragging.startTop + (e.clientY - dragging.startY);
    // نسمح للوقو يطلع جزئيًا برا حدود الفريم (يمين/يسار/فوق/تحت) بدل ما يكون محصور بالكامل جواه —
    // بس نبقي 20px منه ظاهرة جوا الفريم عشان تقدر تمسكه وتكمل تحريكه
    newLeft = Math.max(-(logoBox.offsetWidth - 20), Math.min(newLeft, frameRect.width - 20));
    newTop = Math.max(-(logoBox.offsetHeight - 20), Math.min(newTop, frameRect.height - 20));
    logoBox.style.left = newLeft + 'px';
    logoBox.style.top = newTop + 'px';
  });
  logoBox.addEventListener('pointerup', () => { dragging = null; });

  let resizing = null;
  resizeHandle.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    resizing = { startX: e.clientX, startY: e.clientY, startW: logoBox.offsetWidth, startH: logoBox.offsetHeight };
    resizeHandle.setPointerCapture(e.pointerId);
  });
  resizeHandle.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    const frameRect = previewFrame.getBoundingClientRect();
    let newW = resizing.startW + (e.clientX - resizing.startX);
    let newH = resizing.startH + (e.clientY - resizing.startY);
    // ما عاد نحصر الحجم بحدود الفريم — نخليه يكبر حتى لو جزء منه يطلع برا، بس بحد أقصى معقول
    newW = Math.max(24, Math.min(newW, frameRect.width * 3));
    newH = Math.max(24, Math.min(newH, frameRect.height * 3));
    logoBox.style.width = newW + 'px';
    logoBox.style.height = newH + 'px';
  });
  resizeHandle.addEventListener('pointerup', () => { resizing = null; });
}

function resetLivePreview(clubKey, container) {
  previewState[`${clubKey}:live`] = defaultPreviewState();
  container.querySelector('.p-preview-box').style.display = 'none';
  container.querySelector('.p-logo-box').style.display = 'none';
  const logoInput = container.querySelector('.p-logo-input');
  logoInput.value = '';
  logoInput.disabled = true;
  container.querySelector('.p-confirm-pos-btn').disabled = true;
  container.querySelector('.p-preview-toast').textContent = '';
}

async function startLive(clubKey, container) {
  const url = container.querySelector('.p-url').value.trim();
  const decryptionKey = container.querySelector('.p-decryption-key').value.trim();
  if (!url) return setLiveToast(container, 'حط رابط البث أول', 'error');

  const okruUrl = container.querySelector('.p-okru-url').value.trim();

  const st = previewState[`${clubKey}:live`];
  if (st && st.logoFile && !st.confirmed) {
    return setLiveToast(container, 'أكّد موضع اللوقو قبل بدء البث', 'error');
  }

  const btn = container.querySelector('.p-live-start-btn');
  btn.disabled = true;
  setLiveToast(container, 'جاري بدء البث...');

  try {
    const form = new FormData();
    form.append('club', clubKey);
    form.append('url', url);
    if (decryptionKey) form.append('decryptionKey', decryptionKey);
    if (okruUrl) form.append('okruUrl', okruUrl);
    if (st && st.logoFile && st.confirmed) {
      form.append('logo', st.logoFile);
      form.append('logoX', st.xPct);
      form.append('logoY', st.yPct);
      form.append('logoW', st.wPct);
      form.append('logoH', st.hPct);
      form.append('videoWidth', st.videoWidth);
      form.append('videoHeight', st.videoHeight);
    }

    const res = await fetch('/api/live/start', { method: 'POST', headers: { 'x-api-key': API_KEY }, body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'حدث خطأ غير متوقع');

    resetLivePreview(clubKey, container);
    container.querySelector('.p-decryption-key').value = '';
    container.querySelector('.p-okru-url').value = '';
    setLiveToast(container, data.pushingToOkru ? '📡 البث بدأ — يوصل الآن على OK.RU' : '📡 البث بدأ (محليًا فقط، حط رابط RTMP + المفتاح تبع OK.RU)', 'ok');
    refreshLiveStreams();
  } catch (err) {
    setLiveToast(container, err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function stopLive(clubKey, container) {
  if (!confirm('إيقاف البث المباشر؟ لو فيه تسجيل شوط شغال بيتوقف ويترفع تلقائيًا.')) return;
  const btn = container.querySelector('.p-live-stop-btn');
  btn.disabled = true;
  try {
    await api('/live/stop', { method: 'POST', body: JSON.stringify({ club: clubKey }) });
    refreshLiveStreams();
    refreshActive();
  } catch (err) {
    setLiveToast(container, err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function toggleLiveRecording(clubKey, container) {
  const btn = container.querySelector('.p-rec-toggle-btn');
  const isRecording = btn.dataset.recording === '1';
  btn.disabled = true;
  try {
    if (isRecording) {
      await api('/live/recording/stop', { method: 'POST', body: JSON.stringify({ club: clubKey }) });
    } else {
      const matchName = container.querySelector('.p-rec-name').value.trim();
      await api('/live/recording/start', { method: 'POST', body: JSON.stringify({ club: clubKey, matchName }) });
      container.querySelector('.p-rec-name').value = '';
    }
    refreshLiveStreams();
    refreshActive();
  } catch (err) {
    setLiveToast(container, err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function refreshLiveStreams() {
  let data;
  try {
    data = await api('/live/status');
  } catch (_) {
    return;
  }
  Object.keys(state.clubs).forEach((clubKey) => {
    const panel = panelFor(clubKey);
    if (!panel) return;
    const container = panel.querySelector('.p-live-start-btn').closest('.card');
    const live = data.live[clubKey];

    const startBtn = container.querySelector('.p-live-start-btn');
    const stopBtn = container.querySelector('.p-live-stop-btn');
    const statusBox = container.querySelector('.p-live-status');
    const recBtn = container.querySelector('.p-rec-toggle-btn');

    if (live) {
      startBtn.style.display = 'none';
      stopBtn.style.display = 'block';
      statusBox.style.display = 'block';
      if (live.recording) {
        recBtn.textContent = '⏹ إيقاف التسجيل ورفعه';
        recBtn.dataset.recording = '1';
      } else {
        recBtn.textContent = '⏺ ابدأ تسجيل';
        recBtn.dataset.recording = '0';
      }
    } else {
      startBtn.style.display = 'block';
      stopBtn.style.display = 'none';
      statusBox.style.display = 'none';
    }
  });
}

async function stopOrCancel(id) {
  try {
    await api('/record/stop', { method: 'POST', body: JSON.stringify({ id }) });
    refreshActive();
  } catch (err) {
    alert(err.message);
  }
}

async function deleteRecording(clubKey, name, itemEl) {
  if (!confirm('تأكيد حذف التسجيل نهائيًا من التخزين؟')) return;
  try {
    await api(`/recordings/${clubKey}/${encodeURIComponent(name)}`, { method: 'DELETE' });
    itemEl.remove();
    refreshStorageUsage();
  } catch (err) {
    alert(err.message);
  }
}

// ==================== تحديث التسجيلات الجارية/المجدولة (كل الأندية) ====================

function statusLabel(status) {
  return {
    scheduled: '⏳ مجدول',
    recording: '🔴 يسجل الآن',
    stopping: '⏹ جاري الإيقاف',
    uploading: '⬆️ جاري الرفع',
    done: '✅ اكتمل',
    error: '❌ خطأ',
  }[status] || status;
}

function renderActiveCard(rec) {
  const card = document.createElement('div');
  card.className = 'rec-card';

  let metaHtml = '';
  let actionsHtml = '';

  if (rec.status === 'scheduled') {
    metaHtml = `يبدأ الساعة ${fmtClock(rec.scheduledStart)}` +
      (rec.scheduledStop ? ` — يوقف الساعة ${fmtClock(rec.scheduledStop)}` : '');
    actionsHtml = `<button class="btn-cancel">إلغاء الجدولة</button>`;
  } else if (rec.status === 'recording') {
    metaHtml = `<span class="live-timer" data-start="${rec.startTime}">${fmtDuration(rec.elapsedMs)}</span> · ${fmtSize(rec.fileSizeBytes)}` +
      (rec.scheduledStop ? ` · يوقف تلقائيًا الساعة ${fmtClock(rec.scheduledStop)}` : '');
    if (rec.stalled) {
      metaHtml = `⚠️ البث ما يستقبل بيانات جديدة — ${metaHtml}`;
    }
    actionsHtml = `<button class="btn-stop">⏹ إيقاف ورفع</button>`;
  } else if (rec.status === 'stopping' || rec.status === 'uploading') {
    if (rec.status === 'uploading' && rec.totalUploadBytes > 0) {
      const pct = Math.min(100, Math.round((rec.uploadedBytes / rec.totalUploadBytes) * 100));
      metaHtml = `
        <div class="upload-progress">
          <div class="upload-progress-bar" style="width:${pct}%"></div>
        </div>
        <div class="upload-progress-text">جاري الرفع لـ B2... ${pct}% (${fmtSize(rec.uploadedBytes)} / ${fmtSize(rec.totalUploadBytes)}) — لا تقفل الصفحة</div>
      `;
    } else {
      metaHtml = rec.status === 'uploading' ? 'جاري رفع الملف لـ B2... لا تقفل الصفحة' : 'جاري إيقاف التسجيل...';
    }
  } else if (rec.status === 'error') {
    metaHtml = rec.errorMessage || 'حدث خطأ';
    actionsHtml = `<button class="btn-dismiss">إغلاق</button>`;
  }

  card.innerHTML = `
    <div class="top">
      <div class="name">${rec.matchName}</div>
      <div class="badge ${rec.status}">${statusLabel(rec.status)}</div>
    </div>
    <div class="meta ${rec.status === 'error' ? 'err' : rec.stalled ? 'warn' : ''}">${metaHtml}</div>
    ${actionsHtml}
  `;

  const stopBtn = card.querySelector('.btn-stop');
  if (stopBtn) stopBtn.onclick = () => { stopBtn.disabled = true; stopBtn.textContent = 'جاري الإيقاف...'; stopOrCancel(rec.id); };

  const cancelBtn = card.querySelector('.btn-cancel');
  if (cancelBtn) cancelBtn.onclick = () => stopOrCancel(rec.id);

  const dismissBtn = card.querySelector('.btn-dismiss');
  if (dismissBtn) dismissBtn.onclick = () => { state.dismissedIds.add(rec.id); renderAllActive(state.lastActiveList || []); };

  return card;
}

function renderAllActive(list) {
  state.lastActiveList = list;
  const visible = list.filter((r) => !state.dismissedIds.has(r.id));

  Object.keys(state.clubs).forEach((clubKey) => {
    const panel = panelFor(clubKey);
    if (!panel) return;
    const listEl = panel.querySelector('.f-active-list');
    const clubRecs = visible.filter((r) => r.club === clubKey);
    listEl.innerHTML = '';
    if (!clubRecs.length) {
      listEl.innerHTML = '<div class="empty">لا يوجد تسجيل جارٍ حاليًا لهذا النادي</div>';
    } else {
      clubRecs.forEach((rec) => listEl.appendChild(renderActiveCard(rec)));
    }
  });

  renderOverview(visible);

  // لما تسجيل يخلص (status done) لأول مرة: نحدّث قائمة المحفوظات مرة وحدة وننضف
  visible
    .filter((r) => r.status === 'done' && !state.handledDoneIds.has(r.id))
    .forEach((r) => {
      state.handledDoneIds.add(r.id);
      loadSavedRecordings(r.club);
      refreshStorageUsage();
      setTimeout(() => { state.dismissedIds.add(r.id); renderAllActive(state.lastActiveList || []); }, 6000);
    });
}

function renderOverview(list) {
  const el = document.getElementById('overviewList');
  if (!el) return;
  el.innerHTML = '';
  Object.entries(state.clubs).forEach(([key, name]) => {
    const clubRecs = list.filter((r) => r.club === key);
    const priority = ['recording', 'uploading', 'stopping', 'scheduled'];
    const main = priority.map((s) => clubRecs.find((r) => r.status === s)).find(Boolean);

    let text = '⚪ لا يوجد تسجيل حالي';
    let cls = 'idle';
    if (main) {
      if (main.status === 'recording') { text = `🔴 يسجل الآن — <span class="live-timer" data-start="${main.startTime}">${fmtDuration(main.elapsedMs)}</span>`; cls = 'recording'; }
      else if (main.status === 'uploading' || main.status === 'stopping') { text = '⬆️ جاري الرفع'; cls = 'uploading'; }
      else if (main.status === 'scheduled') { text = `⏳ مجدول الساعة ${fmtClock(main.scheduledStart)}`; cls = 'scheduled'; }
      if (clubRecs.length > 1) text += ` (+${clubRecs.length - 1})`;
    }

    const row = document.createElement('div');
    row.className = 'overview-row';
    row.innerHTML = `<div class="club-name">${name}</div><div class="state ${cls}">${text}</div>`;
    el.appendChild(row);
  });
}

async function refreshActive() {
  try {
    const { recordings } = await api('/record/active');
    renderAllActive(recordings);
  } catch (_) {
    // تجاهل فشل تحديث لحظي (مثلاً الشبكة انقطعت)
  }
}

// ==================== قائمة التسجيلات المحفوظة ====================

async function loadSavedRecordings(clubKey) {
  const panel = panelFor(clubKey);
  if (!panel) return;
  const listEl = panel.querySelector('.f-saved-list');
  try {
    const { recordings, linkValidDays } = await api('/recordings/' + clubKey);
    if (linkValidDays) {
      panel.querySelector('.f-expiry').textContent = `⏱ الروابط صالحة لمدة ${Math.round(linkValidDays)} يوم من وقت الفتح`;
    }
    if (!recordings.length) {
      listEl.innerHTML = '<div class="empty">لا توجد تسجيلات بعد لهذا النادي</div>';
      return;
    }
    listEl.innerHTML = '';
    recordings.forEach((r) => {
      const item = document.createElement('div');
      item.className = 'rec-item';
      item.innerHTML = `
        <div class="rec-info">
          <div class="rec-name">${r.name}</div>
          <div class="rec-meta">${fmtSize(r.sizeBytes)} · ${new Date(r.lastModified).toLocaleDateString('ar')}</div>
        </div>
        <div class="rec-actions">
          <a href="${r.url}" target="_blank" rel="noopener">فتح</a>
          <button class="del">حذف</button>
        </div>`;
      item.querySelector('.del').onclick = () => deleteRecording(clubKey, r.name, item);
      listEl.appendChild(item);
    });
  } catch (err) {
    listEl.innerHTML = `<div class="empty">تعذر التحميل: ${err.message}</div>`;
  }
}

// ==================== شريط استهلاك B2 ====================

async function refreshStorageUsage() {
  try {
    const { usedBytes, quotaBytes } = await api('/storage/usage');
    const pct = Math.min(100, (usedBytes / quotaBytes) * 100);
    document.getElementById('storageFill').style.width = pct + '%';
    document.getElementById('storageFill').className =
      'storage-fill' + (pct > 90 ? ' full' : pct > 70 ? ' warn' : '');
    document.getElementById('storageText').textContent =
      `${fmtSize(usedBytes)} من ${fmtSize(quotaBytes)}`;
  } catch (_) {
    // تجاهل فشل مؤقت
  }
}

init();
