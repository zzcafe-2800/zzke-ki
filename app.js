// app.js - module (updated)
// - Admin mode with password (1122) and admin-only start/stop/clear
// - Asset URLs fixed to raw.githubusercontent.com
// - No AI auto-creation
// - Single entry per name (doc id is sanitized name) -> joining a new role overwrites previous
// - "部下になる" directly starts the game locally for that client only (per request)
// - When meta.started === true and the client hasn't started, show "現在待機中" on lobby
// - Admin can clear all player docs
// - Player grouping UI updated

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js";
import {
  getFirestore, collection, doc, setDoc, onSnapshot, updateDoc, deleteDoc, getDocs, serverTimestamp, getDoc
} from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";

// --- Firebase init (from user's provided config) ---
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

// --- Basic app state ---
const ROOM_ID = "main_room"; // single room prototype
let localPlayer = null; // {id=nameKey, name, role, x,y,...}
const players = new Map(); // playerId -> playerData
const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");
const TILE_SIZE = 120; // visual scale for the simple map
let lastTick = performance.now();
let keys = {};
let localClientStarted = false; // local-only start state
let globalGameStarted = false;  // meta.started from firestore
let isAdmin = false;
let captureCount = 0;
let remainingTime = 10 * 60; // seconds

// Asset base/URLs (fixed to loadable raw URLs as requested)
const ASSETS = {
  king: "https://raw.githubusercontent.com/zzcafe-2800/zzke-ki/main/p.png",
  guard: "https://raw.githubusercontent.com/zzcafe-2800/zzke-ki/main/p.png",
  strawberry: "https://raw.githubusercontent.com/zzcafe-2800/zzke-ki/main/p.png",
  map: "https://raw.githubusercontent.com/zzcafe-2800/zzke-ki/main/p.png",
  footstep: "https://raw.githubusercontent.com/zzcafe-2800/zzke-ki/main/e.mp3",
  heartbeat: "https://raw.githubusercontent.com/zzcafe-2800/zzke-ki/main/e.mp3",
  lowrumble: "https://raw.githubusercontent.com/zzcafe-2800/zzke-ki/main/e.mp33",
  captureSE: "https://raw.githubusercontent.com/zzcafe-2800/zzke-ki/main/e.mp3"
};
const audioCache = {};
function loadAudio(name, url){
  const a = new Audio(url);
  a.preload = "auto";
  audioCache[name] = a;
}
for (const k in ASSETS){
  if (ASSETS[k].endsWith(".mp3")) loadAudio(k, ASSETS[k]);
}
const imgCache = {};
function loadImg(name, url){
  const i = new Image();
  i.src = url;
  imgCache[name] = i;
}
loadImg("map", ASSETS.map);
loadImg("king", ASSETS.king);
loadImg("guard", ASSETS.guard);
loadImg("straw", ASSETS.strawberry);

// --- UI elements ---
const overlay = document.getElementById("overlay");
const lobby = document.getElementById("lobby");
const nameInput = document.getElementById("nameInput");
const joinKingBtn = document.getElementById("joinKingBtn");
const joinGuardBtn = document.getElementById("joinGuardBtn"); // immediate local start
const joinGuardWaitBtn = document.getElementById("joinGuardWaitBtn"); // join & wait
const joinStrawBtn = document.getElementById("joinStrawBtn");
const enterGameBtn = document.getElementById("enterGameBtn");
const groupKing = document.getElementById("groupKing");
const groupGuard = document.getElementById("groupGuard");
const groupStraw = document.getElementById("groupStraw");
const gameUI = document.getElementById("gameUI");
const gaugeCountEl = document.getElementById("gaugeCount");
const timerEl = document.getElementById("timer");
const chatStack = document.getElementById("chatStack");
const miniMap = document.getElementById("miniMap");
const adminPass = document.getElementById("adminPass");
const adminDecide = document.getElementById("adminDecide");
const adminBadge = document.getElementById("adminBadge");
const adminControls = document.getElementById("adminControls");
const startGameBtn = document.getElementById("startGameBtn");
const stopGameBtn = document.getElementById("stopGameBtn");
const clearAllBtn = document.getElementById("clearAllBtn");
const waitingNotice = document.getElementById("waitingNotice");

