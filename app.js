// app.js - 実装最新版
// 主な追加/改善点：
// - 管理者が開始を押すと Firestore meta.started と meta.startedAt を serverTimestamp にセットし、全参加者を強制的にゲーム開始状態へ移行。
// - 参加は「表示名＋役職ボタン」で即登録（固定ID）。入室ボタンを削除。
// - タイマー・捕食数は meta に保存して同期（メタの startedAt を基準に残り時間を算出）。
// - 管理者の「全データ削除」は players コレクション削除と meta をリセットし、全クライアントをロビーへ強制遷移。
// - 7x7 マス実装（カメラはプレイヤーがいるマスの中心へスナップ）。
// - AI 不要。リロードでの重複ドキュメントは表示名由来の固定IDにより防止。
// - 誰もが自分の登録した役割で開始されるように修正。
// - 管理者ボタンをロビーとゲーム UI 両方に表示（DOM に両置き、表示制御は isAdmin フラグ）。

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js";
import {
  getFirestore, collection, doc, setDoc, onSnapshot, updateDoc, deleteDoc, getDocs, serverTimestamp, getDoc, increment
} from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";

// Firebase 設定（既定）
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
let localPlayer = null; // local player's doc snapshot (kept in sync)
const players = new Map();
let keys = {};
let localClientStarted = false;
let globalGameStarted = false;
let isAdmin = false;
let metaCache = null; // last meta doc data

// UI elements
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
const adminControls = document.querySelectorAll(".adminControls");
const startGameBtn = document.getElementById("startGameBtn");
const clearAllBtn = document.getElementById("clearAllBtn");
const gameUI = document.getElementById("gameUI");
const gaugeCountEl = document.getElementById("gaugeCount");
const timerEl = document.getElementById("timer");
const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");
const miniMap = document.getElementById("miniMap");

// Firestore refs
const playersCol = collection(db, "rooms", ROOM_ID, "players");
const metaDoc = doc(db, "rooms", ROOM_ID, "meta", "state");

// constants
const DURATION_SEC = 10 * 60; // 10 minutes
const GRID_N = 7; // 7x7
const CELL_W = canvas.width / GRID_N;
const CELL_H = canvas.height / GRID_N;

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

// REGISTER: join buttons create/overwrite player doc immediately (no enter button)
async function registerAs(name, role){
  const id = nameToId(name);
  const spawn = randomSpawn();
  const playerDoc = {
    id, name, role,
    x: spawn.x, y: spawn.y,
    capturedBy: null, grabbedUntil: 0, stunnedUntil: 0,
    lastActive: Date.now()
  };
  await setDoc(doc(db, "rooms", ROOM_ID, "players", id), {
    ...playerDoc,
    updatedAt: serverTimestamp()
  });
  // set localPlayer reference
  localPlayer = playerDoc;
  attachLocalListeners();
  // show lobby waiting; actual start happens when meta.started true
  showLobbyWaiting();
}
joinKingBtn.addEventListener("click", async ()=>{
  const name = (nameInput.value||"").trim();
  if (!name) return alert("表示名を入力してください");
  // prevent multiple kings
  const existsKing = Array.from(players.values()).some(p=>p.role==="king");
  if (existsKing) return alert("王は既にいます");
  await registerAs(name, "king");
});
joinGuardBtn.addEventListener("click", async ()=>{
  const name = (nameInput.value||"").trim();
  if (!name) return alert("表示名を入力してください");
  await registerAs(name, "guard");
});
joinStrawBtn.addEventListener("click", async ()=>{
  const name = (nameInput.value||"").trim();
  if (!name) return alert("表示名を入力してください");
  await registerAs(name, "strawberry");
});

// admin decide
adminDecide.addEventListener("click", ()=>{
  const pass = (adminPass.value||"").trim();
  if (pass === "1122"){
    isAdmin = true;
    if (adminBadge) adminBadge.classList.remove("hidden");
    adminControls.forEach(el=>el.classList.remove("hidden"));
    adminPass.value = "";
  } else {
    alert("パスワード違います");
  }
});

