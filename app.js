// app.js - 修正版（重複関数削除・クリック無反応修正・画像フォールバック）
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js";
import {
  getFirestore, collection, doc, setDoc, onSnapshot, updateDoc, deleteDoc,
  getDocs, serverTimestamp, getDoc, increment
} from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";

// Firebase config (既定)
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

// DOM elements (存在チェックしてから使う)
const qs = id => document.getElementById(id);
const nameInput = qs("nameInput");
const joinKingBtn = qs("joinKingBtn");
const joinGuardBtn = qs("joinGuardBtn");
const joinStrawBtn = qs("joinStrawBtn");
const groupKing = qs("groupKing");
const groupGuard = qs("groupGuard");
const groupStraw = qs("groupStraw");
const overlay = qs("overlay");
const waitingNotice = qs("waitingNotice");
const adminPass = qs("adminPass");
const adminDecide = qs("adminDecide");
const adminBadge = qs("adminBadge");
const adminControlsNodes = document.querySelectorAll(".adminControls");
const adminControlsSmall = qs("adminControlsSmall");
const startGameBtn = qs("startGameBtn");
const startGameBtnSmall = qs("startGameBtn_small");
const clearAllBtn = qs("clearAllBtn");
const clearAllBtnSmall = qs("clearAllBtn_small");
const gameUI = qs("gameUI");
const gaugeCountEl = qs("gaugeCount");
const timerEl = qs("timer");
const roleIcon = qs("roleIcon");
const canvas = qs("gameCanvas");
const ctx = canvas ? canvas.getContext("2d") : null;
const miniMap = qs("miniMap");
const teamChat = qs("teamChat");
const chatMessages = qs("chatMessages");
const chatInput = qs("chatInput");
const chatSend = qs("chatSend");
const worldOverlay = qs("worldOverlay");

// Firestore refs
const ROOM_ID = "main_room";
const playersCol = collection(db, "rooms", ROOM_ID, "players");
const metaDoc = doc(db, "rooms", ROOM_ID, "meta", "state");
const chatsCol = collection(db, "rooms", ROOM_ID, "chats");

// state
let localPlayer = null;
const players = new Map();
let keys = {};
let localClientStarted = false;
let globalGameStarted = false;
let isAdmin = false;
let metaCache = null;
let collisionMaskCtx = null; // optional
let raf = null;

// assets (optional)
const ASSET_BASE = "https://raw.githubusercontent.com/zzcafe-2800/zzke-ki/main/";
const ASSETS = {
  map: ASSET_BASE + "e.png",
  collisionMask: ASSET_BASE + "atarihantei.png",
  pimg: ASSET_BASE + "p.png",
  eaudio: ASSET_BASE + "e.mp3"
};
const imgCache = {};
async function tryLoadImage(key, url){
  try {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = url;
    await new Promise((res) => { img.onload = res; img.onerror = res; setTimeout(res, 2000); });
    imgCache[key] = img;
  } catch(e){
    imgCache[key] = null;
  }
}

// minimal preloads (non-blocking)
tryLoadImage("map", ASSETS.map).catch(()=>{});
tryLoadImage("mask", ASSETS.collisionMask).catch(()=>{});
tryLoadImage("p", ASSETS.pimg).catch(()=>{});

// helpers
function nameToId(name){
  return name.trim().toLowerCase().replace(/\s+/g,"_").replace(/[^a-z0-9_\-]/g,"") || ("player_"+Math.floor(Math.random()*10000));
}
function clamp01(v){ return Math.max(0, Math.min(1, v)); }
function dist(a,b){ return Math.hypot(a.x - b.x, a.y - b.y); }
async function updateDocSafe(ref, data){ try { await updateDoc(ref, data); } catch(e){ try{ await setDoc(ref, data, {merge:true}); }catch{} } }

