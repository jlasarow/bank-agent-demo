// Telephony bridge: Twilio outbound call -> Media Stream -> this server ->
// ElevenLabs Conversational AI agent, with the rendezvous tone injected into
// the call after the agent's greeting and Patent 2 timing captured on the
// customer's replies.

const WebSocket = require("ws");
const twilio = require("twilio");
const ToneCodec = require("./tonecodec");
const PauseCodec = require("./pausecodec");
const trust = require("./trust");
const { createTurnTracker } = require("./analysis");

const EL_API = "https://api.elevenlabs.io";
const FRAME_BYTES = 160;   // 20 ms of 8 kHz mu-law
const env = () => ({
  sid: process.env.TWILIO_ACCOUNT_SID,
  token: process.env.TWILIO_AUTH_TOKEN,
  from: process.env.TWILIO_FROM_NUMBER,
  assistantNumber: process.env.TWILIO_ASSISTANT_NUMBER,   // second number, answered by the customer's AI
  elKey: process.env.ELEVENLABS_API_KEY,
  agentId: process.env.ELEVENLABS_AGENT_ID,
  publicHost: process.env.PUBLIC_HOST || process.env.RENDER_EXTERNAL_HOSTNAME   // Render sets the latter automatically
});

function configured() {
  const e = env();
  return !!(e.sid && e.token && e.from && e.agentId && e.publicHost);
}
// "internal" (default): the bank's agent and the customer's AI are connected
// inside this server. "phone": a real Twilio call to TWILIO_ASSISTANT_NUMBER.
function divertMode() { return process.env.DIVERT_MODE === "phone" ? "phone" : "internal"; }
function divertAvailable() { return configured() && (divertMode() === "internal" || !!env().assistantNumber); }

// Point the assistant number's voice webhook at this server so inbound calls
// land on the customer agent. Runs at boot, no console clicks needed.
async function configureAssistantNumber() {
  const e = env();
  if (!configured() || !e.assistantNumber) return { skipped: true };
  const client = twilio(e.sid, e.token);
  const [num] = await client.incomingPhoneNumbers.list({ phoneNumber: e.assistantNumber, limit: 1 });
  if (!num) return { ok: false, reason: "assistant number not found on this Twilio account" };
  const voiceUrl = `https://${e.publicHost}/twilio/assistant-inbound`;
  if (num.voiceUrl !== voiceUrl) await client.incomingPhoneNumbers(num.sid).update({ voiceUrl, voiceMethod: "POST" });
  return { ok: true, voiceUrl };
}

// Diverted calls arrive at the assistant number as an ordinary inbound call,
// so the session id cannot ride along. The bank queues the session when it
// dials and the inbound webhook claims the oldest one still fresh.
const pendingDiverts = [];
function claimPendingDivert() {
  const now = Date.now();
  while (pendingDiverts.length && now - pendingDiverts[0].at > 120000) pendingDiverts.shift();
  const p = pendingDiverts.shift();
  return p ? p.sessionId : null;
}

// One-time agent configuration so audio matches Twilio's mu-law 8 kHz.
async function configureAgent() {
  const e = env();
  if (!e.elKey || !e.agentId) return { skipped: true };
  const res = await fetch(`${EL_API}/v1/convai/agents/${e.agentId}`, {
    method: "PATCH",
    signal: AbortSignal.timeout(15000),
    headers: { "xi-api-key": e.elKey, "content-type": "application/json" },
    body: JSON.stringify({
      conversation_config: {
        asr: { user_input_audio_format: "ulaw_8000" },
        tts: { agent_output_audio_format: "ulaw_8000", model_id: "eleven_flash_v2" }
      }
    })
  });
  return { ok: res.ok, status: res.status };
}

