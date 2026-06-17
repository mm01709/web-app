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
}

function onCreate() {
  const user = $("inp-username").value.trim();
  const url = $("inp-video-url").value.trim();
  if (!user) return showError("اكتب اسمك");
  const parsed = parseVideoUrl(url);
  if (!parsed) return showError("رابط الفيديو غير صحيح (محتاج .mp4 / .m3u8 / YouTube)");

  videoSrc = parsed;
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
    case "room_state":
      // لو منضم جديد وماعندوش مصدر، استقبله من الغرفة
      if (!videoSrc && msg.source) {
        videoSrc = msg.source;
        loadPlayer(videoSrc);
      }
      if (msg.currentTime != null && player) {
        setTimeout(() => {
          applySync("seek", msg.currentTime);
          if (msg.isPlaying) setTimeout(() => applySync("play", msg.currentTime), 400);
        }, 800);
      }
      break;
    case "source":
      // منشئ الغرفة غيّر/حدّد الفيديو
      if (msg.source) { videoSrc = msg.source; loadPlayer(videoSrc); }
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
  if (src.type === "youtube") loadYouTube(src.id);
  else loadHtml5(src);
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
function loadYouTube(videoId) {
  showQualityBar(true);
  $("html5-video").style.display = "none";
  $("yt-player").style.display = "block";

  const create = () => {
    const yt = new YT.Player("yt-player", {
      videoId,
      playerVars: { autoplay: 0, controls: 1, rel: 0, playsinline: 1 },
      events: {
        onReady: () => {
          player = {
            play: () => yt.playVideo(),
            pause: () => yt.pauseVideo(),
            seek: (t) => yt.seekTo(t, true),
            getTime: () => yt.getCurrentTime(),
            _yt: yt,
          };
        },
        onStateChange: (e) => {
          if (isSyncing) return;
          const t = yt.getCurrentTime();
          if (e.data === YT.PlayerState.PLAYING) emit("play", t);
          else if (e.data === YT.PlayerState.PAUSED) emit("pause", t);
        },
      },
    });
  };

  if (window.YT && YT.Player) { create(); return; }
  // حمّل YouTube IFrame API مرة واحدة
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
  const TOL = 1.5;
  if (action === "seek" || Math.abs(player.getTime() - time) > TOL) player.seek(time);
  if (action === "play") player.play();
  else if (action === "pause") player.pause();
  setTimeout(() => { isSyncing = false; }, 600);
}

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
  $("sb-emoji-btn").onclick = toggleEmojiPicker;

  // زر الموبايل
  $("sb-toggle").onclick = () => $("sidebar").classList.toggle("floating");

  addEvent(null, "welcome");
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

// منتقي الإيموجي
let picker = null;
function toggleEmojiPicker() {
  if (picker) { picker.remove(); picker = null; return; }
  picker = el("div", { class: "emoji-picker" });
  EMOJI_SET.forEach(e => picker.appendChild(el("span", { class: "pe", text: e, onclick: () => {
    $("sb-chat-input").value += e; $("sb-chat-input").focus();
  } })));
  $("sidebar").appendChild(picker);
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
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (e) {
    toast("تعذر الوصول للميكروفون: " + (e.message || e));
    return;
  }

  inVoice = true;
  micMuted = false;
  $("btn-voice").textContent = "🔴 مغادرة الصوت";
  $("btn-voice").classList.add("active");
  $("btn-mute").style.display = "";
  $("btn-mute").textContent = "🎤";
  $("btn-mute").classList.remove("muted");

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

<<<<<<< HEAD
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

  // إخفاء شاشة الدخول وبدء الجلسة مباشرة
  const parsed = url ? parseVideoUrl(decodeURIComponent(url)) : null;
  if (parsed) videoSrc = parsed;

  roomId   = room;
  username = user;
  localStorage.setItem("wp-username", user);

  connect()
    .then(() => {
      buildSidebar();
      showScreen("watch");
      if (videoSrc) loadPlayer(videoSrc);
    })
    .catch(() => {
      // لو فشل الاتصال نرجع لشاشة الدخول
      showScreen("join");
    });

  return true;
}

// ── بدء ──
initJoinScreen();
initQualityBar();
tryAutoJoin();
=======
// ── بدء ──
initJoinScreen();
initQualityBar();
>>>>>>> 59d23a610bd56ab0b725cc6c1599655e1ca4432c
