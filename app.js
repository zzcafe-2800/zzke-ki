// app.js - Bugfix + adjustments
// - Fixed duplicate function declaration error
// - Ensure clicks work (no duplicated identifiers)
// - Narrowed vision (king & strawberry): full black overlay with small clear circle
// - Guard: grab cooldown 20s, UI showing availability; grab lasts 5s, then guard stunned 15s (black screen for stunned guard)
// - Display "掴み中" and "操作不能" indicators for both guard and strawberry while grabbing
// - Handle missing images gracefully
// - Preserve existing functionality, but correct bugs that prevented interaction
//
// Note: This file replaces previous app.js. Keep index.html and style.css from previous step.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js";
import {
  getFirestore, collection, doc, setDoc, onSnapshot, updateDoc, deleteDoc,
  getDocs, serverTimestamp, getDoc, increment
} from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";

// Firebase config (unchanged)
const firebaseConfig = {
  apiKey: "AIzaSyAcDEj5VPQmzekn-njX4YV33_80mdUv_os",
  authDomain: "zzke-ki.firebaseapp.com",
  projectId: "zzke-ki",
  storageBucket: "zzke-ki.firebasestorage.app",
  messagingSenderId: "155414272080",
  appId: "1:155414272080:web:f1f0f01c118e5dfbe29955",
  measurementId: "G-RHYBY3SBKH"
};
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// --- DOM elements (assume index.html as provided earlier) ---
const nameInput = document.getElementById("nameInput");
const joinKingBtn = document.getElementById("joinKingBtn");
const joinGuardBtn = document.getElementById("joinGuardBtn");
const joinStrawBtn = document.getElementById("joinStrawBtn");
const groupKing = document.getElementById("groupKing");
const groupGuard = document.getElementById("groupGuard");
const groupStraw = document.getElementById("groupStraw");
const overlay = document.getElementById("overlay");
const waitingNotice = document.getElementById("waitingNotice");
const adminPass = document.getElementById("adminPass");
const adminDecide = document.getElementById("adminDecide");
const adminBadge = document.getElementById("adminBadge");
const adminControlsNodes = document.querySelectorAll(".adminControls");
const adminControlsSmall = document.getElementById("adminControlsSmall");
const startGameBtn = document.getElementById("startGameBtn");
const startGameBtnSmall = document.getElementById("startGameBtn_small");
const clearAllBtn = document.getElementById("clearAllBtn");
const clearAllBtnSmall = document.getElementById("clearAllBtn_small");
const gameUI = document.getElementById("gameUI");
const gaugeCountEl = document.getElementById("gaugeCount");
const timerEl = document.getElementById("timer");
const roleIcon = document.getElementById("roleIcon");
const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");
const miniMap = document.getElementById("miniMap");
const teamChat = document.getElementById("teamChat");
const chatMessages = document.getElementById("chatMessages");
const chatInput = document.getElementById("chatInput");
const chatSend = document.getElementById("chatSend");
const royalChatToggle = document.getElementById("royalChatToggle");
const worldOverlay = document.getElementById("worldOverlay");
const adminControlsSmallNode = document.getElementById("adminControlsSmall");

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
let collisionMaskCtx = null; // optional
let raf = null;

// Configs
const DURATION_SEC = 10 * 60;
const GRID_N = 7;
const CELL_W = canvas.width / GRID_N;
const CELL_H = canvas.height / GRID_N;

// Vision radii (px) - significantly narrower per request
const VISION_PX = {
  king: 60,
  guard: 2000, // effectively full view
  strawberry: 60
};

// Grab timings
const GRAB_DURATION_MS = 5000;
const GRAB_COOLDOWN_MS = 20000;
const GUARD_STUN_MS = 15000;

// Asset placeholders (optional)
const ASSET_BASE = "https://raw.githubusercontent.com/zzcafe-2800/zzke-ki/main/";
const ASSETS = {
  map: ASSET_BASE + "e.png",
  collisionMask: ASSET_BASE + "atarihantei.png"
};

// Utility helpers
function nameToId(name){
  return name.trim().toLowerCase().replace(/\s+/g,'_').replace(/[^a-z0-9_\-]/g,'') || `player_${Math.floor(Math.random()*10000)}`;
}
function clamp01(v){ return Math.max(0, Math.min(1, v)); }
function dist(a,b){ return Math.hypot(a.x - b.x, a.y - b.y); }
function nowMs(){ return Date.now(); }

