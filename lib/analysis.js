// Patent 2 (Prosodic and Temporal Challenge-Response) measurement only.
// Nothing here passes or fails a caller. It records, per customer turn:
//   - reply latency from the end of the agent's turn to first speech
//   - utterance length
//   - pitch at the start and end of the utterance and whether it fell or rose
// Pitch is a simple autocorrelation estimate on 8 kHz audio, good enough
// to show a trend on screen. No voiceprint is stored.

const ToneCodec = require("./tonecodec");

const FRAME_MS = 20;              // Twilio sends 20 ms mu-law frames
const SPEECH_RMS = 0.02;          // energy threshold for speech
const END_SILENCE_MS = 700;       // silence that ends an utterance
const MIN_UTTER_MS = 250;

function mulawFrameToPCM(buf) {
  const out = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = ToneCodec.mulawToLinear(buf[i]);
  return out;
}
function rms(pcm) { let s = 0; for (const v of pcm) s += v * v; return Math.sqrt(s / (pcm.length || 1)); }

// autocorrelation pitch over a block of 8 kHz samples, 70-350 Hz search
function pitchHz(pcm, sr) {
  const minLag = Math.floor(sr / 350), maxLag = Math.floor(sr / 70);
  let best = 0, bestLag = 0, e = 0;
  for (const v of pcm) e += v * v;
  if (e < 1e-4) return 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let c = 0;
    for (let i = 0; i + lag < pcm.length; i++) c += pcm[i] * pcm[i + lag];
    c /= e;
    if (c > best) { best = c; bestLag = lag; }
  }
  return best > 0.3 ? sr / bestLag : 0;
}

function createTurnTracker(onTurn) {
  let agentTurnEndAt = null;    // ms epoch when agent audio finished playing
  let inSpeech = false, speechStart = 0, lastSpeech = 0;
  let utter = [];               // pcm blocks for the current utterance
  let agentTurnIndex = 0;

  return {
    // called when the agent's audio for a turn has been fully handed to Twilio
    agentTurnEnded(playbackEndMs) { agentTurnEndAt = playbackEndMs; agentTurnIndex++; },
    // inbound 20 ms frame from the customer side
    customerFrame(mulawBuf, nowMs) {
      const pcm = mulawFrameToPCM(mulawBuf);
      const energy = rms(pcm);
      if (energy > SPEECH_RMS) {
        if (!inSpeech) { inSpeech = true; speechStart = nowMs; utter = []; }
        lastSpeech = nowMs; utter.push(pcm);
      } else if (inSpeech && nowMs - lastSpeech > END_SILENCE_MS) {
        inSpeech = false;
        const lengthMs = lastSpeech - speechStart;
        if (lengthMs >= MIN_UTTER_MS) {
          const all = new Float32Array(utter.reduce((n, b) => n + b.length, 0));
          let p = 0; for (const b of utter) { all.set(b, p); p += b.length; }
          const n300 = Math.min(all.length, 8000 * 0.3);
          const startPitch = Math.round(pitchHz(all.subarray(0, n300), 8000));
          const endPitch = Math.round(pitchHz(all.subarray(all.length - n300), 8000));
          const turn = {
            agentTurn: agentTurnIndex,
            replyLatencyMs: agentTurnEndAt ? Math.max(0, speechStart - agentTurnEndAt) : null,
            utteranceMs: lengthMs,
            startPitchHz: startPitch || null,
            endPitchHz: endPitch || null,
            contour: startPitch && endPitch ? (endPitch < startPitch * 0.93 ? "falling" : endPitch > startPitch * 1.07 ? "rising" : "flat") : "unknown",
            bitsOfEvidence: 0
          };
          // rough evidence count: latency in a human window and a falling
          // contour after a question each count for something. Logged only.
          if (turn.replyLatencyMs != null && turn.replyLatencyMs > 150 && turn.replyLatencyMs < 1500) turn.bitsOfEvidence += 4;
          if (turn.contour === "falling") turn.bitsOfEvidence += 3;
          if (turn.utteranceMs > 400 && turn.utteranceMs < 6000) turn.bitsOfEvidence += 2;
          onTurn(turn);
        }
        agentTurnEndAt = null;
      }
    }
  };
}

module.exports = { createTurnTracker, mulawFrameToPCM, pitchHz };