// --- Firestore helpers ---
const playersCol = collection(db, "rooms", ROOM_ID, "players");
const metaDoc = doc(db, "rooms", ROOM_ID, "meta", "state");

// sanitize name -> key (doc id)
function nameToId(name){
  return name.trim().toLowerCase().replace(/\s+/g,"_").replace(/[^a-z0-9_\-]/g,"") || ("player_"+Math.floor(Math.random()*10000));
}

// create or update local player in firestore
async function enterRoom(name, roleWanted, opts = {soloStart:false, wait:false}){
  const id = nameToId(name);
  const startPos = randomSpawn();
  localPlayer = {
    id, name,
    role: roleWanted || "strawberry",
    x: startPos.x,
    y: startPos.y,
    dir: 0,
    capturedBy: null,
    grabbedUntil: 0,
    stunnedUntil: 0,
    lastActive: Date.now()
  };
  // Always set/overwrite doc for this name (ensures single entry per name)
  await setDoc(doc(db, "rooms", ROOM_ID, "players", id), {
    ...localPlayer,
    updatedAt: serverTimestamp()
  });
  attachLocalListeners(id);
  // If opts.soloStart true -> start locally without setting meta.started
  if (opts.soloStart){
    localClientStarted = true;
    showGameUI();
    startGameLoop();
  } else if (globalGameStarted){
    // global started -> clients should enter game when player exists
    localClientStarted = true;
    showGameUI();
    startGameLoop();
  } else {
    // not started -> remain in lobby, show waiting notice
    showLobbyWaiting();
  }
}

// Listen players collection
onSnapshot(playersCol, snapshot=>{
  snapshot.docChanges().forEach(ch=>{
    const d = ch.doc.data();
    const pid = ch.doc.id;
    if (ch.type === "removed"){
      players.delete(pid);
    } else {
      players.set(pid, {...d, id:pid});
    }
  });
  renderPlayersGrouped();
});

// Listen meta changes
onSnapshot(metaDoc, snap=>{
  const data = snap.exists() ? snap.data() : {};
  const started = !!data.started;
  globalGameStarted = started;
  // if global started and we have a local player, start if not started already
  if (globalGameStarted){
    if (localPlayer && !localClientStarted){
      localClientStarted = true;
      showGameUI();
      startGameLoop();
    } else {
      // if not local player yet, show waiting overlay
      showLobbyWaiting();
    }
  } else {
    // game stopped globally; go back to lobby if local isn't solo-started
    if (!localClientStarted){
      showLobby();
    }
  }
});

// Remove local player on unload
window.addEventListener("beforeunload", async ()=>{
  if (localPlayer) {
    try { await deleteDoc(doc(db, "rooms", ROOM_ID, "players", localPlayer.id)); } catch(e){}
  }
});

// UI events
enterGameBtn.addEventListener("click", async ()=>{
  const name = (nameInput.value || "").trim();
  if (!name) { alert("表示名を入力してください"); return; }
  // join as spectator role selection not forced here; default strawberry wait
  await enterRoom(name, "strawberry", {soloStart:false});
});

joinKingBtn.addEventListener("click", async ()=>{
  const name = (nameInput.value || "").trim();
  if (!name){ alert("表示名を入力してください"); return; }
  // check if another king exists
  const kingExists = Array.from(players.values()).some(p => p.role === "king");
  if (kingExists){ alert("王様は既にいます"); return; }
  // Join as king (wait for global start)
  await enterRoom(name, "king", {soloStart:false});
});

joinGuardBtn.addEventListener("click", async ()=>{
  const name = (nameInput.value || "").trim();
  if (!name){ alert("表示名を入力してください"); return; }
  // Pressing "部下になる" per request: this starts the game for this client immediately (solo)
  await enterRoom(name, "guard", {soloStart:true});
});