// collision mask support (optional)
async function ensureCollisionMask(){
  const img = imgCache["mask"];
  if (!img || !canvas) { collisionMaskCtx = null; return; }
  const c = document.createElement("canvas");
  c.width = canvas.width; c.height = canvas.height;
  const cctx = c.getContext("2d");
  cctx.drawImage(img, 0, 0, c.width, c.height);
  collisionMaskCtx = cctx;
}

// random spawn: avoid black pixels if mask exists
function randomSpawn(){
  const margin = 0.08;
  if (!collisionMaskCtx || !canvas) {
    return { x: Math.random()*(1-2*margin) + margin, y: Math.random()*(1-2*margin) + margin, mapX:0, mapY:0 };
  }
  let attempts = 0;
  while (attempts++ < 60){
    const x = Math.random();
    const y = Math.random();
    const px = Math.floor(x * canvas.width);
    const py = Math.floor(y * canvas.height);
    const d = collisionMaskCtx.getImageData(px, py, 1, 1).data;
    if (!(d[0]===0 && d[1]===0 && d[2]===0 && d[3] !== 0)) {
      return { x, y, mapX:0, mapY:0 };
    }
  }
  return { x: 0.5, y: 0.5, mapX:0, mapY:0 };
}

// SINGLE registerAs (fixed, no duplicates)
async function registerAs(name, role){
  const id = nameToId(name);
  // ensure optional mask ready (non-blocking)
  await ensureCollisionMask().catch(()=>{});
  const spawn = randomSpawn();
  const playerDoc = {
    id, name, role,
    x: spawn.x, y: spawn.y, mapX: spawn.mapX, mapY: spawn.mapY,
    capturedBy: null, grabbedUntil: 0, stunnedUntil: 0, lastActive: Date.now()
  };
  await setDoc(doc(db, "rooms", ROOM_ID, "players", id), {
    ...playerDoc, updatedAt: serverTimestamp()
  });
  localPlayer = playerDoc;
  attachLocalListeners();
  showLobbyWaiting();
}

// UI show/hide helpers
function showLobbyWaiting(){ if (overlay) overlay.classList.remove("hidden"); if (gameUI) gameUI.classList.add("hidden"); if (waitingNotice) waitingNotice.classList.remove("hidden"); }
function showLobby(){ if (overlay) overlay.classList.remove("hidden"); if (gameUI) gameUI.classList.add("hidden"); if (waitingNotice) waitingNotice.classList.add("hidden"); }
function showGameUI(){ if (overlay) overlay.classList.add("hidden"); if (gameUI) gameUI.classList.remove("hidden"); if (waitingNotice) waitingNotice.classList.add("hidden"); }

// attach keyboard
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

// event listeners (attach only if element exists)
if (joinKingBtn) joinKingBtn.addEventListener("click", async ()=>{
  const name = (nameInput?.value || "").trim(); if (!name) return alert("表示名を入力してください");
  // check king existence
  const kingExists = Array.from(players.values()).some(p=>p.role==="king");
  if (kingExists) return alert("王は既にいます");
  await registerAs(name, "king");
});
if (joinGuardBtn) joinGuardBtn.addEventListener("click", async ()=>{
  const name = (nameInput?.value || "").trim(); if (!name) return alert("表示名を入力してください");
  await registerAs(name, "guard");
});
if (joinStrawBtn) joinStrawBtn.addEventListener("click", async ()=>{
  const name = (nameInput?.value || "").trim(); if (!name) return alert("表示名を入力してください");
  await registerAs(name, "strawberry");
});

