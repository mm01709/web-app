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
      if (xhr.status === 200) {
        const data = JSON.parse(xhr.responseText);
        _uploadedUrl = data.publicUrl;
        showUploadDone(file.name);
        resolve();
      } else {
        $("upload-status").style.display = "none";
        showError("فشل رفع الملف: " + xhr.status);
        reject();
      }
    };
    xhr.onerror = () => {
      _uploadXhr = null;
      if (!_uploadAbort) { $("upload-status").style.display = "none"; showError("خطأ في الاتصال أثناء الرفع"); }
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
  if (!initRes.ok) { showError("فشل بدء الرفع"); return; }
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
      const partRes = await fetch(`${R2_WORKER}/api/r2/multipart/part?uploadId=${encodeURIComponent(uploadId)}&objectKey=${encodeURIComponent(objectKey)}&partNumber=${i + 1}`, {
        method: "PUT",
        headers: { "Content-Type": mimeType },
        body: chunk
      });
      if (partRes.ok) { const d = await partRes.json(); etag = d.etag || d.ETag || ""; break; }
      if (attempt === 3) { showError("فشل رفع جزء " + (i + 1)); return; }
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
  if (!compRes.ok) { showError("فشل إنهاء الرفع"); return; }
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

function startSession(room, user) {
  roomId = room;
  username = user;
  localStorage.setItem("wp-username", user);
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
    ws.onclose = () => { if (socket === ws) { socket = null; toast("🔴 انقطع الاتصال"); } };
    ws.onmessage = (e) => { try { handleMessage(JSON.parse(e.data)); } catch (err) {} };
  });
}

function isConnected() { return socket && socket.readyState === WebSocket.OPEN; }
function send(obj) { if (isConnected()) socket.send(JSON.stringify(obj)); }

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
    player = null;
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
          player = {
            play: () => { try { yt.playVideo(); } catch(_) {} },
            pause: () => { try { yt.pauseVideo(); } catch(_) {} },
            seek: (t) => { try { yt.seekTo(t, true); } catch(_) {} },
            getTime: () => { try { return yt.getCurrentTime() || 0; } catch(_) { return 0; } },
            _yt: yt,
          };
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

  const copy = () => { navigator.clipboard.writeText(roomId).catch(() => {}); toast("✓ تم نسخ الكود: " + roomId); };
  $("sb-room-code").onclick = copy;
  $("sb-share").onclick = copy;
  $("sb-leave").onclick = () => { leaveVoice(); location.reload(); };

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

  // إغلاق الـ sidebar لما تضغط برا في portrait
  document.addEventListener("click", (e) => {
    const sb = $("sidebar");
    if (sb.classList.contains("open") && !sb.contains(e.target) && e.target !== $("fb-chat")) {
      const isLandOrFs = window.matchMedia("(orientation: landscape)").matches
        || !!(document.fullscreenElement || document.webkitFullscreenElement)
        || document.body.classList.contains("is-fullscreen");
      if (isLandOrFs) return; // في landscape/fullscreen الـ sidebar جنب الفيديو مش overlay
      sb.classList.remove("open");
      try { $("fb-chat").classList.remove("active"); } catch(_) {}
    }
  });

  // fullscreen events
  document.addEventListener("fullscreenchange", _onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", _onFullscreenChange);

  addEvent(null, "welcome");
}

// ── Video Overlay (يظهر في landscape + fullscreen) ──────────────
let _overlayTimer = null;

