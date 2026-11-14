// Flex and Count v2 — counting logic (no DOM, so it can be tested in Node).

// MediaPipe Pose landmark indices.
export const LM = {
  left: { shoulder: 11, elbow: 13, wrist: 15, hip: 23 },
  right: { shoulder: 12, elbow: 14, wrist: 16, hip: 24 },
};

// Curl styles. Preacher / elbow-forward curls skip the swing check,
// and count a slightly shorter stretch since the pad stops full lockout.
export const EXERCISES = {
  standing: { downAngle: 160, upAngle: 50, maxDrift: 45 },
  preacher: { downAngle: 150, upAngle: 55, maxDrift: null },
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

// Reads one arm from a pose. Returns null if the arm isn't visible enough.
export function readArm(landmarks, side, minVisibility = 0.5) {
  const ids = LM[side];
  const shoulder = landmarks[ids.shoulder];
  const elbow = landmarks[ids.elbow];
  const wrist = landmarks[ids.wrist];
  const hip = landmarks[ids.hip];
  if (![shoulder, elbow, wrist].every((p) => visible(p, minVisibility))) return null;
  return {
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
export function createRepCounter({
  downAngle = 160,
  upAngle = 50,
  maxDrift = 45,
  smoothing = 0.5,
  cap = Infinity,
} = {}) {
  let stage = null;
  let reps = 0;
  let clean = 0;
  let smooth = null;
  let peakDrift = 0;

  return {
    update(angle, drift = null) {
      smooth = smooth === null ? angle : smoothing * angle + (1 - smoothing) * smooth;
      if (drift !== null) peakDrift = Math.max(peakDrift, drift);

      let rep = null;
      if (smooth > downAngle) {
        if (stage !== "down") peakDrift = drift ?? 0;
        stage = "down";
      } else if (smooth < upAngle && stage === "down" && reps < cap) {
        stage = "up";
        reps += 1;
        const swing = maxDrift !== null && peakDrift > maxDrift;
        if (!swing) clean += 1;
        rep = { n: reps, swing };
      }
      return { angle: smooth, stage, reps, clean, rep };
    },
    get reps() {
      return reps;
    },
    get clean() {
      return clean;
    },
  };
}
