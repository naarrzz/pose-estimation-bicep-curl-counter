import {
  PoseLandmarker,
  FilesetResolver,
  DrawingUtils,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/vision_bundle.mjs";
import { readArm, createRepCounter, LM, EXERCISES } from "./counter.js";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm";
const MODEL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

const $ = (id) => document.getElementById(id);
const el = Object.fromEntries(
  [
    "stage", "video", "canvas", "count", "countMain", "countBoth", "reps", "repsL", "repsR",
    "goalHud", "goalHud2", "stageChip", "cue", "overlay", "overlayText", "camBtn", "fileInput",
    "fileInput2", "camBack", "trimCard", "trimLen", "trimStart", "trimEnd", "trimSel", "tStart",
    "tEnd", "exSeg", "armSeg", "goal", "goalUnit", "goalMinus", "goalPlus", "setupHint",
    "startBtn", "resetBtn", "flipBtn", "soundBtn", "setsCard", "sets", "themeSeg", "done",
    "doneTitle", "doneSub", "nextBtn",
  ].map((id) => [id, $(id)]),
);
const ctx = el.canvas.getContext("2d");
const draw = new DrawingUtils(ctx);

const state = {
  landmarker: null,
  source: null, // "camera" | "file"
  stream: null,
  facing: "user",
  running: false,
  exercise: "standing",
  arm: "right",
  goal: 12,
  sound: true,
  counters: {},
  lastSeen: { left: 0, right: 0 },
  lastVideoTime: -1,
  trim: { start: 0, end: 0 },
  setNo: 0,
};

const accent = () => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

// ---------- model ----------
async function loadModel() {
  const fileset = await FilesetResolver.forVisionTasks(WASM);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: "VIDEO",
    numPoses: 1,
  });
  try {
    state.landmarker = await PoseLandmarker.createFromOptions(fileset, opts("GPU"));
  } catch {
    state.landmarker = await PoseLandmarker.createFromOptions(fileset, opts("CPU"));
  }
  el.overlayText.textContent = "Set your phone down, step back until your upper body fits, then press Start.";
}

// ---------- sources ----------
async function startCamera() {
  stopSource();
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: state.facing, width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false,
    });
  } catch {
    el.overlay.hidden = false;
    el.overlayText.textContent =
      "Camera blocked or not found. Allow camera access in your browser settings, or use a video.";
    return;
  }
  el.video.srcObject = state.stream;
  el.video.loop = false;
  await el.video.play().catch(() => {});
  state.source = "camera";
  el.stage.classList.toggle("mirror", state.facing === "user");
  el.overlay.hidden = true;
  el.trimCard.hidden = true;
  el.startBtn.disabled = false;
  renderStartLabel();
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
  el.flipBtn.hidden = cams.length < 2;
}

function startFile(file) {
  stopSource();
  el.video.srcObject = null;
  el.video.loop = false;
  el.video.src = URL.createObjectURL(file);
  el.video.load();
  state.source = "file";
  el.stage.classList.remove("mirror");
  el.overlay.hidden = true;
  el.flipBtn.hidden = true;
  el.startBtn.disabled = true;
  el.video.addEventListener(
    "loadedmetadata",
    () => {
      const d = el.video.duration || 0;
      for (const r of [el.trimStart, el.trimEnd]) r.max = d.toFixed(1);
      el.trimStart.value = 0;
      el.trimEnd.value = d.toFixed(1);
      state.trim = { start: 0, end: d };
      el.trimCard.hidden = false;
      el.startBtn.disabled = false;
      renderTrim();
      renderStartLabel();
      el.video.currentTime = 0.01; // show the first frame with the skeleton
    },
    { once: true },
  );
}

function stopSource() {
  state.running = false;
  el.video.pause();
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
  if (el.video.src.startsWith("blob:")) URL.revokeObjectURL(el.video.src);
  el.video.removeAttribute("src");
  state.lastVideoTime = -1;
}

// ---------- trim ----------
function onTrim(which) {
  let s = +el.trimStart.value;
  let e = +el.trimEnd.value;
  const gap = Math.min(1, el.video.duration / 4 || 1);
  if (e - s < gap) {
    if (which === "start") s = e - gap;
    else e = s + gap;
    el.trimStart.value = s;
    el.trimEnd.value = e;
  }
  state.trim = { start: s, end: e };
  if (!state.running) el.video.currentTime = which === "start" ? s : e;
  renderTrim();
}

function renderTrim() {
  const d = el.video.duration || 1;
  const { start, end } = state.trim;
  el.trimSel.style.left = `${(start / d) * 100}%`;
  el.trimSel.style.right = `${100 - (end / d) * 100}%`;
  el.tStart.textContent = fmt(start);
  el.tEnd.textContent = fmt(end);
  el.trimLen.textContent = `${fmt(end - start)} selected`;
}