// admin
if (adminDecide) adminDecide.addEventListener("click", ()=>{
  const pass = (adminPass?.value || "").trim();
  if (pass === "1122"){ isAdmin = true; if (adminBadge) adminBadge.classList.remove("hidden"); adminControlsNodes.forEach(n=>n.classList.remove("hidden")); if (adminControlsSmall) adminControlsSmall.classList.remove("hidden"); adminPass.value = ""; }
  else alert("パスワードが違います");
});
async function adminStart(){
  if (!isAdmin) return alert("運営権限が必要です");
  await setDoc(metaDoc, { started:true, startedAt: serverTimestamp(), duration: 10*60, captureCount: 0 });
  if (localPlayer) { localClientStarted = true; showGameUI(); startGameLoop(); }
}
if (startGameBtn) startGameBtn.addEventListener("click", adminStart);
if (startGameBtnSmall) startGameBtnSmall.addEventListener("click", adminStart);

async function adminClearAll(){
  if (!isAdmin) return alert("運営権限が必要です");
  if (!confirm("本当に全データを削除しますか？")) return;
  const snap = await getDocs(playersCol);
  const promises = [];
  snap.forEach(s => promises.push(deleteDoc(doc(db, "rooms", ROOM_ID, "players", s.id))));
  await Promise.all(promises);
  await setDoc(metaDoc, { started:false, startedAt:null, duration:10*60, captureCount:0, clearedAt: serverTimestamp() });
}
if (clearAllBtn) clearAllBtn.addEventListener("click", adminClearAll);
if (clearAllBtnSmall) clearAllBtnSmall.addEventListener("click", adminClearAll);

// chat (king+guard only)
if (chatSend){
  chatSend.addEventListener("click", async ()=>{
    const text = (chatInput?.value || "").trim(); if (!text) return;
    if (!localPlayer) return;
    if (!(localPlayer.role === "king" || localPlayer.role === "guard")) return alert("チャットは王と部下のみ利用可能です");
    await setDoc(doc(db, "rooms", ROOM_ID, "chats", `${Date.now()}_${localPlayer.id}`), {
      fromId: localPlayer.id, fromName: localPlayer.name, role: localPlayer.role, text, createdAt: serverTimestamp()
    });
    if (chatInput) chatInput.value = "";
  });
}

// Firestore snapshots
onSnapshot(playersCol, snap=>{
  snap.docChanges().forEach(ch=>{
    const pid = ch.doc.id;
    if (ch.type === "removed"){ players.delete(pid); if (localPlayer && pid === localPlayer.id){ localPlayer = null; localClientStarted = false; showLobby(); } }
    else { const d = ch.doc.data(); players.set(pid, {...d, id: pid}); if (localPlayer && pid === localPlayer.id) localPlayer = {...localPlayer, ...d}; }
  });
  renderPlayersGrouped();
});

onSnapshot(metaDoc, snap=>{
  const data = snap.exists() ? snap.data() : null;
  metaCache = data;
  if (!data){ globalGameStarted = false; return; }
  if (data.clearedAt){ localClientStarted = false; showLobby(); return; }
  if (data.started){
    globalGameStarted = true;
    if (localPlayer){ localClientStarted = true; showGameUI(); startGameLoop(); }
    else showLobbyWaiting();
    if (gaugeCountEl) gaugeCountEl.textContent = String(data.captureCount || 0);
  } else {
    globalGameStarted = false;
    if (!localClientStarted) showLobby();
  }
});

onSnapshot(chatsCol, snap=>{
  if (!chatMessages) return;
  chatMessages.innerHTML = "";
  snap.forEach(s=>{
    const d = s.data();
    if (!d) return;
    const el = document.createElement("div"); el.className = "msg"; el.textContent = `[${d.role}] ${d.fromName}: ${d.text}`;
    if (localPlayer && (localPlayer.role === "king" || localPlayer.role === "guard")) chatMessages.appendChild(el);
  });
});