joinGuardWaitBtn.addEventListener("click", async ()=>{
  const name = (nameInput.value || "").trim();
  if (!name){ alert("表示名を入力してください"); return; }
  await enterRoom(name, "guard", {soloStart:false});
});

joinStrawBtn.addEventListener("click", async ()=>{
  const name = (nameInput.value || "").trim();
  if (!name){ alert("表示名を入力してください"); return; }
  await enterRoom(name, "strawberry", {soloStart:false});
});

// Admin password decide
adminDecide.addEventListener("click", ()=>{
  const pass = (adminPass.value || "").trim();
  if (pass === "1122"){
    isAdmin = true;
    adminBadge.classList.remove("hidden");
    adminControls.classList.remove("hidden");
    adminPass.value = "";
  } else {
    alert("パスワードが違います");
  }
});

// Admin controls
startGameBtn.addEventListener("click", async ()=>{
  if (!isAdmin) return;
  await setDoc(metaDoc, { started: true, startedAt: serverTimestamp() });
});
stopGameBtn.addEventListener("click", async ()=>{
  if (!isAdmin) return;
  await setDoc(metaDoc, { started: false, startedAt: serverTimestamp() });
});
clearAllBtn.addEventListener("click", async ()=>{
  if (!isAdmin) return;
  if (!confirm("本当に全データを削除しますか？（元に戻せません）")) return;
  // delete all players docs
  const snap = await getDocs(playersCol);
  const promises = [];
  snap.forEach(docSnap=>{
    promises.push(deleteDoc(doc(db, "rooms", ROOM_ID, "players", docSnap.id)));
  });
  await Promise.all(promises);
  // reset meta
  await setDoc(metaDoc, { started: false, startedAt: serverTimestamp() });
  alert("全データを削除しました");
});

// Helpers for showing UI states
function showGameUI(){
  overlay.classList.add("hidden");
  gameUI.classList.remove("hidden");
  waitingNotice.classList.add("hidden");
}
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

// Render grouped participants
function renderPlayersGrouped(){
  groupKing.innerHTML = "";
  groupGuard.innerHTML = "";
  groupStraw.innerHTML = "";
  const arr = Array.from(players.values());
  // Show ordered lists
  arr.forEach(p=>{
    const el = document.createElement("div");
    el.textContent = p.name;
    if (p.role === "king") groupKing.appendChild(el);
    else if (p.role === "guard") groupGuard.appendChild(el);
    else groupStraw.appendChild(el);
  });
}

// Helper: random spawn within map bounds (normalized 0..1)
function randomSpawn(){
  const margin = 0.08;
  return {
    x: Math.random()*(1-2*margin) + margin,
    y: Math.random()*(1-2*margin) + margin
  };
}

// Attach keyboard listeners and local update loop
function attachLocalListeners(id){
  window.addEventListener("keydown", e=>{
    if (e.key === " "){ e.preventDefault(); }
    keys[e.key.toLowerCase()] = true;
    if (e.key === " "){ handleAbility(); }
  });
  window.addEventListener("keyup", e=>{
    keys[e.key.toLowerCase()] = false;
  });
}

// ROLE PARAMETERS
const ROLE_PARAMS = {
  king: {speed: 0.9, viewRadius: 0.18, visionPixels: 140},
  guard: {speed: 1.6, viewRadius: 1.0, visionPixels: 1000},
  strawberry: {speed: 1.8, viewRadius: 0.22, visionPixels: 160}
};

// Game loop
let tickRaf = null;
function startGameLoop(){
  if (tickRaf) return; // already running
  lastTick = performance.now();
  tickRaf = requestAnimationFrame(tick);
  // start timer countdown if not already
  if (!globalGameStarted && localClientStarted){
    // local-only start: timer runs locally
    setInterval(()=>{
      if (!localClientStarted) return;
      remainingTime = Math.max(0, remainingTime-1);
      updateTimerUI();
      if (remainingTime === 0) {
        endGame("strawberry");
      }
    }, 1000);
  } else if (globalGameStarted){
    // a global timer might be set by meta; for prototype keep local countdown too
    setInterval(()=>{
      if (!localClientStarted) return;
      remainingTime = Math.max(0, remainingTime-1);
      updateTimerUI();
      if (remainingTime === 0) {
        endGame("strawberry");
      }
    }, 1000);
  }
}