// ---------- loop ----------
function loop() {
  requestAnimationFrame(loop);
  const v = el.video;

  // Video: stop at the trim end, never loop.
  if (state.source === "file" && state.running && (v.ended || v.currentTime >= state.trim.end)) {
    v.pause();
    finishSet("video");
  }

  if (!state.landmarker || v.readyState < 2 || v.currentTime === state.lastVideoTime) return;
  state.lastVideoTime = v.currentTime;

  if (el.canvas.width !== v.videoWidth) {
    el.canvas.width = v.videoWidth;
    el.canvas.height = v.videoHeight;
  }
  const result = state.landmarker.detectForVideo(v, performance.now());
  ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
  const pose = result.landmarks?.[0];
  if (!pose) {
    if (state.running && state.source === "camera") showCue("Can't see you. Step back so your upper body fits.");
    return;
  }

  draw.drawConnectors(pose, PoseLandmarker.POSE_CONNECTIONS, { color: "rgba(255,255,255,.6)", lineWidth: 3 });
  draw.drawLandmarks(pose, { color: "#ffffff", radius: 3 });

  const now = performance.now();
  for (const side of activeSides()) {
    const arm = readArm(pose, side);
    if (!arm) {
      if (state.running && now - state.lastSeen[side] > 1200)
        showCue(`Can't see your ${side} arm. Turn a bit so it faces the camera.`);
      continue;
    }
    state.lastSeen[side] = now;
    highlightArm(pose, side);

    if (state.running) {
      const r = state.counters[side].update(arm.elbowAngle, arm.drift);
      if (state.arm !== "both") setStageChip(r.stage);
      if (r.rep) onRep(r.rep);
      labelAngle(arm.elbow, r.angle);
    } else {
      labelAngle(arm.elbow, arm.elbowAngle);
    }
  }
}

function activeSides() {
  return state.arm === "both" ? ["left", "right"] : [state.arm];
}

function highlightArm(pose, side) {
  const ids = LM[side];
  draw.drawConnectors(pose, [
    { start: ids.shoulder, end: ids.elbow },
    { start: ids.elbow, end: ids.wrist },
  ], { color: accent(), lineWidth: 7 });
}

function labelAngle(p, angle) {
  const x = p.x * el.canvas.width;
  const y = p.y * el.canvas.height;
  const size = Math.round(el.canvas.width / 20);
  ctx.save();
  ctx.translate(x, y);
  if (el.stage.classList.contains("mirror")) ctx.scale(-1, 1);
  ctx.font = `600 ${size}px -apple-system, system-ui, sans-serif`;
  const text = `${Math.round(angle)}°`;
  const w = ctx.measureText(text).width;
  const pad = size * 0.35;
  ctx.fillStyle = "rgba(28,28,30,.7)";
  ctx.beginPath();
  ctx.roundRect(size * 0.4, -size * 1.2, w + pad * 2, size * 1.35, size * 0.6);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.fillText(text, size * 0.4 + pad, -size * 0.18);
  ctx.restore();
}

// ---------- reps ----------
function newCounters() {
  const cfg = EXERCISES[state.exercise];
  const cap = state.arm === "both" ? state.goal : Infinity;
  state.counters = {
    left: createRepCounter({ ...cfg, cap }),
    right: createRepCounter({ ...cfg, cap }),
  };
}

function progress() {
  const { left, right } = state.counters;
  if (state.arm === "both") return Math.min(left.reps, right.reps);
  return state.counters[state.arm].reps;
}
const totalReps = () => activeSides().reduce((n, s) => n + state.counters[s].reps, 0);
const cleanReps = () => activeSides().reduce((n, s) => n + state.counters[s].clean, 0);

function onRep(rep) {
  render();
  el.count.classList.remove("bump");
  void el.count.offsetWidth;
  el.count.classList.add("bump");
  beep(rep.swing ? 330 : 880);
  navigator.vibrate?.(30);
  if (rep.swing) showCue("Elbow swung forward. Keep it by your side, or switch to Preacher.");
  if (progress() >= state.goal) finishSet("goal");
}

