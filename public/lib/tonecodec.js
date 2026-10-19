// Untapped AI - narrowband tone codec for the telephone band.
//
// Carries a short rendezvous code inside ordinary call audio so that a
// handset listening on its microphone can confirm the caller is the party
// that also completed the data-link handshake (Patent 1, First-Contact
// Voice Trust Bootstrap).
//
// Design constraints: a Twilio call is 8 kHz mu-law with usable audio of
// roughly 300 to 3400 Hz, so the 6.8 to 8.2 kHz tones used in the earlier
// WebRTC demo cannot survive. This codec uses 16 tones from 1000 to 2500 Hz,
// 100 Hz apart, one tone per symbol, 4 bits per symbol, 50 ms per symbol
// (80 bits per second). A 2800 Hz sync tone marks the start of a frame.
//
// Frame layout (symbols): SYNC(200ms) | 2 header symbols | 16 payload
// symbols (64-bit code) | 2 CRC-8 symbols | SYNC(100ms)
// Total airtime about 1.3 s.
//
// Works in Node (encoder for mu-law injection) and in the browser (decoder
// on microphone audio at any sample rate) with no dependencies.

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ToneCodec = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const TONE_BASE = 1000;    // Hz
  const TONE_STEP = 100;     // Hz
  const TONE_COUNT = 16;
  const SYNC_FREQ = 2800;    // Hz
  const SYMBOL_S = 0.05;     // 50 ms
  const SYNC_S = 0.2;
  const TAIL_S = 0.1;
  const HEADER = 0xA5;       // fixed byte, catches gross mis-decodes
  const PAYLOAD_BYTES = 8;   // 64-bit rendezvous code

  function toneFreq(sym) { return TONE_BASE + sym * TONE_STEP; }

  // CRC-8 (poly 0x07), enough for a 10-byte frame.
  function crc8(bytes) {
    let crc = 0;
    for (const b of bytes) {
      crc ^= b;
      for (let i = 0; i < 8; i++) crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) & 0xFF : (crc << 1) & 0xFF;
    }
    return crc;
  }

  function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  function bytesToHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  // Turn a 16-hex-char code into the symbol list that goes on air.
  function frameSymbols(codeHex) {
    const payload = hexToBytes(codeHex);
    if (payload.length !== PAYLOAD_BYTES) throw new Error("code must be 8 bytes (16 hex chars)");
    const bytes = new Uint8Array(1 + PAYLOAD_BYTES + 1);
    bytes[0] = HEADER;
    bytes.set(payload, 1);
    bytes[bytes.length - 1] = crc8(bytes.subarray(0, bytes.length - 1));
    const syms = [];
    for (const b of bytes) { syms.push(b >> 4); syms.push(b & 0x0F); }
    return syms;
  }

  // ---- encoder: produce PCM float samples in [-1,1] at sampleRate ----
  function encodePCM(codeHex, sampleRate, amplitude) {
    amplitude = amplitude == null ? 0.6 : amplitude;
    const syms = frameSymbols(codeHex);
    const total = Math.round((SYNC_S + syms.length * SYMBOL_S + TAIL_S) * sampleRate);
    const out = new Float32Array(total);
    let pos = 0;
    const put = (freq, dur) => {
      const n = Math.round(dur * sampleRate);
      const fade = Math.min(Math.round(0.004 * sampleRate), Math.floor(n / 4));
      for (let i = 0; i < n && pos < total; i++, pos++) {
        let g = 1;
        if (i < fade) g = i / fade;
        else if (i > n - fade) g = (n - i) / fade;
        out[pos] = amplitude * g * Math.sin(2 * Math.PI * freq * (i / sampleRate));
      }
    };
    put(SYNC_FREQ, SYNC_S);
    for (const s of syms) put(toneFreq(s), SYMBOL_S);
    put(SYNC_FREQ, TAIL_S);
    return out;
  }

  // ---- mu-law helpers for Twilio media streams (8 kHz) ----
  function linearToMulaw(sample) {
    const BIAS = 0x84, CLIP = 32635;
    let s = Math.max(-1, Math.min(1, sample)) * 32767 | 0;
    const sign = (s >> 8) & 0x80;
    if (sign) s = -s;
    if (s > CLIP) s = CLIP;
    s += BIAS;
    let exp = 7;
    for (let mask = 0x4000; (s & mask) === 0 && exp > 0; exp--, mask >>= 1) {}
    const mant = (s >> (exp + 3)) & 0x0F;
    return ~(sign | (exp << 4) | mant) & 0xFF;
  }
  function mulawToLinear(u) {
    u = ~u & 0xFF;
    const sign = u & 0x80, exp = (u >> 4) & 0x07, mant = u & 0x0F;
    let s = ((mant << 3) + 0x84) << exp;
    s -= 0x84;
    return (sign ? -s : s) / 32768;
  }
  function encodeMulaw8k(codeHex, amplitude) {
    const pcm = encodePCM(codeHex, 8000, amplitude);
    const out = new Uint8Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) out[i] = linearToMulaw(pcm[i]);
    return out;
  }

  // ---- Goertzel power at one frequency over a window ----
  function goertzel(samples, start, len, freq, sampleRate) {
    const k = Math.round((len * freq) / sampleRate);
    const w = (2 * Math.PI * k) / len;
    const coeff = 2 * Math.cos(w);
    let s0 = 0, s1 = 0, s2 = 0;
    for (let i = 0; i < len; i++) {
      s0 = samples[start + i] + coeff * s1 - s2;
      s2 = s1; s1 = s0;
    }
    return s1 * s1 + s2 * s2 - coeff * s1 * s2;
  }

  // ---- streaming decoder ----
  // feed(Float32Array) with mic samples; onCode(hex) fires on a valid frame.
  function createDecoder(sampleRate, onCode, opts) {
    opts = opts || {};
    const hop = Math.round(0.01 * sampleRate);          // 10 ms analysis hop
    const win = Math.round(0.04 * sampleRate);          // 40 ms window
    const symHops = Math.round(SYMBOL_S / 0.01);        // 5 hops per symbol
    const syncHopsNeeded = Math.round((SYNC_S / 0.01) * 0.6);
    const minSNR = opts.minSNR == null ? 4 : opts.minSNR; // tone vs mean of others
    const freqs = [];
    for (let i = 0; i < TONE_COUNT; i++) freqs.push(toneFreq(i));

    let buf = new Float32Array(0);
    let state = "idle";      // idle -> sync -> data
    let syncRun = 0;
    let hopVotes = [];       // per-hop best symbol during data
    let lastCode = null, lastTime = 0;

    function analyseHop(start) {
      const pS = goertzel(buf, start, win, SYNC_FREQ, sampleRate);
      let best = -1, bestP = 0, sum = 0;
      for (let i = 0; i < TONE_COUNT; i++) {
        const p = goertzel(buf, start, win, freqs[i], sampleRate);
        sum += p;
        if (p > bestP) { bestP = p; best = i; }
      }
      const meanOthers = (sum - bestP) / (TONE_COUNT - 1) + 1e-12;
      return { sym: best, symP: bestP, syncP: pS, snr: bestP / meanOthers, syncSnr: pS / (sum / TONE_COUNT + 1e-12) };
    }

    function finishFrame() {
      // collapse hop votes into symbols by majority within each 5-hop group
      const nSyms = (1 + PAYLOAD_BYTES + 1) * 2;
      const syms = [];
      for (let s = 0; s < nSyms; s++) {
        const counts = new Array(TONE_COUNT).fill(0);
        for (let h = 0; h < symHops; h++) {
          const v = hopVotes[s * symHops + h];
          if (v != null && v >= 0) counts[v]++;
        }
        let b = 0;
        for (let i = 1; i < TONE_COUNT; i++) if (counts[i] > counts[b]) b = i;
        syms.push(b);
      }
      const bytes = new Uint8Array(nSyms / 2);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (syms[2 * i] << 4) | syms[2 * i + 1];
      const ok = bytes[0] === HEADER && crc8(bytes.subarray(0, bytes.length - 1)) === bytes[bytes.length - 1];
      if (ok) {
        const hex = bytesToHex(bytes.subarray(1, 1 + PAYLOAD_BYTES));
        const now = Date.now();
        if (hex !== lastCode || now - lastTime > 2000) { lastCode = hex; lastTime = now; onCode(hex); }
      }
      return ok;
    }

    return {
      feed(samples) {
        // append
        const merged = new Float32Array(buf.length + samples.length);
        merged.set(buf); merged.set(samples, buf.length);
        buf = merged;
        let start = 0;
        while (start + win <= buf.length) {
          const r = analyseHop(start);
          if (state === "idle" || state === "sync") {
            if (r.syncSnr > minSNR) { syncRun++; state = "sync"; }
            else if (state === "sync") {
              if (syncRun >= syncHopsNeeded) {
                // sync ended, data begins now
                state = "data"; hopVotes = [];
                hopVotes.push(r.snr > minSNR ? r.sym : -1);
              } else { state = "idle"; syncRun = 0; }
            }
          } else if (state === "data") {
            const nHopsNeeded = (1 + PAYLOAD_BYTES + 1) * 2 * symHops;
            hopVotes.push(r.snr > minSNR && r.syncSnr < minSNR ? r.sym : -1);
            if (hopVotes.length >= nHopsNeeded) {
              finishFrame();
              state = "idle"; syncRun = 0; hopVotes = [];
            }
          }
          start += hop;
        }
        buf = buf.subarray(start);
      },
      reset() { buf = new Float32Array(0); state = "idle"; syncRun = 0; hopVotes = []; }
    };
  }

  // one-shot decode of a whole PCM buffer
  function decodePCM(samples, sampleRate, opts) {
    let found = null;
    const d = createDecoder(sampleRate, hex => { found = hex; }, opts);
    // feed in chunks like a mic would
    const chunk = Math.round(sampleRate * 0.02);
    for (let i = 0; i < samples.length; i += chunk) d.feed(samples.subarray(i, Math.min(samples.length, i + chunk)));
    d.feed(new Float32Array(Math.round(sampleRate * 0.3))); // flush with silence
    return found;
  }

  function randomCodeHex() {
    const b = new Uint8Array(PAYLOAD_BYTES);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(b);
    else for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
    return bytesToHex(b);
  }

  return {
    TONE_BASE, TONE_STEP, TONE_COUNT, SYNC_FREQ, SYMBOL_S, SYNC_S,
    encodePCM, encodeMulaw8k, linearToMulaw, mulawToLinear,
    createDecoder, decodePCM, randomCodeHex, crc8, frameSymbols,
    airtimeSeconds: SYNC_S + (1 + PAYLOAD_BYTES + 1) * 2 * SYMBOL_S + TAIL_S
  };
});
