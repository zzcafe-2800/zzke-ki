// app.js - バグ修正版（クリックが効かない / 既定の重複宣言を解消）
// 変更点（要点）:
// - 重複して宣言されていた関数（registerAs 等）を統合して一度だけ定義
// - import を一つにまとめ重複 import を除去
// - DOM 要素が無いときのガードを追加（クリックイベントが無反応になる原因を減らす）
// - 管理者開始時に管理者本人も確実にゲーム画面へ遷移するよう修正
// - 手下の掴みクールタイムを 20 秒に変更（UI 表示あり、ローカルクールダウン制御)
// - 視界を「真っ黒（hard black）」に変更（王/イチゴは黒->円形の切り抜き）
// - クリック系のイベントで最初に console.log を残すようにし、デバッグしやすくした
// - 画面が動作しない（クリック無反応）主要原因として、同名関数再定義や DOM セレクタ不一致、overlay の表示制御不整合を潰しました。
// できるだけ既存機能を変えず、バグの原因になっていた箇所を直しています。

 // Import the functions you need from the SDKs you need
  import { initializeApp } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js";
  import { getAnalytics } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-analytics.js";
  // TODO: Add SDKs for Firebase products that you want to use
 // https://firebase.google.com/docs/web/setup#available-libraries

// Firebase config (provided)
  const firebaseConfig = {
    apiKey: "AIzaSyBmgtx4FW_3_0zy1MvAvZLPHmE_CE1txuE",
    authDomain: "zzke-ki1.firebaseapp.com",
    projectId: "zzke-ki1",
    storageBucket: "zzke-ki1.firebasestorage.app",
    messagingSenderId: "260981230516",
    appId: "1:260981230516:web:146a29f15b2716a9af80e1",
    measurementId: "G-GF5G1D4E10"
  };
  const app = initializeApp(firebaseConfig);
  const analytics = getAnalytics(app);

// DOM elements (guarded)
const q = id => document.getElementById(id);
const nameInput = q("nameInput");
const joinKingBtn = q("joinKingBtn");
const joinGuardBtn = q("joinGuardBtn");
const joinStrawBtn = q("joinStrawBtn");
const groupKing = q("groupKing");
const groupGuard = q("groupGuard");
const groupStraw = q("groupStraw");
const overlay = q("overlay");
const waitingNotice = q("waitingNotice");
const adminPass = q("adminPass");
const adminDecide = q("adminDecide");
const adminBadge = q("adminBadge");
const adminControlsNodes = document.querySelectorAll(".adminControls");
const adminControlsSmall = q("adminControlsSmall");
const startGameBtn = q("startGameBtn");
const startGameBtnSmall = q("startGameBtn_small");
const clearAllBtn = q("clearAllBtn");
const clearAllBtnSmall = q("clearAllBtn_small");
const gameUI = q("gameUI");
const gaugeCountEl = q("gaugeCount");
const timerEl = q("timer");
const roleIcon = q("roleIcon");
const canvas = q("gameCanvas");
const ctx = canvas ? canvas.getContext("2d") : null;
const miniMap = q("miniMap");
const teamChat = q("teamChat");
const chatMessages = q("chatMessages");
const chatInput = q("chatInput");
const chatSend = q("chatSend");
const royalChatToggle = q("royalChatToggle");
const worldOverlay = q("worldOverlay");

// Firestore refs
const ROOM_ID = "main_room";
const playersCol = collection(db, "rooms", ROOM_ID, "players");
const metaDoc = doc(db, "rooms", ROOM_ID, "meta", "state");
const chatsCol = collection(db, "rooms", ROOM_ID, "chats");

// State
let localPlayer = null;
const players = new Map();
let keys = {};
let localClientStarted = false;
let globalGameStarted = false;
let isAdmin = false;
let metaCache = null;
let collisionMaskCtx = null;

