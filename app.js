// ============================================
//  WatchParty WebApp — app.js
//  مشغّل خاص + مزامنة + شات (يشتغل على الموبايل والكمبيوتر)
//  يستخدم نفس سيرفر الإكستنشن
// ============================================

const SERVER_URL = "wss://watchparty-server-553f.onrender.com";

// ── حالة ──
let socket = null;
let roomId = null;
let username = null;
let isSyncing = false;
let videoSrc = null;       // { type: "html5"|"youtube", url, id }
let player = null;         // واجهة موحّدة للمشغّل الحالي
let ytReady = false;
let ytApiLoading = false;
let ytPlayer = null; // اختصار مباشر لـ YT.Player instance
let _roomStateReceived = false; // منع source من إعادة التحميل بعد room_state

// ── عناصر ──
const $ = (id) => document.getElementById(id);
const screens = { join: $("screen-join"), watch: $("screen-watch") };

// ============================================
//  أدوات صغيرة
// ============================================
const AVATAR_COLORS = ["#2a6df0", "#e0529c", "#f0962a", "#1dbf73", "#9b59b6", "#16a8a8", "#e74c3c"];
function colorFor(name) {
  let h = 0;
  for (let i = 0; i < (name || "").length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function initials(name) { return (name || "?").trim().charAt(0).toUpperCase(); }
function fmtTime(sec) {
  if (sec == null || isNaN(sec)) return "00:00";
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
function genRoomId() { return Math.random().toString(36).substring(2, 8).toUpperCase(); }

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "style") Object.assign(n.style, v);
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  kids.forEach(c => { if (c != null) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
  return n;
}
function avatarEl(name) {
  return el("span", { class: "avatar", style: { background: colorFor(name) }, text: initials(name) });
}

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove("active"));
  screens[name].classList.add("active");
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 2500);
}

// ============================================
//  تحليل رابط الفيديو
// ============================================
function parseVideoUrl(url) {
  url = (url || "").trim();
  if (!url) return null;

  // YouTube
  const yt = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|live\/)|youtu\.be\/)([\w-]{11})/);
  if (yt) return { type: "youtube", id: yt[1], url };

  // m3u8 (HLS) أو mp4 أو أي رابط مباشر
  if (/^https?:\/\//.test(url)) {
    const isHls = /\.m3u8(\?|$)/i.test(url);
    return { type: "html5", url, hls: isHls };
  }
  return null;
}

// ============================================
//  شاشة الدخول
// ============================================
let setupRoomCode = genRoomId();

function initJoinScreen() {
  $("gen-room-code").textContent = setupRoomCode;

  // التبويبات
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      $("panel-" + btn.dataset.tab).classList.add("active");
    });
  });

  // اسم محفوظ
  const savedName = localStorage.getItem("wp-username");
  if (savedName) $("inp-username").value = savedName;

  $("btn-create").addEventListener("click", onCreate);
  $("btn-join").addEventListener("click", onJoin);

  // نسخ كود الغرفة
  $("btn-copy-code").addEventListener("click", () => {
    navigator.clipboard.writeText(setupRoomCode).catch(() => {});
    toast("تم نسخ الكود: " + setupRoomCode);
  });

  initUpload();
}

// ============================================
//  R2 Upload
// ============================================
const R2_WORKER = "https://rough-cell-19ed.mmsleep95.workers.dev";
const CHUNK_SIZE = 5 * 1024 * 1024;   // 5 MB
const SINGLE_LIMIT = 50 * 1024 * 1024; // 50 MB

let _uploadedUrl = null;
let _uploadXhr = null;
let _uploadAbort = false;
let _pickedFile = null;

function initUpload() {
  const zone = $("upload-zone");
  const fileInput = $("inp-file");

  zone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) pickFile(fileInput.files[0]);
  });

  // Drag & drop
  zone.addEventListener("dragover", e => { e.preventDefault(); zone.classList.add("drag"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag"));
  zone.addEventListener("drop", e => {
    e.preventDefault();
    zone.classList.remove("drag");
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith("video/")) pickFile(f);
  });

  $("btn-upload-cancel").addEventListener("click", cancelUpload);
  $("btn-upload-change").addEventListener("click", resetUpload);
}

function pickFile(file) {
  _pickedFile = file;
  _uploadedUrl = null;
  const zone = $("upload-zone");
  zone.classList.add("picked");
  zone.querySelector(".upload-zone-icon").textContent = "🎬";
  zone.querySelector(".upload-zone-text").textContent = file.name;
  zone.querySelector(".upload-zone-sub").textContent = formatBytes(file.size);
  $("upload-done").style.display = "none";
  startUpload(file);
}

function resetUpload() {
  _uploadedUrl = null;
  _pickedFile = null;
  _uploadAbort = false;
  const zone = $("upload-zone");
  zone.classList.remove("picked");
  zone.querySelector(".upload-zone-icon").textContent = "📁";
  zone.querySelector(".upload-zone-text").textContent = "اضغط لاختيار فيديو";
  zone.querySelector(".upload-zone-sub").textContent = "MP4 · MKV · MOV · WEBM";
  $("upload-done").style.display = "none";
  $("upload-status").style.display = "none";
  $("inp-file").value = "";
}

function cancelUpload() {
  _uploadAbort = true;
  if (_uploadXhr) { _uploadXhr.abort(); _uploadXhr = null; }
  $("upload-status").style.display = "none";
  resetUpload();
  toast("تم إلغاء الرفع");
}

function setUploadProgress(pct, statusText) {
  $("upload-status").style.display = "block";
  $("upload-done").style.display = "none";
  $("upload-status-text").textContent = statusText || "جاري الرفع...";
  $("upload-pct").textContent = Math.round(pct * 100) + "%";
  $("upload-progress-fill").style.width = (pct * 100) + "%";
}

function showUploadDone(name) {
  $("upload-status").style.display = "none";
  $("upload-done").style.display = "flex";
  $("upload-done-name").textContent = name;
}

async function startUpload(file) {
  _uploadAbort = false;
  const mimeType = file.type || "video/mp4";

  if (file.size <= SINGLE_LIMIT) {
    await uploadSmall(file, mimeType);
  } else {
    await uploadMultipart(file, mimeType);
  }
}

async function uploadSmall(file, mimeType) {
  setUploadProgress(0, "جاري رفع الملف...");
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    _uploadXhr = xhr;
    xhr.open("POST", `${R2_WORKER}/api/r2/upload`);
    xhr.setRequestHeader("Content-Type", mimeType);
    xhr.setRequestHeader("x-file-name", file.name);
    xhr.setRequestHeader("x-chat-id", "watchparty");
    xhr.setRequestHeader("x-uploaded-by", "watchparty");
    xhr.setRequestHeader("x-folder", "videos");

    xhr.upload.onprogress = e => {
      if (e.lengthComputable) setUploadProgress(e.loaded / e.total, "جاري الرفع...");
    };
    xhr.onload = () => {
      _uploadXhr = null;
      if (_uploadAbort) return;
      if (xhr.status === 200 || xhr.status === 201) {
        try {
          const data = JSON.parse(xhr.responseText);
          _uploadedUrl = data.publicUrl || data.url || data.fileUrl;
          if (!_uploadedUrl) { console.error("upload response missing publicUrl:", xhr.responseText); showError("فشل: لا يوجد رابط في الرد"); reject(); return; }
          showUploadDone(file.name);
          resolve();
        } catch(e) { console.error("upload parse error:", e, xhr.responseText); showError("فشل قراءة رد الخادم"); reject(); }
      } else {
        console.error("upload failed status:", xhr.status, "body:", xhr.responseText);
        $("upload-status").style.display = "none";
        showError("فشل رفع الملف: " + xhr.status + " — " + xhr.responseText.slice(0, 80));
        reject();
      }
    };
    xhr.onerror = () => {
      _uploadXhr = null;
      if (!_uploadAbort) { console.error("upload XHR network error"); $("upload-status").style.display = "none"; showError("خطأ في الاتصال أثناء الرفع"); }
      reject();
    };
    xhr.send(file);
  });
}

