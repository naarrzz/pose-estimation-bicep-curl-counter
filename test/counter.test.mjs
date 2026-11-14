import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateAngle, createRepCounter, readArm, EXERCISES } from "../docs/counter.js";

const P = (x, y, visibility = 1) => ({ x, y, visibility });

test("angle: straight arm is 180, right angle is 90", () => {
  assert.equal(Math.round(calculateAngle(P(0, 0), P(0, 1), P(0, 2))), 180);
  assert.equal(Math.round(calculateAngle(P(0, 0), P(0, 1), P(1, 1))), 90);
});

const feed = (c, angles, drift = 10) => angles.map((a) => c.update(a, drift)).at(-1);
const curl = [170, 170, 120, 80, 40, 30, 30, 80, 120, 170, 170];

test("counts one rep per full curl", () => {
  const c = createRepCounter();
  feed(c, curl);
  feed(c, curl);
  assert.equal(c.reps, 2);
  assert.equal(c.clean, 2);
});

test("half reps that never extend are not counted", () => {
  const c = createRepCounter();
  feed(c, curl);
  feed(c, [120, 80, 40, 30, 80, 120, 80, 40, 30]);
  assert.equal(c.reps, 1);
});

test("swinging the elbow counts the rep but not as strict", () => {
  const c = createRepCounter();
  feed(c, [170, 170], 10);
  feed(c, [120, 80], 60);
  const r = feed(c, [40, 30, 30], 60);
  assert.equal(c.reps, 1);
  assert.equal(c.clean, 0);
  assert.equal(r.reps, 1);
});

test("preacher mode never flags a swing", () => {
  const c = createRepCounter(EXERCISES.preacher);
  feed(c, [165, 165], 10);
  feed(c, [120, 80, 40, 30, 30], 70);
  assert.equal(c.reps, 1);
  assert.equal(c.clean, 1);
});

test("alternating: an arm stops counting at its goal", () => {
  const c = createRepCounter({ cap: 2 });
  feed(c, curl); feed(c, curl); feed(c, curl);
  assert.equal(c.reps, 2);
});

test("readArm: low confidence is hidden, off-screen joints don't count", () => {
  const lm = [];
  lm[12] = P(0.5, 0.3); lm[14] = P(0.5, 0.5); lm[16] = P(0.5, 0.7, 0.1); lm[24] = P(0.5, 0.8);
  assert.equal(readArm(lm, "right").why, "hidden");
  lm[16] = P(0.5, 1.08); // wrist below the bottom edge
  assert.equal(readArm(lm, "right").why, "offframe");
  lm[16] = P(0.7, 0.5);
  const arm = readArm(lm, "right");
  assert.ok(arm.ok);
  assert.equal(Math.round(arm.elbowAngle), 90);
});

test("glitch guard: a one-frame jump doesn't make a rep", () => {
  const c = createRepCounter();
  feed(c, [170, 170, 170]);
  feed(c, [20, 170, 170, 175]); // 179 -> 6 for one frame, like a joint guessed off-screen
  assert.equal(c.reps, 0);
});

test("glitch guard: a jump that holds is real", () => {
  const c = createRepCounter();
  feed(c, [170, 170, 30, 30, 30, 30]);
  assert.equal(c.reps, 1);
});

test("speed check: a 'rep' faster than a real curl is thrown out", () => {
  const c = createRepCounter();
  const at = (angles, t0, dt) => angles.map((a, i) => c.update(a, 10, t0 + i * dt));
  at([170, 170, 120, 80, 40, 30, 30], 0, 30); // ~120 ms from extension to curled
  assert.equal(c.reps, 0);
  at([60, 100, 140, 170, 170, 170, 170, 140, 110, 80, 50, 35, 30, 30], 1000, 80); // ~560 ms: a real rep
  assert.equal(c.reps, 1);
});

test("takeRange reports how much an arm moved", () => {
  const c = createRepCounter();
  feed(c, curl);
  assert.ok(c.takeRange() > 100);
  feed(c, [170, 171, 169]);
  assert.ok(c.takeRange() < 10);
});