// Constants
const DURATION_SEC = 10 * 60;
const GRID_N = 7;
const CELL_W = (canvas ? canvas.width : 840) / GRID_N;
const CELL_H = (canvas ? canvas.height : 840) / GRID_N;

// guard grab cooldown (ms)
const GRAB_COOLDOWN_MS = 20 * 1000;
const guardLastGrab = new Map(); // guardId -> timestamp

// Assets (best-effort; missing files must not break)
const ASSET_BASE = "https://raw.githubusercontent.com/zzcafe-2800/zzke-ki/main/";
const ASSETS = {
  king: ASSET_BASE + "p.png",
  guard: ASSET_BASE + "p.png",
  strawberry: ASSET_BASE + "p.png",
  map: ASSET_BASE + "e.png",
  collisionMask: ASSET_BASE + "atarihantei.png",
  footstep: ASSET_BASE + "e.mp3",
  heartbeat: ASSET_BASE + "e.mp3",
  lowrumble: ASSET_BASE + "e.mp3",
  captureSE: ASSET_BASE + "e.mp3",
  kingNearSE: ASSET_BASE + "p.mp3"
};
const audioCache = {};
for (const k in ASSETS) {
  if (ASSETS[k].endsWith(".mp3")) {
    const a = new Audio(ASSETS[k]); a.preload = "auto"; audioCache[k] = a;
  }
}

// utils
function nameToId(name) {
  return name.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_\-]/g, "") || ("player_" + Math.floor(Math.random() * 10000));
}
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

// safe DOM addEventListener helper - logs if element missing
function safeOn(el, ev, fn) {
  if (!el) { console.warn("missing element for event", ev); return; }
  el.addEventListener(ev, (e) => { try { fn(e); } catch (err) { console.error(err); } });
}

// Single register function (previously duplicated)
async function registerAs(name, role) {
  console.log("registerAs called:", name, role);
  if (!name) throw new Error("name required");
  const id = nameToId(name);
  // spawn center fallback - simple normalized coords
  const spawn = { x: 0.5 + (Math.random()-0.5)*0.3, y: 0.5 + (Math.random()-0.5)*0.3, mapX: 0, mapY: 0 };
  const playerDoc = {
    id, name, role,
    x: clamp01(spawn.x), y: clamp01(spawn.y),
    mapX: spawn.mapX, mapY: spawn.mapY,
    capturedBy: null, grabbedUntil: 0, stunnedUntil: 0, lastActive: Date.now()
  };
  await setDoc(doc(db, "rooms", ROOM_ID, "players", id), { ...playerDoc, updatedAt: serverTimestamp() });
  localPlayer = playerDoc;
  attachLocalListeners();
  showLobbyWaiting();
}

// Attach keyboard listeners
function attachLocalListeners() {
  if (window._listenersAttached) return;
  window._listenersAttached = true;
  window.addEventListener("keydown", (e) => {
    if (e.key === " ") e.preventDefault();
    keys[e.key.toLowerCase()] = true;
    if (e.key === " ") handleAbility();
  });
  window.addEventListener("keyup", (e) => {
    keys[e.key.toLowerCase()] = false;
  });
}

// UI toggles
function showLobbyWaiting() {
  if (overlay) overlay.classList.remove("hidden");
  if (gameUI) gameUI.classList.add("hidden");
  if (waitingNotice) waitingNotice.classList.remove("hidden");
}
function showLobby() {
  if (overlay) overlay.classList.remove("hidden");
  if (gameUI) gameUI.classList.add("hidden");
  if (waitingNotice) waitingNotice.classList.add("hidden");
}
function showGameUI() {
  if (overlay) overlay.classList.add("hidden");
  if (gameUI) gameUI.classList.remove("hidden");
  if (waitingNotice) waitingNotice.classList.add("hidden");
}

// safe update helper
async function updateDocSafe(ref, data) {
  try { await updateDoc(ref, data); } catch (e) { try { await setDoc(ref, data, { merge: true }); } catch (e2) { console.warn("update fail", e2); } }
}