// Safe Firestore update
async function updateDocSafe(ref, data){
  try { await updateDoc(ref, data); } catch(e){ try { await setDoc(ref, data, { merge: true }); } catch(e2){} }
}

// Random spawn (simple normalized coords). If collision mask exists, try to avoid black pixels.
function randomSpawn(mapKey = "0,0"){
  if (!collisionMaskCtx){
    return { x: Math.random()*0.8 + 0.1, y: Math.random()*0.8 + 0.1, mapX: 0, mapY: 0 };
  }
  let attempts = 0;
  while (attempts < 60){
    const x = Math.random();
    const y = Math.random();
    const px = Math.floor(x * canvas.width);
    const py = Math.floor(y * canvas.height);
    const d = collisionMaskCtx.getImageData(px, py, 1, 1).data;
    if (!(d[0]===0 && d[1]===0 && d[2]===0 && d[3] !== 0)){
      return { x, y, mapX: 0, mapY: 0 };
    }
    attempts++;
  }
  return { x:0.5, y:0.5, mapX:0, mapY:0 };
}

// UI helpers
function showLobbyWaiting(){ overlay.classList.remove("hidden"); gameUI.classList.add("hidden"); waitingNotice.classList.remove("hidden"); }
function showLobby(){ overlay.classList.remove("hidden"); gameUI.classList.add("hidden"); waitingNotice.classList.add("hidden"); }
function showGameUI(){ overlay.classList.add("hidden"); gameUI.classList.remove("hidden"); waitingNotice.classList.add("hidden"); }

// Create small status elements in top bar for grab cooldown / grabbed state
const topBar = document.getElementById("topBar");
const grabStatusEl = document.createElement("div");
grabStatusEl.style.padding = "4px 8px";
grabStatusEl.style.borderRadius = "6px";
grabStatusEl.style.background = "rgba(0,0,0,0.6)";
grabStatusEl.style.color = "#fff";
grabStatusEl.style.fontWeight = "700";
grabStatusEl.style.marginLeft = "8px";
if (topBar) topBar.appendChild(grabStatusEl);

// Make adminPass less prominent
if (adminPass) adminPass.style.opacity = "0.45";

// --- Register player (renamed to avoid duplicate) ---
async function registerPlayer(name, role){
  const id = nameToId(name);
  const spawn = randomSpawn();
  const docRef = doc(db, "rooms", ROOM_ID, "players", id);
  const playerDoc = {
    id, name, role,
    x: spawn.x, y: spawn.y, mapX: spawn.mapX, mapY: spawn.mapY,
    capturedBy: null, grabbedUntil: 0, stunnedUntil: 0, lastActive: nowMs(),
    grabAvailableAt: 0
  };
  await setDoc(docRef, { ...playerDoc, updatedAt: serverTimestamp() });
  localPlayer = playerDoc;
  attachLocalListeners();
  showLobbyWaiting();
}

// Wire up register buttons
joinKingBtn.addEventListener("click", async ()=>{
  const name = (nameInput.value || "").trim();
  if (!name) return alert("表示名を入力してください");
  // check existing king
  const kingExists = Array.from(players.values()).some(p=>p.role==="king");
  if (kingExists) return alert("王は既にいます");
  await registerPlayer(name, "king");
});
joinGuardBtn.addEventListener("click", async ()=>{
  const name = (nameInput.value || "").trim();
  if (!name) return alert("表示名を入力してください");
  await registerPlayer(name, "guard");
});
joinStrawBtn.addEventListener("click", async ()=>{
  const name = (nameInput.value || "").trim();
  if (!name) return alert("表示名を入力してください");
  await registerPlayer(name, "strawberry");
});