async function uploadMultipart(file, mimeType) {
  setUploadProgress(0, "جاري تهيئة الرفع...");

  // 1. Init
  const initRes = await fetch(`${R2_WORKER}/api/r2/multipart/init`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileName: file.name, chatId: "watchparty", uploadedBy: "watchparty", folder: "videos", contentType: mimeType })
  });
  if (!initRes.ok) { const errTxt = await initRes.text().catch(()=>""); console.error("multipart init failed:", initRes.status, errTxt); showError("فشل بدء الرفع: " + initRes.status + " — " + errTxt.slice(0,80)); return; }
  const { uploadId, objectKey, publicUrl } = await initRes.json();

  const parts = [];
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  let uploaded = 0;

  for (let i = 0; i < totalChunks; i++) {
    if (_uploadAbort) return;
    const start = i * CHUNK_SIZE;
    const chunk = file.slice(start, start + CHUNK_SIZE);
    setUploadProgress(uploaded / file.size, `جزء ${i + 1} من ${totalChunks}`);

    // retry 3x
    let etag = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      const partRes = await fetch(`${R2_WORKER}/api/r2/multipart/part`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "x-upload-id": uploadId,
          "x-object-key": objectKey,
          "x-part-number": String(i + 1),
        },
        body: chunk
      });
      if (partRes.ok) { const d = await partRes.json(); etag = d.etag || d.ETag || ""; break; }
      const pErrTxt = await partRes.text().catch(()=>"");
      console.error(`part ${i+1} attempt ${attempt} failed:`, partRes.status, pErrTxt);
      if (attempt === 3) { showError("فشل رفع جزء " + (i + 1) + ": " + partRes.status + " — " + pErrTxt.slice(0,60)); return; }
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
    parts.push({ partNumber: i + 1, etag });
    uploaded += chunk.size;
    setUploadProgress(uploaded / file.size, `جزء ${i + 1} من ${totalChunks}`);
  }

  if (_uploadAbort) return;
  setUploadProgress(1, "جاري الإنهاء...");

  // Complete
  const compRes = await fetch(`${R2_WORKER}/api/r2/multipart/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uploadId, objectKey, parts, publicUrl })
  });
  if (!compRes.ok) { const cErrTxt = await compRes.text().catch(()=>""); console.error("multipart complete failed:", compRes.status, cErrTxt); showError("فشل إنهاء الرفع: " + compRes.status + " — " + cErrTxt.slice(0,80)); return; }
  const compData = await compRes.json();
  _uploadedUrl = compData.publicUrl || publicUrl;
  showUploadDone(file.name);
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function onCreate() {
  const user = $("inp-username").value.trim();
  if (!user) return showError("اكتب اسمك");

  // لو في فيديو مرفوع استخدمه
  if (_uploadedUrl) {
    videoSrc = { type: "html5", url: _uploadedUrl, hls: false };
    startSession(setupRoomCode, user);
    return;
  }

  // لو في رابط مكتوب
  const url = $("inp-video-url").value.trim();
  if (url) {
    const parsed = parseVideoUrl(url);
    if (!parsed) return showError("رابط الفيديو غير صحيح (محتاج .mp4 / .m3u8 / YouTube)");
    videoSrc = parsed;
  }

  // ممكن يبدأ الغرفة بدون فيديو (هيضيف لاحقاً)
  startSession(setupRoomCode, user);
}

function onJoin() {
  const user = $("inp-username").value.trim();
  const code = $("inp-join-code").value.trim().toUpperCase();
  if (!user) return showError("اكتب اسمك");
  if (!code || code.length < 4) return showError("اكتب كود الغرفة");
  // المنضم هياخد مصدر الفيديو من السيرفر (room_state)
  startSession(code, user);
}

function showError(msg) {
  $("join-error").textContent = "❌ " + msg;
}

function _keepAlive() {
  // يمنع Chrome من عمل tab discard أو تعليق الـ JS لما التاب في الخلفية
  if (navigator.locks) {
    navigator.locks.request("wp-keep-alive", { mode: "shared" }, () =>
      new Promise(() => {}) // promise مش بتتحل = lock دايماً شغال
    );
  }
  // Screen Wake Lock لو الجهاز موبايل — يمنع الشاشة من الإغلاق التلقائي
  if ("wakeLock" in navigator) {
    const _acquireWakeLock = async () => {
      try {
        const wl = await navigator.wakeLock.request("screen");
        document.addEventListener("visibilitychange", async () => {
          if (document.visibilityState === "visible") {
            try { await navigator.wakeLock.request("screen"); } catch(_) {}
          }
        }, { once: false });
      } catch(_) {}
    };
    _acquireWakeLock();
  }
}

function startSession(room, user) {
  roomId = room;
  username = user;
  localStorage.setItem("wp-username", user);
  _keepAlive();
  $("join-error").textContent = "";
  $("btn-create").textContent = "⏳ جاري الاتصال...";

  connect()
    .then(() => {
      buildSidebar();
      showScreen("watch");
      if (videoSrc) loadPlayer(videoSrc);
    })
    .catch((e) => {
      showError("تعذر الاتصال بالسيرفر: " + e.message);
      $("btn-create").textContent = "🎉 أنشئ الغرفة";
    });
}

// ============================================
//  الاتصال بالسيرفر
// ============================================
function connect() {
  return new Promise((resolve, reject) => {
    if (socket) { socket.close(); socket = null; }
    const ws = new WebSocket(SERVER_URL);
    const timeout = setTimeout(() => { ws.close(); reject(new Error("انتهت المهلة")); }, 12000);

    ws.onopen = () => {
      clearTimeout(timeout);
      socket = ws;
      _roomStateReceived = false;
      // ابعت الانضمام + مصدر الفيديو (لو منشئ الغرفة)
      ws.send(JSON.stringify({ type: "join", roomId, username }));
      if (videoSrc) {
        ws.send(JSON.stringify({ type: "set_source", roomId, username, source: videoSrc }));
      }
      resolve();
    };
    ws.onerror = () => { clearTimeout(timeout); reject(new Error("فشل الاتصال")); };
    ws.onclose = () => {
      if (socket === ws) {
        socket = null;
        toast("🔴 انقطع الاتصال — جاري إعادة الاتصال...");
        _scheduleReconnect();
      }
    };
    ws.onmessage = (e) => { try { handleMessage(JSON.parse(e.data)); } catch (err) {} };
  });
}

function isConnected() { return socket && socket.readyState === WebSocket.OPEN; }
function send(obj) { if (isConnected()) socket.send(JSON.stringify(obj)); }

let _reconnectTimer = null;
let _reconnectAttempts = 0;

function _scheduleReconnect() {
  if (_reconnectTimer) return;
  // exponential backoff: 2s, 4s, 8s, max 30s
  const delay = Math.min(2000 * Math.pow(2, _reconnectAttempts), 30000);
  _reconnectAttempts++;
  _reconnectTimer = setTimeout(async () => {
    _reconnectTimer = null;
    if (!roomId || !username) return;
    try {
      await connect();
      _reconnectAttempts = 0;
      toast("✅ عاد الاتصال");
      // أعد إرسال الـ join + voice لو كنت فيه
      if (inVoice) send({ type: "voice_join", roomId, username });
    } catch (_) {
      _scheduleReconnect(); // حاول تاني
    }
  }, delay);
}

// لما التاب يرجع للأمام — تحقق من الاتصال فوراً
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && roomId && !isConnected()) {
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
    _reconnectAttempts = 0;
    _scheduleReconnect();
  }
});

function handleMessage(msg) {
  switch (msg.type) {
    case "sync":
      applySync(msg.action, msg.time);
      addEvent(msg.by, msg.action, msg.time);
      break;
    case "chat":
      addChat(msg.username, msg.text, msg.username === username);
      break;
    case "user_joined": addEvent(msg.username, "joined"); break;
    case "user_left": addEvent(msg.username, "left"); break;
    case "members": renderMembers(msg.members); break;
    case "reaction": floatReaction(msg.emoji); break;
    case "room_state": {
      _roomStateReceived = true;
      const _autoUrl = new URLSearchParams(window.location.search).get("url");
      if (_autoUrl) {
        // auto-join من Flutter: نحمّل من URL params لو لسه ما حملناش
        if (!player && videoSrc) {
          loadPlayer(videoSrc);
        }
      } else if (msg.source) {
        // guest عادي: خد الـ source من السيرفر
        videoSrc = msg.source;
        if (!player) loadPlayer(videoSrc);
      }
      if (msg.currentTime != null) {
        const _syncTime = msg.currentTime;
        const _syncPlay = msg.isPlaying;
        // نستنى عشان الـ player يتحمل
        setTimeout(() => {
          if (!player) return;
          applySync("seek", _syncTime);
          if (_syncPlay) setTimeout(() => { if (player) applySync("play", _syncTime); }, 500);
        }, 1200);
      }
      break; }
    case "source":
      // الهوست غيّر الفيديو — حمّل الجديد
      // لو room_state وصل بالفعل وحمّل الفيديو، مش محتاجين نعيد التحميل
      if (msg.source) {
        videoSrc = msg.source;
        if (!_roomStateReceived || !player) {
          loadPlayer(videoSrc);
        }
        // reset عشان التغييرات الجاية تتطبق
        _roomStateReceived = false;
      }
      break;
    case "voice_state":
      handleVoiceState(msg.voiceUids || []);
      break;
    case "voice_offer":
      handleVoiceOffer(msg);
      break;
    case "voice_answer":
      handleVoiceAnswer(msg);
      break;
    case "voice_ice":
      handleVoiceIce(msg);
      break;
  }
}

// ============================================
//  المشغّل الموحّد (HTML5 / YouTube)
// ============================================
function loadPlayer(src) {
  // لو فيه youtubeUrl (من Flutter)، استخرج منه الـ id وشغّل YouTube
  if (src.youtubeUrl) {
    const parsed = parseVideoUrl(src.youtubeUrl);
    if (parsed && parsed.type === "youtube") { loadYouTube(parsed.id); return; }
  }
  if (src.type === "youtube") {
    // لو الـ id مش موجود جرّب نستخرجه من الـ url
    const id = src.id || (src.url ? (parseVideoUrl(src.url) || {}).id : null);
    if (id) { loadYouTube(id); return; }
  }
  // html5 أو r2 عادي
  const url = src.url || "";
  if (!url) return;
  loadHtml5({ url, hls: /\.m3u8(\?|$)/i.test(url) });
}

// ── HTML5 (MP4 / HLS) ──
function loadHtml5(src) {
  showQualityBar(false);
  $("yt-player").style.display = "none";
  const v = $("html5-video");
  v.style.display = "block";
  v.controls = true;

  if (src.hls && window.Hls && Hls.isSupported()) {
    const hls = new Hls();
    hls.loadSource(src.url);
    hls.attachMedia(v);
  } else {
    v.src = src.url; // mp4 أو HLS أصلي (Safari)
  }

  v.addEventListener("play", () => emit("play", v.currentTime));
  v.addEventListener("pause", () => emit("pause", v.currentTime));
  v.addEventListener("seeked", () => emit("seek", v.currentTime));

  player = {
    play: () => v.play().catch(() => {}),
    pause: () => v.pause(),
    seek: (t) => { v.currentTime = t; },
    getTime: () => v.currentTime,
  };
}

// ── YouTube ──
let _ytInstance = null; // نحتفظ بالـ YT.Player instance عشان نعمل destroy

function loadYouTube(videoId) {
  showQualityBar(true);
  $("html5-video").style.display = "none";

  // destroy الـ player القديم لو موجود
  if (_ytInstance) {
    try { _ytInstance.destroy(); } catch(_) {}
    _ytInstance = null;
    ytPlayer = null;
    player = null;
    const shield = document.getElementById("yt-click-shield");
    if (shield) shield.style.display = "none";
  }

  // أعد إنشاء الـ div عشان YT.Player يشتغل صح
  const wrap = $("player-wrap");
  let ytDiv = $("yt-player");
  if (ytDiv) ytDiv.remove();
  ytDiv = document.createElement("div");
  ytDiv.id = "yt-player";
  wrap.appendChild(ytDiv);
  ytDiv.style.display = "block";

  const create = () => {
    const yt = new YT.Player("yt-player", {
      videoId,
      width: "100%",
      height: "100%",
      playerVars: { autoplay: 0, controls: 1, rel: 0, playsinline: 1, enablejsapi: 1 },
      events: {
        onReady: () => {
          _ytInstance = yt;
          ytPlayer = yt;
          player = {
            play: () => { try { yt.playVideo(); } catch(_) {} },
            pause: () => { try { yt.pauseVideo(); } catch(_) {} },
            seek: (t) => { try { yt.seekTo(t, true); } catch(_) {} },
            getTime: () => { try { return yt.getCurrentTime() || 0; } catch(_) { return 0; } },
            _yt: yt,
          };
          // فعّل الـ shield عشان نقدر نمسك click فوق الـ iframe
          const shield = document.getElementById("yt-click-shield");
          if (shield) {
            shield.style.display = "block";
            shield.onclick = () => showOverlay();
          }
        },
        onStateChange: (e) => {
          if (isSyncing || !player) return;
          try {
            const t = yt.getCurrentTime();
            // BUFFERING(3) نتجاهله — مش حدث حقيقي من اليوزر
            if (e.data === YT.PlayerState.PLAYING) emit("play", t);
            else if (e.data === YT.PlayerState.PAUSED) {
              // نتجاهل PAUSED لو جاءت أثناء الـ buffering (بعد seek)
              // نستنى 200ms ونتحقق إن الـ player فعلاً وقف
              setTimeout(() => {
                if (!isSyncing && player) {
                  try {
                    const state = yt.getPlayerState();
                    if (state === YT.PlayerState.PAUSED) emit("pause", yt.getCurrentTime());
                  } catch(_) {}
                }
              }, 200);
            }
          } catch(_) {}
        },
      },
    });
  };

  if (window.YT && YT.Player) { create(); return; }
  if (!ytApiLoading) {
    ytApiLoading = true;
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
  }
  window.onYouTubeIframeAPIReady = () => { ytReady = true; create(); };
}

// ── إرسال حدث ──
function emit(action, time) {
  if (isSyncing || !isConnected()) return;
  send({ type: action, roomId, username, time });
}

// ── تطبيق مزامنة ──
function applySync(action, time) {
  if (!player) return;
  isSyncing = true;
  clearTimeout(applySync._t);

  const TOL = 1.5;
  const needSeek = action === "seek" || Math.abs(player.getTime() - time) > TOL;

  if (action === "play") {
    if (needSeek) {
      player.seek(time);
      // نستنى الـ seek يخلص قبل الـ play — مهم مع YouTube IFrame API
      applySync._t = setTimeout(() => {
        if (player) player.play();
        // نفضل isSyncing=true لحد ما YouTube يطلق PLAYING event ويتجاهلها
        applySync._t = setTimeout(() => { isSyncing = false; }, 1500);
      }, 500);
    } else {
      player.play();
      applySync._t = setTimeout(() => { isSyncing = false; }, 1500);
    }
  } else if (action === "pause") {
    if (needSeek) player.seek(time);
    player.pause();
    applySync._t = setTimeout(() => { isSyncing = false; }, 800);
  } else {
    // seek فقط
    player.seek(time);
    applySync._t = setTimeout(() => { isSyncing = false; }, 600);
  }
}
applySync._t = null;

// ============================================
//  الشريط الجانبي
// ============================================
const EMOJI_QUICK = ["😂", "❤️", "😮", "😢", "🔥", "👏", "🎉"];
const EMOJI_SET = ["😂","🤣","❤️","🔥","👏","🎉","😮","😢","😡","👍","👎","🙏","😍","🥰","😎","🤔","😴","🤯","💀","👀","🙌","💯","✨","🎬","🍿","😱","😅","😭","🥳","🤩","😏","🫡","🤝","💔","⭐","😬"];

function buildSidebar() {
  $("sb-room-code").textContent = roomId;
  try { $("ov-room-code").textContent = roomId; } catch(_) {}

  const copy = () => { navigator.clipboard.writeText(roomId).catch(() => {}); toast("✓ تم نسخ الكود: " + roomId); };
  $("sb-room-code").onclick = copy;
  $("sb-share").onclick = copy;
  $("sb-leave").onclick = () => { leaveVoice(); location.reload(); };
  try { $("sb-close-chat").onclick = () => toggleChat(false); } catch(_) {}

  // زرار تغيير الفيديو
  $("sb-change-video").onclick = () => {
    const panel = $("change-video-panel");
    const isOpen = panel.style.display !== "none";
    panel.style.display = isOpen ? "none" : "";
    if (!isOpen) setTimeout(() => $("inp-change-url").focus(), 50);
  };
  $("btn-change-cancel").onclick = () => { $("change-video-panel").style.display = "none"; };
  $("btn-change-confirm").onclick = () => _changeVideo();
  $("inp-change-url").addEventListener("keydown", (e) => { if (e.key === "Enter") _changeVideo(); });
  initRoomUpload();

  // زر مكتبة الفيديوهات
  $("sb-media").onclick = toggleMediaPanel;
  $("media-close").onclick = () => { $("media-panel").style.display = "none"; };
  $("media-refresh").onclick = loadMediaList;

  initVoiceBar();
  renderVoiceAvatars();

  // إيموجي سريع
  const bar = $("sb-emoji-bar");
  bar.innerHTML = "";
  EMOJI_QUICK.forEach(e => bar.appendChild(el("span", { class: "emo", text: e, onclick: () => sendReaction(e) })));

  // إدخال
  const input = $("sb-chat-input");
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });
  $("sb-send").onclick = sendChat;

  initVideoOverlay();
  initSidebarResize();

  // في portrait: إغلاق الشات لما تضغط على الفيديو (بس مش بعد drag)
  $("video-area")?.addEventListener("click", () => {
    if (_isLandscapeOrFs()) return;
    if (window._sidebarDidDrag && window._sidebarDidDrag()) return; // كان بيسحب مش بيضغط
    const sb = $("sidebar");
    if (sb?.classList.contains("open")) toggleChat(false);
  });

  // fullscreen events
  document.addEventListener("fullscreenchange", _onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", _onFullscreenChange);

  addEvent(null, "welcome");
}

// ── Video Overlay + FABs (زي التطبيق بالظبط) ─────────────────────
let _overlayTimer = null;

function _doMute() {
  micMuted = !micMuted;
  if (localStream) localStream.getAudioTracks().forEach(t => { t.enabled = !micMuted; });
  const muteText = micMuted ? "🔇" : "🎤";
  try { $("fb-mute").textContent = muteText; $("fb-mute").classList.toggle("muted", micMuted); } catch(_) {}
  try { $("fab-mute").textContent = muteText; $("fab-mute").classList.toggle("muted", micMuted); } catch(_) {}
  try { $("btn-mute").textContent = micMuted ? "🔇 أنت مكتوم" : "🎤"; $("btn-mute").classList.toggle("muted", micMuted); } catch(_) {}
  toast(micMuted ? "تم كتم الميكروفون 🔇" : "الميكروفون مفعّل 🎤");
}

function _doVoiceToggle() {
  if (inVoice) {
    showConfirm({
      title: "خروج من المكالمة",
      message: "هتخرج من المكالمة الصوتية؟",
      confirmText: "خروج",
      confirmClass: "confirm-danger",
      onConfirm: () => {
        leaveVoice();
        try { $("fb-voice").classList.remove("in-voice"); $("fb-voice").textContent = "🎙"; $("fb-mute").style.display = "none"; } catch(_) {}
        try { $("fab-voice").classList.remove("in-voice"); $("fab-mute").style.display = "none"; } catch(_) {}
        toast("خرجت من الصوت");
      }
    });
  } else {
    showConfirm({
      title: "انضمام للمكالمة",
      message: "هتنضم للمكالمة الصوتية مع أعضاء الغرفة؟",
      confirmText: "انضمام",
      confirmClass: "confirm-primary",
      onConfirm: () => {
        joinVoice().then(() => {
          try { $("fb-voice").classList.add("in-voice"); $("fb-voice").textContent = "🔴"; $("fb-mute").style.display = ""; } catch(_) {}
          try { $("fab-voice").classList.add("in-voice"); $("fab-mute").style.display = ""; } catch(_) {}
          toast("دخلت الصوت 🎙");
        }).catch(err => toast("❌ " + (err.message || "فشل الصوت")));
      }
    });
  }
}

function showConfirm({ title, message, confirmText, confirmClass, onConfirm }) {
  // إزالة أي dialog قديم
  const old = document.getElementById("confirm-dialog");
  if (old) old.remove();

  const overlay = document.createElement("div");
  overlay.id = "confirm-dialog";
  overlay.innerHTML = `
    <div class="confirm-box">
      <div class="confirm-title">${title}</div>
      <div class="confirm-msg">${message}</div>
      <div class="confirm-btns">
        <button class="confirm-btn confirm-cancel">إلغاء</button>
        <button class="confirm-btn ${confirmClass}">${confirmText}</button>
      </div>
    </div>
  `;

  overlay.querySelector(".confirm-cancel").onclick = () => overlay.remove();
  overlay.querySelector("." + confirmClass).onclick = () => { overlay.remove(); onConfirm(); };
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  document.body.appendChild(overlay);
}

function _doRotate() {
  if (!screen.orientation || !screen.orientation.lock) { toast("⚠️ اقلب جهازك يدوياً"); return; }
  const cur = screen.orientation.type || "";
  const target = cur.includes("landscape") ? "portrait" : "landscape";
  screen.orientation.lock(target).catch(() => toast("⚠️ اقلب جهازك يدوياً"));
}

function initVideoOverlay() {
  const overlay = $("video-overlay");
  const va = $("video-area");

  // ملء إيموجي bar في overlay
  const emoBar = $("ov-emojis");
  if (emoBar) {
    EMOJI_QUICK.forEach(em => {
      const btn = el("span", { class: "ov-emo", text: em });
      btn.onclick = (e) => { e.stopPropagation(); sendReaction(em); showOverlay(); };
      emoBar.appendChild(btn);
    });
  }

  // === Overlay buttons ===
  $("fb-fullscreen").onclick = toggleFullscreen;
  $("fb-rotate").onclick     = () => { _doRotate(); showOverlay(); };
  $("fb-mute").onclick       = () => { _doMute(); showOverlay(); };
  $("fb-voice").onclick      = () => { _doVoiceToggle(); showOverlay(); };
  $("fb-chat").onclick       = () => { toggleChat(); showOverlay(); };

  // Center: play/skip
  $("ov-play").onclick       = () => { togglePlayPause(); showOverlay(); };
  $("ov-skip-back").onclick  = () => { seekRelative(-10); showOverlay(); };
  $("ov-skip-fwd").onclick   = () => { seekRelative(10);  showOverlay(); };

  // Seek bar
  const seekEl = $("ov-seek");
  let _seeking = false;
  seekEl.addEventListener("input", () => {
    _seeking = true;
    const val = seekEl.value / 1000;
    seekRelativeTo(val);
    showOverlay();
  });
  seekEl.addEventListener("change", () => { _seeking = false; });

  // FABs
  $("fab-voice").onclick = _doVoiceToggle;
  $("fab-mute").onclick  = _doMute;
  try { $("fab-chat").onclick = () => toggleChat(); } catch(_) {}
  $("btn-toggle-chat").onclick = () => toggleChat();

  // حالة أولية لزرار الشات
  if (_isDesktop()) {
    $("btn-toggle-chat").classList.add("chat-open"); // مفتوح في desktop افتراضياً
  }

  // Room code in overlay top
  try { $("ov-room-code").textContent = roomId || ""; } catch(_) {}

  // Close sidebar from X button inside sidebar
  try { $("sb-close-chat").onclick = () => toggleChat(false); } catch(_) {}

  // Show overlay on interaction with video area
  va.addEventListener("click", () => { if (!_seeking) showOverlay(); });
  va.addEventListener("mousemove", showOverlay);
  va.addEventListener("touchstart", showOverlay, { passive: true });

  // Sync progress bar
  _startProgressSync();
}

function _startProgressSync() {
  setInterval(() => {
    let cur = 0, dur = 1, paused = true;
    const video = $("html5-video");
    if (video && video.style.display !== "none" && video.duration) {
      cur = video.currentTime; dur = video.duration; paused = video.paused;
    } else if (ytPlayer && typeof ytPlayer.getDuration === "function" && ytPlayer.getDuration() > 0) {
      cur = ytPlayer.getCurrentTime(); dur = ytPlayer.getDuration();
      paused = ytPlayer.getPlayerState() !== 1;
    } else return;
    const pct = cur / dur;
    const seekEl = $("ov-seek");
    if (seekEl) {
      seekEl.value = Math.round(pct * 1000);
      seekEl.style.setProperty("--progress", (pct * 100).toFixed(2) + "%");
    }
    const t = $("ov-time"), d = $("ov-dur");
    if (t) t.textContent = fmtTime(cur);
    if (d) d.textContent = fmtTime(dur);
    const playBtn = $("ov-play");
    if (playBtn) playBtn.textContent = paused ? "▶" : "⏸";
  }, 500);
}

function fmtTime(s) {
  if (!s || isNaN(s)) return "0:00";
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m + ":" + String(sec).padStart(2, "0");
}

function togglePlayPause() {
  const video = $("html5-video");
  if (video && video.style.display !== "none") {
    if (video.paused) { video.play(); send({ type: "play",  roomId, username, time: video.currentTime }); }
    else              { video.pause(); send({ type: "pause", roomId, username, time: video.currentTime }); }
  } else if (ytPlayer && typeof ytPlayer.getPlayerState === "function") {
    const st = ytPlayer.getPlayerState();
    if (st === 1) { ytPlayer.pauseVideo(); send({ type: "pause", roomId, username, time: ytPlayer.getCurrentTime() }); }
    else          { ytPlayer.playVideo();  send({ type: "play",  roomId, username, time: ytPlayer.getCurrentTime() }); }
  }
}

function seekRelative(delta) {
  const video = $("html5-video");
  if (video && video.style.display !== "none") {
    const t = Math.max(0, Math.min(video.duration || 0, video.currentTime + delta));
    video.currentTime = t;
    send({ type: "seek", roomId, username, time: t });
  } else if (ytPlayer && typeof ytPlayer.getCurrentTime === "function") {
    const t = Math.max(0, ytPlayer.getCurrentTime() + delta);
    ytPlayer.seekTo(t, true);
    send({ type: "seek", roomId, username, time: t });
  }
}

function seekRelativeTo(pct) {
  const video = $("html5-video");
  if (video && video.style.display !== "none" && video.duration) {
    const t = pct * video.duration;
    video.currentTime = t;
    send({ type: "seek", roomId, username, time: t });
  } else if (ytPlayer && typeof ytPlayer.getDuration === "function") {
    const t = pct * ytPlayer.getDuration();
    ytPlayer.seekTo(t, true);
    send({ type: "seek", roomId, username, time: t });
  }
}

function showOverlay() {
  const ov = $("video-overlay");
  ov.classList.add("visible");
  // أخفي FABs لما الـ overlay ظاهر في landscape/fullscreen
  const isLandFs = _isLandscapeOrFs();
  if (isLandFs) $("fabs")?.classList.add("hidden");
  clearTimeout(_overlayTimer);
  _overlayTimer = setTimeout(() => {
    ov.classList.remove("visible");
    if (isLandFs) $("fabs")?.classList.remove("hidden");
  }, 4000);
}

function _isLandscapeOrFs() {
  return window.matchMedia("(orientation: landscape)").matches
    || !!(document.fullscreenElement || document.webkitFullscreenElement)
    || document.body.classList.contains("is-fullscreen");
}

function _isDesktop() {
  return window.innerWidth > 768 && !document.body.classList.contains("is-fullscreen");
}

function toggleChat(forceOpen) {
  const sb = $("sidebar");
  if (!sb) return;

  let willOpen;
  if (_isDesktop()) {
    // desktop: الشات مفتوح افتراضياً — نتحكم بـ chat-hidden على body
    const hidden = document.body.classList.contains("chat-hidden");
    willOpen = forceOpen !== undefined ? forceOpen : hidden; // لو hidden=true نفتحه
    document.body.classList.toggle("chat-hidden", !willOpen);
  } else {
    // mobile / fullscreen: نتحكم بـ .open على sidebar
    willOpen = forceOpen !== undefined ? forceOpen : !sb.classList.contains("open");
    sb.classList.toggle("open", willOpen);
  }

  try { $("fb-chat").classList.toggle("chat-open", willOpen); } catch(_) {}
  try { $("fab-chat").classList.toggle("chat-open", willOpen); } catch(_) {}
  try { $("btn-toggle-chat").classList.toggle("chat-open", willOpen); } catch(_) {}

  // أخفي الـ notification لما الشات يفتح
  if (willOpen) {
    const notif = document.getElementById("chat-notif");
    if (notif) notif.classList.remove("show");
  }
}

function toggleSidebarOverlay() { toggleChat(); } // backward compat

// ── Sidebar Resize ────────────────────────────────────────────────
function initSidebarResize() {
  const resizer = $("sidebar-resizer");
  const sidebar = $("sidebar");
  const watchRoot = $("watch-root");
  if (!resizer || !sidebar) return;

  let _dragging = false;
  let _startX = 0, _startY = 0;
  let _startW = 0, _startH = 0;

  function isHorizontal() {
    // desktop أو landscape
    return window.innerWidth > 768 || window.matchMedia("(orientation: landscape)").matches;
  }

  function updateResizerVisibility() {
    const horiz = isHorizontal();
    const chatVisible = _isDesktop()
      ? !document.body.classList.contains("chat-hidden")
      : sidebar.classList.contains("open");
    const show = horiz ? chatVisible : chatVisible; // في portrait: بس لما مفتوح
    resizer.classList.toggle("visible", show);
    if (!horiz) {
      // portrait: inline style لأن CSS مش بيتحكم فيه بـ class في portrait
      resizer.style.display = show ? "flex" : "none";
    } else {
      resizer.style.display = ""; // الـ CSS يتحكم
    }
  }

  const _resizerObserver = new MutationObserver(() => updateResizerVisibility());
  _resizerObserver.observe(sidebar, { attributes: true, attributeFilter: ["class"] });
  _resizerObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  updateResizerVisibility();

  let _didDrag = false;

  function onStart(e) {
    _dragging = true;
    _didDrag = false;
    const touch = e.touches ? e.touches[0] : e;
    _startX = touch.clientX;
    _startY = touch.clientY;
    _startW = sidebar.offsetWidth;
    _startH = sidebar.offsetHeight;
    document.addEventListener("mousemove", onMove, { passive: false });
    document.addEventListener("mouseup", onEnd);
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd);
    e.preventDefault();
    e.stopPropagation();
  }

  function onMove(e) {
    if (!_dragging) return;
    if (e.cancelable) e.preventDefault();
    _didDrag = true;
    const touch = e.touches ? e.touches[0] : e;

    if (isHorizontal()) {
      const delta = touch.clientX - _startX;
      const newW = Math.min(Math.max(_startW - delta, 150), Math.round(window.innerWidth * 0.65));
      sidebar.style.width = newW + "px";
      sidebar.style.flex = "none";
    } else {
      const delta = _startY - touch.clientY;
      const maxH = Math.round(window.innerHeight * 0.82);
      const newH = Math.min(Math.max(_startH + delta, 80), maxH);
      sidebar.style.maxHeight = maxH + "px";
      sidebar.style.flex = "0 0 " + newH + "px";
      sidebar.style.height = newH + "px";
    }
  }

  function onEnd() {
    _dragging = false;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onEnd);
    document.removeEventListener("touchmove", onMove);
    document.removeEventListener("touchend", onEnd);
  }

  // منع video-area click من إغلاق الشات بعد drag
  window._sidebarDidDrag = () => _didDrag;

  resizer.addEventListener("mousedown", onStart);
  resizer.addEventListener("touchstart", onStart, { passive: false });

  // زرار إغلاق الشات في الـ resizer
  const closeBtn = document.getElementById("resizer-close");
  if (closeBtn) {
    closeBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleChat(false); });
    closeBtn.addEventListener("touchend", (e) => { e.stopPropagation(); e.preventDefault(); toggleChat(false); });
  }

  // double-click/tap = reset الحجم للافتراضي
  let _lastTap = 0;
  function onReset() {
    sidebar.style.width = "";
    sidebar.style.height = "";
    sidebar.style.flex = "";
    sidebar.style.maxHeight = "";
  }
  resizer.addEventListener("dblclick", onReset);
  resizer.addEventListener("touchend", (e) => {
    const now = Date.now();
    if (now - _lastTap < 350) onReset();
    _lastTap = now;
  });
}

function toggleFullscreen() {
  if (!document.fullscreenElement && !document.webkitFullscreenElement) {
    const fsEl = document.documentElement;
    (fsEl.requestFullscreen || fsEl.webkitRequestFullscreen || (() => toast("⚠️ المتصفح لا يدعم الشاشة الكاملة"))).call(fsEl);
    if (screen.orientation && screen.orientation.lock) {
      screen.orientation.lock("landscape").catch(() => {});
    }
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
    if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
  }
}

function _onFullscreenChange() {
  const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
  document.body.classList.toggle("is-fullscreen", isFs);
  if (isFs) {
    try { $("fb-fullscreen").textContent = "✕"; } catch(_) {}
    showOverlay();
  } else {
    try { $("fb-fullscreen").textContent = "⛶"; } catch(_) {}
    try { screen.orientation?.unlock?.(); } catch(_) {}
    // عند الخروج من fullscreen: أغلق الشات (في desktop هيفتح تلقائياً بالـ CSS)
    const sb = $("sidebar");
    if (sb) sb.classList.remove("open");
    try { $("btn-toggle-chat").classList.remove("chat-open"); } catch(_) {}
    try { $("fb-chat").classList.remove("chat-open"); } catch(_) {}
  }
}

function renderMembers(members) {
  const box = $("sb-members");
  box.innerHTML = "";
  members.forEach(name => {
    const you = name === username;
    box.appendChild(el("span", { class: "member" + (you ? " you" : "") },
      avatarEl(name), you ? name + " (أنت)" : name));
  });
}

function addChat(from, text, self) {
  const feed = $("sb-feed");
  feed.appendChild(el("div", { class: "msg" + (self ? " self" : "") },
    avatarEl(from),
    el("div", { class: "bubble" },
      el("div", { class: "name", text: self ? from + " (أنت)" : from }),
      el("div", { class: "text", text }))
  ));
  feed.scrollTop = feed.scrollHeight;

  // لو الشات مغلق، اعرض notification bubble على الشمال
  if (!self && !_isChatVisible()) showChatNotif(from, text);
}

function _isChatVisible() {
  if (_isDesktop()) return !document.body.classList.contains("chat-hidden");
  const sb = $("sidebar");
  return sb ? sb.classList.contains("open") : false;
}

let _notifTimer = null;
function showChatNotif(from, text) {
  let notif = document.getElementById("chat-notif");
  if (!notif) {
    notif = document.createElement("div");
    notif.id = "chat-notif";
    notif.onclick = () => { toggleChat(true); notif.classList.remove("show"); };
    document.body.appendChild(notif);
  }
  notif.innerHTML = `<span class="chat-notif-name">${from}</span><span class="chat-notif-text">${text}</span>`;
  notif.classList.add("show");
  clearTimeout(_notifTimer);
  _notifTimer = setTimeout(() => notif.classList.remove("show"), 4000);
}

function addEvent(who, action, time) {
  const feed = $("sb-feed");
  let txt = "";
  switch (action) {
    case "play": txt = `شغّل الفيديو${time != null ? " عند " + fmtTime(time) : ""}`; break;
    case "pause": txt = `أوقف الفيديو${time != null ? " عند " + fmtTime(time) : ""}`; break;
    case "seek": txt = `انتقل إلى ${fmtTime(time)}`; break;
    case "joined": txt = "انضم للغرفة 🎉"; break;
    case "left": txt = "غادر الغرفة"; break;
    case "welcome": txt = "🎬 أهلاً بك في الغرفة"; break;
    default: return;
  }
  const d = el("div", { class: "event" });
  if (who) d.appendChild(el("b", { text: who + " " }));
  d.appendChild(document.createTextNode(txt));
  feed.appendChild(d);
  feed.scrollTop = feed.scrollHeight;
}

function sendChat() {
  const input = $("sb-chat-input");
  const text = input.value.trim();
  if (!text || !isConnected()) return;
  input.value = "";
  send({ type: "chat", roomId, username, text });
}

function sendReaction(emoji) {
  floatReaction(emoji);
  send({ type: "reaction", roomId, username, emoji });
}

function floatReaction(emoji) {
  const e = el("div", { class: "float-reaction", text: emoji });
  const maxX = Math.max(80, window.innerWidth - 400);
  e.style.left = (40 + Math.random() * maxX) + "px";
  e.style.top = (window.innerHeight - 120) + "px";
  document.body.appendChild(e);
  setTimeout(() => e.remove(), 2300);
}


// ============================================
//  تحكم جودة YouTube
// ============================================
function initQualityBar() {
  const sel = $("quality-select");
  sel.addEventListener("change", () => {
    if (!player || !player._yt) return;
    const v = sel.value;
    if (v === "auto") {
      player._yt.setPlaybackQualityRange("small", "hd2160");
    } else {
      player._yt.setPlaybackQuality(v);
    }
  });
}

// أظهر/أخفي شريط الجودة بناءً على نوع المشغّل
function showQualityBar(show) {
  $("quality-bar").style.display = show ? "flex" : "none";
  if (!show) $("quality-select").value = "auto";
}

// ============================================
//  Voice Chat — WebRTC
// ============================================
let localStream = null;
let inVoice = false;
let micMuted = false;
const peerConnections = {}; // username → RTCPeerConnection
const voiceUsers = new Set(); // المستخدمون في الصوت حالياً

const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    // TURN عشان يشتغل بين شبكات مختلفة
    { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
  ]
};

function initVoiceBar() {
  const btnVoice = $("btn-voice");
  const btnMute = $("btn-mute");

  btnVoice.addEventListener("click", () => _doVoiceToggle());

  btnMute.addEventListener("click", () => {
    micMuted = !micMuted;
    if (localStream) {
      localStream.getAudioTracks().forEach(t => { t.enabled = !micMuted; });
    }
    btnMute.textContent = micMuted ? "🔇 أنت مكتوم" : "🎤";
    btnMute.classList.toggle("muted", micMuted);
    toast(micMuted ? "تم كتم الميكروفون" : "الميكروفون مفعّل");
  });
}

async function joinVoice() {
  // تحقق إن المتصفح يدعم getUserMedia
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast("⚠️ متصفحك لا يدعم المكالمات الصوتية");
    return;
  }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (e) {
    const name = e.name || "";
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      toast("🔒 اسمح للموقع بالوصول للميكروفون من إعدادات المتصفح");
    } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      toast("🎙 لم يُعثر على ميكروفون — تأكد من توصيله");
    } else if (name === "NotReadableError") {
      toast("⚠️ الميكروفون مستخدم من تطبيق آخر");
    } else {
      toast("تعذر الوصول للميكروفون: " + (e.message || name || e));
    }
    return;
  }

  inVoice = true;
  micMuted = false;
  $("btn-voice").textContent = "🔴 مغادرة الصوت";
  $("btn-voice").classList.add("active");
  $("btn-mute").style.display = "";
  $("btn-mute").textContent = "🎤";
  $("btn-mute").classList.remove("muted");
  $("fb-mute").style.display = "";
  $("fb-mute").textContent = "🎤";
  $("fb-mute").classList.remove("muted");
  try { $("fb-voice").classList.add("in-voice"); $("fb-voice").textContent = "🔴"; } catch(_) {}
  try { $("fab-voice").classList.add("in-voice"); $("fab-mute").style.display = ""; } catch(_) {}

  send({ type: "voice_join", roomId, username });
  toast("انضممت للصوت 🎙");
}

function leaveVoice() {
  inVoice = false;

  // أغلق كل الاتصالات
  Object.keys(peerConnections).forEach(uid => closePeer(uid));

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }

  $("btn-voice").textContent = "🎙 صوت";
  $("btn-voice").classList.remove("active");
  $("btn-mute").style.display = "none";
  $("fb-mute").style.display = "none";
  try { $("fb-voice").classList.remove("in-voice"); $("fb-voice").textContent = "🎙"; } catch(_) {}
  try { $("fab-voice").classList.remove("in-voice"); $("fab-mute").style.display = "none"; } catch(_) {}

  // امسح الـ audio elements
  $("remote-audios").innerHTML = "";

  send({ type: "voice_leave", roomId, username });
  toast("غادرت الصوت");
}

function closePeer(uid) {
  if (peerConnections[uid]) {
    peerConnections[uid].close();
    delete peerConnections[uid];
  }
  const audioEl = document.getElementById("audio-" + uid);
  if (audioEl) audioEl.remove();
}

function createPeer(uid, isInitiator) {
  closePeer(uid);

  const pc = new RTCPeerConnection(ICE_SERVERS);
  peerConnections[uid] = pc;

  // أضف التراك المحلي
  if (localStream) {
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  }

  // استقبل الصوت البعيد
  pc.ontrack = (e) => {
    const stream = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
    let audioEl = document.getElementById("audio-" + uid);
    if (!audioEl) {
      audioEl = document.createElement("audio");
      audioEl.id = "audio-" + uid;
      audioEl.autoplay = true;
      audioEl.setAttribute("playsinline", "");
      $("remote-audios").appendChild(audioEl);
    }
    audioEl.srcObject = stream;
    audioEl.play().catch(() => {});
  };

  // إرسال ICE candidates
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      send({ type: "voice_ice", roomId, username, to: uid, candidate: e.candidate });
    }
  };

  if (isInitiator) {
    pc.onnegotiationneeded = async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        send({ type: "voice_offer", roomId, username, to: uid, sdp: pc.localDescription });
      } catch (e) {}
    };
  }

  return pc;
}

function _toSdpInit(raw) {
  if (!raw) return null;
  if (typeof raw === "string") return { type: "offer", sdp: raw };
  if (raw.sdp) return { type: raw.type || "offer", sdp: raw.sdp };
  return null;
}

async function handleVoiceOffer(msg) {
  if (!inVoice || !localStream) return;
  const sdpInit = _toSdpInit(msg.sdp);
  if (!sdpInit) { console.error("[Voice] handleVoiceOffer: invalid sdp", msg.sdp); return; }
  const pc = createPeer(msg.from, false);
  await pc.setRemoteDescription(new RTCSessionDescription(sdpInit));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  send({ type: "voice_answer", roomId, username, to: msg.from, sdp: pc.localDescription });
}

async function handleVoiceAnswer(msg) {
  const pc = peerConnections[msg.from];
  if (!pc) return;
  const sdpInit = _toSdpInit(msg.sdp);
  if (!sdpInit) { console.error("[Voice] handleVoiceAnswer: invalid sdp", msg.sdp); return; }
  await pc.setRemoteDescription(new RTCSessionDescription({ ...sdpInit, type: "answer" }));
}

async function handleVoiceIce(msg) {
  const pc = peerConnections[msg.from];
  if (!pc) return;
  try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch (e) {}
}

function handleVoiceState(uids) {
  const newSet = new Set(uids);

  // تعامل مع من انضم حديثاً
  newSet.forEach(uid => {
    if (uid !== username && !voiceUsers.has(uid)) {
      if (inVoice && localStream) {
        // اللي اسمه أكبر أبجدياً هو اللي يبعت الـ offer — يمنع الـ glare collision
        const shouldOffer = username.localeCompare(uid) > 0;
        createPeer(uid, shouldOffer);
      }
    }
  });

  // تعامل مع من غادر
  voiceUsers.forEach(uid => {
    if (!newSet.has(uid)) {
      closePeer(uid);
    }
  });

  voiceUsers.clear();
  newSet.forEach(uid => voiceUsers.add(uid));

  // لو السيرفر شالني من المكالمة (مثلاً Flutter عمل leave) — اطلع تلقائياً
  if (inVoice && !newSet.has(username)) {
    inVoice = false;
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    try { $("fb-voice").classList.remove("in-voice"); $("fb-voice").textContent = "🎙"; $("fb-mute").style.display = "none"; } catch(_) {}
    try { $("fab-voice").classList.remove("in-voice"); $("fab-mute").style.display = "none"; } catch(_) {}
  }

  renderVoiceAvatars();
}

function renderVoiceAvatars() {
  const box = $("voice-avatars");
  box.innerHTML = "";
  if (voiceUsers.size === 0) {
    box.innerHTML = '<span style="font-size:11px;color:#ffffff35">لا أحد في الصوت</span>';
    return;
  }
  voiceUsers.forEach(uid => {
    const isSelf = uid === username;
    const el2 = document.createElement("span");
    el2.className = "voice-avatar" + (isSelf && inVoice ? " speaking" : "");
    el2.innerHTML = `${avatarEl(uid).outerHTML}<span class="mic-icon${isSelf && micMuted ? " muted" : ""}">${isSelf && micMuted ? "🔇" : "🎤"}</span> ${uid}`;
    box.appendChild(el2);
  });
}

// ============================================
//  Auto-join من URL params
//  مثال: ?room=ABC123&user=أحمد&url=https://youtu.be/xxx
// ============================================
function tryAutoJoin() {
  const params = new URLSearchParams(window.location.search);
  const room = params.get("room");
  const user = params.get("user");
  const url  = params.get("url");

  if (!room || !user) return false;

  const parsed = url ? parseVideoUrl(decodeURIComponent(url)) : null;
  if (parsed) videoSrc = parsed;

  roomId   = room;
  username = user;
  localStorage.setItem("wp-username", user);

  // اخفي شاشة الدخول فوراً — قبل أي حاجة تانية
  document.getElementById("screen-join").classList.remove("active");
  document.getElementById("screen-watch").classList.add("active");
  try { buildSidebar(); } catch(e) {}

  connect()
    .then(() => {
      // نستنى room_state يوصل (~300ms) ثم نحمّل الفيديو
      setTimeout(() => {
        if (parsed) {
          videoSrc = parsed;
          loadPlayer(parsed);
          send({ type: 'set_source', roomId, username, source: parsed });
        } else if (videoSrc) {
          loadPlayer(videoSrc);
        }
        // لو Flutter بعت voice=1 — انضم للمكالمة تلقائياً بعد الاتصال
        const _autoVoice = new URLSearchParams(window.location.search).get("voice");
        if (_autoVoice === "1") {
          joinVoice();
        }
      }, 600);
    })
    .catch((e) => {
      console.error("connect failed:", e);
      const wrap = $("player-wrap");
      if (wrap) wrap.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#ff6b6b;font-size:14px">❌ تعذر الاتصال — حاول مرة أخرى</div>';
    });

  return true;
}

// ============================================
//  Video-only mode — يخفي كل حاجة غير الفيديو
//  يُفعَّل بـ ?videoonly=1
// ============================================
function applyVideoOnlyMode() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("videoonly") !== "1") return;

  // أضف class على الـ body يخفي السايدبار والأزرار
  document.body.classList.add("videoonly");

  // أبلغ Flutter بأحداث الفيديو (play/pause/seek) عبر postMessage
  const origEmit = window.emit;
  window.emit = function(action, time) {
    origEmit?.(action, time);
    try {
      // للـ Android JavaScriptChannel اسمه FlutterBridge
      if (window.FlutterBridge) {
        FlutterBridge.postMessage(JSON.stringify({ action, time }));
      }
    } catch(e) {}
  };

  // استقبل أوامر من Flutter عبر postMessage
  window.addEventListener("message", (e) => {
    try {
      const cmd = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
      if (!cmd || !player) return;
      if (cmd.action === "play")  { isSyncing = true; player.seek(cmd.time); player.play();  setTimeout(() => isSyncing = false, 600); }
      if (cmd.action === "pause") { isSyncing = true; player.seek(cmd.time); player.pause(); setTimeout(() => isSyncing = false, 600); }
      if (cmd.action === "seek")  { isSyncing = true; player.seek(cmd.time);                 setTimeout(() => isSyncing = false, 600); }
    } catch(e) {}
  });
}

// ============================================
//  Keep voice alive in background tab
// ============================================
function _keepVoiceAlive() {
  // AudioContext trick — يمنع المتصفح من تجميد الـ JS لما التاب في الخلفية
  if (!inVoice) return;
  try {
    if (!_keepVoiceAlive._ctx) {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0; // صامت تماماً
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      _keepVoiceAlive._ctx = ctx;
    }
  } catch(_) {}
}
_keepVoiceAlive._ctx = null;

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && inVoice) {
    _keepVoiceAlive();
  }
});

// ============================================
//  R2 Media Browser (داخل الغرفة)
// ============================================
let _mediaPanelOpen = false;
let _currentPlayingKey = null;

// رفع فيديو جوه الروم
let _roomUploadAbort = false;
let _roomUploadXhr = null;

function initRoomUpload() {
  const btn = $("btn-room-upload");
  if (!btn) return;
  const inp = $("inp-room-file");
  btn.onclick = () => inp && inp.click();
  if (!inp) return;
  inp.addEventListener("change", () => {
    const f = inp.files && inp.files[0];
    if (f) _startRoomUpload(f);
  });
}

async function _startRoomUpload(file) {
  _roomUploadAbort = false;
  const status = $("room-upload-status");
  const bar = $("room-upload-bar");
  const pct = $("room-upload-pct");
  if (status) status.style.display = "block";

  const mimeType = file.type || "video/mp4";
  const setP = (p, txt) => {
    if (bar) bar.style.width = (p * 100) + "%";
    if (pct) pct.textContent = Math.round(p * 100) + "% — " + (txt || "");
  };

  try {
    let url;
    if (file.size <= SINGLE_LIMIT) {
      url = await _roomUploadSmall(file, mimeType, setP);
    } else {
      url = await _roomUploadMultipart(file, mimeType, setP);
    }
    if (!url) return;
    if (status) status.style.display = "none";
    const parsed = { type: "html5", url, hls: false };
    videoSrc = parsed;
    loadPlayer(parsed);
    send({ type: "set_source", roomId, username, source: parsed });
    toast("✅ تم رفع الفيديو وتشغيله");
    $("change-video-panel").style.display = "none";
  } catch(e) {
    if (status) status.style.display = "none";
    toast("❌ فشل رفع الفيديو: " + (e.message || e));
  }
}

function _roomUploadSmall(file, mimeType, setP) {
  setP(0, "جاري الرفع...");
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    _roomUploadXhr = xhr;
    xhr.open("POST", `${R2_WORKER}/api/r2/upload`);
    xhr.setRequestHeader("Content-Type", mimeType);
    xhr.setRequestHeader("x-file-name", file.name);
    xhr.setRequestHeader("x-chat-id", "watchparty");
    xhr.setRequestHeader("x-uploaded-by", username || "guest");
    xhr.setRequestHeader("x-folder", "videos");
    xhr.upload.onprogress = e => { if (e.lengthComputable) setP(e.loaded / e.total, "جاري الرفع..."); };
    xhr.onload = () => {
      _roomUploadXhr = null;
      if (_roomUploadAbort) return resolve(null);
      if (xhr.status === 200 || xhr.status === 201) {
        try {
          const data = JSON.parse(xhr.responseText);
          resolve(data.publicUrl || data.url || data.fileUrl || null);
        } catch(e) { reject(e); }
      } else { reject(new Error("HTTP " + xhr.status)); }
    };
    xhr.onerror = () => { _roomUploadXhr = null; reject(new Error("network error")); };
    xhr.send(file);
  });
}

async function _roomUploadMultipart(file, mimeType, setP) {
  setP(0, "جاري تهيئة الرفع...");
  const initRes = await fetch(`${R2_WORKER}/api/r2/multipart/init`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileName: file.name, chatId: "watchparty", uploadedBy: username || "guest", folder: "videos", contentType: mimeType })
  });
  if (!initRes.ok) throw new Error("init failed " + initRes.status);
  const { uploadId, objectKey, publicUrl } = await initRes.json();
  const parts = [];
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  let uploaded = 0;
  for (let i = 0; i < totalChunks; i++) {
    if (_roomUploadAbort) return null;
    const chunk = file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    setP(uploaded / file.size, `جزء ${i+1}/${totalChunks}`);
    const partRes = await fetch(`${R2_WORKER}/api/r2/multipart/part`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", "x-upload-id": uploadId, "x-object-key": objectKey, "x-part-number": String(i+1) },
      body: chunk
    });
    if (!partRes.ok) throw new Error("part failed " + partRes.status);
    const d = await partRes.json();
    parts.push({ partNumber: i+1, etag: d.etag || d.ETag || "" });
    uploaded += chunk.size;
  }
  setP(1, "جاري الإنهاء...");
  const compRes = await fetch(`${R2_WORKER}/api/r2/multipart/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uploadId, objectKey, parts, publicUrl })
  });
  if (!compRes.ok) throw new Error("complete failed " + compRes.status);
  const cd = await compRes.json();
  return cd.publicUrl || publicUrl;
}

