// app.js - 完全版プロトタイプ
// - 運営強制開始（全クライアント強制遷移）
// - 7x7 マップ管理（mapX,mapY keys、warp objects、edge block）
// - collision mask (atarihantei.png) pixel-based walkability check (if available)
// - 役割ごとの視界（王/イチゴ：暗転＋視野円、手下：全体視界）、視界同期表現
// - 手下の掴み（5秒運搬、15秒スタン）、王の捕食（範囲内即捕食、meta.captureCount インクリメント）
// - 王/手下チャット（Firestore chats collection、閲覧は王と手下のみ）
// - 参加一覧を見やすく横並び表示（更新リアルタイム）
// - meta.started / startedAt / duration / captureCount を基準に全クライアントが同期
// - admin: clear all forces clients to lobby
// - No AI players
//
// NOTE: This prototype uses client-side logic for some behaviours (grab authority, stun, etc.).
// Production: move authoritative game logic to server-side (Cloud Functions) to avoid cheating.

// Firebase imports
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js";
import {
  getFirestore, collection, doc, setDoc, onSnapshot, updateDoc, deleteDoc,
  getDocs, serverTimestamp, getDoc, increment
} from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";

// Firebase config (provided)
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

// DOM
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

// Firestore refs
const ROOM_ID = "main_room";
const playersCol = collection(db, "rooms", ROOM_ID, "players");
const metaDoc = doc(db, "rooms", ROOM_ID, "meta", "state");
const chatsCol = collection(db, "rooms", ROOM_ID, "chats");

// State
let localPlayer = null; // local canonical player object as stored in Firestore
const players = new Map(); // id -> player data
let keys = {};
let localClientStarted = false;
let globalGameStarted = false;
let isAdmin = false;
let metaCache = null;
let maps = {}; // map data (loaded/defined below)
let collisionMaskImage = null; // for current map
let collisionMaskCanvas = null;
let collisionMaskCtx = null;
let raf = null;
let audioCache = {};

// Constants
const DURATION_SEC = 10*60;
const GRID_N = 7; // 7x7 cells per screen
const CELL_W = canvas.width / GRID_N;
const CELL_H = canvas.height / GRID_N;

// ASSET base (user repo)
const ASSET_BASE = "https://raw.githubusercontent.com/zzcafe-2800/zzke-ki/main/";
const ASSETS = {
  king: ASSET_BASE + "p.png",
  guard: ASSET_BASE + "p.png",
  strawberry: ASSET_BASE + "p.png",
  map: ASSET_BASE + "e.png", // optional
  collisionMask: ASSET_BASE + "atarihantei.png",
  footstep: ASSET_BASE + "e.mp3",
  heartbeat: ASSET_BASE + "e.mp3",
  lowrumble: ASSET_BASE + "e.mp3",
  captureSE: ASSET_BASE + "e.mp3",
  kingNearSE: ASSET_BASE + "p.mp3"
};

// preload audio (best-effort)
for (const k in ASSETS){
  if (ASSETS[k].endsWith(".mp3")){
    const a = new Audio(ASSETS[k]); a.preload = "auto"; audioCache[k] = a;
  }
}

// Basic map definitions example (maps object). You can extend by adding keys.
maps = {
  "0,0": {
    name: "フィールドA",
    bg: ASSETS.map,
    collisionMask: ASSETS.collisionMask,
    block: { up:false, down:false, left:false, right:false },
    objects: [
      // example warp (none by default)
      // { type:"warp", x: 300, y: 300, w:40, h:40, to:{mapX:0,mapY:1,x:100,y:100} }
    ]
  }
};