async function signedUrlFor(agentId) {
  const e = env();
  if (!e.elKey) return `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${agentId}`; // public agent
  const res = await fetch(`${EL_API}/v1/convai/conversation/get-signed-url?agent_id=${agentId}`, { headers: { "xi-api-key": e.elKey }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error("signed url failed " + res.status);
  return (await res.json()).signed_url;
}
const signedUrl = () => signedUrlFor(env().agentId);

// ---- Patent 2 proof: one ordinary sentence, the session's pattern in its gaps ----
let bankVoice = null;
async function bankVoiceId() {
  if (bankVoice) return bankVoice;
  const e = env();
  try {
    const r = await fetch(`${EL_API}/v1/convai/agents/${e.agentId}`, { headers: { "xi-api-key": e.elKey }, signal: AbortSignal.timeout(15000) });
    if (r.ok) bankVoice = (await r.json())?.conversation_config?.tts?.voice_id || null;
  } catch {}
  return bankVoice || process.env.ELEVENLABS_PROOF_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
}

// Speak the sentence in the bank agent's own voice, then open a short or long
// silence at each word boundary according to the session's bit pattern.
async function buildPausePhrase(session) {
  const e = env();
  const res = await fetch(`${EL_API}/v1/text-to-speech/${await bankVoiceId()}/with-timestamps?output_format=ulaw_8000`, {
    method: "POST", signal: AbortSignal.timeout(20000),
    headers: { "xi-api-key": e.elKey, "content-type": "application/json" },
    body: JSON.stringify({ text: PauseCodec.PHRASE, model_id: "eleven_flash_v2" })
  });
  if (!res.ok) throw new Error("speech generation failed " + res.status + " " + (await res.text()).slice(0, 120));
  const j = await res.json();
  return assemblePausePhrase(Buffer.from(j.audio_base64, "base64"), j.alignment || j.normalized_alignment, trust.expectedPauseBits(session));
}

function assemblePausePhrase(mu, alignment, bits) {
  if (!alignment || !alignment.characters) throw new Error("speech came back without word timings");
  const ch = alignment.characters, st = alignment.character_start_times_seconds, en = alignment.character_end_times_seconds;
  const cuts = [];
  for (let i = 1; i < ch.length; i++) {
    if (/\s/.test(ch[i - 1]) && !/\s/.test(ch[i])) {           // a new word starts at i
      let k = i - 1; while (k >= 0 && /\s/.test(ch[k])) k--;    // last letter of the previous word
      const t = k >= 0 ? (en[k] + st[i]) / 2 : st[i];
      cuts.push(Math.min(mu.length, Math.max(0, Math.round(t * 8000))));
    }
  }
  if (cuts.length !== bits.length) throw new Error(`speech had ${cuts.length} word breaks, expected ${bits.length}`);
  const silence = ms => Buffer.alloc(Math.round(ms * 8), 0xFF);   // mu-law zero
  const parts = [silence(PauseCodec.LEAD_MS)];
  let from = 0;
  cuts.forEach((c, i) => { parts.push(mu.subarray(from, c)); parts.push(silence(bits[i] ? PauseCodec.LONG_MS : PauseCodec.SHORT_MS)); from = c; });
  parts.push(mu.subarray(from), silence(PauseCodec.TAIL_MS));
  return Buffer.concat(parts);
}

// Generate the sentence as soon as the call is placed so it is ready by the
// time the greeting ends.
const proofCache = new Map();
function preparePausePhrase(session) {
  if (session.method !== "pauses" || proofCache.has(session.id)) return;
  proofCache.set(session.id, buildPausePhrase(session).catch(err => ({ error: err })));
  setTimeout(() => proofCache.delete(session.id), 10 * 60 * 1000);
}
async function getPausePhrase(session) {
  preparePausePhrase(session);
  const r = await proofCache.get(session.id);
  if (!r || r.error) throw (r && r.error) || new Error("no sentence");
  return r;
}

// Place the outbound call for a flagged session.
async function placeCall(session) {
  const e = env();
  const client = twilio(e.sid, e.token);
  const streamUrl = `wss://${e.publicHost}/media`;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${streamUrl}"><Parameter name="session" value="${session.id}"/></Stream></Connect></Response>`;
  preparePausePhrase(session);
  let diverted = false;
  if (session.divert) {
    if (divertAvailable()) diverted = true;
    else await trust.log(session, "divert_unavailable", { note: "no assistant number configured, calling the handset instead" });
  }
  session.divert = diverted;
  if (diverted && divertMode() === "internal") {
    // connect the bank's agent and the customer's AI inside this server
    session.call = { sid: "internal-" + session.id, placedAt: new Date().toISOString() };
    await trust.log(session, "call_placed", { to: "customer AI assistant (connected inside the server)", internal: true });
    require("./virtualcall").start(session);
    return session.call.sid;
  }
  const opts = {
    to: diverted ? e.assistantNumber : session.phone,
    from: e.from,
    twiml,
    statusCallback: `https://${e.publicHost}/twilio/status?session=${session.id}`,
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed"]
  };
  // Only the agent-to-agent call is recorded; a call to a real person is not.
  if (diverted) Object.assign(opts, {
    record: true,
    recordingStatusCallback: `https://${e.publicHost}/twilio/recording?session=${session.id}`,
    recordingStatusCallbackEvent: ["completed"]
  });
  if (diverted) pendingDiverts.push({ sessionId: session.id, at: Date.now() });
  const call = await client.calls.create(opts);
  session.call = { sid: call.sid, placedAt: new Date().toISOString() };
  await trust.log(session, "call_placed", diverted
    ? { to: "customer AI assistant " + maskPhone(e.assistantNumber), callSid: call.sid, recorded: true }
    : { to: maskPhone(session.phone), callSid: call.sid });
  return call.sid;
}

function maskPhone(p) { return p ? p.slice(0, 4) + "*****" + p.slice(-2) : ""; }

async function onStatus(sessionId, status) {
  const s = trust.getSession(sessionId);
  if (!s) return;
  if (status === "ringing") await trust.log(s, "call_ringing", {});
  if (status === "in-progress") { s.call.answeredAt = new Date().toISOString(); await trust.log(s, "call_answered", {}); }
  if (status === "completed" || status === "busy" || status === "no-answer" || status === "failed") {
    s.call.endedAt = new Date().toISOString();
    await trust.log(s, "call_ended", { status });
    if (s.status !== "closed") {
      s.status = "closed";
      const who = s.divert ? "customer AI assistant" : "handset";
      await trust.log(s, "session_closed", { outcome: s.bankVerified ? `bank verified by ${who}, re-enrolment allowed` : `bank not verified by ${who}, account remains frozen` });
    }
  }
}

async function onRecording(sessionId, body) {
  const s = trust.getSession(sessionId);
  if (!s || body.RecordingStatus !== "completed") return;
  s.recording = { sid: body.RecordingSid, durationS: Number(body.RecordingDuration) || null };
  await trust.log(s, "recording_ready", { durationS: s.recording.durationS });
}

// Fetch the recording with the server's Twilio credentials so the browser
// never needs them.
async function fetchRecording(session) {
  const e = env();
  if (!session.recording) return null;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${e.sid}/Recordings/${session.recording.sid}.mp3`;
  const res = await fetch(url, { headers: { authorization: "Basic " + Buffer.from(e.sid + ":" + e.token).toString("base64") }, signal: AbortSignal.timeout(20000) });
  return res.ok ? res : null;
}

// Handle one Twilio media stream connection.
function handleMediaStream(twilioWs) {
  let streamSid = null, session = null, el = null;
  let playhead = 0;                      // ms epoch when queued audio finishes playing
  let agentSpeaking = false, agentSilenceTimer = null;
  let turnSeq = 0, lastAudioAt = 0, proofUntil = 0;
  let toneSent = false, greetingHeard = false;
  let turns = 0;
  let tracker = null;

  const sendToTwilio = obj => { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.send(JSON.stringify(obj)); };

  function queueMulaw(buf, markName) {
    // send in 20 ms frames, keep a playhead so we know when it will finish
    for (let i = 0; i < buf.length; i += FRAME_BYTES) {
      sendToTwilio({ event: "media", streamSid, media: { payload: Buffer.from(buf.subarray(i, i + FRAME_BYTES)).toString("base64") } });
    }
    const durMs = (buf.length / 8000) * 1000;
    playhead = Math.max(playhead, Date.now()) + durMs;
    if (markName) sendToTwilio({ event: "mark", streamSid, mark: { name: markName } });
  }

  // After the greeting, play the proof: the tone (Patent 1) or the sentence
  // whose word gaps carry the session's pattern (Patent 2).
  async function injectTone() {
    if (toneSent || !session) return;
    toneSent = true;
    let mu = null;
    if (session.method === "pauses") {
      try { mu = await getPausePhrase(session); }
      catch (e) { await trust.log(session, "pause_sentence_failed", { message: String(e.message || e), fallback: "tones" }); }
    }
    const pauses = !!mu;
    if (!mu) mu = ToneCodec.encodeMulaw8k(session.code, 0.5, ToneCodec.DEFAULT_REPEATS);
    agentSpeaking = true; lastAudioAt = Date.now();
    queueMulaw(mu, "tone-done");
    proofUntil = playhead;
    if (pauses) await trust.log(session, "pause_sentence_sent", { words: PauseCodec.gapCount() + 1, gaps: PauseCodec.gapCount(), airtimeMs: Math.round(mu.length / 8), sentence: PauseCodec.PHRASE });
    else await trust.log(session, "tone_sent", { airtimeMs: Math.round(mu.length / 8), copies: ToneCodec.DEFAULT_REPEATS, band: "1.0-2.8 kHz" });
  }

  // ElevenLabs streams audio faster than real time, so "no more audio
  // arriving" is not "the agent has stopped talking". We send a mark after
  // the turn's audio; Twilio returns it once playback reaches it, and only
  // then is the turn over and the customer's reply clock started.
  function agentAudioArrived(b64) {
    const buf = Buffer.from(b64, "base64");
    queueMulaw(buf);
    agentSpeaking = true;
    lastAudioAt = Date.now();
    clearTimeout(agentSilenceTimer);
    agentSilenceTimer = setTimeout(() => {
      turns++;
      sendToTwilio({ event: "mark", streamSid, mark: { name: "turn-end-" + (++turnSeq) } });
      if (!toneSent && session) {
        // greeting finished: play the rendezvous tone right after it
        const wait = Math.max(0, playhead - Date.now()) + 150;
        setTimeout(injectTone, wait);
      }
    }, 400);
  }

  // On a real call: once the bank's goodbye has finished playing, hang up.
  function hangUpAfterPlayback() {
    const started = Date.now();
    const check = () => {
      const done = Date.now() - started > 1000 && playhead <= Date.now() && Date.now() - lastAudioAt > 800;
      if (!done && Date.now() - started < 20000) return setTimeout(check, 200);
      setTimeout(async () => {
        try {
          const e = env();
          if (session?.call?.sid && !String(session.call.sid).startsWith("internal-")) {
            await twilio(e.sid, e.token).calls(session.call.sid).update({ status: "completed" });
            await trust.log(session, "call_hung_up", { reason: "bank said goodbye" });
          }
        } catch (err) { await trust.log(session, "warning", { note: "hang-up failed: " + (err.message || err) }); }
      }, 700);
    };
    setTimeout(check, 200);
  }

  function playbackReachedMark(name) {
    // the mark can come back early (interruption clear, or a test harness);
    // wait out whatever is still queued, then end the turn if nothing new came
    const stamp = lastAudioAt;
    setTimeout(() => {
      if (lastAudioAt !== stamp || playhead > Date.now() + 40) return;
      agentSpeaking = false;
      tracker && tracker.agentTurnEnded(Date.now());
    }, Math.max(0, playhead - Date.now()));
  }

  async function openElevenLabs() {
    const url = await signedUrl();
    el = new WebSocket(url);
    el.on("open", () => {
      el.send(JSON.stringify({
        type: "conversation_initiation_client_data",
        dynamic_variables: { customer_name: session.name, session_id: session.id }
      }));
    });
    el.on("message", async raw => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      switch (msg.type) {
        case "conversation_initiation_metadata": {
          const m = msg.conversation_initiation_metadata_event || {};
          await trust.log(session, "agent_connected", { conversationId: m.conversation_id, audioOut: m.agent_output_audio_format, audioIn: m.user_input_audio_format });
          if (m.agent_output_audio_format && m.agent_output_audio_format !== "ulaw_8000") {
            await trust.log(session, "warning", { note: "agent output is not ulaw_8000; run configureAgent" });
          }
          break;
        }
        case "audio": agentAudioArrived(msg.audio_event.audio_base_64); break;
        case "agent_response": {
          const text = msg.agent_response_event?.agent_response || "";
          // treat each agent question as a request for a specific item, checked
          // against what the fraud desk is authorised to ask for
          const item = classifyRequest(text);
          await trust.log(session, "agent_turn", { text, request: item.name, authorised: item.authorised });
          if (/\b(good ?-?bye|bye now|bye-bye)\b/i.test(text.slice(-40))) {
            if (twilioWs.isVirtual) twilioWs.emit("said_goodbye", "bank");
            else hangUpAfterPlayback();
          }
          break;
        }
        case "user_transcript":
          // in divert mode the customer agent logs its own words, so skip the echo
          if (!session.divert) await trust.log(session, "customer_said", { text: msg.user_transcription_event?.user_transcript || "" });
          break;
        case "interruption":
          // never cut the proof short: the listener needs all of it
          if (Date.now() < proofUntil) break;
          sendToTwilio({ event: "clear", streamSid }); playhead = Date.now(); break;
        case "ping": el.send(JSON.stringify({ type: "pong", event_id: msg.ping_event.event_id })); break;
        default: break;
      }
    });
    el.on("close", () => { twilioWs.emit("agent_closed"); });   // agent hung up or finished
    el.on("error", async err => { if (session) await trust.log(session, "agent_error", { message: String(err.message || err) }); });
  }

  twilioWs.on("message", async raw => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    switch (msg.event) {
      case "start": {
        streamSid = msg.start.streamSid;
        const sid = msg.start.customParameters?.session;
        session = trust.getSession(sid);
        if (!session) { twilioWs.close(); return; }
        tracker = createTurnTracker(async turn => {
          session.turns.push(turn);
          await trust.log(session, "customer_turn_measured", turn);
        });
        await trust.log(session, "media_stream_started", { streamSid });
        try { await openElevenLabs(); } catch (e) { await trust.log(session, "agent_error", { message: String(e.message || e) }); }
        break;
      }
      case "media": {
        const b64 = msg.media.payload;
        if (el && el.readyState === WebSocket.OPEN) el.send(JSON.stringify({ user_audio_chunk: b64 }));
        if (tracker && !agentSpeaking) tracker.customerFrame(Buffer.from(b64, "base64"), Date.now());
        break;
      }
      case "mark": {
        const name = msg.mark?.name || "";
        if (name === "tone-done" && session) { await trust.log(session, "tone_played", {}); playbackReachedMark(name); }
        if (name.startsWith("turn-end-")) playbackReachedMark(name);
        break;
      }
      case "stop":
        if (el) try { el.close(); } catch {}
        break;
      default: break;
    }
  });
  twilioWs.on("close", () => { if (el) try { el.close(); } catch {} });
}

// Which item is the agent asking for, and is the fraud desk allowed to?
function classifyRequest(text) {
  const t = text.toLowerCase();
  const rules = [
    { name: "identity confirmation (was it you)", test: /log ?in|logged in|was that you|you who/, authorised: true },
    { name: "biometric or device change", test: /fingerprint|face|new phone|biometric|device/, authorised: true },
    { name: "PIN or password", test: /\bpin\b|password|passcode/, authorised: false },
    { name: "card number", test: /card number|cvv|expiry/, authorised: false },
    { name: "one-time code", test: /one[- ]time|otp|code/, authorised: false }
  ];
  for (const r of rules) if (r.test.test(t)) return { name: r.name, authorised: r.authorised };
  return { name: "conversation", authorised: true };
}

module.exports = {
  configured, divertAvailable, divertMode, configureAgent, bankVoiceId, assemblePausePhrase, buildPausePhrase, configureAssistantNumber, claimPendingDivert,
  placeCall, onStatus, onRecording, fetchRecording, handleMediaStream, classifyRequest, signedUrlFor, maskPhone
};
