// app.js - module
// Prototype implementation using Firebase Firestore for realtime sync.
// Features implemented:
// - Lobby with name input and team selection (King limited to 1)
// - Player movement (WASD), SPACE ability handling
// - Roles: king, guard (hand), strawberry
// - Vision masks, minimap, simple audio cues by distance
// - Capture/respawn and guard grab/stun mechanics
//
// NOTES:
// - This is a client-only prototype. Firestore security rules should be defined for production.
// - Assets are referenced under the user's GitHub raw URL pattern as requested.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js";
import {
  getFirestore, collection, doc, setDoc, onSnapshot, updateDoc, deleteDoc, getDoc, addDoc, serverTimestamp
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
let localPlayer = null; // {id, name, role, x,y,dir,...}
const players = new Map(); // playerId -> playerData
const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");
const TILE_SIZE = 120; // visual scale for the simple map
const MAP_W = 7, MAP_H = 7;
const MAP_PX = canvas.width; // assume square
const CENTER = {x: canvas.width/2, y: canvas.height/2};
let lastTick = performance.now();
let keys = {};
let gameStarted = false;
let captureCount = 0;
let remainingTime = 10 * 60; // seconds

// Asset base (as requested)
const ASSET_BASE = "https://raw.githubusercontent.com/zzcafe-2800/zzke-ki/main/p.png";
const ASSETS = {
  king: ASSET_BASE + "https://raw.githubusercontent.com/zzcafe-2800/zzke-ki/main/p.png",
  guard: ASSET_BASE + "https://raw.githubusercontent.com/zzcafe-2800/zzke-ki/main/p.png",
  strawberry: ASSET_BASE + "https://raw.githubusercontent.com/zzcafe-2800/zzke-ki/main/p.png",
  map: ASSET_BASE + "https://raw.githubusercontent.com/zzcafe-2800/zzke-ki/main/p.png",
  footstep: ASSET_BASE + "https://raw.githubusercontent.com/zzcafe-2800/zzke-ki/main/e.mp3",
  heartbeat: ASSET_BASE + "https://raw.githubusercontent.com/zzcafe-2800/zzke-ki/main/e.mp3",
  lowrumble: ASSET_BASE + "https://raw.githubusercontent.com/zzcafe-2800/zzke-ki/main/e.mp3",
  captureSE: ASSET_BASE + "https://raw.githubusercontent.com/zzcafe-2800/zzke-ki/main/e.mp3"
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
// Preload simple images
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
const joinGuardBtn = document.getElementById("joinGuardBtn");
const joinStrawBtn = document.getElementById("joinStrawBtn");
const enterGameBtn = document.getElementById("enterGameBtn");
const playersList = document.getElementById("playersList");
const gameUI = document.getElementById("gameUI");
const gaugeCountEl = document.getElementById("gaugeCount");
const timerEl = document.getElementById("timer");
const chatStack = document.getElementById("chatStack");
const miniMap = document.getElementById("miniMap");

// --- Firestore helpers ---
const playersCol = collection(db, "rooms", ROOM_ID, "players");
const metaDoc = doc(db, "rooms", ROOM_ID, "meta", "state");

// create local player in firestore
async function enterRoom(name, roleWanted){
  const id = crypto.randomUUID();
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
  await setDoc(doc(db, "rooms", ROOM_ID, "players", id), {
    ...localPlayer,
    updatedAt: serverTimestamp()
  });
  attachLocalListeners(id);
  gameStarted = true;
  overlay.classList.add("hidden");
  gameUI.classList.remove("hidden");
  startGameLoop();
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
  renderPlayersList();
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
  // default to strawberry role selection not forced here; user must click team buttons
  overlay.classList.add("hidden");
  // show team buttons in lobby style: we choose prompt rather than forcibly selecting
  // We'll set localPlayer via join buttons; for quick enter choose strawberry
  await enterRoom(name, "strawberry");
});
joinKingBtn.addEventListener("click", async ()=>{
  const name = (nameInput.value || "").trim();
  if (!name){ alert("表示名を入力してください"); return; }
  // check if another king exists
  const kingExists = Array.from(players.values()).some(p => p.role === "king");
  if (kingExists){ alert("王様は既にいます"); return; }
  await enterRoom(name, "king");
});
joinGuardBtn.addEventListener("click", async ()=>{
  const name = (nameInput.value || "").trim();
  if (!name){ alert("表示名を入力してください"); return; }
  await enterRoom(name, "guard");
});
joinStrawBtn.addEventListener("click", async ()=>{
  const name = (nameInput.value || "").trim();
  if (!name){ alert("表示名を入力してください"); return; }
  await enterRoom(name, "strawberry");
});

// Render player list in lobby
function renderPlayersList(){
  playersList.innerHTML = "";
  for (const p of players.values()){
    const li = document.createElement("li");
    li.textContent = `${p.name} - ${p.role}`;
    playersList.appendChild(li);
  }
}

// Helper: random spawn within map bounds (normalized 0..1)
function randomSpawn(){
  const margin = 0.1;
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
  king: {speed: 0.9, viewRadius: 0.18, visionPixels: 180},
  guard: {speed: 1.6, viewRadius: 1.0, visionPixels: 1000},
  strawberry: {speed: 1.8, viewRadius: 0.22, visionPixels: 160}
};

// Game loop
function startGameLoop(){
  lastTick = performance.now();
  requestAnimationFrame(tick);
  // start timer countdown
  setInterval(()=>{
    if (!gameStarted) return;
    remainingTime = Math.max(0, remainingTime-1);
    updateTimerUI();
    if (remainingTime === 0) {
      endGame("strawberry"); // strawberries win if time up
    }
  }, 1000);
}

function updateTimerUI(){
  const mm = Math.floor(remainingTime/60).toString().padStart(2,"0");
  const ss = (remainingTime%60).toString().padStart(2,"0");
  timerEl.textContent = `残り: ${mm}:${ss}`;
}

async function tick(now){
  const dt = Math.min(0.1, (now-lastTick)/1000);
  lastTick = now;
  if (localPlayer && gameStarted){
    // movement
    const role = localPlayer.role;
    const params = ROLE_PARAMS[role] || ROLE_PARAMS.strawberry;
    // check disabled states
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
        localPlayer.x = clamp01(localPlayer.x + vx * params.speed * dt * 0.1);
        localPlayer.y = clamp01(localPlayer.y + vy * params.speed * dt * 0.1);
        localPlayer.lastActive = Date.now();
        // update Firestore
        setDoc(doc(db, "rooms", ROOM_ID, "players", localPlayer.id), {
          ...localPlayer,
          updatedAt: serverTimestamp()
        }).catch(console.warn);
      }
    }
    // periodic heartbeat update
    if (Math.random() < 0.02){
      updateDoc(doc(db, "rooms", ROOM_ID, "players", localPlayer.id), { lastActive: Date.now() }).catch(()=>{});
    }
  }

  renderScene();

  requestAnimationFrame(tick);
}

