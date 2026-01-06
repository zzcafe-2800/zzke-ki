// app.js - 修正版（重要な修正点：DOM参照ガード、固定ID（名前由来）による重複防止、管理者開始必須化、AI削除）
//
// 必要: index.html は上記の最新版に差し替えてください。
// Firebase 設定は既存のまま利用します。

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js";
import {
  getFirestore, collection, doc, setDoc, onSnapshot, updateDoc, deleteDoc, getDocs, serverTimestamp, getDoc
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

// state
const ROOM_ID = "main_room";
let localPlayer = null;
const players = new Map();
let keys = {};
let localClientStarted = false;
let globalGameStarted = false;
let isAdmin = false;
let captureCount = 0;
let remainingTime = 10 * 60;

// DOM
const overlay = document.getElementById("overlay");
const nameInput = document.getElementById("nameInput");
const joinKingBtn = document.getElementById("joinKingBtn");
const joinGuardBtn = document.getElementById("joinGuardBtn");
const joinStrawBtn = document.getElementById("joinStrawBtn");
const enterGameBtn = document.getElementById("enterGameBtn");
const groupKing = document.getElementById("groupKing");
const groupGuard = document.getElementById("groupGuard");
const groupStraw = document.getElementById("groupStraw");
const adminPass = document.getElementById("adminPass");
const adminDecide = document.getElementById("adminDecide");
const adminBadge = document.getElementById("adminBadge");
const adminControls = document.getElementById("adminControls");
const startGameBtn = document.getElementById("startGameBtn");
const stopGameBtn = document.getElementById("stopGameBtn");
const clearAllBtn = document.getElementById("clearAllBtn");
const waitingNotice = document.getElementById("waitingNotice");
const gameUI = document.getElementById("gameUI");
const gaugeCountEl = document.getElementById("gaugeCount");
const timerEl = document.getElementById("timer");
const miniMap = document.getElementById("miniMap");
const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

// Firestore refs
const playersCol = collection(db, "rooms", ROOM_ID, "players");
const metaDoc = doc(db, "rooms", ROOM_ID, "meta", "state");

// helpers
function nameToId(name){
  return name.trim().toLowerCase().replace(/\s+/g,"_").replace(/[^a-z0-9_\-]/g,"") || ("player_"+Math.floor(Math.random()*10000));
}
function randomSpawn(){
  const margin = 0.08;
  return { x: Math.random()*(1-2*margin) + margin, y: Math.random()*(1-2*margin) + margin };
}
function clamp01(v){ return Math.max(0, Math.min(1, v)); }
function dist(a,b){ return Math.hypot(a.x-b.x, a.y-b.y); }

// enter room: always wait for global start (no solo start)
async function enterRoom(name, roleWanted){
  const id = nameToId(name);
  const pos = randomSpawn();
  localPlayer = {
    id, name, role: roleWanted || "strawberry",
    x: pos.x, y: pos.y, dir:0, capturedBy:null, grabbedUntil:0, stunnedUntil:0, lastActive: Date.now()
  };
  // overwrite doc for that name (prevents duplicates on reload)
  await setDoc(doc(db, "rooms", ROOM_ID, "players", id), {
    ...localPlayer, updatedAt: serverTimestamp()
  });
  attachLocalListeners();
  // if global already started -> start locally
  if (globalGameStarted){
    localClientStarted = true;
    showGameUI();
    startGameLoop();
  } else {
    showLobbyWaiting();
  }
}

// remove local doc on unload
window.addEventListener("beforeunload", async ()=>{
  if (localPlayer){
    try { await deleteDoc(doc(db, "rooms", ROOM_ID, "players", localPlayer.id)); } catch(e){}
  }
});

// snapshots
onSnapshot(playersCol, snap=>{
  snap.docChanges().forEach(ch=>{
    const d = ch.doc.data();
    const pid = ch.doc.id;
    if (ch.type === "removed") players.delete(pid);
    else players.set(pid, {...d, id:pid});
  });
  renderPlayersGrouped(); // safe render
});

// meta snapshot: global start/stop
onSnapshot(metaDoc, snap=>{
  const data = snap.exists() ? snap.data() : {};
  const started = !!data.started;
  globalGameStarted = started;
  if (globalGameStarted){
    // if client has a registered player and not started locally -> start
    if (localPlayer && !localClientStarted){
      localClientStarted = true;
      showGameUI();
      startGameLoop();
    } else {
      showLobbyWaiting();
    }
  } else {
    // stopped globally -> don't auto-start
    if (!localClientStarted){
      showLobby();
    }
  }
});

// UI events
enterGameBtn.addEventListener("click", async ()=>{
  const name = (nameInput.value || "").trim();
  if (!name) return alert("表示名を入力してください");
  await enterRoom(name, "strawberry");
});
joinKingBtn.addEventListener("click", async ()=>{
  const name = (nameInput.value || "").trim();
  if (!name) return alert("表示名を入力してください");
  // check existing king
  const kingExists = Array.from(players.values()).some(p => p.role === "king");
  if (kingExists) return alert("王様は既にいます");
  await enterRoom(name, "king");
});
joinGuardBtn.addEventListener("click", async ()=>{
  const name = (nameInput.value || "").trim();
  if (!name) return alert("表示名を入力してください");
  await enterRoom(name, "guard");
});
joinStrawBtn.addEventListener("click", async ()=>{
  const name = (nameInput.value || "").trim();
  if (!name) return alert("表示名を入力してください");
  await enterRoom(name, "strawberry");
});

// admin
adminDecide.addEventListener("click", ()=>{
  const pass = (adminPass.value || "").trim();
  if (pass === "1122"){
    isAdmin = true;
    if (adminBadge) adminBadge.classList.remove("hidden");
    if (adminControls) adminControls.classList.remove("hidden");
    adminPass.value = "";
  } else {
    alert("パスワードが違います");
  }
});
if (startGameBtn) startGameBtn.addEventListener("click", async ()=>{
  if (!isAdmin) return;
  await setDoc(metaDoc, { started: true, startedAt: serverTimestamp() });
});
if (stopGameBtn) stopGameBtn.addEventListener("click", async ()=>{
  if (!isAdmin) return;
  await setDoc(metaDoc, { started: false, startedAt: serverTimestamp() });
});
if (clearAllBtn) clearAllBtn.addEventListener("click", async ()=>{
  if (!isAdmin) return;
  if (!confirm("本当に全データを削除しますか？")) return;
  const snap = await getDocs(playersCol);
  const promises = [];
  snap.forEach(s => promises.push(deleteDoc(doc(db, "rooms", ROOM_ID, "players", s.id))));
  await Promise.all(promises);
  await setDoc(metaDoc, { started: false, startedAt: serverTimestamp() });
  alert("全データを削除しました");
});

// safe render grouped participants (handles missing DOM gracefully)
function renderPlayersGrouped(){
  // guard nulls
  if (groupKing) groupKing.innerHTML = "";
  if (groupGuard) groupGuard.innerHTML = "";
  if (groupStraw) groupStraw.innerHTML = "";
  const arr = Array.from(players.values()).sort((a,b)=> (a.role===b.role)? a.name.localeCompare(b.name) : a.role.localeCompare(b.role));
  arr.forEach(p=>{
    const el = document.createElement("div");
    el.textContent = p.name;
    if (p.role === "king"){
      if (groupKing) groupKing.appendChild(el);
    } else if (p.role === "guard"){
      if (groupGuard) groupGuard.appendChild(el);
    } else {
      if (groupStraw) groupStraw.appendChild(el);
    }
  });
}

// UI visibility helpers
function showLobbyWaiting(){
  if (overlay) overlay.classList.remove("hidden");
  if (gameUI) gameUI.classList.add("hidden");
  if (waitingNotice) waitingNotice.classList.remove("hidden");
}
function showLobby(){
  if (overlay) overlay.classList.remove("hidden");
  if (gameUI) gameUI.classList.add("hidden");
  if (waitingNotice) waitingNotice.classList.add("hidden");
}
function showGameUI(){
  if (overlay) overlay.classList.add("hidden");
  if (gameUI) gameUI.classList.remove("hidden");
  if (waitingNotice) waitingNotice.classList.add("hidden");
}

// input handling & game loop (minimal, only runs when global start is true)
function attachLocalListeners(){
  window.addEventListener("keydown", e=>{
    if (e.key === " ") e.preventDefault();
    keys[e.key.toLowerCase()] = true;
  });
  window.addEventListener("keyup", e=>{
    keys[e.key.toLowerCase()] = false;
  });
}

let rafId = null;
function startGameLoop(){
  if (rafId) return;
  let last = performance.now();
  const loop = async (t)=>{
    const dt = Math.min(0.1, (t-last)/1000);
    last = t;
    if (localPlayer && localClientStarted === false && globalGameStarted){
      localClientStarted = true;
    }
    if (localPlayer && localClientStarted){
      // simple movement and update
      const role = localPlayer.role;
      const speed = (role === "king") ? 0.9 : (role === "guard") ? 1.6 : 1.8;
      let vx=0, vy=0;
      if (keys["w"]) vy -= 1;
      if (keys["s"]) vy += 1;
      if (keys["a"]) vx -= 1;
      if (keys["d"]) vx += 1;
      const len = Math.hypot(vx,vy);
      if (len>0){
        vx/=len; vy/=len;
        localPlayer.x = clamp01(localPlayer.x + vx * speed * dt * 0.12);
        localPlayer.y = clamp01(localPlayer.y + vy * speed * dt * 0.12);
        // persist position
        setDoc(doc(db, "rooms", ROOM_ID, "players", localPlayer.id), {
          ...localPlayer, updatedAt: serverTimestamp()
        }).catch(()=>{});
      }
    }
    renderScene();
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
  // timer
  const timerId = setInterval(()=>{
    if (!globalGameStarted) return;
    remainingTime = Math.max(0, remainingTime-1);
    const mm = Math.floor(remainingTime/60).toString().padStart(2,"0");
    const ss = (remainingTime%60).toString().padStart(2,"0");
    if (timerEl) timerEl.textContent = `残り: ${mm}:${ss}`;
    if (remainingTime === 0){
      clearInterval(timerId);
      // set meta stopped
      setDoc(metaDoc, { started: false, endedAt: serverTimestamp() }).catch(()=>{});
    }
  }, 1000);
}

// simple render
function renderScene(){
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle = "#0b3";
  ctx.fillRect(0,0,canvas.width,canvas.height);
  // draw players
  for (const p of players.values()){
    const px = p.x * canvas.width;
    const py = p.y * canvas.height;
    ctx.fillStyle = (p.role === "king") ? "#ff6b9a" : (p.role === "guard") ? "#6bff9a" : "#ffd36b";
    ctx.beginPath(); ctx.arc(px, py, (p.role==="king"? 14:10), 0, Math.PI*2); ctx.fill();
  }
  // update gauge display safely
  if (gaugeCountEl) gaugeCountEl.textContent = captureCount;
}

// remove any leftover accidental functions referencing old DOM to avoid null refs

// init: check meta on load
(async function init(){
  try {
    const metaSnap = await getDoc(metaDoc);
    globalGameStarted = metaSnap.exists() && !!metaSnap.data().started;
    if (globalGameStarted) showLobbyWaiting(); else showLobby();
  } catch(e){
    console.warn("meta read error", e);
    showLobby();
  }
})();

console.log("app.js (fixed) loaded");