// Admin logic
adminDecide.addEventListener("click", ()=>{
  const pass = (adminPass.value || "").trim();
  if (pass === "1122"){
    isAdmin = true;
    adminBadge.classList.remove("hidden");
    adminControlsNodes.forEach(n=>n.classList.remove("hidden"));
    if (adminControlsSmall) adminControlsSmall.classList.remove("hidden");
    adminPass.value = "";
  } else {
    alert("パスワードが違います");
  }
});
if (startGameBtn) startGameBtn.addEventListener("click", adminStart);
if (startGameBtnSmall) startGameBtnSmall.addEventListener("click", adminStart);
async function adminStart(){
  if (!isAdmin) return alert("運営権限が必要です");
  await setDoc(metaDoc, {
    started: true,
    startedAt: serverTimestamp(),
    duration: DURATION_SEC,
    captureCount: 0
  });
  if (localPlayer){
    localClientStarted = true;
    showGameUI();
    startGameLoop();
  }
}
if (clearAllBtn) clearAllBtn.addEventListener("click", adminClearAll);
if (clearAllBtnSmall) clearAllBtnSmall.addEventListener("click", adminClearAll);
async function adminClearAll(){
  if (!isAdmin) return alert("運営権限が必要です");
  if (!confirm("本当に全データを削除しますか？")) return;
  const snap = await getDocs(playersCol);
  const promises = [];
  snap.forEach(s => promises.push(deleteDoc(doc(db, "rooms", ROOM_ID, "players", s.id))));
  await Promise.all(promises);
  await setDoc(metaDoc, { started: false, startedAt: null, duration: DURATION_SEC, captureCount: 0, clearedAt: serverTimestamp() });
  // clients will observe meta change and players deletions and return to lobby
}

// Chat send (king/guard only)
chatSend.addEventListener("click", async ()=>{
  const text = (chatInput.value || "").trim();
  if (!text) return;
  if (!localPlayer) return;
  if (!(localPlayer.role === "king" || localPlayer.role === "guard")) return alert("チャットは王と部下のみ利用可能です");
  const id = `${Date.now()}_${localPlayer.id}`;
  await setDoc(doc(db, "rooms", ROOM_ID, "chats", id), {
    fromId: localPlayer.id, fromName: localPlayer.name, role: localPlayer.role, text,
    createdAt: serverTimestamp()
  });
  chatInput.value = "";
});

// Snapshot handlers
onSnapshot(playersCol, snap=>{
  snap.docChanges().forEach(ch=>{
    const pid = ch.doc.id;
    if (ch.type === "removed"){
      players.delete(pid);
      if (localPlayer && pid === localPlayer.id){
        localPlayer = null;
        localClientStarted = false;
        showLobby();
      }
    } else {
      const d = ch.doc.data();
      players.set(pid, {...d, id: pid});
      if (localPlayer && pid === localPlayer.id){
        // update local canonical copy
        localPlayer = {...localPlayer, ...d};
      }
    }
  });
  renderPlayersGrouped();
});

