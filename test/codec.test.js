// Self-test for the tone codec: round trip through a simulated telephone
// leg (8 kHz mu-law, 300-3400 Hz band limit, noise, gain changes, and a
// resample to a 48 kHz microphone) and report success rate.
const C = require("../lib/tonecodec");

function bandpass(x, sr) {
  // simple 2nd-order sections: high-pass 300 Hz, low-pass 3400 Hz (biquads)
  function biquad(type, f0, q) {
    const w0 = 2 * Math.PI * f0 / sr, a = Math.sin(w0) / (2 * q), c = Math.cos(w0);
    let b0, b1, b2, a0, a1, a2;
    if (type === "lp") { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
    else { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
    a0 = 1 + a; a1 = -2 * c; a2 = 1 - a;
    const o = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const y = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = y; o[i] = y;
    }
    x = o; return o;
  }
  biquad("hp", 300, 0.7); return biquad("lp", 3400, 0.7);
}

function resample(x, from, to) {
  const n = Math.round(x.length * to / from), o = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i * from / to, j = Math.floor(t), f = t - j; o[i] = (x[j] || 0) * (1 - f) + (x[j + 1] || 0) * f; }
  return o;
}

function addNoise(x, snrDb) {
  let p = 0; for (const v of x) p += v * v; p /= x.length;
  const np = p / Math.pow(10, snrDb / 10), sd = Math.sqrt(np);
  const o = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) { const u = Math.random(), v = Math.random(); o[i] = x[i] + sd * Math.sqrt(-2 * Math.log(u + 1e-12)) * Math.cos(2 * Math.PI * v); }
  return o;
}

function speechLike(len, sr) {
  // crude talker: a few wandering harmonics, to sit under the tones
  const o = new Float32Array(len);
  for (let i = 0; i < len; i++) { const t = i / sr; const f = 140 + 40 * Math.sin(2 * Math.PI * 0.7 * t); let s = 0; for (let h = 1; h <= 8; h++) s += Math.sin(2 * Math.PI * f * h * t) / h; o[i] = 0.15 * s * (0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t)); }
  return o;
}

function trial(snrDb, withSpeech, gain) {
  const code = C.randomCodeHex();
  // encoder side: mu-law 8k as Twilio would carry it
  const mu = C.encodeMulaw8k(code, 0.6);
  let pcm = new Float32Array(mu.length); for (let i = 0; i < mu.length; i++) pcm[i] = C.mulawToLinear(mu[i]);
  // pad with silence either side, add speech, band-limit, noise, gain
  const pad = new Float32Array(8000 * 0.5);
  let line = new Float32Array(pad.length * 2 + pcm.length); line.set(pad); line.set(pcm, pad.length);
  if (withSpeech) { const sp = speechLike(line.length, 8000); for (let i = 0; i < line.length; i++) line[i] += sp[i]; }
  line = bandpass(line, 8000);
  line = addNoise(line, snrDb);
  for (let i = 0; i < line.length; i++) line[i] *= gain;
  // phone speaker -> mic at 48k
  const mic = resample(line, 8000, 48000);
  const got = C.decodePCM(mic, 48000);
  return got === code;
}

const cases = [[30, false, 1], [20, false, 0.3], [12, true, 0.5], [8, true, 1], [5, true, 0.2]];
let allOk = true;
for (const [snr, sp, g] of cases) {
  let ok = 0, N = 20;
  for (let i = 0; i < N; i++) if (trial(snr, sp, g)) ok++;
  const pct = Math.round(100 * ok / N);
  console.log(`SNR ${snr} dB, speech ${sp ? "yes" : "no "}, gain ${g}: ${pct}% decoded`);
  if (snr >= 12 && pct < 95) allOk = false;
}
// a wrong code must never pass
const code = C.randomCodeHex(); const mu = C.encodeMulaw8k(code);
let pcm = new Float32Array(mu.length); for (let i = 0; i < mu.length; i++) pcm[i] = C.mulawToLinear(mu[i]);
const other = C.decodePCM(resample(pcm, 8000, 48000), 48000);
console.log("exact match on clean line:", other === code);
console.log("airtime:", C.airtimeSeconds.toFixed(2), "s");
if (!allOk || other !== code) { console.log("FAIL"); process.exit(1); } else console.log("PASS");
