// Untapped AI - pause codec (Patent 2, Prosodic and Temporal Challenge-Response).
//
// The bank speaks one ordinary sentence. Nothing unusual is said: the proof
// is in the gaps between the words. Each gap is either short or long, and the
// pattern of shorts and longs is derived from the session secret, so it is
// different on every call and cannot be predicted by anyone without the key.
//
// The listener (the laptop microphone, or the customer's AI on the server)
// measures the gaps and sends them over the data link. The bank compares them
// with the pattern it expected and, if they match, signs. A recording of an
// earlier call carries the wrong pattern, and a voice clone or a coached
// human cannot produce the right one without the key.
//
// Works in Node and in the browser with no dependencies.

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PauseCodec = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // The sentence the bank speaks: small talk about the weather, so nothing in
  // the words gives away that it is a check. 19 words, so 18 gaps carry 18 bits.
  const PHRASE = "It is a lovely sunny day here in Johannesburg while down in Cape Town it is cool and windy";
  const SHORT_MS = 180;          // gap for a 0 bit
  const LONG_MS = 520;           // gap for a 1 bit (a natural pause, not a stall)
  const SPLIT_MS = 500;          // fallback split if a sentence has only one kind of gap
  const MIN_GAP_MS = 120;        // shorter silences are inside words, not gaps
  const UTTERANCE_END_MS = 1100; // a silence this long ends the sentence
  const LEAD_MS = 1200;          // silence before the sentence (separates it from the greeting)
  const TAIL_MS = 1500;          // silence after it
  const MAX_DISTANCE = 2;        // edits tolerated between heard and expected patterns

  function gapCount() { return PHRASE.split(/\s+/).length - 1; }

  function bitsToGapsMs(bits) { return bits.map(b => (b ? LONG_MS : SHORT_MS)); }
  // Measured gaps come out longer than the inserted ones (the quiet edges of
  // words fall under the detector's threshold), by an amount that depends on
  // the voice, the speaker and the room. So the short/long split is taken
  // from the sentence itself: the cut that best separates its gaps into two
  // groups. A fixed split is used only if the gaps don't form two groups.
  function splitPoint(gapsMs) {
    const g = gapsMs.slice().sort((a, b) => a - b);
    if (g.length < 4 || g[g.length - 1] - g[0] < 250) return SPLIT_MS;
    let best = SPLIT_MS, bestCost = Infinity;
    for (let i = 1; i < g.length; i++) {
      const lo = g.slice(0, i), hi = g.slice(i);
      const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
      const ml = mean(lo), mh = mean(hi);
      const cost = lo.reduce((c, v) => c + (v - ml) ** 2, 0) + hi.reduce((c, v) => c + (v - mh) ** 2, 0);
      if (cost < bestCost) { bestCost = cost; best = (g[i - 1] + g[i]) / 2; }
    }
    return best;
  }
  function gapsToBits(gapsMs) {
    const g = gapsMs.filter(v => v >= MIN_GAP_MS);
    const split = splitPoint(g);
    return g.map(v => (v >= split ? 1 : 0));
  }

  // Edit distance between two bit arrays: a word split in two by the detector
  // adds a gap, two words run together remove one, a gap misjudged flips one.
  function distance(a, b) {
    const d = [];
    for (let i = 0; i <= a.length; i++) { d[i] = [i]; }
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }

  function match(heardBits, expectedBits) {
    const dist = distance(heardBits, expectedBits);
    return { ok: Math.abs(heardBits.length - expectedBits.length) <= MAX_DISTANCE && dist <= MAX_DISTANCE, distance: dist };
  }

  // ---- streaming detector ----
  // feed(Float32Array) with audio at sampleRate; onUtterance({ gapsMs, words })
  // fires after each stretch of speech that ends with a long silence.
  function createDetector(sampleRate, onUtterance, opts) {
    opts = opts || {};
    const frame = Math.round(0.01 * sampleRate);   // 10 ms frames
    const minWords = opts.minWords || 8;
    let pending = new Float32Array(0);
    const history = [];                             // recent frame levels, for the noise floor
    let floor = 0.001;
    let inSpeech = false, speechFrames = 0, silenceFrames = 0;
    let gaps = [], words = 0, lastSpeechEnd = null, frameIndex = 0;

    function updateFloor(level) {
      history.push(level);
      if (history.length > 300) history.shift();          // last 3 s
      if (frameIndex % 25 === 0 && history.length > 20) {
        const sorted = history.slice().sort((x, y) => x - y);
        floor = Math.max(sorted[Math.floor(sorted.length * 0.1)], 1e-5);
      }
    }

    function endUtterance() {
      if (words >= minWords && gaps.length) onUtterance({ gapsMs: gaps.slice(), words });
      gaps = []; words = 0; lastSpeechEnd = null;
    }

    function step(level) {
      frameIndex++;
      updateFloor(level);
      const on = Math.max(floor * 4, opts.minLevel || 0.002);
      const off = on * 0.6;
      if (!inSpeech) {
        if (level > on) {
          speechFrames++;
          if (speechFrames >= 3) {                           // 30 ms of sound: a word has started
            inSpeech = true;
            const startFrame = frameIndex - speechFrames;
            if (lastSpeechEnd !== null) {
              const gapMs = (startFrame - lastSpeechEnd) * 10;
              if (gapMs >= MIN_GAP_MS) { gaps.push(gapMs); words++; }
            } else words = 1;
            silenceFrames = 0;
          }
        } else {
          speechFrames = 0;
          silenceFrames++;
          if (lastSpeechEnd !== null && silenceFrames * 10 >= UTTERANCE_END_MS) endUtterance();
        }
      } else {
        if (level < off) {
          silenceFrames++;
          if (silenceFrames * 10 >= MIN_GAP_MS) {            // the word has ended
            inSpeech = false; speechFrames = 0;
            lastSpeechEnd = frameIndex - silenceFrames;
          }
        } else silenceFrames = 0;
      }
    }

    return {
      feed(samples) {
        const merged = new Float32Array(pending.length + samples.length);
        merged.set(pending); merged.set(samples, pending.length);
        let i = 0;
        for (; i + frame <= merged.length; i += frame) {
          let s = 0;
          for (let k = i; k < i + frame; k++) s += merged[k] * merged[k];
          step(Math.sqrt(s / frame));
        }
        pending = merged.subarray(i);
      },
      flush() { if (inSpeech) { inSpeech = false; lastSpeechEnd = frameIndex; } endUtterance(); },
      level() { return floor; }
    };
  }

  return {
    PHRASE, SHORT_MS, LONG_MS, SPLIT_MS, MIN_GAP_MS, UTTERANCE_END_MS, LEAD_MS, TAIL_MS, MAX_DISTANCE,
    gapCount, bitsToGapsMs, gapsToBits, splitPoint, distance, match, createDetector
  };
});