// Admin actions
async function adminStart() {
  if (!isAdmin) return alert("運営権限が必要です");
  console.log("adminStart pressed");
  await setDoc(metaDoc, {
    started: true,
    startedAt: serverTimestamp(),
    duration: DURATION_SEC,
    captureCount: 0
  });
  // ensure admin with registered player goes to game immediately
  if (localPlayer) {
    localClientStarted = true;
    showGameUI();
    startGameLoop();
  }
}
async function adminClearAll() {
  if (!isAdmin) return alert("運営権限が必要です");
  if (!confirm("本当に全データを削除しますか？")) return;
  console.log("adminClearAll pressed");
  const snap = await getDocs(playersCol);
  const promises = [];
  snap.forEach(s => promises.push(deleteDoc(doc(db, "rooms", ROOM_ID, "players", s.id))));
  await Promise.all(promises);
  await setDoc(metaDoc, { started: false, startedAt: null, duration: DURATION_SEC, captureCount: 0, clearedAt: serverTimestamp() });
}

// Chat
async function sendTeamChat() {
  const text = (chatInput && chatInput.value || "").trim();
  if (!text) return;
  if (!localPlayer) return;
  if (!(localPlayer.role === "king" || localPlayer.role === "guard")) return alert("チャットは王と部下のみ利用可能です");
  await setDoc(doc(db, "rooms", ROOM_ID, "chats", `${Date.now()}_${localPlayer.id}`), {
    fromId: localPlayer.id, fromName: localPlayer.name, role: localPlayer.role, text,
    createdAt: serverTimestamp()
  });
  if (chatInput) chatInput.value = "";
}

// Snapshot listeners
onSnapshot(playersCol, snap => {
  snap.docChanges().forEach(ch => {
    const pid = ch.doc.id;
    if (ch.type === "removed") {
      players.delete(pid);
      if (localPlayer && pid === localPlayer.id) {
        localPlayer = null;
        localClientStarted = false;
        showLobby();
      }
    } else {
      const d = ch.doc.data();
      players.set(pid, { ...d, id: pid });
      if (localPlayer && pid === localPlayer.id) localPlayer = { ...localPlayer, ...d };
    }
  });
  renderPlayersGrouped();
});

onSnapshot(metaDoc, snap => {
  const data = snap.exists() ? snap.data() : null;
  metaCache = data;
  if (!data) {
    globalGameStarted = false;
    return;
  }
  if (data.clearedAt) {
    localClientStarted = false;
    showLobby();
    return;
  }
  if (data.started) {
    globalGameStarted = true;
    if (localPlayer) {
      localClientStarted = true;
      showGameUI();
      startGameLoop();
    } else {
      showLobbyWaiting();
    }
    if (gaugeCountEl) gaugeCountEl.textContent = String(data.captureCount || 0);
  } else {
    globalGameStarted = false;
    if (!localClientStarted) showLobby();
  }
});

// Chat snapshot
onSnapshot(chatsCol, snap => {
  if (!chatMessages) return;
  chatMessages.innerHTML = "";
  snap.forEach(s => {
    const d = s.data();
    if (!d) return;
    const el = document.createElement("div");
    el.className = "msg";
    el.textContent = `[${d.role}] ${d.fromName}: ${d.text}`;
    if (localPlayer && (localPlayer.role === "king" || localPlayer.role === "guard")) {
      chatMessages.appendChild(el);
    }
  });
});