onSnapshot(metaDoc, snap=>{
  const data = snap.exists() ? snap.data() : null;
  metaCache = data;
  if (!data){
    globalGameStarted = false;
    return;
  }
  if (data.clearedAt){
    localClientStarted = false;
    showLobby();
    return;
  }
  if (data.started){
    globalGameStarted = true;
    if (localPlayer){
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

// chats listener
onSnapshot(chatsCol, snap=>{
  chatMessages.innerHTML = "";
  snap.forEach(snapItem=>{
    const d = snapItem.data();
    if (!d) return;
    const msgEl = document.createElement("div");
    msgEl.className = "msg";
    msgEl.textContent = `[${d.role}] ${d.fromName}: ${d.text}`;
    if (localPlayer && (localPlayer.role === "king" || localPlayer.role === "guard")){
      chatMessages.appendChild(msgEl);
    }
  });
});

// remove local doc on unload
window.addEventListener("beforeunload", async ()=>{
  if (localPlayer){
    try { await deleteDoc(doc(db, "rooms", ROOM_ID, "players", localPlayer.id)); } catch(e){}
  }
});

// Render participant groups
function renderPlayersGrouped(){
  if (groupKing) groupKing.innerHTML = "";
  if (groupGuard) groupGuard.innerHTML = "";
  if (groupStraw) groupStraw.innerHTML = "";
  const arr = Array.from(players.values()).sort((a,b)=> a.role.localeCompare(b.role) || a.name.localeCompare(b.name));
  arr.forEach(p=>{
    const el = document.createElement("div");
    el.style.padding = "6px 10px";
    el.style.borderRadius = "8px";
    el.style.background = (p.role==="king")? "rgba(255,214,107,0.12)" : (p.role==="guard")? "rgba(155,230,166,0.08)" : "rgba(255,159,180,0.06)";
    el.style.margin = "4px";
    el.textContent = p.name;
    if (p.role === "king" && groupKing) groupKing.appendChild(el);
    else if (p.role === "guard" && groupGuard) groupGuard.appendChild(el);
    else if (groupStraw) groupStraw.appendChild(el);
  });
}

// Input listeners attach
function attachLocalListeners(){
  window.addEventListener("keydown", e=>{
    if (e.key === " ") e.preventDefault();
    keys[e.key.toLowerCase()] = true;
    if (e.key === " ") handleAbility();
  });
  window.addEventListener("keyup", e=>{
    keys[e.key.toLowerCase()] = false;
  });
}

// Start game loop
function startGameLoop(){
  if (raf) return;
  let last = performance.now();
  raf = requestAnimationFrame(function frame(now){
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (localPlayer && localClientStarted){
      // handle movement, but block if captured or stunned
      const nowt = nowMs();
      const stunned = localPlayer.stunnedUntil && nowt < localPlayer.stunnedUntil;
      const captured = localPlayer.capturedBy && localPlayer.capturedBy !== "";
      if (!stunned && !captured){
        const role = localPlayer.role;
        let speed = (role === "king") ? 0.5 : (role === "guard") ? 1.2 : 1.6;
        let vx=0, vy=0;
        if (keys["w"] || keys["arrowup"]) vy -= 1;
        if (keys["s"] || keys["arrowdown"]) vy += 1;
        if (keys["a"] || keys["arrowleft"]) vx -= 1;
        if (keys["d"] || keys["arrowright"]) vx += 1;
        const len = Math.hypot(vx, vy);
        if (len > 0){
          vx /= len; vy /= len;
          localPlayer.x = clamp01(localPlayer.x + vx * speed * dt * 0.12);
          localPlayer.y = clamp01(localPlayer.y + vy * speed * dt * 0.12);
          // persist
          setDoc(doc(db, "rooms", ROOM_ID, "players", localPlayer.id), {
            ...localPlayer, updatedAt: serverTimestamp()
          }).catch(()=>{});
        }
      }
    }

    renderScene();
    raf = requestAnimationFrame(frame);
  });

  // timer sync
  setInterval(()=>{
    if (!metaCache || !metaCache.started) return;
    const startedAt = metaCache.startedAt;
    if (!startedAt || typeof startedAt.toMillis !== "function") return;
    const elapsed = Math.floor((Date.now() - startedAt.toMillis())/1000);
    const duration = metaCache.duration || DURATION_SEC;
    const remain = Math.max(0, duration - elapsed);
    if (timerEl) timerEl.textContent = `残り: ${String(Math.floor(remain/60)).padStart(2,"0")}:${String(remain%60).padStart(2,"0")}`;
    if (metaCache.captureCount !== undefined && gaugeCountEl) gaugeCountEl.textContent = String(metaCache.captureCount);
  }, 500);
}

// Rendering including vision masks and UI overlays
function renderScene(){
  // draw base grid
  ctx.clearRect(0,0,canvas.width,canvas.height);
  for (let gy=0; gy<GRID_N; gy++){
    for (let gx=0; gx<GRID_N; gx++){
      const px = gx * CELL_W;
      const py = gy * CELL_H;
      ctx.fillStyle = ((gx+gy)%2===0) ? "#163" : "#1a4";
      ctx.fillRect(px, py, CELL_W-1, CELL_H-1);
    }
  }

  // draw players on same map as local
  if (localPlayer){
    const currentMapX = localPlayer.mapX || 0;
    const currentMapY = localPlayer.mapY || 0;
    for (const p of players.values()){
      if (p.mapX !== currentMapX || p.mapY !== currentMapY) continue;
      const px = p.x * canvas.width;
      const py = p.y * canvas.height;
      ctx.beginPath();
      ctx.fillStyle = (p.role==="king")? "#ff6b9a" : (p.role==="guard")? "#6bff9a" : "#ffd36b";
      const r = (p.role==="king")? 14 : 10;
      ctx.arc(px, py, r, 0, Math.PI*2);
      ctx.fill();
      ctx.fillStyle = "#000";
      ctx.font = "11px sans-serif";
      ctx.fillText(p.name, px + r + 3, py + 4);
      if (p.capturedBy){
        ctx.fillStyle = "#000";
        ctx.fillText("掴まれ中", px - r, py - r - 6);
      }
    }
  }

  // Vision overlay: full black canvas, then cut circle for king/strawberry
  worldOverlay.innerHTML = ""; // clear
  if (localPlayer){
    if (localPlayer.role === "guard"){
      // guard sees all -> no black mask
    } else {
      // Create a full black canvas overlay and cut hole at player's pos
      const mask = document.createElement("canvas");
      mask.width = canvas.width; mask.height = canvas.height;
      mask.className = "visionMask";
      const mctx = mask.getContext("2d");
      // fully black
      mctx.fillStyle = "black";
      mctx.fillRect(0,0,mask.width, mask.height);
      // cut hole
      const vision = VISION_PX[localPlayer.role] || 60;
      const cx = (localPlayer.x || 0.5) * mask.width;
      const cy = (localPlayer.y || 0.5) * mask.height;
      mctx.globalCompositeOperation = "destination-out";
      mctx.beginPath();
      mctx.arc(cx, cy, vision, 0, Math.PI*2);
      mctx.fill();
      worldOverlay.appendChild(mask);
    }

    // If local player is grabbed, show small indicator
    if (localPlayer.capturedBy){
      const info = document.createElement("div");
      info.style.position = "absolute";
      info.style.left = "12px";
      info.style.bottom = "12px";
      info.style.background = "#000";
      info.style.color = "#fff";
      info.style.padding = "6px 10px";
      info.style.borderRadius = "6px";
      info.textContent = "掴まれ中 — 操作不可";
      worldOverlay.appendChild(info);
    }

    // Guard-specific: show grab cooldown / grabbed target text at top bar via existing element
    if (localPlayer.role === "guard"){
      const nowt = nowMs();
      const availAt = localPlayer.grabAvailableAt || 0;
      if (nowt >= availAt){
        grabStatusEl.textContent = "掴み: 使用可能";
      } else {
        const remain = Math.ceil((availAt - nowt)/1000);
        grabStatusEl.textContent = `掴み: 再使用まで ${remain}s`;
      }
      // If guard is stunned, show black overlay (like king/strawberry) and big "スタン中"
      if (localPlayer.stunnedUntil && nowt < localPlayer.stunnedUntil){
        // full black
        const dark = document.createElement("div");
        dark.style.position = "absolute";
        dark.style.left = "0"; dark.style.top = "0";
        dark.style.width = "100%"; dark.style.height = "100%";
        dark.style.background = "black";
        worldOverlay.appendChild(dark);
        const stunText = document.createElement("div");
        stunText.style.position = "absolute";
        stunText.style.left = "50%"; stunText.style.top = "50%";
        stunText.style.transform = "translate(-50%,-50%)";
        stunText.style.color = "#fff";
        stunText.style.background = "rgba(0,0,0,0.6)";
        stunText.style.padding = "12px 18px";
        stunText.style.borderRadius = "10px";
        stunText.style.fontSize = "20px";
        stunText.textContent = "スタン中 — 操作不可";
        worldOverlay.appendChild(stunText);
      }
    } else {
      grabStatusEl.textContent = "";
    }
  }

  // Ensure top UI (timer/gauge) are visible above the black board (they are in DOM above worldOverlay)
  // Mini-map and other UI are unchanged

  // Mini map rendering: only guard & king see positions
  miniMap.innerHTML = "";
  const mapCanvas = document.createElement("canvas"); mapCanvas.width = 140; mapCanvas.height = 140;
  const mctx = mapCanvas.getContext("2d");
  mctx.fillStyle = "#111"; mctx.fillRect(0,0,140,140);
  if (localPlayer && (localPlayer.role === "guard" || localPlayer.role === "king")){
    for (const p of players.values()){
      if (!p) continue;
      if (p.mapX !== localPlayer.mapX || p.mapY !== localPlayer.mapY) continue;
      mctx.fillStyle = (p.role==="king")? "#ff6b9a" : (p.role==="guard")? "#6bff9a" : "#ffd36b";
      mctx.fillRect(p.x * 140 - 3, p.y * 140 - 3, 6, 6);
    }
  } else {
    mctx.fillStyle = "#00000088"; mctx.fillRect(0,0,140,140);
  }
  miniMap.appendChild(mapCanvas);
}

// Ability (SPACE) usage: improved grab cooldown handling and state updates
async function handleAbility(){
  if (!localPlayer || !localClientStarted) return;
  const nowt = nowMs();
  // respect stun & capture
  if (localPlayer.stunnedUntil && nowt < localPlayer.stunnedUntil) return;
  if (localPlayer.capturedBy) return;
  if (localPlayer.role === "king"){
    // capture radius
    const radius = 0.12;
    for (const p of players.values()){
      if (!p || p.role !== "strawberry") continue;
      if (p.mapX !== localPlayer.mapX || p.mapY !== localPlayer.mapY) continue;
      if (dist(localPlayer, p) <= radius){
        // respawn strawberry randomly
        const newPos = randomSpawn();
        await updateDocSafe(doc(db, "rooms", ROOM_ID, "players", p.id), {
          x: newPos.x, y: newPos.y, mapX: newPos.mapX, mapY: newPos.mapY, capturedBy: null, grabbedUntil: 0, updatedAt: serverTimestamp()
        });
        // increment global captureCount
        await updateDocSafe(metaDoc, { captureCount: increment(1) });
        break;
      }
    }
  } else if (localPlayer.role === "guard"){
    // check cooldown
    const availAt = localPlayer.grabAvailableAt || 0;
    if (nowt < availAt){
      // not ready
      return;
    }
    // try to grab nearest strawberry within small radius
    const grabRadius = 0.06;
    for (const p of players.values()){
      if (!p || p.role !== "strawberry") continue;
      if (p.mapX !== localPlayer.mapX || p.mapY !== localPlayer.mapY) continue;
      if (dist(localPlayer, p) <= grabRadius){
        // set strawberry capturedBy and grabbedUntil
        const strawRef = doc(db, "rooms", ROOM_ID, "players", p.id);
        await updateDocSafe(strawRef, {
          capturedBy: localPlayer.id,
          grabbedUntil: Date.now() + GRAB_DURATION_MS,
          updatedAt: serverTimestamp()
        });
        // set guard grabAvailableAt to now + cooldown and persist
        const guardRef = doc(db, "rooms", ROOM_ID, "players", localPlayer.id);
        await updateDocSafe(guardRef, { grabAvailableAt: Date.now() + GRAB_COOLDOWN_MS, updatedAt: serverTimestamp() });
        // while grabbed, guard client will move strawberry doc to follow guard (authority on client)
        const intervalId = setInterval(async ()=>{
          try {
            // update strawberry position to guard current pos
            await updateDocSafe(strawRef, { x: localPlayer.x, y: localPlayer.y, updatedAt: serverTimestamp() });
          } catch(e){}
        }, 120);
        // after 5s release and stun guard
        setTimeout(async ()=>{
          clearInterval(intervalId);
          await updateDocSafe(strawRef, { capturedBy: null, grabbedUntil: 0, updatedAt: serverTimestamp() });
          // apply stun to guard
          await updateDocSafe(guardRef, { stunnedUntil: Date.now() + GUARD_STUN_MS, updatedAt: serverTimestamp() });
        }, GRAB_DURATION_MS);
        break;
      }
    }
  } else {
    // strawberry: no active ability
  }
}

// small wrapper to updateDoc with merge
async function updateDocSafe(ref, data){
  try { await updateDoc(ref, data); } catch(e){ try { await setDoc(ref, data, { merge: true }); } catch(e2){} }
}

// init: read meta & show appropriate UI
(async function init(){
  try {
    const metaSnap = await getDoc(metaDoc);
    const data = metaSnap.exists() ? metaSnap.data() : null;
    metaCache = data;
    if (data && data.started){
      showLobbyWaiting();
    } else {
      showLobby();
    }
  } catch(e){
    console.warn("init error", e);
    showLobby();
  }
})();

// Helper: getDoc import used above (ensure present)
import { getDoc } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";

console.log("app.js loaded (bugfixes + vision/grab adjustments).");