function updateTimerUI(){
  const mm = Math.floor(remainingTime/60).toString().padStart(2,"0");
  const ss = (remainingTime%60).toString().padStart(2,"0");
  timerEl.textContent = `残り: ${mm}:${ss}`;
}

async function tick(now){
  const dt = Math.min(0.1, (now-lastTick)/1000);
  lastTick = now;
  if (localPlayer && localClientStarted){
    // movement
    const role = localPlayer.role;
    const params = ROLE_PARAMS[role] || ROLE_PARAMS.strawberry;
    const nowMs = Date.now();
    const stunned = localPlayer.stunnedUntil && nowMs < localPlayer.stunnedUntil;
    const grabbed = localPlayer.capturedBy && localPlayer.capturedBy !== "";
    let vx=0, vy=0;
    if (!stunned && !grabbed){
      if (keys["w"] || keys["arrowup"]) vy -= 1;
      if (keys["s"] || keys["arrowdown"]) vy += 1;
      if (keys["a"] || keys["arrowleft"]) vx -= 1;
      if (keys["d"] || keys["arrowright"]) vx += 1;
      const len = Math.hypot(vx,vy);
      if (len>0){
        vx/=len;vy/=len;
        localPlayer.x = clamp01(localPlayer.x + vx * params.speed * dt * 0.12);
        localPlayer.y = clamp01(localPlayer.y + vy * params.speed * dt * 0.12);
        localPlayer.lastActive = Date.now();
        // update Firestore
        setDoc(doc(db, "rooms", ROOM_ID, "players", localPlayer.id), {
          ...localPlayer,
          updatedAt: serverTimestamp()
        }).catch(console.warn);
      }
    }
  }

  renderScene();

  tickRaf = requestAnimationFrame(tick);
}

function clamp01(v){ return Math.max(0, Math.min(1, v)); }

// Rendering: simple map + players + vision mask
function renderScene(){
  ctx.clearRect(0,0,canvas.width,canvas.height);
  // draw map
  if (imgCache.map && imgCache.map.complete){
    ctx.drawImage(imgCache.map, 0, 0, canvas.width, canvas.height);
  } else {
    ctx.fillStyle = "#0b3";
    ctx.fillRect(0,0,canvas.width,canvas.height);
  }

  // draw players
  const allPlayers = Array.from(players.values());
  for (const p of allPlayers){
    if (!p) continue;
    const px = p.x * canvas.width;
    const py = p.y * canvas.height;
    let icon = imgCache.straw;
    if (p.role === "king") icon = imgCache.king;
    if (p.role === "guard") icon = imgCache.guard;
    const size = (p.role === "king") ? 28 : 20;
    if (icon && icon.complete){
      ctx.drawImage(icon, px - size/2, py - size/2, size, size);
    } else {
      ctx.fillStyle = p.role === "king" ? "#ffb3c2" : (p.role==="guard" ? "#c2ffb3" : "#ffeb9a");
      ctx.beginPath(); ctx.arc(px,py,size/2,0,Math.PI*2); ctx.fill();
    }
  }

  // vision mask for viewer
  const viewer = localPlayer;
  if (viewer && localClientStarted){
    const role = viewer.role;
    if (role !== "guard"){
      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,0.85)";
      ctx.fillRect(0,0,canvas.width,canvas.height);
      const params = ROLE_PARAMS[role] || ROLE_PARAMS.strawberry;
      const radiusPx = params.visionPixels;
      const cx = viewer.x * canvas.width;
      const cy = viewer.y * canvas.height;
      ctx.globalCompositeOperation = "destination-out";
      const g = ctx.createRadialGradient(cx,cy,Math.max(1,radiusPx*0.3), cx,cy,radiusPx);
      g.addColorStop(0,"rgba(0,0,0,1)");
      g.addColorStop(0.6,"rgba(0,0,0,0.6)");
      g.addColorStop(1,"rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx,cy, radiusPx, 0, Math.PI*2);
      ctx.fill();
      ctx.restore();
    }
  }

  // update capture gauge UI
  gaugeCountEl.textContent = captureCount;

  // update minimap
  miniMap.innerHTML = "";
  if (viewer){
    const mapCanvas = document.createElement("canvas");
    mapCanvas.width = 140; mapCanvas.height = 140;
    const mctx = mapCanvas.getContext("2d");
    mctx.fillStyle = "#222";
    mctx.fillRect(0,0,140,140);
    if (viewer.role === "guard" || viewer.role === "king"){
      for (const p of players.values()){
        if (!p) continue;
        const mx = p.x * mapCanvas.width;
        const my = p.y * mapCanvas.height;
        mctx.fillStyle = (p.role==="king") ? "#ff6b9a" : (p.role==="guard" ? "#6bff9a" : "#ffd36b");
        mctx.fillRect(mx-3,my-3,6,6);
      }
    } else {
      mctx.fillStyle = "#00000099";
      mctx.fillRect(0,0,140,140);
    }
    miniMap.appendChild(mapCanvas);
  }
}