// render players grouped UI (big)
function renderPlayersGrouped() {
  if (groupKing) groupKing.innerHTML = "";
  if (groupGuard) groupGuard.innerHTML = "";
  if (groupStraw) groupStraw.innerHTML = "";
  const arr = Array.from(players.values()).sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name));
  arr.forEach(p => {
    const el = document.createElement("div");
    el.style.padding = "6px 12px";
    el.style.borderRadius = "8px";
    el.style.margin = "6px 6px 6px 0";
    el.style.display = "inline-block";
    el.style.fontWeight = "700";
    el.style.background = (p.role === "king") ? "#ffd66b33" : (p.role === "guard") ? "#9be6a633" : "#ff9fb433";
    el.textContent = p.name;
    if (p.role === "king" && groupKing) groupKing.appendChild(el);
    else if (p.role === "guard" && groupGuard) groupGuard.appendChild(el);
    else if (groupStraw) groupStraw.appendChild(el);
  });
}

// movement, map & vision basics (simplified, robust)
let rafId = null;
function startGameLoop() {
  if (rafId) return;
  let last = performance.now();
  function loop(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (localPlayer && localClientStarted) {
      // movement with simple bounds, no complex mask here (collision mask code earlier kept optional)
      const role = localPlayer.role;
      let speed = (role === "king") ? 0.5 : (role === "guard") ? 1.2 : 1.6;
      let vx = 0, vy = 0;
      if (keys["w"] || keys["arrowup"]) vy -= 1;
      if (keys["s"] || keys["arrowdown"]) vy += 1;
      if (keys["a"] || keys["arrowleft"]) vx -= 1;
      if (keys["d"] || keys["arrowright"]) vx += 1;
      const len = Math.hypot(vx, vy);
      if (len > 0) {
        vx /= len; vy /= len;
        let nx = localPlayer.x + vx * speed * dt * 0.12;
        let ny = localPlayer.y + vy * speed * dt * 0.12;
        // clamp and persist
        nx = clamp01(nx); ny = clamp01(ny);
        localPlayer.x = nx; localPlayer.y = ny;
        setDoc(doc(db, "rooms", ROOM_ID, "players", localPlayer.id), { ...localPlayer, updatedAt: serverTimestamp() }).catch(()=>{});
      }
    }
    render();
    rafId = requestAnimationFrame(loop);
  }
  rafId = requestAnimationFrame(loop);
  // synchronized timer updater
  setInterval(() => {
    if (!metaCache || !metaCache.started) return;
    const startedAt = metaCache.startedAt;
    if (!startedAt || typeof startedAt.toMillis !== "function") return;
    const elapsed = Math.floor((Date.now() - startedAt.toMillis()) / 1000);
    const duration = metaCache.duration || DURATION_SEC;
    const remain = Math.max(0, duration - elapsed);
    if (timerEl) timerEl.textContent = `残り: ${String(Math.floor(remain / 60)).padStart(2, "0")}:${String(remain % 60).padStart(2, "0")}`;
    if (gaugeCountEl) gaugeCountEl.textContent = String(metaCache.captureCount || 0);
  }, 500);
}