// UI render of players grouped
function renderPlayersGrouped(){
  if (groupKing) groupKing.innerHTML = "";
  if (groupGuard) groupGuard.innerHTML = "";
  if (groupStraw) groupStraw.innerHTML = "";
  const arr = Array.from(players.values()).sort((a,b)=> a.role.localeCompare(b.role) || a.name.localeCompare(b.name));
  arr.forEach(p=>{
    const el = document.createElement("div");
    el.style.padding = "6px 10px";
    el.style.borderRadius = "8px";
    el.style.background = (p.role==="king")? "linear-gradient(90deg,#ffd66b33,#ffd66b11)" : (p.role==="guard")? "linear-gradient(90deg,#9be6a633,#9be6a611)" : "linear-gradient(90deg,#ff9fb433,#ff9fb411)";
    el.style.margin = "4px";
    el.textContent = p.name;
    if (p.role === "king" && groupKing) groupKing.appendChild(el);
    else if (p.role === "guard" && groupGuard) groupGuard.appendChild(el);
    else if (groupStraw) groupStraw.appendChild(el);
  });
}

// start loop
function startGameLoop(){
  if (!canvas || !ctx) return;
  if (raf) return;
  let last = performance.now();
  if (!collisionMaskCtx) ensureCollisionMask().catch(()=>{});
  function loop(now){
    const dt = Math.min(0.1, (now - last)/1000);
    last = now;
    if (localPlayer && localClientStarted){
      const role = localPlayer.role;
      let speed = (role==="king")? 0.6 : (role==="guard")? 1.2 : 1.6;
      let vx=0, vy=0;
      if (keys["w"]||keys["arrowup"]) vy -= 1;
      if (keys["s"]||keys["arrowdown"]) vy += 1;
      if (keys["a"]||keys["arrowleft"]) vx -= 1;
      if (keys["d"]||keys["arrowright"]) vx += 1;
      const len = Math.hypot(vx,vy);
      if (len > 0){
        vx/=len; vy/=len;
        let nx = localPlayer.x + vx * speed * dt * 0.12;
        let ny = localPlayer.y + vy * speed * dt * 0.12;
        // clamp and check collision (simple)
        nx = clamp01(nx); ny = clamp01(ny);
        const canWalk = canWalkAt(nx, ny);
        if (canWalk){
          localPlayer.x = nx; localPlayer.y = ny;
          setDoc(doc(db, "rooms", ROOM_ID, "players", localPlayer.id), { ...localPlayer, updatedAt: serverTimestamp() }).catch(()=>{});
        }
      }
    }
    render();
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);
  // timer sync (based on meta.startedAt)
  setInterval(()=>{
    if (!metaCache || !metaCache.started) return;
    const startedAt = metaCache.startedAt;
    if (!startedAt || typeof startedAt.toMillis !== "function") return;
    const elapsed = Math.floor((Date.now() - startedAt.toMillis())/1000);
    const duration = metaCache.duration || 600;
    const remain = Math.max(0, duration - elapsed);
    if (timerEl) timerEl.textContent = `残り: ${String(Math.floor(remain/60)).padStart(2,"0")}:${String(remain%60).padStart(2,"0")}`;
  }, 500);
}

// collision check (pixel mask optional)
function canWalkAt(normX, normY){
  if (!collisionMaskCtx || !canvas) return true;
  const px = Math.floor(normX * canvas.width);
  const py = Math.floor(normY * canvas.height);
  if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return false;
  const d = collisionMaskCtx.getImageData(px, py, 1, 1).data;
  if (d[0] === 0 && d[1] === 0 && d[2] === 0 && d[3] !== 0) return false;
  return true;
}