// Ability handling SPACE
let guardGrabIntervals = new Map(); // strawId -> intervalId
async function handleAbility(){
  if (!localPlayer || !localClientStarted) return;
  const now = Date.now();

  if (localPlayer.stunnedUntil && now < localPlayer.stunnedUntil) return; // cannot use
  if (localPlayer.capturedBy) return; // cannot use

  if (localPlayer.role === "king") {
    const radius = 0.12; // normalized
    for (const p of players.values()){
      if (!p) continue;
      if (p.role !== "strawberry") continue;
      const d = dist(localPlayer, p);
      if (d <= radius){
        // Capture: teleport the strawberry to a random safe place (do NOT delete their doc)
        const newPos = randomSpawn();
        await updateDoc(doc(db, "rooms", ROOM_ID, "players", p.id), {
          x: newPos.x,
          y: newPos.y,
          capturedBy: null,
          grabbedUntil: 0,
          updatedAt: serverTimestamp()
        }).catch(console.warn);
        captureCount = captureCount + 1;
        gaugeCountEl.textContent = captureCount;
        if (audioCache.captureSE) { audioCache.captureSE.currentTime = 0; audioCache.captureSE.play().catch(()=>{}); }
        if (captureCount >= 10){
          await setDoc(metaDoc, { started: false, winner: "king", endedAt: serverTimestamp() });
          endGame("king");
        }
        break; // only first match
      }
    }
  } else if (localPlayer.role === "guard") {
    const grabRadius = 0.06;
    for (const p of players.values()){
      if (!p) continue;
      if (p.role !== "strawberry") continue;
      const d = dist(localPlayer, p);
      if (d <= grabRadius){
        const grabbedForMs = 5000;
        const stunMs = 15000;
        const strawRef = doc(db, "rooms", ROOM_ID, "players", p.id);
        // set capturedBy and grabbedUntil
        await updateDoc(strawRef, {
          capturedBy: localPlayer.id,
          grabbedUntil: Date.now()+grabbedForMs,
          updatedAt: serverTimestamp()
        }).catch(console.warn);
        // start interval to update strawberry position to guard while grabbed (this guard client is authoritative for movement during grab)
        const intervalId = setInterval(async ()=>{
          // push current guard position onto strawberry doc
          const guardDocRef = doc(db, "rooms", ROOM_ID, "players", localPlayer.id);
          // get latest guard position from local cache (localPlayer)
          await updateDoc(strawRef, {
            x: localPlayer.x,
            y: localPlayer.y,
            updatedAt: serverTimestamp()
          }).catch(()=>{});
        }, 200);
        guardGrabIntervals.set(p.id, intervalId);

        // release after grabbedForMs
        setTimeout(async ()=>{
          clearInterval(guardGrabIntervals.get(p.id));
          guardGrabIntervals.delete(p.id);
          await updateDoc(strawRef, { capturedBy: null, grabbedUntil: 0, updatedAt: serverTimestamp() }).catch(()=>{});
          // apply stun to guard locally and persist
          localPlayer.stunnedUntil = Date.now() + stunMs;
          await setDoc(doc(db, "rooms", ROOM_ID, "players", localPlayer.id), {
            ...localPlayer,
            updatedAt: serverTimestamp()
          }).catch(()=>{});
        }, grabbedForMs);
        break;
      }
    }
  } else if (localPlayer.role === "strawberry") {
    pushLocalChat(`${localPlayer.name} が SPACE を押した`);
  }
}