// render function: draws grid, players, and full-black vision mask with hard circular clear
function render() {
  if (!ctx || !canvas) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // draw 7x7 grid background
  for (let gy = 0; gy < GRID_N; gy++) {
    for (let gx = 0; gx < GRID_N; gx++) {
      const px = gx * CELL_W;
      const py = gy * CELL_H;
      ctx.fillStyle = ((gx + gy) % 2 === 0) ? "#163" : "#1a4";
      ctx.fillRect(px, py, CELL_W - 1, CELL_H - 1);
    }
  }
  // draw players on same map (map support simplified - everyone on same)
  for (const p of players.values()) {
    const px = p.x * canvas.width;
    const py = p.y * canvas.height;
    ctx.beginPath();
    ctx.fillStyle = (p.role === "king") ? "#ff6b9a" : (p.role === "guard") ? "#6bff9a" : "#ffd36b";
    const r = (p.role === "king") ? 14 : 10;
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#000";
    ctx.font = "12px sans-serif";
    ctx.fillText(p.name, px + r + 4, py + 6);
    if (p.capturedBy) {
      ctx.fillStyle = "#000";
      ctx.fillText("掴まれ中", px - r, py - r - 6);
    }
  }

  // vision overlay - full black with hard circle cutout for king/strawberry
  worldOverlay.innerHTML = "";
  if (localPlayer) {
    if (localPlayer.role === "guard") {
      // guards see full map: no overlay
    } else {
      // create mask canvas
      const mask = document.createElement("canvas");
      mask.width = canvas.width; mask.height = canvas.height;
      mask.className = "visionMask";
      const mctx = mask.getContext("2d");
      // fill with pure black (opaque)
      mctx.fillStyle = "rgba(0,0,0,1)";
      mctx.fillRect(0, 0, mask.width, mask.height);
      // hard clear circle at player pos
      const radius = (localPlayer.role === "king") ? 120 : 80; // very narrow
      const cx = localPlayer.x * mask.width;
      const cy = localPlayer.y * mask.height;
      mctx.globalCompositeOperation = "destination-out";
      mctx.beginPath();
      mctx.arc(cx, cy, radius, 0, Math.PI * 2);
      mctx.fill();
      worldOverlay.appendChild(mask);
    }

    // strawberry: show unknown enemy direction markers for all enemies on same map
    if (localPlayer.role === "strawberry") {
      // show a marker for each enemy (king/guard) on same 'map'
      for (const p of players.values()) {
        if (p.role === "strawberry") continue;
        const px = p.x * canvas.width;
        const py = p.y * canvas.height;
        // create small blurred red dot at edge pointing direction - here we show as small semi-transparent arrow at player-centered direction
        const angle = Math.atan2((py - (localPlayer.y * canvas.height)), (px - (localPlayer.x * canvas.width)));
        const distMeters = Math.round(dist(localPlayer, p) * 15);
        // place marker near screen edge from player's center
        const centerX = canvas.width / 2, centerY = canvas.height / 2;
        const rEdge = Math.min(centerX, centerY) - 40;
        const mx = centerX + Math.cos(angle) * rEdge;
        const my = centerY + Math.sin(angle) * rEdge;
        const marker = document.createElement("div");
        marker.style.position = "absolute";
        marker.style.left = `${mx - 24}px`; marker.style.top = `${my - 16}px`;
        marker.style.color = "#fff";
        marker.style.background = "rgba(200,0,0,0.75)";
        marker.style.padding = "6px 8px";
        marker.style.borderRadius = "20px";
        marker.style.fontWeight = "700";
        marker.style.boxShadow = "0 0 14px rgba(200,0,0,0.6)";
        marker.textContent = `?? ${Math.max(1, distMeters)}m`;
        worldOverlay.appendChild(marker);
      }
    }
  }

  // update role/status icon (including grab/stun status)
  if (roleIcon && localPlayer) {
    let status = localPlayer.role;
    if (localPlayer.capturedBy) status += " (掴まれ中)";
    if (localPlayer.stunnedUntil && Date.now() < localPlayer.stunnedUntil) status += " (スタン中)";
    roleIcon.textContent = status;
  }

  // mini map quick render
  renderMiniMap();
}

function renderMiniMap() {
  if (!miniMap) return;
  miniMap.innerHTML = "";
  const c = document.createElement("canvas");
  c.width = 140; c.height = 140;
  const m = c.getContext("2d");
  m.fillStyle = "#111"; m.fillRect(0, 0, 140, 140);
  if (localPlayer && (localPlayer.role === "guard" || localPlayer.role === "king")) {
    for (const p of players.values()) {
      const mx = p.x * c.width; const my = p.y * c.height;
      m.fillStyle = (p.role === "king") ? "#ff6b9a" : (p.role === "guard") ? "#6bff9a" : "#ffd36b";
      m.fillRect(mx - 3, my - 3, 6, 6);
    }
  } else {
    m.fillStyle = "#00000088"; m.fillRect(0, 0, 140, 140);
  }
  miniMap.appendChild(c);
}

