import {
  PoseLandmarker,
  FilesetResolver,
  DrawingUtils,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/vision_bundle.mjs";
import { readArm, createRepCounter, LM, EXERCISES } from "./counter.js?v=5";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm";
const MODEL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

const $ = (id) => document.getElementById(id);
const el = Object.fromEntries(
  [
    "stage", "video", "canvas", "count", "countMain", "countBoth", "reps", "repsL", "repsR",
    "goalHud", "goalHud2", "stageChip", "stageText", "cue", "overlay", "overlayText", "camBtn",
    "fileInput", "fileInput2", "camBack", "trimBar", "trimLen", "trimStart", "trimEnd", "trimSel",
    "tStart", "tEnd", "setupHint", "exSeg", "armSeg", "startBtn", "startLabel", "flipBtn",
    "settingsBtn", "scrim", "sheet", "sheetDone", "goal", "goalUnit", "goalMinus", "goalPlus",
    "soundBtn", "themeSeg", "setsTitle", "sets", "doneScrim", "done", "doneTitle", "doneSub", "nextBtn",
  ].map((id) => [id, $(id)]),
);
const ctx = el.canvas.getContext("2d");
const draw = new DrawingUtils(ctx);

const saved = JSON.parse(localStorage.getItem("fc-settings") || "{}");
const state = {
  landmarker: null,
  source: null, // "camera" | "file"
  stream: null,
  facing: "user",
  running: false,
  exercise: saved.exercise || "standing",
  arm: saved.arm || "right",
  goal: saved.goal || 12,
  sound: saved.sound ?? true,
  counters: {},
  lastSeen: { left: 0, right: 0 },
  lastVideoTime: -1,
  trim: { start: 0, end: 0 },
  setNo: 0,
};
const save = () =>
  localStorage.setItem("fc-settings", JSON.stringify({
    exercise: state.exercise, arm: state.arm, goal: state.goal, sound: state.sound,
  }));

const ACCENT = "#FF453A";
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
  el.overlayText.textContent = "Set your phone down, step back until your upper body fits.";
}