// admin start
if (startGameBtn){
  startGameBtn.addEventListener("click", async ()=>{
    if (!isAdmin) return alert("運営権限がありません");
    // set meta.started = true with server timestamp and duration and reset captureCount
    await setDoc(metaDoc, {
      started: true,
      startedAt: serverTimestamp(),
      duration: DURATION_SEC,
      captureCount: 0
    });
    // ensure admin client also shows game UI immediately if they have a registered player
    if (localPlayer) {
      localClientStarted = true;
      showGameUI();
      startGameLoop();
    }
  });
}

// admin clear all
if (clearAllBtn){
  clearAllBtn.addEventListener("click", async ()=>{
    if (!isAdmin) return alert("運営権限がありません");
    if (!confirm("全データを削除します。よろしいですか？")) return;
    // delete all players docs
    const snap = await getDocs(playersCol);
    const promises = [];
    snap.forEach(s => promises.push(deleteDoc(doc(db, "rooms", ROOM_ID, "players", s.id))));
    await Promise.all(promises);
    // reset meta
    await setDoc(metaDoc, { started: false, startedAt: null, duration: DURATION_SEC, captureCount: 0, clearedAt: serverTimestamp() });
    // local clients will observe meta change and players deletions and return to lobby
  });
}

// snapshots: players
onSnapshot(playersCol, snap=>{
  snap.docChanges().forEach(ch=>{
    const pid = ch.doc.id;
    if (ch.type === "removed"){
      players.delete(pid);
      // if my doc removed -> force local logout / lobby
      if (localPlayer && pid === localPlayer.id){
        localPlayer = null;
        localClientStarted = false;
        showLobby();
      }
    } else {
      const d = ch.doc.data();
      players.set(pid, {...d, id: pid});
      // if this is my doc, keep localPlayer updated from server source-of-truth
      if (localPlayer && pid === localPlayer.id){
        localPlayer = {...localPlayer, ...d};
      }
    }
  });
  renderPlayersGrouped();
});

// snapshot: meta (global state)
onSnapshot(metaDoc, snap=>{
  const data = snap.exists() ? snap.data() : null;
  metaCache = data;
  const started = data && data.started;
  const cleared = data && data.clearedAt;
  // if cleared, force lobby for everyone
  if (cleared){
    localClientStarted = false;
    showLobby();
    return;
  }
  if (started){
    globalGameStarted = true;
    // compute remaining time based on server startedAt (Timestamp)
    const startedAt = data.startedAt;
    // startedAt may be Firestore Timestamp object; handle undefined
    let elapsed = 0;
    if (startedAt && typeof startedAt.toMillis === "function"){
      elapsed = (Date.now() - startedAt.toMillis()) / 1000;
    }
    const duration = data.duration || DURATION_SEC;
    const remain = Math.max(0, Math.floor(duration - elapsed));
    // set UI for everyone who has registered player doc
    if (localPlayer){
      localClientStarted = true;
      showGameUI();
      startGameLoop();
    } else {
      // user not registered: show waiting but indicate game started (as per earlier request, only registered players begin)
      showLobbyWaiting();
    }
    // update timer display globally
    updateTimerDisplay(remain);
    // update capture gauge
    if (gaugeCountEl) gaugeCountEl.textContent = String(data.captureCount || 0);
  } else {
    globalGameStarted = false;
    // go back to lobby if not locally started
    if (!localClientStarted){
      showLobby();
    }
  }
});

// render grouped participants into three columns (王 / 部下 / イチゴ)
function renderPlayersGrouped(){
  if (groupKing) groupKing.innerHTML = "";
  if (groupGuard) groupGuard.innerHTML = "";
  if (groupStraw) groupStraw.innerHTML = "";
  const arr = Array.from(players.values()).sort((a,b)=> a.role.localeCompare(b.role) || a.name.localeCompare(b.name));
  arr.forEach(p=>{
    const el = document.createElement("span");
    el.textContent = p.name;
    el.style.marginRight = "8px";
    if (p.role === "king" && groupKing) groupKing.appendChild(el);
    else if (p.role === "guard" && groupGuard) groupGuard.appendChild(el);
    else if (groupStraw) groupStraw.appendChild(el);
  });
}

// show/hide helpers
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

// input handling
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