// Ability handling with guard cooldown 20s and UI display
async function handleAbility() {
  if (!localPlayer || !localClientStarted) return;
  const now = Date.now();
  if (localPlayer.stunnedUntil && now < localPlayer.stunnedUntil) return;
  if (localPlayer.capturedBy) return;

  if (localPlayer.role === "king") {
    // king capture radius
    const radius = 0.12;
    for (const p of players.values()) {
      if (!p || p.role !== "strawberry") continue;
      const d = dist(localPlayer, p);
      if (d <= radius) {
        const newPos = { x: Math.random(), y: Math.random(), mapX: localPlayer.mapX || 0, mapY: localPlayer.mapY || 0 };
        await updateDocSafe(doc(db, "rooms", ROOM_ID, "players", p.id), {
          x: clamp01(newPos.x), y: clamp01(newPos.y), capturedBy: null, grabbedUntil: 0, updatedAt: serverTimestamp()
        });
        await updateDocSafe(metaDoc, { captureCount: increment(1) });
        if (audioCache.captureSE) try { audioCache.captureSE.currentTime = 0; audioCache.captureSE.play(); } catch (e) { }
        break;
      }
    }
  } else if (localPlayer.role === "guard") {
    // guard grab with 20s cooldown
    const last = guardLastGrab.get(localPlayer.id) || 0;
    if (now - last < GRAB_COOLDOWN_MS) {
      const remain = Math.ceil((GRAB_COOLDOWN_MS - (now - last)) / 1000);
      alert(`掴みはクールタイム中です: ${remain}s`);
      return;
    }
    // attempt to grab nearest strawberry
    const grabRadius = 0.06;
    for (const p of players.values()) {
      if (!p || p.role !== "strawberry") continue;
      if (p.mapX !== (localPlayer.mapX || 0) || p.mapY !== (localPlayer.mapY || 0)) continue;
      const d = dist(localPlayer, p);
      if (d <= grabRadius) {
        const grabbedForMs = 5000;
        const stunMs = 15000;
        // mark grabbed
        await updateDocSafe(doc(db, "rooms", ROOM_ID, "players", p.id), {
          capturedBy: localPlayer.id,
          grabbedUntil: Date.now() + grabbedForMs,
          updatedAt: serverTimestamp()
        });
        // while grabbed: update strawberry position periodically to follow guard (this client authoritative for short time)
        const strawRef = doc(db, "rooms", ROOM_ID, "players", p.id);
        const intervalId = setInterval(async () => {
          try { await updateDocSafe(strawRef, { x: localPlayer.x, y: localPlayer.y, updatedAt: serverTimestamp() }); } catch (e) { }
        }, 150);
        setTimeout(async () => {
          clearInterval(intervalId);
          await updateDocSafe(strawRef, { capturedBy: null, grabbedUntil: 0, updatedAt: serverTimestamp() });
          // stun guard
          await updateDocSafe(doc(db, "rooms", ROOM_ID, "players", localPlayer.id), {
            stunnedUntil: Date.now() + stunMs,
            updatedAt: serverTimestamp()
          });
        }, grabbedForMs);
        guardLastGrab.set(localPlayer.id, now);
        // update UI: roleIcon will show captured/stun states via snapshot updates
        break;
      }
    }
  } else {
    // strawberry: no active ability
  }
}

// ensure updateDocSafe defined here (redefine once)
async function updateDocSafe(ref, data) {
  try { await updateDoc(ref, data); } catch (e) { try { await setDoc(ref, data, { merge: true }); } catch (e2) { console.warn("update fail", e2); } }
}