// ---------- sources ----------
async function startCamera() {
  stopSource();
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: state.facing, width: { ideal: 1280 }, height: { ideal: 1280 } },
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
  el.trimBar.hidden = true;
  el.startBtn.disabled = false;
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
  el.flipBtn.disabled = cams.length < 2;
  render();
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
  el.flipBtn.disabled = true;
  el.startBtn.disabled = true;
  el.video.addEventListener(
    "loadedmetadata",
    () => {
      const d = el.video.duration || 0;
      for (const r of [el.trimStart, el.trimEnd]) r.max = d.toFixed(1);
      el.trimStart.value = 0;
      el.trimEnd.value = d.toFixed(1);
      state.trim = { start: 0, end: d };
      el.trimBar.hidden = false;
      el.startBtn.disabled = false;
      renderTrim();
      render();
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

  const lw = Math.max(2, el.canvas.width / 260);
  draw.drawConnectors(pose, PoseLandmarker.POSE_CONNECTIONS, { color: "rgba(255,255,255,.65)", lineWidth: lw });
  draw.drawLandmarks(pose, { color: "#ffffff", radius: lw * 1.2 });

  const now = performance.now();
  for (const side of activeSides()) {
    const arm = readArm(pose, side);
    if (!arm) {
      if (state.running && now - state.lastSeen[side] > 1200)
        showCue(`Can't see your ${side} arm. Turn a bit so it faces the camera.`);
      continue;
    }
    state.lastSeen[side] = now;
    highlightArm(pose, side, lw);

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

function highlightArm(pose, side, lw) {
  const ids = LM[side];
  draw.drawConnectors(pose, [
    { start: ids.shoulder, end: ids.elbow },
    { start: ids.elbow, end: ids.wrist },
  ], { color: ACCENT, lineWidth: lw * 2.6 });
}

// Angle label: a small dark glass pill next to the elbow.
function labelAngle(p, angle) {
  const x = p.x * el.canvas.width;
  const y = p.y * el.canvas.height;
  const size = Math.round(el.canvas.width / 22);
  ctx.save();
  ctx.translate(x, y);
  if (el.stage.classList.contains("mirror")) ctx.scale(-1, 1);
  ctx.font = `600 ${size}px -apple-system, system-ui, sans-serif`;
  const text = `${Math.round(angle)}°`;
  const w = ctx.measureText(text).width;
  const pad = size * 0.45;
  const bx = size * 0.5, by = -size * 1.3, bw = w + pad * 2, bh = size * 1.45;
  ctx.fillStyle = "rgba(30,30,32,.62)";
  ctx.strokeStyle = "rgba(255,255,255,.35)";
  ctx.lineWidth = Math.max(1, size / 22);
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, bh / 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#fff";
  ctx.fillText(text, bx + pad, by + bh * 0.72);
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
    const what = `${state.exercise === "preacher" ? "Preacher" : "Standing"} · ${state.arm}`;
    const strict = strictCheck ? ` · <span class="${clean === total ? "ok" : "meh"}">${clean}/${total} strict</span>` : "";
    const row = document.createElement("div");
    row.className = "r";
    row.innerHTML = `<span>Set ${state.setNo} <span class="soft">${what}</span></span><span class="v">${label}${strict}</span>`;
    el.sets.append(row);
    el.sets.hidden = false;
    el.setsTitle.hidden = false;

    if (reason !== "stopped") {
      el.doneTitle.textContent = reason === "goal" ? "Set complete" : "End of clip";
      el.doneSub.innerHTML = `${label}${strict}`;
      showDone(true);
      beep(1320, 0.25);
    }
  } else if (reason === "video") {
    el.doneTitle.textContent = "No reps found";
    el.doneSub.textContent = "Try trimming to just the set, or pick the other arm.";
    showDone(true);
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
  el.setupHint.textContent = state.running ? "" : [
    state.exercise === "preacher" ? "Preacher: elbow forward is fine." : "Standing: keep your elbows by your sides.",
    both ? `Each arm counts to ${state.goal}, alternating works.` : "",
  ].join(" ").trim();
  const label = state.running ? "Stop" : state.source === "file" ? "Count reps" : "Start";
  el.startLabel.textContent = label;
  el.startBtn.classList.toggle("running", state.running);
  el.startBtn.classList.toggle("long", label.length > 5);
  el.soundBtn.setAttribute("aria-checked", state.sound);
  seg(el.exSeg, state.exercise);
  seg(el.armSeg, state.arm);
}

function setStageChip(stage) {
  el.stageText.textContent =
    stage === "up" ? "Up" : stage === "down" ? "Down" : state.running ? "Extend fully" : "Ready";
  el.stageChip.className = `glass chip ${stage ?? ""}`;
}

let cueTimer;
function showCue(text) {
  if (!el.cue.hidden && el.cue.textContent === text) return;
  el.cue.textContent = text;
  el.cue.hidden = false;
  clearTimeout(cueTimer);
  cueTimer = setTimeout(() => (el.cue.hidden = true), 2200);
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

// Segmented control with a sliding glass thumb.
function seg(node, value) {
  let on;
  for (const b of node.querySelectorAll("button")) {
    const is = b.dataset.v === value;
    b.classList.toggle("on", is);
    b.setAttribute("aria-checked", is);
    if (is) on = b;
  }
  const thumb = node.querySelector(".thumb");
  if (on && thumb && on.offsetWidth) {
    thumb.style.left = `${on.offsetLeft}px`;
    thumb.style.width = `${on.offsetWidth}px`;
  }
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

function openSheet(open) {
  el.sheet.hidden = !open;
  el.scrim.hidden = !open;
  if (open) seg(el.themeSeg, localStorage.getItem("fc-theme") || "auto");
}

function showDone(open) {
  el.done.hidden = !open;
  el.doneScrim.hidden = !open;
}

// Liquid glass: a light that follows the pointer, and a squish on press.
function wireGlass() {
  document.addEventListener("pointermove", (e) => {
    const t = e.target.closest?.(".lg, .seg");
    if (!t) return;
    const r = t.getBoundingClientRect();
    t.style.setProperty("--x", `${e.clientX - r.left}px`);
    t.style.setProperty("--y", `${e.clientY - r.top}px`);
  }, { passive: true });
  document.addEventListener("pointerdown", (e) => {
    const t = e.target.closest?.(".lg");
    if (!t) return;
    const r = t.getBoundingClientRect();
    t.style.setProperty("--x", `${e.clientX - r.left}px`);
    t.style.setProperty("--y", `${e.clientY - r.top}px`);
    t.classList.add("pressing");
  });
  const release = () => document.querySelectorAll(".pressing").forEach((n) => n.classList.remove("pressing"));
  document.addEventListener("pointerup", release);
  document.addEventListener("pointercancel", release);
  document.addEventListener("pointerleave", release);
}

// Hold a segmented control and slide, like the Time Log tab bar: the thumb swells into a lens,
// follows your finger, and letting go picks the option under it. A quick tap just picks and squishes.
function wireSegDrag(node) {
  const thumb = node.querySelector(".thumb");
  const buttons = [...node.querySelectorAll("button")];
  let held = null, justDragged = false, lensTimer = null;

  const under = (x) => {
    let best = buttons[0], dist = Infinity;
    for (const b of buttons) {
      const r = b.getBoundingClientRect();
      const d = Math.abs(x - (r.left + r.width / 2));
      if (d < dist) { dist = d; best = b; }
    }
    return best;
  };
  const place = (x) => {
    const box = node.getBoundingClientRect();
    const target = under(x);
    const w = target.offsetWidth;
    const pad = buttons[0].offsetLeft;
    const left = Math.min(Math.max(x - box.left - w / 2, pad), box.width - pad - w);
    thumb.style.left = `${left}px`;
    thumb.style.width = `${w}px`;
    buttons.forEach((b) => b.classList.toggle("peek", b === target));
    return target;
  };
  const startDrag = (x) => {
    clearTimeout(lensTimer);
    held.dragging = true;
    node.classList.add("dragging");
    place(x);
  };
  const end = (e) => {
    if (!held) return;
    clearTimeout(lensTimer);
    const pick = held.dragging && e ? place(e.clientX) : null;
    if (held.dragging) { justDragged = true; setTimeout(() => (justDragged = false), 400); }
    held = null;
    node.classList.remove("holding", "dragging");
    buttons.forEach((b) => b.classList.remove("peek"));
    if (pick) pick.click();
    else squish();
  };
  const squish = () => {
    thumb.classList.remove("squish");
    void thumb.offsetWidth;
    thumb.classList.add("squish");
  };

  node.addEventListener("pointerdown", (e) => {
    held = { x: e.clientX, dragging: false };
    node.classList.add("holding");
    lensTimer = setTimeout(() => { if (held) startDrag(held.x); }, 180);
  });
  window.addEventListener("pointermove", (e) => {
    if (!held) return;
    if (!held.dragging && Math.abs(e.clientX - held.x) < 6) return;
    if (!held.dragging) startDrag(e.clientX); else place(e.clientX);
  });
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", () => end(null));
  // The browser can still send its own tap after a drag; the drag already decided.
  node.addEventListener("click", (e) => {
    if (justDragged && e.isTrusted) { e.stopPropagation(); e.preventDefault(); }
  }, true);
  thumb.addEventListener("animationend", () => thumb.classList.remove("squish"));
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
  showDone(false);
  state.running = true;
  if (state.source === "file") {
    el.video.currentTime = state.trim.start;
    el.video.play();
  }
  setStageChip(null);
  render();
};
el.nextBtn.onclick = () => {
  showDone(false);
  resetCounters();
};
el.doneScrim.onclick = () => showDone(false);
el.settingsBtn.onclick = () => openSheet(true);
el.sheetDone.onclick = () => openSheet(false);
el.scrim.onclick = () => openSheet(false);
el.goalMinus.onclick = () => { state.goal = Math.max(1, state.goal - 1); save(); if (!state.running) newCounters(); render(); };
el.goalPlus.onclick = () => { state.goal = Math.min(50, state.goal + 1); save(); if (!state.running) newCounters(); render(); };
el.soundBtn.onclick = () => { state.sound = !state.sound; save(); render(); };
el.exSeg.onclick = (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  state.exercise = b.dataset.v;
  save();
  if (state.running) finishSet("stopped");
  resetCounters();
};
el.armSeg.onclick = (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  state.arm = b.dataset.v;
  save();
  if (state.running) finishSet("stopped");
  resetCounters();
};
el.themeSeg.onclick = (e) => {
  const b = e.target.closest("button");
  if (b) setTheme(b.dataset.v);
};
el.count.addEventListener("animationend", () => el.count.classList.remove("bump"));
window.addEventListener("resize", () => { seg(el.exSeg, state.exercise); seg(el.armSeg, state.arm); });
document.fonts?.ready.then(() => render());

wireGlass();
[el.exSeg, el.armSeg, el.themeSeg].forEach(wireSegDrag);
el.flipBtn.disabled = true;
newCounters();
render();
loadModel()
  .then(() => requestAnimationFrame(loop))
  .catch(() => {
    el.overlayText.textContent = "Couldn't load the pose model. Check your internet and refresh.";
  });
