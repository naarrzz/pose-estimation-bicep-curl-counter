// Flex and Count v2 — counting logic (no DOM, so it can be tested in Node).

// MediaPipe Pose landmark indices.
export const LM = {
  left: { shoulder: 11, elbow: 13, wrist: 15, hip: 23 },
  right: { shoulder: 12, elbow: 14, wrist: 16, hip: 24 },
};

// Curl styles. Preacher / elbow-forward curls skip the swing check,
// and count a slightly shorter stretch since the pad stops full lockout.
// relDown / relUp: when the arm points toward the camera, a straight arm can look like 140°
// and a curled one like 70°. So a big enough swing (minRange) also counts, as long as the
// extended end is past relDown and the curled end is under relUp.
export const EXERCISES = {
  standing: { downAngle: 160, upAngle: 50, relDown: 130, relUp: 75, minRange: 70, maxDrift: 45 },
  preacher: { downAngle: 150, upAngle: 55, relDown: 115, relUp: 80, minRange: 70, maxDrift: null },
};

// Angle at b (degrees, 0–180) between a-b and c-b. Same math as v1.
export function calculateAngle(a, b, c) {
  const radians =
    Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(a.y - b.y, a.x - b.x);
  let angle = Math.abs((radians * 180) / Math.PI);
  if (angle > 180) angle = 360 - angle;
  return angle;
}

const visible = (p, min) => p && (p.visibility === undefined || p.visibility >= min);
// The model guesses where off-screen joints are. Those guesses jump around, so they don't count.
const inFrame = (p, m) => p && p.x >= m && p.x <= 1 - m && p.y >= m && p.y <= 1 - m;

// Reads one arm from a pose.
// Returns { ok: true, elbowAngle, drift, elbow } or { ok: false, why: "hidden" | "offframe" }.
export function readArm(landmarks, side, { minVisibility = 0.65, margin = 0.02 } = {}) {
  const ids = LM[side];
  const shoulder = landmarks[ids.shoulder];
  const elbow = landmarks[ids.elbow];
  const wrist = landmarks[ids.wrist];
  const hip = landmarks[ids.hip];
  const joints = [shoulder, elbow, wrist];
  if (!joints.every((p) => inFrame(p, margin))) return { ok: false, why: "offframe", elbow };
  if (!joints.every((p) => visible(p, minVisibility))) return { ok: false, why: "hidden", elbow };
  return {
    ok: true,
    elbowAngle: calculateAngle(shoulder, elbow, wrist),
    // How far the upper arm swings away from the torso (hip-shoulder-elbow).
    drift: visible(hip, minVisibility) ? calculateAngle(hip, shoulder, elbow) : null,
    elbow,
  };
}

// One counter per arm.
//  - "down" once the arm is extended past downAngle
//  - a rep counts when it then curls past upAngle
//  - swing: the elbow drifted more than maxDrift during the rep (null = no check)
//  - cap: stop counting this arm once it reaches the goal (alternating curls)
//  - glitch guard: a single-frame jump bigger than maxJump is ignored unless it holds,
//    and a rep that's impossibly quick (minCurlMs, minGapMs) is thrown out.
export function createRepCounter({
  downAngle = 160,
  upAngle = 50,
  relDown = 181, // off unless set
  relUp = -1,
  minRange = 70,
  maxDrift = 45,
  smoothing = 0.5,
  cap = Infinity,
  maxJump = 100,
  holdFrames = 3,
  minCurlMs = 120, // a curl from the fullest stretch to curled can't be quicker than this
  minGapMs = 450, // nor can two reps of the same arm come closer than this
} = {}) {
  let stage = null;
  let reps = 0;
  let clean = 0;
  let smooth = null;
  let peakDrift = 0;
  let jumpCount = 0;
  let downAt = null; // when the arm was last at its fullest stretch
  let lastRepAt = null;
  let range = { min: 180, max: 0 }; // recent range of motion, for picking the working arm
  let valley = Infinity; // lowest angle since the last rep (the curled end)
  let peak = -Infinity; // highest angle since the arm went "down" (the extended end)

  return {
    // t: timestamp in ms (optional; without it the speed check is skipped)
    update(angle, drift = null, t = null) {
      if (smooth !== null && Math.abs(angle - smooth) > maxJump) {
        jumpCount += 1;
        if (jumpCount < holdFrames) return { angle: smooth, stage, reps, clean, rep: null, glitch: true };
        smooth = angle; // it held, so it's real
      }
      jumpCount = 0;
      smooth = smooth === null ? angle : smoothing * angle + (1 - smoothing) * smooth;
      range = { min: Math.min(range.min, smooth), max: Math.max(range.max, smooth) };
      if (drift !== null) peakDrift = Math.max(peakDrift, drift);

      valley = Math.min(valley, smooth);
      if (smooth >= peak - 8) downAt = t; // time of the fullest stretch, for the speed check
      peak = Math.max(peak, smooth);
      // At the very start there's no curled end to measure from, so a clearly straight-ish arm starts it.
      const extended = smooth > downAngle || (smooth >= relDown && smooth - valley >= minRange)
        || (stage === null && smooth >= relDown + 15);
      const curled = smooth < upAngle || (smooth <= relUp && peak - smooth >= minRange);

      let rep = null;
      if (extended && stage !== "down") {
        peakDrift = drift ?? 0;
        stage = "down";
        peak = smooth;
        downAt = t;
      } else if (curled && stage === "down" && reps < cap) {
        valley = smooth;
        const tooFast = t !== null && ((downAt !== null && t - downAt < minCurlMs) || (lastRepAt !== null && t - lastRepAt < minGapMs));
        stage = "up";
        if (!tooFast) {
          reps += 1;
          lastRepAt = t;
          const swing = maxDrift !== null && peakDrift > maxDrift;
          if (!swing) clean += 1;
          rep = { n: reps, swing };
        }
      }
      return { angle: smooth, stage, reps, clean, rep };
    },
    // How much this arm has moved since the last call; resets the window.
    takeRange() {
      const r = range.max - range.min;
      range = { min: 180, max: 0 };
      return Math.max(0, r);
    },
    get reps() {
      return reps;
    },
    get clean() {
      return clean;
    },
  };
}