// render: map placeholder, players, vision mask fallbacks
function render(){
  if (!ctx || !canvas) return;
  ctx.clearRect(0,0,canvas.width,canvas.height);
  // background (image if available, otherwise grid)
  const mapImg = imgCache["map"];
  if (mapImg && mapImg.complete && mapImg.naturalWidth){
    ctx.drawImage(mapImg, 0,0, canvas.width, canvas.height);
  } else {
    // fallback grid
    for (let gy=0; gy<7; gy++){
      for (let gx=0; gx<7; gx++){
        ctx.fillStyle = ((gx+gy)%2===0) ? "#163" : "#1a4";
        ctx.fillRect(gx*(canvas.width/7), gy*(canvas.height/7), canvas.width/7 - 1, canvas.height/7 - 1);
      }
    }
  }

  // draw players present on same map (simplified: mapX,mapY ignored here for brevity)
  players.forEach(p=>{
    const px = p.x * canvas.width;
    const py = p.y * canvas.height;
    ctx.beginPath();
    ctx.fillStyle = (p.role==="king")? "#ff6b9a" : (p.role==="guard")? "#6bff9a" : "#ffd36b";
    const r = (p.role==="king")? 14 : 10;
    ctx.arc(px, py, r, 0, Math.PI*2);
    ctx.fill();
    // name
    ctx.fillStyle = "#000";
    ctx.font = "12px sans-serif";
    ctx.fillText(p.name, px + r + 4, py + 6);
  });

  // vision overlays: for guard nothing; for king/strawberry apply dark overlay with circular clear
  if (localPlayer){
    if (localPlayer.role !== "guard"){
      worldOverlay.innerHTML = "";
      const maskC = document.createElement("canvas");
      maskC.width = canvas.width; maskC.height = canvas.height;
      maskC.className = "visionMask";
      const mctx = maskC.getContext("2d");
      mctx.fillStyle = "rgba(0,0,0,0.92)";
      mctx.fillRect(0,0,maskC.width, maskC.height);
      const visionPx = (localPlayer.role === "king") ? 140 : 160;
      const cx = localPlayer.x * maskC.width;
      const cy = localPlayer.y * maskC.height;
      const g = mctx.createRadialGradient(cx, cy, Math.max(1, visionPx*0.2), cx, cy, visionPx);
      g.addColorStop(0, "rgba(0,0,0,1)");
      g.addColorStop(0.6, "rgba(0,0,0,0.6)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      mctx.globalCompositeOperation = "destination-out";
      mctx.fillStyle = g;
      mctx.beginPath();
      mctx.arc(cx, cy, visionPx, 0, Math.PI*2);
      mctx.fill();
      worldOverlay.appendChild(maskC);
    } else {
      worldOverlay.innerHTML = "";
    }
    // strawberry enemy direction marker (if strawberry)
    if (localPlayer.role === "strawberry"){
      let nearest = null; let nd = Infinity;
      players.forEach(p=>{
        if (p.role === "strawberry") return;
        const d = dist(localPlayer, p);
        if (d < nd){ nd = d; nearest = p; }
      });
      if (nearest){
        const meters = Math.round(nd * 15);
        const angle = Math.atan2((nearest.y - localPlayer.y),(nearest.x - localPlayer.x));
        const cx = canvas.width/2, cy = canvas.height/2;
        const r = Math.min(cx, cy) - 40;
        const mx = cx + Math.cos(angle) * r;
        const my = cy + Math.sin(angle) * r;
        const marker = document.createElement("div");
        Object.assign(marker.style, {
          position: "absolute", left: `${mx-28}px`, top: `${my-18}px`,
          width: "56px", height: "36px", background: "rgba(255,60,60,0.85)", color:"#fff",
          display:"flex", alignItems:"center", justifyContent:"center", borderRadius:"6px", fontWeight:"700", pointerEvents:"none"
        });
        marker.textContent = `?? ${meters}m`;
        worldOverlay.appendChild(marker);
      }
    }
  }
  // update UI fields safely
  if (gaugeCountEl && metaCache) gaugeCountEl.textContent = String(metaCache.captureCount || 0);
  if (roleIcon && localPlayer) roleIcon.textContent = localPlayer.role;
  renderMiniMap();
}

// render mini map
function renderMiniMap(){
  if (!miniMap) return;
  miniMap.innerHTML = "";
  const mcan = document.createElement("canvas"); mcan.width = 140; mcan.height = 140;
  const mctx = mcan.getContext("2d");
  mctx.fillStyle = "#111"; mctx.fillRect(0,0,140,140);
  if (localPlayer && (localPlayer.role === "guard" || localPlayer.role === "king")){
    players.forEach(p=>{
      const mx = p.x * mcan.width, my = p.y * mcan.height;
      mctx.fillStyle = (p.role==="king") ? "#ff6b9a" : (p.role==="guard") ? "#6bff9a" : "#ffd36b";
      mctx.fillRect(mx-3, my-3, 6, 6);
    });
  } else {
    mctx.fillStyle = "#00000088"; mctx.fillRect(0,0,140,140);
  }
  miniMap.appendChild(mcan);
}

// ability (space)
async function handleAbility(){
  if (!localPlayer || !localClientStarted) return;
  const now = Date.now();
  if (localPlayer.stunnedUntil && now < localPlayer.stunnedUntil) return;
  if (localPlayer.capturedBy) return;
  if (localPlayer.role === "king"){
    const radius = 0.12;
    for (const p of players.values()){
      if (!p) continue;
      if (p.role !== "strawberry") continue;
      const d = dist(localPlayer, p);
      if (d <= radius){
        const newPos = randomSpawn();
        await updateDocSafe(doc(db, "rooms", ROOM_ID, "players", p.id), {
          x: newPos.x, y: newPos.y, updatedAt: serverTimestamp()
        });
        await updateDocSafe(metaDoc, { captureCount: increment(1) });
        break;
      }
    }
  } else if (localPlayer.role === "guard"){
    const grabRadius = 0.06;
    for (const p of players.values()){
      if (!p) continue;
      if (p.role !== "strawberry") continue;
      const d = dist(localPlayer, p);
      if (d <= grabRadius){
        const grabbedForMs = 5000;
        const stunMs = 15000;
        const strawRef = doc(db, "rooms", ROOM_ID, "players", p.id);
        await updateDocSafe(strawRef, { capturedBy: localPlayer.id, grabbedUntil: Date.now() + grabbedForMs, updatedAt: serverTimestamp() });
        const intervalId = setInterval(async ()=>{
          try { await updateDocSafe(strawRef, { x: localPlayer.x, y: localPlayer.y, updatedAt: serverTimestamp() }); } catch(e){}
        }, 150);
        setTimeout(async ()=>{
          clearInterval(intervalId);
          await updateDocSafe(strawRef, { capturedBy: null, grabbedUntil: 0, updatedAt: serverTimestamp() });
          await updateDocSafe(doc(db, "rooms", ROOM_ID, "players", localPlayer.id), { stunnedUntil: Date.now() + stunMs, updatedAt: serverTimestamp() });
        }, grabbedForMs);
        break;
      }
    }
  } else {
    // strawberry: no active ability
  }
}

// timer sync initial
setInterval(()=>{
  if (!metaCache || !metaCache.started) return;
  const startedAt = metaCache.startedAt;
  if (!startedAt || typeof startedAt.toMillis !== "function") return;
  const elapsed = Math.floor((Date.now() - startedAt.toMillis())/1000);
  const duration = metaCache.duration || 600;
  const remain = Math.max(0, duration - elapsed);
  if (timerEl) timerEl.textContent = `残り: ${String(Math.floor(remain/60)).padStart(2,"0")}:${String(remain%60).padStart(2,"0")}`;
}, 500);

// initial meta read
(async function init(){
  try {
    await tryLoadImage("map", ASSETS.map);
    await tryLoadImage("mask", ASSETS.collisionMask);
    await ensureCollisionMask();
    const metaSnap = await getDoc(metaDoc);
    metaCache = metaSnap.exists() ? metaSnap.data() : null;
    if (metaCache && metaCache.started) showLobbyWaiting(); else showLobby();
  } catch(e){
    console.warn("init err", e);
    showLobby();
  }
})();

// onSnapshot already set above for players/meta/chats

console.log("app.js loaded (fixed).");