function initVideoOverlay() {
  const overlay = $("video-overlay");

  // ملء emoji bar
  const emoBar = $("overlay-emojis");
  EMOJI_QUICK.forEach(em => {
    const btn = el("span", { class: "ov-emo", text: em });
    btn.onclick = () => { sendReaction(em); showOverlay(); };
    emoBar.appendChild(btn);
  });

  // أزرار التحكم
  $("fb-fullscreen").onclick = toggleFullscreen;

  $("fb-rotate").onclick = () => {
    if (!screen.orientation || !screen.orientation.lock) {
      toast("⚠️ التدوير غير مدعوم");
      return;
    }
    const cur = screen.orientation.type || "";
    const target = cur.includes("landscape") ? "portrait" : "landscape";
    screen.orientation.lock(target).catch(() => toast("⚠️ اقلب جهازك يدوياً"));
    showOverlay();
  };

  $("fb-mute").onclick = () => {
    micMuted = !micMuted;
    if (localStream) localStream.getAudioTracks().forEach(t => { t.enabled = !micMuted; });
    const btn = $("fb-mute");
    btn.textContent = micMuted ? "🔇" : "🎤";
    btn.classList.toggle("muted", micMuted);
    $("btn-mute").textContent = micMuted ? "🔇 أنت مكتوم" : "🎤";
    $("btn-mute").classList.toggle("muted", micMuted);
    toast(micMuted ? "تم كتم الميكروفون 🔇" : "الميكروفون مفعّل 🎤");
    showOverlay();
  };

  $("fb-voice").onclick = () => {
    const inVoice = $("fb-voice").classList.contains("in-voice");
    if (inVoice) {
      leaveVoice();
      $("fb-voice").classList.remove("in-voice");
      $("fb-voice").textContent = "🎙";
      $("fb-mute").style.display = "none";
      toast("خرجت من الصوت");
    } else {
      joinVoice().then(() => {
        $("fb-voice").classList.add("in-voice");
        $("fb-voice").textContent = "🔴";
        $("fb-mute").style.display = "";
        toast("دخلت الصوت 🎙");
      }).catch(err => toast("❌ " + (err.message || "فشل الصوت")));
    }
    showOverlay();
  };

  $("fb-chat").onclick = () => {
    toggleSidebarOverlay();
    showOverlay();
  };

  // إظهار الـ overlay عند تحريك الماوس أو اللمس
  const va = document.querySelector(".video-area");
  va.addEventListener("mousemove", showOverlay);
  va.addEventListener("touchstart", showOverlay, { passive: true });
  overlay.addEventListener("mousemove", showOverlay);
  overlay.addEventListener("touchstart", showOverlay, { passive: true });
}

function showOverlay() {
  const ov = $("video-overlay");
  ov.classList.remove("hidden");
  ov.classList.add("visible");
  clearTimeout(_overlayTimer);
  _overlayTimer = setTimeout(() => {
    ov.classList.remove("visible");
    ov.classList.add("hidden");
  }, 3500);
}

function toggleSidebarOverlay() {
  const sb = $("sidebar");
  const btn = $("fb-chat");
  sb.classList.toggle("open");
  btn.classList.toggle("active", sb.classList.contains("open"));
}

function toggleFullscreen() {
  const wrap = document.documentElement;
  if (!document.fullscreenElement && !document.webkitFullscreenElement) {
    (wrap.requestFullscreen || wrap.webkitRequestFullscreen || (() => {})).call(wrap);
    if (screen.orientation && screen.orientation.lock) {
      screen.orientation.lock("landscape").catch(() => {});
    }
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
    if (screen.orientation && screen.orientation.unlock) {
      screen.orientation.unlock();
    }
  }
}

function _onFullscreenChange() {
  const sb = $("sidebar");
  const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
  document.body.classList.toggle("is-fullscreen", isFs);

  if (!isFs) {
    if (sb) sb.classList.remove("open");
    try { $("fb-chat").classList.remove("active"); } catch(_) {}
    try { $("fb-fullscreen").textContent = "⛶"; } catch(_) {}
    try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch(_) {}
    // أخفِ الـ overlay
    try { $("video-overlay").classList.remove("visible"); $("video-overlay").classList.add("hidden"); } catch(_) {}
  } else {
    try { $("fb-fullscreen").textContent = "✕"; } catch(_) {}
    showOverlay();
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
  ]
};

function initVoiceBar() {
  const btnVoice = $("btn-voice");
  const btnMute = $("btn-mute");

  btnVoice.addEventListener("click", () => {
    if (!inVoice) joinVoice();
    else leaveVoice();
  });

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
  $("fb-mute").classList.remove("muted");

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
    let audioEl = document.getElementById("audio-" + uid);
    if (!audioEl) {
      audioEl = document.createElement("audio");
      audioEl.id = "audio-" + uid;
      audioEl.autoplay = true;
      $("remote-audios").appendChild(audioEl);
    }
    audioEl.srcObject = e.streams[0];
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

async function handleVoiceOffer(msg) {
  if (!inVoice || !localStream) return;
  const pc = createPeer(msg.from, false);
  await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  send({ type: "voice_answer", roomId, username, to: msg.from, sdp: pc.localDescription });
}

async function handleVoiceAnswer(msg) {
  const pc = peerConnections[msg.from];
  if (!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
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
      // مستخدم جديد في الصوت — لو أنا في الصوت أبدأ اتصال معاه
      if (inVoice && localStream) {
        createPeer(uid, true);
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
//  R2 Media Browser (داخل الغرفة)
// ============================================
let _mediaPanelOpen = false;
let _currentPlayingKey = null;

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