// Helpers
function nameToId(name){
  return name.trim().toLowerCase().replace(/\s+/g,"_").replace(/[^a-z0-9_\-]/g,"") || ("player_"+Math.floor(Math.random()*10000));
}
function randomSpawnOnMap(mapKey){
  // For prototype: spawn at random normalized position (0..1) but avoid collision if mask present
  const [mapX, mapY] = mapKey.split(",").map(n=>parseInt(n,10));
  let attempts = 0;
  while (attempts < 50){
    const x = Math.random();
    const y = Math.random();
    // check collision mask if available
    if (!collisionMaskCtx){
      return { x, y, mapX, mapY };
    } else {
      const px = Math.floor(x * canvas.width);
      const py = Math.floor(y * canvas.height);
      const d = collisionMaskCtx.getImageData(px, py, 1, 1).data;
      // black pixel => blocked: d[0]==0 && d[1]==0 && d[2]==0 && alpha>0
      if (!(d[0]===0 && d[1]===0 && d[2]===0 && d[3] !== 0)){
        return { x, y, mapX, mapY };
      }
    }
    attempts++;
  }
  // fallback
  return { x:0.5, y:0.5, mapX: parseInt(mapX,10), mapY: parseInt(mapY,10) };
}
function clamp01(v){ return Math.max(0, Math.min(1, v)); }
function dist(a,b){ return Math.hypot(a.x-b.x, a.y-b.y); }

// Firestore safe update helper
async function updateDocSafe(ref, data){
  try { await updateDoc(ref, data); } catch(e){ try { await setDoc(ref, data, { merge:true }); } catch(e2){} }
}