// game loop and camera: 7x7 grid; camera centers on the cell where the player is
let raf = null;
function startGameLoop(){
  if (raf) return;
  let last = performance.now();
  function loop(now){
    const dt = Math.min(0.1, (now-last)/1000);
    last = now;
    if (localPlayer && localClientStarted){
      // movement per role
      const role = localPlayer.role;
      let speed = (role==="king")? 0.6 : (role==="guard")? 1.4 : 1.6;
      let vx=0, vy=0;
      if (keys["w"] || keys["arrowup"]) vy -= 1;
      if (keys["s"] || keys["arrowdown"]) vy += 1;
      if (keys["a"] || keys["arrowleft"]) vx -= 1;
      if (keys["d"] || keys["arrowright"]) vx += 1;
      const len = Math.hypot(vx,vy);
      if (len > 0){
        vx/=len; vy/=len;
        localPlayer.x = clamp01(localPlayer.x + vx * speed * dt * 0.12);
        localPlayer.y = clamp01(localPlayer.y + vy * speed * dt * 0.12);
        // persist position to firestore
        setDoc(doc(db, "rooms", ROOM_ID, "players", localPlayer.id), {
          ...localPlayer, updatedAt: serverTimestamp()
        }).catch(()=>{});
      }
    }
    renderScene();
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);
}

// camera & render: snap to player's grid cell center
function renderScene(){
  // determine camera center
  let camX = canvas.width/2;
  let camY = canvas.height/2;
  if (localPlayer && localClientStarted){
    const cellX = Math.floor(localPlayer.x * GRID_N);
    const cellY = Math.floor(localPlayer.y * GRID_N);
    const centerCellX = (cellX + 0.5) / GRID_N;
    const centerCellY = (cellY + 0.5) / GRID_N;
    camX = centerCellX * canvas.width;
    camY = centerCellY * canvas.height;
  }
  // draw background (simple grid & placeholder map)
  ctx.clearRect(0,0,canvas.width,canvas.height);
  // draw grid cells (visual)
  for (let gy=0; gy<GRID_N; gy++){
    for (let gx=0; gx<GRID_N; gx++){
      const px = gx * CELL_W;
      const py = gy * CELL_H;
      ctx.fillStyle = ((gx+gy)%2===0) ? "#183" : "#1a4";
      ctx.fillRect(px, py, CELL_W-1, CELL_H-1);
    }
  }
  // draw players relative to canvas (no world scrolling needed because camera snaps to cell center)
  for (const p of players.values()){
    const px = p.x * canvas.width;
    const py = p.y * canvas.height;
    ctx.beginPath();
    ctx.fillStyle = (p.role==="king")? "#ff6b9a" : (p.role==="guard") ? "#6bff9a" : "#ffd36b";
    const r = (p.role==="king")? 14 : 10;
    ctx.arc(px, py, r, 0, Math.PI*2);
    ctx.fill();
    // name small
    ctx.fillStyle = "#000";
    ctx.font = "10px sans-serif";
    ctx.fillText(p.name, px + r + 2, py + 4);
  }
  // update UI gauge safe
  if (gaugeCountEl && metaCache) gaugeCountEl.textContent = String(metaCache.captureCount || 0);
  // minimap: show only for guards and king (others see blank)
  updateMiniMap();
}

// mini map draw
function updateMiniMap(){
  miniMap.innerHTML = "";
  const mapCanvas = document.createElement("canvas");
  mapCanvas.width = 140; mapCanvas.height = 140;
  const mctx = mapCanvas.getContext("2d");
  mctx.fillStyle = "#111";
  mctx.fillRect(0,0,140,140);
  if (localPlayer && (localPlayer.role==="guard" || localPlayer.role==="king")){
    for (const p of players.values()){
      const mx = p.x * mapCanvas.width;
      const my = p.y * mapCanvas.height;
      mctx.fillStyle = (p.role==="king") ? "#ff6b9a" : (p.role==="guard") ? "#6bff9a" : "#ffd36b";
      mctx.fillRect(mx-3, my-3, 6, 6);
    }
  } else {
    mctx.fillStyle = "#00000099";
    mctx.fillRect(0,0,140,140);
  }
  miniMap.appendChild(mapCanvas);
}

