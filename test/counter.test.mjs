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

test("readArm skips arms the model can't see", () => {
  const lm = [];
  lm[12] = P(0, 0); lm[14] = P(0, 1); lm[16] = P(0, 2, 0.1); lm[24] = P(0, 3);
  assert.equal(readArm(lm, "right"), null);
  lm[16] = P(1, 1);
  assert.equal(Math.round(readArm(lm, "right").elbowAngle), 90);
});