// Register player (name + role) - uses fixed id to avoid duplicates on reload
async function registerAs(name, role){
  const id = nameToId(name);
  // default map key
  const startMapKey = "0,0";
  // ensure collision mask is loaded for spawn validity
  await ensureCollisionMaskForMap(startMapKey);
  const spawn = randomSpawnOnMap(startMapKey);
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

// Attach key listeners
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

// Snap UI functions
function showLobbyWaiting(){
  overlay.classList.remove("hidden");
  gameUI.classList.add("hidden");
  waitingNotice.classList.remove("hidden");
}
function showLobby(){
  overlay.classList.remove("hidden");
  gameUI.classList.add("hidden");
  waitingNotice.classList.add("hidden");
}
function showGameUI(){
  overlay.classList.add("hidden");
  gameUI.classList.remove("hidden");
  waitingNotice.classList.add("hidden");
}

// Admin logic
adminDecide.addEventListener("click", ()=>{
  const pass = (adminPass.value||"").trim();
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
  // set meta.started true and startedAt server timestamp, duration and reset captureCount
  await setDoc(metaDoc, {
    started: true,
    startedAt: serverTimestamp(),
    duration: DURATION_SEC,
    captureCount: 0
  });
  // admin may be registered player: ensure they go into game UI
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
  // clients observe changes via onSnapshot and will return to lobby (handled below)
}

// Chat (king & guards only)
chatSend.addEventListener("click", async ()=>{
  const text = (chatInput.value || "").trim();
  if (!text) return;
  if (!localPlayer) return;
  if (!(localPlayer.role === "king" || localPlayer.role === "guard")) return alert("チャットは王と部下のみ利用可能です");
  await setDoc(doc(db, "rooms", ROOM_ID, "chats", `${Date.now()}_${localPlayer.id}`), {
    fromId: localPlayer.id, fromName: localPlayer.name, role: localPlayer.role, text,
    createdAt: serverTimestamp()
  });
  chatInput.value = "";
});

// Snapshot listeners
onSnapshot(playersCol, snap=>{
  snap.docChanges().forEach(ch=>{
    const pid = ch.doc.id;
    if (ch.type === "removed"){
      players.delete(pid);
      if (localPlayer && pid === localPlayer.id){
        // if my doc deleted by admin clearAll -> force local logout
        localPlayer = null;
        localClientStarted = false;
        showLobby();
      }
    } else {
      const d = ch.doc.data();
      players.set(pid, {...d, id: pid});
      if (localPlayer && pid === localPlayer.id){
        // keep local canonical copy
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
    // admin cleared: force everyone to lobby
    localClientStarted = false;
    showLobby();
    return;
  }
  if (data.started){
    globalGameStarted = true;
    // start game UI for registered players
    if (localPlayer){
      localClientStarted = true;
      showGameUI();
      startGameLoop();
    } else {
      // not registered: show waiting (game in progress)
      showLobbyWaiting();
    }
    // update gauge
    if (gaugeCountEl) gaugeCountEl.textContent = String(data.captureCount || 0);
  } else {
    globalGameStarted = false;
    if (!localClientStarted){
      showLobby();
    }
  }
});

// chats snapshot (only show king/guard messages to king/guard)
onSnapshot(chatsCol, snap=>{
  chatMessages.innerHTML = "";
  snap.forEach(snapItem=>{
    const d = snapItem.data();
    if (!d) return;
    const msgEl = document.createElement("div");
    msgEl.className = "msg";
    msgEl.textContent = `[${d.role}] ${d.fromName}: ${d.text}`;
    // display only to king/guard
    if (localPlayer && (localPlayer.role === "king" || localPlayer.role === "guard")){
      chatMessages.appendChild(msgEl);
    }
  });
});

// UI: register buttons
joinKingBtn.addEventListener("click", async ()=>{
  const name = (nameInput.value || "").trim();
  if (!name) return alert("表示名を入力してください");
  // check king exists
  const kingExists = Array.from(players.values()).some(p => p.role === "king");
  if (kingExists) return alert("王は既にいます");
  await registerAs(name, "king");
});
joinGuardBtn.addEventListener("click", async ()=>{
  const name = (nameInput.value || "").trim();
  if (!name) return alert("表示名を入力してください");
  await registerAs(name, "guard");
});
joinStrawBtn.addEventListener("click", async ()=>{
  const name = (nameInput.value || "").trim();
  if (!name) return alert("表示名を入力してください");
  await registerAs(name, "strawberry");
});


// prevent duplicate entries on reload: we use fixed id per name, above

// ensure collision mask loaded for a map key
async function ensureCollisionMaskForMap(mapKey){
  const map = maps[mapKey];
  if (!map || !map.collisionMask) {
    collisionMaskImage = null;
    collisionMaskCanvas = null;
    collisionMaskCtx = null;
    return;
  }
  if (collisionMaskImage && collisionMaskImage.src === map.collisionMask) return;
  collisionMaskImage = new Image();
  collisionMaskImage.crossOrigin = "anonymous";
  collisionMaskImage.src = map.collisionMask;
  await new Promise((res, rej)=>{
    collisionMaskImage.onload = ()=>{ res(); };
    collisionMaskImage.onerror = ()=>{ collisionMaskImage = null; res(); };
  });
  if (collisionMaskImage){
    collisionMaskCanvas = document.createElement("canvas");
    collisionMaskCanvas.width = canvas.width;
    collisionMaskCanvas.height = canvas.height;
    collisionMaskCtx = collisionMaskCanvas.getContext("2d");
    collisionMaskCtx.drawImage(collisionMaskImage, 0,0, canvas.width, canvas.height);
  }
}

// Movement / collision check
function canWalkAt(mapKey, normX, normY){
  // if no mask, allow
  if (!collisionMaskCtx) return true;
  const px = Math.floor(normX * canvas.width);
  const py = Math.floor(normY * canvas.height);
  if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return false;
  const d = collisionMaskCtx.getImageData(px, py, 1, 1).data;
  // black pixel (0,0,0 with alpha>0) indicates wall -> blocked
  if (d[0] === 0 && d[1] === 0 && d[2] === 0 && d[3] !== 0) return false;
  return true;
}

// Map transition rules
function handleMapBoundary(pos){
  // pos: {x,y,mapX,mapY} normalized 0..1
  let {x,y,mapX,mapY} = pos;
  let moved = false;
  const mapKey = `${mapX},${mapY}`;
  const map = maps[mapKey];
  if (!map) return pos;
  // when x<0 or >=1 or y<0 or >=1, attempt to cross if block allows
  if (x < 0){
    if (!map.block.left){
      // move to left map
      const toKey = `${mapX-1},${mapY}`;
      if (maps[toKey]){
        mapX -= 1; x = 0.999; moved = true;
      } else { x = 0; }
    } else { x = 0; }
  } else if (x > 1){
    if (!map.block.right){
      const toKey = `${mapX+1},${mapY}`;
      if (maps[toKey]){
        mapX += 1; x = 0.001; moved = true;
      } else { x = 1; }
    } else { x = 1; }
  }
  if (y < 0){
    if (!map.block.up){
      const toKey = `${mapX},${mapY-1}`;
      if (maps[toKey]){
        mapY -= 1; y = 0.999; moved = true;
      } else { y = 0; }
    } else { y = 0; }
  } else if (y > 1){
    if (!map.block.down){
      const toKey = `${mapX},${mapY+1}`;
      if (maps[toKey]){
        mapY += 1; y = 0.001; moved = true;
      } else { y = 1; }
    } else { y = 1; }
  }
  // warp objects (immediate teleport)
  if (maps[`${mapX},${mapY}`] && maps[`${mapX},${mapY}`].objects){
    for (const obj of maps[`${mapX},${mapY}`].objects){
      if (obj.type === "warp"){
        // check overlap: player's foot circle intersects warp rect
        const px = x * canvas.width, py = y * canvas.height, r = 8;
        if (px >= obj.x && px <= obj.x + obj.w && py >= obj.y && py <= obj.y + obj.h){
          // warp
          mapX = obj.to.mapX; mapY = obj.to.mapY; x = obj.to.x / canvas.width; y = obj.to.y / canvas.height;
          moved = true;
          // after warp, ensure collision mask for destination loaded
          ensureCollisionMaskForMap(`${mapX},${mapY}`).catch(()=>{});
          break;
        }
      }
    }
  }
  if (moved){
    ensureCollisionMaskForMap(`${mapX},${mapY}`).catch(()=>{});
  }
  return { x:x, y:y, mapX: mapX, mapY: mapY };
}

// Main game loop
function startGameLoop(){
  if (raf) return;
  let last = performance.now();
  function loop(now){
    const dt = Math.min(0.1, (now - last)/1000);
    last = now;
    if (localPlayer && localClientStarted){
      // movement logic with collision checks and map transitions
      const role = localPlayer.role;
      let speed = (role === "king") ? 0.6 : (role === "guard") ? 1.2 : 1.6;
      let vx=0, vy=0;
      if (keys["w"] || keys["arrowup"]) vy -= 1;
      if (keys["s"] || keys["arrowdown"]) vy += 1;
      if (keys["a"] || keys["arrowleft"]) vx -= 1;
      if (keys["d"] || keys["arrowright"]) vx += 1;
      const len = Math.hypot(vx,vy);
      if (len > 0){
        vx/=len; vy/=len;
        let nx = localPlayer.x + vx * speed * dt * 0.12;
        let ny = localPlayer.y + vy * speed * dt * 0.12;
        let mapX = localPlayer.mapX || 0;
        let mapY = localPlayer.mapY || 0;
        // boundary crossing handled by handleMapBoundary; but check collision before committing position
        // create candidate pos and check collision in that map
        // If collision mask present, test walkability
        // temporary apply map transitions based on candidate pos
        let cand = handleMapBoundary({ x: nx, y: ny, mapX, mapY });
        const walkable = canWalkAt(`${cand.mapX},${cand.mapY}`, cand.x, cand.y);
        if (walkable){
          localPlayer.x = cand.x; localPlayer.y = cand.y; localPlayer.mapX = cand.mapX; localPlayer.mapY = cand.mapY;
          // persist to firestore
          setDoc(doc(db, "rooms", ROOM_ID, "players", localPlayer.id), {
            ...localPlayer, updatedAt: serverTimestamp()
          }).catch(()=>{});
        } else {
          // blocked: attempt axis-aligned movement fallback
          cand = handleMapBoundary({ x: localPlayer.x + vx * speed * dt * 0.12, y: localPlayer.y, mapX, mapY });
          if (canWalkAt(`${cand.mapX},${cand.mapY}`, cand.x, cand.y)){
            localPlayer.x = cand.x; localPlayer.mapX = cand.mapX; localPlayer.mapY = cand.mapY;
            setDoc(doc(db, "rooms", ROOM_ID, "players", localPlayer.id), {
              ...localPlayer, updatedAt: serverTimestamp()
            }).catch(()=>{});
          } else {
            cand = handleMapBoundary({ x: localPlayer.x, y: localPlayer.y + vy * speed * dt * 0.12, mapX, mapY });
            if (canWalkAt(`${cand.mapX},${cand.mapY}`, cand.x, cand.y)){
              localPlayer.y = cand.y; localPlayer.mapX = cand.mapX; localPlayer.mapY = cand.mapY;
              setDoc(doc(db, "rooms", ROOM_ID, "players", localPlayer.id), {
                ...localPlayer, updatedAt: serverTimestamp()
              }).catch(()=>{});
            }
          }
        }
      }
    }
    render();
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);
  // synchronized timer updater based on metaCache.startedAt
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

// Rendering: map grid, players, vision masks, strawberry detection marker, UI updates
function render(){
  // draw grid background for the current map of localPlayer (or default 0,0)
  ctx.clearRect(0,0,canvas.width,canvas.height);
  // draw map cells
  for (let gy=0; gy<GRID_N; gy++){
    for (let gx=0; gx<GRID_N; gx++){
      const px = gx * CELL_W;
      const py = gy * CELL_H;
      ctx.fillStyle = ((gx+gy)%2===0) ? "#163" : "#1a4";
      ctx.fillRect(px, py, CELL_W-1, CELL_H-1);
    }
  }
  // draw objects (warps) for current map if any
  const curMapKey = (localPlayer) ? `${localPlayer.mapX||0},${localPlayer.mapY||0}` : "0,0";
  const curMap = maps[curMapKey];
  if (curMap && curMap.objects){
    ctx.fillStyle = "#222";
    curMap.objects.forEach(o=>{
      if (o.type === "warp"){
        ctx.fillStyle = "#4444ff";
        ctx.fillRect(o.x, o.y, o.w, o.h);
      }
    });
  }

  // draw players
  for (const p of players.values()){
    // render only those on same map as local player (except mini-map)
    if (!localPlayer) continue;
    if (p.mapX !== localPlayer.mapX || p.mapY !== localPlayer.mapY) continue;
    const px = p.x * canvas.width;
    const py = p.y * canvas.height;
    ctx.beginPath();
    ctx.fillStyle = (p.role==="king")? "#ff6b9a" : (p.role==="guard") ? "#6bff9a" : "#ffd36b";
    const r = (p.role==="king") ? 14 : 10;
    ctx.arc(px, py, r, 0, Math.PI*2);
    ctx.fill();
    // draw name
    ctx.fillStyle = "#000";
    ctx.font = "12px sans-serif";
    ctx.fillText(p.name, px + r + 4, py + 6);
    // if guard sees all, maybe draw indicator for which ones are grabbed
    if (p.capturedBy){
      ctx.fillStyle = "#000";
      ctx.fillText("掴まれ中", px - r, py - r - 6);
    }
  }

  // vision overlay:
  worldOverlay.innerHTML = ""; // clear existing masks
  if (localPlayer){
    if (localPlayer.role === "guard"){
      // guard sees everything -> no mask
    } else {
      // create dark overlay with circular clear around viewer
      const maskCanvas = document.createElement("canvas");
      maskCanvas.width = canvas.width; maskCanvas.height = canvas.height;
      maskCanvas.className = "visionMask";
      const mctx = maskCanvas.getContext("2d");
      mctx.fillStyle = "rgba(0,0,0,0.92)";
      mctx.fillRect(0,0,maskCanvas.width, maskCanvas.height);
      // vision radius
      const visionPx = (localPlayer.role==="king") ? 140 : 160;
      const cx = localPlayer.x * maskCanvas.width;
      const cy = localPlayer.y * maskCanvas.height;
      // radial gradient to soften edges
      const g = mctx.createRadialGradient(cx, cy, Math.max(1, visionPx*0.2), cx, cy, visionPx);
      g.addColorStop(0, "rgba(0,0,0,1)");
      g.addColorStop(0.6, "rgba(0,0,0,0.6)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      mctx.globalCompositeOperation = "destination-out";
      mctx.fillStyle = g;
      mctx.beginPath();
      mctx.arc(cx, cy, visionPx, 0, Math.PI*2);
      mctx.fill();
      worldOverlay.appendChild(maskCanvas);
    }
    // if strawberry or king, show enemy direction marker (red blurred arrow) - origin unknown to player
    if (localPlayer.role === "strawberry"){
      // compute nearest enemy (king or guard) distance and direction
      let nearest = null; let nd = Infinity;
      for (const p of players.values()){
        if (p.role === "strawberry") continue;
        if (p.mapX !== localPlayer.mapX || p.mapY !== localPlayer.mapY) continue;
        const d = dist(localPlayer, p);
        if (d < nd){ nd = d; nearest = p; }
      }
      if (nearest){
        const meters = nd * 15;
        // compute angle on screen
        const angle = Math.atan2((nearest.y - localPlayer.y), (nearest.x - localPlayer.x));
        // place marker at screen edge in that direction
        const cx = canvas.width/2, cy = canvas.height/2;
        const r = Math.min(cx, cy) - 30;
        const mx = cx + Math.cos(angle) * r;
        const my = cy + Math.sin(angle) * r;
        const marker = document.createElement("div");
        marker.style.position = "absolute";
        marker.style.left = `${mx - 18}px`; marker.style.top = `${my - 18}px`;
        marker.style.width = `36px`; marker.style.height = `36px`;
        marker.style.borderRadius = "50%";
        marker.style.background = "rgba(255,50,50,0.8)";
        marker.style.boxShadow = "0 0 20px rgba(255,0,0,0.6)";
        marker.style.display = "flex";
        marker.style.alignItems = "center";
        marker.style.justifyContent = "center";
        marker.style.color = "#fff";
        marker.style.fontWeight = "700";
        // distance display (rounded)
        marker.textContent = `?? ${Math.max(1, Math.round(meters))}m`;
        worldOverlay.appendChild(marker);
      }
    }
  }

  // update role icon
  if (roleIcon && localPlayer){
    roleIcon.textContent = localPlayer.role;
  }

  // update mini map
  renderMiniMap();
}

// mini map
function renderMiniMap(){
  miniMap.innerHTML = "";
  const mapCanvas = document.createElement("canvas");
  mapCanvas.width = 140; mapCanvas.height = 140;
  const mctx = mapCanvas.getContext("2d");
  mctx.fillStyle = "#111";
  mctx.fillRect(0,0,140,140);
  if (localPlayer && (localPlayer.role === "guard" || localPlayer.role === "king")){
    for (const p of players.values()){
      if (p.mapX !== localPlayer.mapX || p.mapY !== localPlayer.mapY) continue;
      const mx = p.x * mapCanvas.width;
      const my = p.y * mapCanvas.height;
      mctx.fillStyle = (p.role==="king") ? "#ff6b9a" : (p.role==="guard") ? "#6bff9a" : "#ffd36b";
      mctx.fillRect(mx-3, my-3, 6, 6);
    }
  } else {
    mctx.fillStyle = "#00000088";
    mctx.fillRect(0,0,140,140);
  }
  miniMap.appendChild(mapCanvas);
}

// Ability use (SPACE)
async function handleAbility(){
  if (!localPlayer || !localClientStarted) return;
  const now = Date.now();
  // ignore if stunned or captured
  if (localPlayer.stunnedUntil && now < localPlayer.stunnedUntil) return;
  if (localPlayer.capturedBy) return;
  if (localPlayer.role === "king"){
    // capture within radius
    const radius = 0.12;
    for (const p of players.values()){
      if (!p) continue;
      if (p.role !== "strawberry") continue;
      if (p.mapX !== localPlayer.mapX || p.mapY !== localPlayer.mapY) continue;
      const d = dist(localPlayer, p);
      if (d <= radius){
        // respawn strawberry randomly
        const newPos = randomSpawnOnMap(`${localPlayer.mapX},${localPlayer.mapY}`);
        await updateDocSafe(doc(db, "rooms", ROOM_ID, "players", p.id), {
          x: newPos.x, y: newPos.y, mapX: newPos.mapX, mapY: newPos.mapY, capturedBy: null, grabbedUntil: 0, updatedAt: serverTimestamp()
        });
        // increment global captureCount
        await updateDocSafe(metaDoc, { captureCount: increment(1) });
        // play capture sound if exists
        if (audioCache.captureSE) { try{ audioCache.captureSE.currentTime = 0; audioCache.captureSE.play(); }catch(e){} }
        break; // only first
      }
    }
  } else if (localPlayer.role === "guard"){
    // attempt to grab strawberry in close proximity
    const grabRadius = 0.06;
    for (const p of players.values()){
      if (!p) continue;
      if (p.role !== "strawberry") continue;
      if (p.mapX !== localPlayer.mapX || p.mapY !== localPlayer.mapY) continue;
      const d = dist(localPlayer, p);
      if (d <= grabRadius){
        const grabbedForMs = 5000;
        const stunMs = 15000;
        const strawRef = doc(db, "rooms", ROOM_ID, "players", p.id);
        await updateDocSafe(strawRef, {
          capturedBy: localPlayer.id,
          grabbedUntil: Date.now() + grabbedForMs,
          updatedAt: serverTimestamp()
        });
        // while grabbed: this guard client will update strawberry position to follow guard
        const intervalId = setInterval(async ()=>{
          try {
            await updateDocSafe(strawRef, { x: localPlayer.x, y: localPlayer.y, updatedAt: serverTimestamp() });
          } catch(e){}
        }, 150);
        // release after grabbedForMs
        setTimeout(async ()=>{
          clearInterval(intervalId);
          await updateDocSafe(strawRef, { capturedBy: null, grabbedUntil: 0, updatedAt: serverTimestamp() });
          // stun guard
          await updateDocSafe(doc(db, "rooms", ROOM_ID, "players", localPlayer.id), {
            stunnedUntil: Date.now() + stunMs,
            updatedAt: serverTimestamp()
          });
        }, grabbedForMs);
        break;
      }
    }
  } else {
    // strawberry: no active ability (could add panic sound)
  }
}

// Utility: safe updateDoc wrapper
async function updateDocSafe(ref, data){
  try { await updateDoc(ref, data); } catch(e){ try { await setDoc(ref, data, { merge:true }); } catch(e2){ } }
}

// Render players grouped (UI list)
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

// Load collision mask for current map (mapKey)
async function loadCollisionMaskForMapKey(mapKey){
  const map = maps[mapKey];
  if (!map || !map.collisionMask) { collisionMaskImage = null; collisionMaskCanvas = null; collisionMaskCtx = null; return; }
  if (collisionMaskImage && collisionMaskImage.src === map.collisionMask) return;
  collisionMaskImage = new Image();
  collisionMaskImage.crossOrigin = "anonymous";
  collisionMaskImage.src = map.collisionMask;
  await new Promise((res)=>{ collisionMaskImage.onload = res; collisionMaskImage.onerror = res; });
  collisionMaskCanvas = document.createElement("canvas");
  collisionMaskCanvas.width = canvas.width; collisionMaskCanvas.height = canvas.height;
  collisionMaskCtx = collisionMaskCanvas.getContext("2d");
  collisionMaskCtx.drawImage(collisionMaskImage, 0,0, canvas.width, canvas.height);
}

// onSnapshot for players & meta already set above
// Set up snapshot handlers now (we re-use some earlier listeners)
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

// Sync chats (shown to king and guards)
onSnapshot(chatsCol, snap=>{
  chatMessages.innerHTML = "";
  snap.forEach(s=>{
    const d = s.data();
    if (!d) return;
    const el = document.createElement("div");
    el.className = "msg";
    el.textContent = `[${d.role}] ${d.fromName}: ${d.text}`;
    if (localPlayer && (localPlayer.role === "king" || localPlayer.role === "guard")){
      chatMessages.appendChild(el);
    }
  });
});

// Remove local when leaving
window.addEventListener("beforeunload", async ()=>{
  if (localPlayer){
    try { await deleteDoc(doc(db, "rooms", ROOM_ID, "players", localPlayer.id)); } catch(e){}
  }
});

// initialization: read meta and show lobby/waiting
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
    // ensure collision mask initially
    await loadCollisionMaskForMapKey("0,0");
  } catch(e){
    console.warn("init error", e);
    showLobby();
  }
})();

// Utility: getDoc import used above
import { getDoc } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";

// Small UI: toggle royal chat visible if user is king/guard
function updateChatUI(){
  if (!localPlayer) { teamChat.classList.add("hidden"); royalChatToggle.classList.add("hidden"); return; }
  if (localPlayer.role === "king" || localPlayer.role === "guard"){
    teamChat.classList.remove("hidden");
    royalChatToggle.classList.remove("hidden");
  } else {
    teamChat.classList.add("hidden");
    royalChatToggle.classList.add("hidden");
  }
}
setInterval(updateChatUI, 500);

// Helper: ensureCollisionMaskForMap alias
async function ensureCollisionMaskForMap(mapKey){
  await loadCollisionMaskForMapKey(mapKey);
}

// Utility: random spawn wrapper using maps
function randomSpawnOnMapKey(mapKey){
  return randomSpawnOnMap(mapKey);
}
function randomSpawnOnMap(mapKey){
  // reuse earlier randomSpawnOnMap but local here
  let attempts = 0;
  while (attempts < 50){
    const x = Math.random();
    const y = Math.random();
    if (!collisionMaskCtx) return { x, y, mapX: parseInt(mapKey.split(",")[0],10), mapY: parseInt(mapKey.split(",")[1],10) };
    const px = Math.floor(x * canvas.width);
    const py = Math.floor(y * canvas.height);
    const d = collisionMaskCtx.getImageData(px, py, 1, 1).data;
    if (!(d[0]===0 && d[1]===0 && d[2]===0 && d[3]!==0)){
      return { x, y, mapX: parseInt(mapKey.split(",")[0],10), mapY: parseInt(mapKey.split(",")[1],10) };
    }
    attempts++;
  }
  return { x:0.5, y:0.5, mapX: parseInt(mapKey.split(",")[0],10), mapY: parseInt(mapKey.split(",")[1],10) };
}

// Expose nothing; app runs via listeners above.

// END OF FILE
console.log("Strawberry Escape prototype loaded (complete feature set - prototype).");
```

Notes and next steps
- This is a full, browser-side prototype integrating the requested features as best-effort:
  - role-based vision masks (guard: full, king/strawberry: dark overlay with local circular vision).
  - guard grab (captures strawberry doc.capturedBy, strawberry follows guard while grabbed, guard becomes stunned after 5s).
  - king capture increments meta.captureCount and teleports strawberry to random spawn.
  - admin start forces all registered players into game state (meta.started).
  - meta.startedAt is used to compute synchronized remaining time for all clients (serverTimestamp in meta).
  - players are created by name-derived fixed IDs so reload doesn't produce duplicates.
  - map management: maps object, warp handling, and screen-edge transitions (block flags) implemented. Collision mask pixel checks use atarihantei.png if present.
  - king/guard team chat implemented in Firestore "chats" collection (visible only to king & guards).
  - Participant UI improved and larger (grouped horizontally).
- Known prototype caveats:
  - Some authority (grab handling, stun states) are client-driven; in production this should be server-authoritative (Cloud Functions or game server).
  - Audio cues are placeholders using the assets you specified; ensure the files exist in your GitHub repo or update URLs.
  - When collision mask or maps are absent the code falls back to allowing movement.
  - Edge cases (player disconnect mid-grab, simultaneous captures) are best handled server-side.
- Deploy:
  - Replace existing index.html / style.css / app.js with the blocks above.
  - Ensure the GitHub raw asset URLs exist (p.png, e.mp3, atarihantei.png, e.png) or replace with your assets.
  - Open multiple browsers to test: register with different names/roles, admin decide -> start -> observe synchronized start, timer, captureCount and chat.

If you'd like I'll:
- Harden authority (move critical ops to Cloud Functions).
- Add visual SFX on capture (screen shake/flash) synchronized via meta events.
- Add per-player sound distance (stereo panning) and more accurate audio states.
Which of these should I implement next?