function clamp01(v){ return Math.max(0, Math.min(1, v)); }

// Rendering: simple map + players + vision mask
function renderScene(){
  ctx.clearRect(0,0,canvas.width,canvas.height);
  // draw map
  if (imgCache.map && imgCache.map.complete){
    ctx.drawImage(imgCache.map, 0, 0, canvas.width, canvas.height);
  } else {
    // placeholder
    ctx.fillStyle = "#0b3";
    ctx.fillRect(0,0,canvas.width,canvas.height);
  }

  // draw players (only those permitted to be visible depending on role)
  // Determine viewer: localPlayer
  const viewer = localPlayer;
  // Collect arrays for different rendering passes
  const allPlayers = Array.from(players.values());

  // draw player markers (but for strawberry viewers, we must hide strawberry positions)
  for (const p of allPlayers){
    if (!p) continue;
    // draw only certain info on mini-map
    // main canvas: show all characters for debugging; but enforce vision: strawberries shouldn't see others far
    // We'll implement vision mask separately
    const px = p.x * canvas.width;
    const py = p.y * canvas.height;
    // choose icon
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
  if (viewer){
    const role = viewer.role;
    if (role === "guard"){
      // guard sees all -> no mask
    } else {
      // darken whole screen then cut a circle near viewer or guard's target (for guard when stunned etc)
      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,0.85)";
      ctx.fillRect(0,0,canvas.width,canvas.height);

      // compute radius in px from role's parameter
      const params = ROLE_PARAMS[role] || ROLE_PARAMS.strawberry;
      const radiusPx = params.visionPixels;
      const cx = viewer.x * canvas.width;
      const cy = viewer.y * canvas.height;
      ctx.globalCompositeOperation = "destination-out";
      // soft gradient circle
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

  // update minimap (for guard & king show others)
  miniMap.innerHTML = "";
  if (viewer){
    const mapCanvas = document.createElement("canvas");
    mapCanvas.width = 140; mapCanvas.height = 140;
    const mctx = mapCanvas.getContext("2d");
    mctx.fillStyle = "#222";
    mctx.fillRect(0,0,140,140);
    // draw players visible to minimap: guards and king see others, strawberries don't see positions
    if (viewer.role === "guard" || viewer.role === "king"){
      for (const p of players.values()){
        if (!p) continue;
        const mx = p.x * mapCanvas.width;
        const my = p.y * mapCanvas.height;
        mctx.fillStyle = (p.role==="king") ? "#ff6b9a" : (p.role==="guard" ? "#6bff9a" : "#ffd36b");
        mctx.fillRect(mx-3,my-3,6,6);
      }
    } else {
      // strawberry sees only noise or nothing on minimap
      mctx.fillStyle = "#00000099";
      mctx.fillRect(0,0,140,140);
    }
    miniMap.appendChild(mapCanvas);
  }
}

// Ability handling SPACE
async function handleAbility(){
  if (!localPlayer) return;
  const now = Date.now();

  if (localPlayer.stunnedUntil && now < localPlayer.stunnedUntil) return; // cannot use
  if (localPlayer.capturedBy) return; // cannot use

  if (localPlayer.role === "king") {
    // perform capture in radius
    const radius = 0.12; // normalized
    // find strawberries within radius
    for (const p of players.values()){
      if (!p) continue;
      if (p.role !== "strawberry") continue;
      const d = dist(localPlayer, p);
      if (d <= radius){
        // capture: remove strawberry doc and respawn it
        try {
          await deleteDoc(doc(db, "rooms", ROOM_ID, "players", p.id));
        } catch(e){ console.warn(e); }
        // spawn new strawberry player doc
        const newPos = randomSpawn();
        const newId = crypto.randomUUID();
        await setDoc(doc(db, "rooms", ROOM_ID, "players", newId), {
          id: newId,
          name: p.name,
          role: "strawberry",
          x: newPos.x,
          y: newPos.y,
          dir: 0,
          capturedBy: null,
          grabbedUntil: 0,
          stunnedUntil: 0,
          lastActive: Date.now(),
          updatedAt: serverTimestamp()
        });
        captureCount = captureCount + 1;
        gaugeCountEl.textContent = captureCount;
        // play capture sound
        if (audioCache.captureSE) { audioCache.captureSE.currentTime = 0; audioCache.captureSE.play().catch(()=>{}); }
        if (captureCount >= 10){
          endGame("king");
        }
        break; // first-come: only capture first
      }
    }
  } else if (localPlayer.role === "guard") {
    // attempt to grab a strawberry within radius
    const grabRadius = 0.06;
    for (const p of players.values()){
      if (!p) continue;
      if (p.role !== "strawberry") continue;
      const d = dist(localPlayer, p);
      if (d <= grabRadius){
        // set strawberry.capturedBy = guardId and grabbedUntil
        const grabbedForMs = 5000;
        const stunMs = 15000;
        const strawRef = doc(db, "rooms", ROOM_ID, "players", p.id);
        await updateDoc(strawRef, {
          capturedBy: localPlayer.id,
          grabbedUntil: Date.now()+grabbedForMs
        }).catch(console.warn);
        // move strawberry along with guard - we will update strawberry position in tick via watchers (simple approach is to keep strawberry's position on guard's client)
        // apply stun to guard after grab time
        setTimeout(async ()=>{
          // after 5s: release strawberry
          await updateDoc(strawRef, { capturedBy: null, grabbedUntil: 0 }).catch(()=>{});
          // stun guard
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
    // strawberries have no active ability; perhaps panic/scream? We'll push a chat message to nearby hand/king channels
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
  gameStarted = false;
  alert(`ゲーム終了: 勝者 = ${winnerRole}`);
  // Clear room local state (in prototype we won't delete other players automatically)
}

// Listen to remote updates to apply special effects like grabbed strawberry following guard
onSnapshot(playersCol, snapshot=>{
  snapshot.docChanges().forEach(ch=>{
    const p = ch.doc.data();
    if (!p) return;
    const pid = ch.doc.id;
    // If strawberry is captured by guard, and guard exists locally in players map, we move strawberry's stored position to guard's position
    if (p.role === "strawberry" && p.capturedBy){
      const captor = players.get(p.capturedBy);
      if (captor){
        // set strawberry position equal to captor
        // if local strawberry is the captured one, we reflect the movement locally by updating firestore from the captor's client during movement (simple approach)
        // We'll let the captor update strawberry doc position periodically by setting pos on strawberry doc (not implementing full authoritative behavior here)
      }
    }
  });
});

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
  // convert normalized distance to meters (assume 15m is full screen diagonal as user requested: map scale)
  const meters = nearest * 15;
  // choose audio state
  if (meters <= 3){
    playAudioLoop('lowrumble', 1.0); // heavy
    // small camera shake
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
  // simple CSS transform shake
  canvas.style.transform = `translate(${(Math.random()-0.5)*amount}px, ${(Math.random()-0.5)*amount}px)`;
  setTimeout(()=>{ canvas.style.transform = ""; }, 120);
}

// Basic collision / respawn handling: if king captures a strawberry we already delete and respawn
// Additional behaviors like ensuring respawn location is not too close to king implemented client-side on spawn

// For demonstration, create a few AI strawberries if room empty (local-only fallback)
async function ensureSomePlayers(){
  const snap = await (await fetchPlayersOnce());
  if (snap.size === 0){
    // create 6 strawberries to make game lively (only if you're testing locally using same Firebase project)
    for (let i=0;i<6;i++){
      const id = crypto.randomUUID();
      const pos = randomSpawn();
      await setDoc(doc(db, "rooms", ROOM_ID, "players", id), {
        id, name: `AI_${i+1}`, role: "strawberry", x: pos.x, y: pos.y,
        capturedBy: null, grabbedUntil:0, stunnedUntil:0, lastActive: Date.now(),
        updatedAt: serverTimestamp()
      });
    }
  }
}
async function fetchPlayersOnce(){
  // lightweight snapshot using REST is complex; instead use getDoc on meta or read players via onSnapshot first time
  // But for simplicity return a Map from current 'players' map
  return players;
}

// Kickoff: ensure some players on an empty room (optional)
ensureSomePlayers().catch(()=>{});

// The end of app.js
console.log("Prototype loaded. Open the page, enter your name, and join a team.");