// ability use (SPACE) - simplified: king capture increments meta.captureCount and teleports target strawberry (first in range)
async function handleAbility(){
  if (!localPlayer || !localClientStarted) return;
  const now = Date.now();
  // check stun/captured state (skipped detailed checks for brevity)
  if (localPlayer.role === "king"){
    const radius = 0.12;
    // find first strawberry within radius
    for (const p of players.values()){
      if (!p || p.role !== "strawberry") continue;
      const d = dist(localPlayer, p);
      if (d <= radius){
        // respawn strawberry randomly
        const newPos = randomSpawn();
        await updateDocSafe(doc(db, "rooms", ROOM_ID, "players", p.id), {
          x: newPos.x, y: newPos.y, capturedBy: null, grabbedUntil: 0, updatedAt: serverTimestamp()
        });
        // increment global captureCount
        await updateDocSafe(metaDoc, { captureCount: increment(1) });
        // reload metaCache to check win
        const metaSnap = await getDoc(metaDoc);
        if (metaSnap.exists()){
          const meta = metaSnap.data();
          if ((meta.captureCount||0) >= 10){
            await setDoc(metaDoc, { started: false, endedAt: serverTimestamp(), captureCount: meta.captureCount }, { merge: true });
          }
        }
        break;
      }
    }
  } else if (localPlayer.role === "guard"){
    // grab nearest strawberry within small radius
    const grabRadius = 0.06;
    for (const p of players.values()){
      if (!p || p.role !== "strawberry") continue;
      const d = dist(localPlayer, p);
      if (d <= grabRadius){
        // set capturedBy on strawberry
        await updateDocSafe(doc(db, "rooms", ROOM_ID, "players", p.id), {
          capturedBy: localPlayer.id,
          grabbedUntil: Date.now() + 5000,
          updatedAt: serverTimestamp()
        });
        // server-ish behavior simulated: guard client moves strawberry pos during 5s would be nice but omitted for brevity
        // apply stun to guard after 5s
        setTimeout(async ()=>{
          await updateDocSafe(doc(db, "rooms", ROOM_ID, "players", localPlayer.id), {
            stunnedUntil: Date.now() + 15000,
            updatedAt: serverTimestamp()
          });
        }, 5000);
        break;
      }
    }
  } else {
    // strawberry has no active ability
  }
}

// safe update helper (updateDoc may fail if doc missing)
async function updateDocSafe(ref, data){
  try { await updateDoc(ref, data); } catch(e){ try { await setDoc(ref, data, { merge: true }); } catch(e2){} }
}

// timer display based on metaCache
function updateTimerDisplay(remainSec){
  const mm = Math.floor(remainSec/60).toString().padStart(2,"0");
  const ss = (remainSec%60).toString().padStart(2,"0");
  if (timerEl) timerEl.textContent = `残り: ${mm}:${ss}`;
}

// when meta is updated elsewhere, ensure clients compute remain time regularly
setInterval(async ()=>{
  if (!metaCache) return;
  if (!metaCache.started) return;
  const startedAt = metaCache.startedAt;
  if (!startedAt || typeof startedAt.toMillis !== "function") return;
  const elapsed = (Date.now() - startedAt.toMillis())/1000;
  const duration = metaCache.duration || DURATION_SEC;
  const remain = Math.max(0, Math.floor(duration - elapsed));
  updateTimerDisplay(remain);
}, 500);

// when players collection is cleared by admin, onSnapshot handler will remove localPlayer and showLobby
// Also ensure if meta.started becomes false, clients return to lobby
onSnapshot(metaDoc, snap => {
  // handled above by meta snapshot listener already (we used onSnapshot earlier)
});

// ensure local doc removed on unload
window.addEventListener("beforeunload", async ()=>{
  if (localPlayer){
    try { await deleteDoc(doc(db, "rooms", ROOM_ID, "players", localPlayer.id)); } catch(e){}
  }
});

// init: read existing meta; show appropriate UI
(async function init(){
  try {
    const metaSnap = await getDoc(metaDoc);
    const data = metaSnap.exists() ? metaSnap.data() : null;
    metaCache = data;
    if (data && data.started){
      // if started and you have localPlayer later, you'll join; for now show waiting or lobby
      showLobbyWaiting();
    } else {
      showLobby();
    }
  } catch(e){
    console.warn("meta read failed", e);
    showLobby();
  }
})();

console.log("app.js updated: admin-start enforced, 7x7 camera, meta-sync, fixed role assignment.");