function _changeVideo() {
  const inp = $("inp-change-url");
  const url = inp.value.trim();
  if (!url) return;
  const parsed = parseVideoUrl(url);
  if (!parsed) { toast("❌ رابط غير صحيح"); return; }
  inp.value = "";
  $("change-video-panel").style.display = "none";
  videoSrc = parsed;
  loadPlayer(parsed);
  send({ type: "set_source", roomId, username, source: parsed });
  toast("▶ تم تغيير الفيديو");
}

function toggleMediaPanel() {
  _mediaPanelOpen = !_mediaPanelOpen;
  const panel = $("media-panel");
  panel.style.display = _mediaPanelOpen ? "flex" : "none";
  if (_mediaPanelOpen) loadMediaList();
}

async function loadMediaList() {
  const list = $("media-list");
  list.innerHTML = '<div class="media-loading">جاري التحميل...</div>';
  try {
    const res = await fetch(`${R2_WORKER}/api/r2/list?prefix=videos&chatId=watchparty`);
    if (!res.ok) throw new Error("فشل التحميل");
    const data = await res.json();
    let items = data.objects || data.items || (Array.isArray(data) ? data : []);

    // فلتر فيديوهات فقط
    const videoExts = /\.(mp4|mkv|webm|mov|avi|m4v|ts)$/i;
    items = items.filter(o => videoExts.test(o.key || o.name || ""));

    // ترتيب من الأحدث
    items.sort((a, b) => new Date(b.uploaded || b.lastModified || 0) - new Date(a.uploaded || a.lastModified || 0));

    if (!items.length) {
      list.innerHTML = '<div class="media-empty">لا توجد فيديوهات مرفوعة</div>';
      return;
    }

    list.innerHTML = "";
    const R2_PUBLIC = "https://pub-c4aeb02f97054c51be915efafd801dbc.r2.dev";
    items.forEach(o => {
      const key = o.key || o.name || "";
      const name = key.split("/").pop();
      const url = o.publicUrl || o.url || `${R2_PUBLIC}/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
      const size = o.size ? formatBytes(o.size) : "";
      const isPlaying = key === _currentPlayingKey;

      const item = el("div", { class: "media-item" + (isPlaying ? " playing" : "") },
        el("span", { class: "media-item-icon", text: "🎬" }),
        el("div", { class: "media-item-info" },
          el("div", { class: "media-item-name", text: name }),
          size ? el("div", { class: "media-item-size", text: size }) : null
        ),
        el("button", { class: "media-item-play", text: isPlaying ? "▶" : "▶",
          onclick: (e) => { e.stopPropagation(); playMediaItem(key, url, name); }
        })
      );
      item.onclick = () => playMediaItem(key, url, name);
      list.appendChild(item);
    });
  } catch (err) {
    list.innerHTML = `<div class="media-empty">❌ ${err.message}</div>`;
  }
}

function playMediaItem(key, url, name) {
  _currentPlayingKey = key;
  const src = { type: "r2", url, youtubeUrl: null };
  videoSrc = { type: "html5", url, hls: false };
  loadPlayer(videoSrc);

  // أبلّغ كل الحضور
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "set_source", roomId, username, source: src }));
  }

  // أغلق الـ panel وحدّث القائمة
  loadMediaList();
  toast("▶ " + name);
}

// ── بدء ──
initJoinScreen();
initQualityBar();
applyVideoOnlyMode();
tryAutoJoin();