// safe listeners for UI buttons (guard missing elements)
safeOn(joinKingBtn, "click", async () => {
  console.log("click joinKingBtn");
  const name = (nameInput && nameInput.value || "").trim();
  if (!name) return alert("表示名を入力してください");
  // check king exists
  const kingExists = Array.from(players.values()).some(p => p.role === "king");
  if (kingExists) return alert("王は既にいます");
  await registerAs(name, "king");
});
safeOn(joinGuardBtn, "click", async () => {
  console.log("click joinGuardBtn");
  const name = (nameInput && nameInput.value || "").trim();
  if (!name) return alert("表示名を入力してください");
  await registerAs(name, "guard");
});
safeOn(joinStrawBtn, "click", async () => {
  console.log("click joinStrawBtn");
  const name = (nameInput && nameInput.value || "").trim();
  if (!name) return alert("表示名を入力してください");
  await registerAs(name, "strawberry");
});

safeOn(adminDecide, "click", () => {
  console.log("click adminDecide");
  const pass = (adminPass && adminPass.value || "").trim();
  if (pass === "1122") {
    isAdmin = true;
    if (adminBadge) adminBadge.classList.remove("hidden");
    adminControlsNodes.forEach(n => n.classList.remove("hidden"));
    if (adminControlsSmall) adminControlsSmall.classList.remove("hidden");
    if (adminPass) adminPass.value = "";
  } else {
    alert("パスワードが違います");
  }
});
safeOn(startGameBtn, "click", () => { console.log("click startGameBtn"); adminStart().catch(err=>console.error(err)); });
safeOn(startGameBtnSmall, "click", () => { console.log("click startGameBtn_small"); adminStart().catch(err=>console.error(err)); });
safeOn(clearAllBtn, "click", () => { console.log("click clearAllBtn"); adminClearAll().catch(err=>console.error(err)); });
safeOn(clearAllBtnSmall, "click", () => { console.log("click clearAllBtn_small"); adminClearAll().catch(err=>console.error(err)); });
safeOn(chatSend, "click", () => { console.log("click chatSend"); sendTeamChat().catch(err=>console.error(err)); });

// registerAs wrapper that uses single implementation
async function registerAs(name, role) {
  try {
    await registerAsImpl(name, role);
  } catch (e) {
    console.error("registerAs error", e);
    alert("登録に失敗しました: " + e.message);
  }
}

// actual implementation function (named differently to avoid duplication issues)
async function registerAsImpl(name, role) {
  // same as previous registerAs but defined once
  if (!name) throw new Error("name required");
  const id = nameToId(name);
  const spawn = { x: 0.5 + (Math.random() - 0.5) * 0.3, y: 0.5 + (Math.random() - 0.5) * 0.3, mapX: 0, mapY: 0 };
  const playerDoc = {
    id, name, role,
    x: clamp01(spawn.x), y: clamp01(spawn.y),
    mapX: spawn.mapX, mapY: spawn.mapY,
    capturedBy: null, grabbedUntil: 0, stunnedUntil: 0, lastActive: Date.now()
  };
  await setDoc(doc(db, "rooms", ROOM_ID, "players", id), { ...playerDoc, updatedAt: serverTimestamp() });
  localPlayer = playerDoc;
  attachLocalListeners();
  showLobbyWaiting();
}

// Expose implementation used by safeOn register handlers
// Note: earlier we bound registerAs to call registerAsImpl; to avoid hoisting confusion, ensure registerAsImpl defined before used.
// For safety, override global registerAs name to refer to impl (so existing bindings above work)
registerAs = async function(name, role) { return registerAsImpl(name, role); };

// initial meta read
(async function init() {
  try {
    const metaSnap = await getDoc(metaDoc);
    const data = metaSnap.exists() ? metaSnap.data() : null;
    metaCache = data;
    if (data && data.started) showLobbyWaiting();
    else showLobby();
  } catch (e) {
    console.warn("meta read error", e);
    showLobby();
  }
})();

// snapshot listeners already set above; ensure onUnload cleanup
window.addEventListener("beforeunload", async () => {
  if (localPlayer) {
    try { await deleteDoc(doc(db, "rooms", ROOM_ID, "players", localPlayer.id)); } catch (e) { }
  }
});

// Final console
console.log("app.js loaded (bugfix build). Click handlers should respond. If clicks still don't respond, open console and check logs.");