// Utility: distance normalized
function dist(a,b){
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx,dy);
}

// Chat stack pushes
function pushLocalChat(text){
  const div = document.createElement("div");
  div.className = "chat";
  div.textContent = text;
  chatStack.prepend(div);
  setTimeout(()=>{ div.remove(); }, 15000);
}

// End game
function endGame(winnerRole){
  localClientStarted = false;
  globalGameStarted = false;
  alert(`ゲーム終了: 勝者 = ${winnerRole}`);
  // Return to lobby overlay
  showLobby();
  // Reset some local states
  // (global meta already set by admin/start logic)
}

// SOUND / FEAR AE: For strawberry players, play audio cues according to nearest enemy distance
setInterval(()=>{
  if (!localPlayer) return;
  if (localPlayer.role !== "strawberry") return;
  // find nearest king or guard
  let nearest = Infinity;
  for (const p of players.values()){
    if (!p) continue;
    if (p.role === "strawberry") continue;
    nearest = Math.min(nearest, dist(localPlayer, p));
  }
  const meters = nearest * 15;
  if (meters <= 3){
    playAudioLoop('lowrumble', 1.0);
    shakeCanvas(8);
  } else if (meters <= 6){
    playAudioLoop('heartbeat', 0.9);
  } else if (meters <= 10){
    playAudioLoop('footstep', 0.7);
  } else {
    stopAudioLoop();
  }
}, 700);

let currentLoopAudio = null;
function playAudioLoop(name, vol=0.8){
  const a = audioCache[name];
  if (!a) return;
  if (currentLoopAudio && currentLoopAudio !== a){
    try{ currentLoopAudio.pause(); currentLoopAudio.currentTime = 0; }catch(e){}
  }
  currentLoopAudio = a;
  a.loop = true;
  a.volume = vol;
  a.play().catch(()=>{});
}
function stopAudioLoop(){
  if (currentLoopAudio){
    try{ currentLoopAudio.pause(); currentLoopAudio.currentTime=0; }catch(e){}
    currentLoopAudio = null;
  }
}
function shakeCanvas(amount){
  canvas.style.transform = `translate(${(Math.random()-0.5)*amount}px, ${(Math.random()-0.5)*amount}px)`;
  setTimeout(()=>{ canvas.style.transform = ""; }, 120);
}

// Utility to fetch current players once (used by some flows)
async function fetchPlayersSnapshot(){
  const snap = await getDocs(playersCol);
  const map = new Map();
  snap.forEach(s=>{
    map.set(s.id, {...s.data(), id:s.id});
  });
  return map;
}

// Initialization: read meta once to show waiting if necessary
(async function init(){
  const metaSnap = await getDoc(metaDoc);
  const started = metaSnap.exists() && metaSnap.data().started;
  globalGameStarted = !!started;
  if (globalGameStarted){
    // show waiting overlay until player joins or admin starts/they solo-start
    showLobbyWaiting();
  } else {
    showLobby();
  }
})();

console.log("Prototype updated and loaded.");