// reason: "goal" | "video" | "stopped"
function finishSet(reason) {
  if (!state.running) return;
  state.running = false;
  if (state.source === "file") el.video.pause();
  const total = totalReps();
  const strictCheck = EXERCISES[state.exercise].maxDrift !== null;
  if (total > 0) {
    state.setNo += 1;
    const clean = cleanReps();
    const label = state.arm === "both"
      ? `L ${state.counters.left.reps} · R ${state.counters.right.reps}`
      : `${total} reps`;
    const what = `${state.exercise === "preacher" ? "Preacher" : "Standing"} · ${state.arm === "both" ? "both" : state.arm}`;
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<span><b>Set ${state.setNo}</b> <span class="muted">${what}</span></span>
      <span class="v">${label}${strictCheck ? ` · <span class="${clean === total ? "ok" : "meh"}">${clean}/${total} strict</span>` : ""}</span>`;
    el.sets.append(row);
    el.setsCard.hidden = false;

    if (reason !== "stopped") {
      el.doneTitle.textContent = reason === "goal" ? "Set complete" : "End of clip";
      el.doneSub.textContent = `${label}${strictCheck ? ` · ${clean}/${total} strict` : ""}`;
      el.done.hidden = false;
      beep(1320, 0.25);
    }
  } else if (reason === "video") {
    el.doneTitle.textContent = "No reps found";
    el.doneSub.textContent = "Try trimming to just the set, or pick the other arm.";
    el.done.hidden = false;
  }
  setStageChip(null);
  render();
}

function resetCounters() {
  newCounters();
  setStageChip(null);
  render();
}

// ---------- UI ----------
function render() {
  const both = state.arm === "both";
  el.countMain.hidden = both;
  el.countBoth.hidden = !both;
  el.reps.textContent = progress();
  el.repsL.textContent = state.counters.left.reps;
  el.repsR.textContent = state.counters.right.reps;
  el.goal.textContent = state.goal;
  el.goalHud.textContent = state.goal;
  el.goalHud2.textContent = state.goal;
  el.goalUnit.textContent = both ? "per arm" : "";
  el.setupHint.textContent = [
    state.exercise === "preacher"
      ? "Preacher: elbow forward is fine, so there's no swing check."
      : "Standing: reps where the elbow swings forward still count, but not as strict.",
    both ? "Both: each arm counts on its own, so alternating curls work too." : "",
  ].join(" ");
  renderStartLabel();
}

function renderStartLabel() {
  if (state.running) {
    el.startBtn.textContent = "Stop";
  } else {
    el.startBtn.textContent = state.source === "file" ? "Count reps in clip" : "Start";
  }
}

function setStageChip(stage) {
  el.stageChip.textContent =
    stage === "up" ? "Up" : stage === "down" ? "Down" : state.running ? "Extend fully" : "Ready";
  el.stageChip.className = `chip glass ${stage ?? ""}`;
}

let cueTimer;
function showCue(text) {
  el.cue.textContent = text;
  el.cue.hidden = false;
  clearTimeout(cueTimer);
  cueTimer = setTimeout(() => (el.cue.hidden = true), 2000);
}

let audio;
function beep(freq, dur = 0.08) {
  if (!state.sound) return;
  audio ??= new AudioContext();
  const o = audio.createOscillator();
  const g = audio.createGain();
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.15, audio.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + dur);
  o.connect(g).connect(audio.destination);
  o.start();
  o.stop(audio.currentTime + dur);
}

function seg(node, value) {
  for (const b of node.children) b.classList.toggle("on", b.dataset.v === value);
}

function setTheme(v) {
  if (v === "auto") {
    delete document.documentElement.dataset.theme;
    localStorage.removeItem("fc-theme");
  } else {
    document.documentElement.dataset.theme = v;
    localStorage.setItem("fc-theme", v);
  }
  seg(el.themeSeg, v);
}

// ---------- events ----------
el.camBtn.onclick = startCamera;
el.camBack.onclick = startCamera;
for (const input of [el.fileInput, el.fileInput2]) {
  input.onchange = (e) => {
    if (e.target.files[0]) startFile(e.target.files[0]);
    e.target.value = "";
  };
}
el.trimStart.oninput = () => onTrim("start");
el.trimEnd.oninput = () => onTrim("end");
el.flipBtn.onclick = () => {
  state.facing = state.facing === "user" ? "environment" : "user";
  startCamera();
};
el.startBtn.onclick = () => {
  audio ??= new AudioContext(); // iOS needs a tap before sound works
  if (state.running) return finishSet("stopped");
  resetCounters();
  el.done.hidden = true;
  state.running = true;
  if (state.source === "file") {
    el.video.currentTime = state.trim.start;
    el.video.play();
  }
  setStageChip(null);
  render();
};
el.resetBtn.onclick = () => {
  state.running = false;
  if (state.source === "file") el.video.pause();
  resetCounters();
};
el.nextBtn.onclick = () => {
  el.done.hidden = true;
  resetCounters();
};
el.goalMinus.onclick = () => { state.goal = Math.max(1, state.goal - 1); render(); };
el.goalPlus.onclick = () => { state.goal = Math.min(50, state.goal + 1); render(); };
el.soundBtn.onclick = () => {
  state.sound = !state.sound;
  el.soundBtn.setAttribute("aria-pressed", state.sound);
  el.soundBtn.setAttribute("aria-label", state.sound ? "Sound on" : "Sound off");
};
el.exSeg.onclick = (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  state.exercise = b.dataset.v;
  seg(el.exSeg, state.exercise);
  if (state.running) finishSet("stopped");
  resetCounters();
};
el.armSeg.onclick = (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  state.arm = b.dataset.v;
  seg(el.armSeg, state.arm);
  if (state.running) finishSet("stopped");
  resetCounters();
};
el.themeSeg.onclick = (e) => {
  const b = e.target.closest("button");
  if (b) setTheme(b.dataset.v);
};

el.count.addEventListener("animationend", () => el.count.classList.remove("bump"));
seg(el.themeSeg, localStorage.getItem("fc-theme") || "auto");
newCounters();
render();
loadModel()
  .then(() => requestAnimationFrame(loop))
  .catch(() => {
    el.overlayText.textContent = "Couldn't load the pose model. Check your internet and refresh.";
  });
