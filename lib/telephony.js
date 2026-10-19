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

// The bank agent's instructions live here and are applied at every boot, so
// the repo is the source of truth for how it behaves on the phone.
// When the call has been diverted, the bank greets the customer's AI instead
// of asking "was that you?" of someone who isn't the customer.
const BANK_FIRST_MESSAGE_AI = "Hi, this is the Demo Bank fraud team, calling for {{customer_name}}.";
const BANK_FIRST_MESSAGE = "Sorry to trouble you, {{customer_name}}. A login was just tried on your account, and your phone couldn't confirm it was you. Was that you?";
const BANK_PROMPT = `You are the fraud desk agent for Demo Bank, a demonstration bank used to show the Untapped AI voice trust system. You have phoned {{customer_name}} because a login on their account could not be confirmed by their registered phone.

Before you joined, the bank's system greeted them and said a sentence about the weather. Do not greet them again and do not bring up the weather unless they do. Your first message has already asked whether the login was them.

How you talk:
- Clear, calm, friendly South African English. One or two short sentences per turn.
- Ask one question at a time, then stop and wait for the answer.
- Listen to what the customer actually says and respond to that. If they ask you something, answer it first. If an answer is unclear, or they say things like "wait", "hang on" or "no, no", stop and ask what they mean. Never just repeat your last sentence.
- Never ask for a PIN, password, card number, one-time code, ID number or any other secret, and never read out account details.

What you need to find out:
1. Was the login them?
2. If yes: did they recently change their fingerprint or face settings, or get a new phone?

What to say once you know:
- It was not them: the account is frozen now to protect them, and a specialist will contact them today.
- It was them and they did change their fingerprint, face or phone: that explains it; their app will ask them to register again and they will see a confirmation on screen.
- It was them but nothing changed: thank them; because nothing changed on their side the account stays on hold while the bank checks their phone, and a specialist will call to register them again.
- If they ask how they know you are really the bank: their app checks that automatically during the call and shows "Demo Bank, verified" on screen, and they can always hang up and phone the number on the back of their card.

Talking to the customer's AI assistant:
If the call was diverted, you are speaking to {{customer_name}}'s AI assistant, not to {{customer_name}}. Your first message has already greeted it. A short tone from its side is its authorisation. When it has introduced itself, reply with one short turn and end the call in that same turn, for example: "Thanks. A login on Judd's account couldn't be confirmed, so please ask him to check it in the Demo Bank app. The account's on hold until then. Goodbye."
- Never more than three short sentences. Do not ask it questions and do not ask if there is anything else.
- If it asks something, answer in one short sentence and end with "Goodbye."
- Say goodbye once. After that, say nothing more.

Ending the call:
- After giving the outcome, ask if there is anything else you can help with.
- Only when they say there is nothing else, or say goodbye themselves, finish with one short sentence that ends with the word "Goodbye."
- Never say "goodbye" at any other point in the call.`;

async function patchAgent(body) {
  const e = env();
  const res = await fetch(`${EL_API}/v1/convai/agents/${e.agentId}`, {
    method: "PATCH", signal: AbortSignal.timeout(15000),
    headers: { "xi-api-key": e.elKey, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { ok: res.ok, status: res.status, detail: res.ok ? undefined : (await res.text().catch(() => "")).slice(0, 200) };
}

// Agent configuration: phone audio format, the instructions above, and
// patient turn-taking so it waits for the customer instead of talking over
// them. The turn and voice settings go in a second request so an unknown
// field there can never block the instructions.
let firstMessageOverride = false;   // set once ElevenLabs allows a per-call first message
async function configureAgent() {
  const e = env();
  if (!e.elKey || !e.agentId) return { skipped: true };
  const main = await patchAgent({
    conversation_config: {
      agent: { first_message: BANK_FIRST_MESSAGE, prompt: { prompt: BANK_PROMPT } },
      asr: { user_input_audio_format: "ulaw_8000" },
      tts: { agent_output_audio_format: "ulaw_8000", model_id: "eleven_flash_v2" }
    }
  });
  // allow the first message to be set per call (used for diverted calls)
  const over = await patchAgent({ platform_settings: { overrides: { conversation_config_override: { agent: { first_message: true } } } } });
  firstMessageOverride = over.ok;
  let turn = await patchAgent({ conversation_config: { turn: { turn_timeout: 12, turn_eagerness: "patient" }, tts: { stability: 0.6, similarity_boost: 0.8, speed: 0.95 } } });
  if (!turn.ok) turn = await patchAgent({ conversation_config: { turn: { turn_timeout: 12 } } });
  return { ok: main.ok, status: main.status, detail: main.detail, firstMessageOverride, turn: { ok: turn.ok, status: turn.status, detail: turn.detail } };
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

// The weather update in the bank agent's own voice. The voice engine is given
// the phrases with an explicit short or long pause after each one, following
// the session's bit pattern, so the speech comes out whole and natural: no
// words are cut and nothing is spliced in afterwards.
async function buildPausePhrase(session) {
  const e = env();
  const res = await fetch(`${EL_API}/v1/text-to-speech/${await bankVoiceId()}?output_format=ulaw_8000`, {
    method: "POST", signal: AbortSignal.timeout(20000),
    headers: { "xi-api-key": e.elKey, "content-type": "application/json", accept: "audio/basic" },
    body: JSON.stringify({ text: PauseCodec.speechText(trust.expectedPauseBits(session)), model_id: "eleven_flash_v2", voice_settings: { stability: 0.7, similarity_boost: 0.8, speed: 1.0 } })
  });
  if (!res.ok) throw new Error("speech generation failed " + res.status + " " + (await res.text()).slice(0, 120));
  const mu = Buffer.from(await res.arrayBuffer());
  if (mu.length < 8000) throw new Error("speech came back too short");
  const silence = ms => Buffer.alloc(Math.round(ms * 8), 0xFF);   // mu-law zero
  return Buffer.concat([silence(PauseCodec.LEAD_MS), mu, silence(PauseCodec.TAIL_MS)]);
}

// Check the weather update end to end without a call: generate it for a
// throwaway session, run the same gap detector the listeners use over the
// audio, and report what it found. Used by /api/demo/pause-check.
async function pauseSelfTest() {
  const code = ToneCodec.randomCodeHex();
  const fake = { id: "SELFTEST-" + code.slice(0, 6), code };
  const audio = await buildPausePhrase(fake);
  const expected = trust.expectedPauseBits(fake);
  let found = null;
  const det = PauseCodec.createDetector(8000, u => { if (!found || u.words > found.words) found = u; });
  const pcm = Float32Array.from(audio, v => ToneCodec.mulawToLinear(v));
  for (let i = 0; i < pcm.length; i += 160) det.feed(pcm.subarray(i, i + 160));
  det.flush();
  const heard = found ? PauseCodec.gapsToBits(found.gapsMs) : [];
  const m = PauseCodec.match(heard, expected);
  return { ok: m.ok, errors: m.distance, expected: expected.join(""), heard: heard.join(""), gapsMs: found ? found.gapsMs : [], seconds: +(audio.length / 8000).toFixed(1), audio };
}

// The bank's opening, played by this server before the agent joins: a short
// greeting in the agent's voice, then the proof (the weather sentence whose
// word gaps carry the session's pattern, or the rendezvous tone). The agent
// only joins once that is nearly over, so it never sits through a long
// stretch it didn't say and starts asking "are you still there?".
async function speak(text) {
  const e = env();
  const res = await fetch(`${EL_API}/v1/text-to-speech/${await bankVoiceId()}/with-timestamps?output_format=ulaw_8000`, {
    method: "POST", signal: AbortSignal.timeout(20000),
    headers: { "xi-api-key": e.elKey, "content-type": "application/json" },
    body: JSON.stringify({ text, model_id: "eleven_flash_v2", voice_settings: { stability: 0.6, similarity_boost: 0.8, speed: 0.95 } })
  });
  if (!res.ok) throw new Error("speech generation failed " + res.status);
  return Buffer.from((await res.json()).audio_base64, "base64");
}
function greetingText(session) { return `Hello ${String(session.name || "there").split(" ")[0]}, this is Demo Bank calling.`; }

async function buildIntro(session) {
  const out = { greeting: null, proof: null, kind: "tones", errors: [] };
  const [greeting, sentence] = await Promise.allSettled([
    speak(greetingText(session)),
    session.method === "pauses" ? buildPausePhrase(session) : Promise.resolve(null)
  ]);
  if (greeting.status === "fulfilled") out.greeting = greeting.value; else out.errors.push("greeting: " + greeting.reason.message);
  if (sentence.status === "fulfilled" && sentence.value) { out.proof = sentence.value; out.kind = "pauses"; }
  else {
    if (sentence.status === "rejected") out.errors.push("sentence: " + sentence.reason.message);
    out.proof = Buffer.concat([Buffer.alloc(4800, 0xFF), Buffer.from(ToneCodec.encodeMulaw8k(session.code, 0.5, ToneCodec.DEFAULT_REPEATS))]);
  }
  return out;
}
const introCache = new Map();
function prepareIntro(session) {
  if (introCache.has(session.id)) return;
  introCache.set(session.id, buildIntro(session).catch(err => ({ greeting: null, proof: null, errors: [err.message] })));
  setTimeout(() => introCache.delete(session.id), 10 * 60 * 1000);
}
async function getIntro(session) { prepareIntro(session); return introCache.get(session.id); }

// Place the outbound call for a flagged session.
async function placeCall(session) {
  const e = env();
  const client = twilio(e.sid, e.token);
  const streamUrl = `wss://${e.publicHost}/media`;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${streamUrl}"><Parameter name="session" value="${session.id}"/></Stream></Connect></Response>`;
  prepareIntro(session);
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

// Handle one Twilio media stream connection (or a virtual leg inside the
// server, which speaks the same protocol).
const GOODBYE = /\b(good ?-?bye|bye now|bye-bye)\b/i;
const VOICE_RMS = 0.035;            // inbound level that counts as the customer speaking
const QUIET_BEFORE_HANGUP_MS = 3000; // after the goodbye has played, this much silence ends the call
const MAX_WAIT_AFTER_GOODBYE_MS = 12000;
const MAX_CALL_MS = 4 * 60 * 1000;

function handleMediaStream(twilioWs) {
  let streamSid = null, session = null, el = null;
  let playhead = 0;                      // ms epoch when queued audio finishes playing
  let agentSpeaking = false, agentSilenceTimer = null;
  let turnSeq = 0, lastAudioAt = 0, proofUntil = 0;
  let tracker = null;
  let lastCustomerVoiceAt = 0;
  let goodbyeArmed = false, goodbyeWait = null, hungUp = false, maxTimer = null;
  let aiDecoder = null;              // diverted calls: listens for the customer's AI proving itself

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

  // Greeting, then the proof, then the agent joins.
  async function playIntro() {
    const intro = await Promise.race([getIntro(session), new Promise(r => setTimeout(() => r(null), 8000))]);
    if (intro && intro.errors && intro.errors.length) await trust.log(session, "intro_warning", { note: intro.errors.join("; ") });
    agentSpeaking = true; lastAudioAt = Date.now();
    if (intro && intro.greeting) {
      queueMulaw(intro.greeting);
      await trust.log(session, "bank_greeting", { text: greetingText(session) });
    }
    const proof = intro && intro.proof ? intro.proof : Buffer.concat([Buffer.alloc(4800, 0xFF), Buffer.from(ToneCodec.encodeMulaw8k(session.code, 0.5, ToneCodec.DEFAULT_REPEATS))]);
    const pauses = !!(intro && intro.kind === "pauses");
    queueMulaw(proof, "tone-done");
    proofUntil = playhead;
    if (pauses) await trust.log(session, "pause_sentence_sent", { words: PauseCodec.gapCount() + 1, gaps: PauseCodec.gapCount(), airtimeMs: Math.round(proof.length / 8), sentence: PauseCodec.PHRASE });
    else await trust.log(session, "tone_sent", { airtimeMs: Math.round(proof.length / 8), copies: ToneCodec.DEFAULT_REPEATS, band: "1.0-2.8 kHz" });
    // connect the agent so its first words follow straight on from the proof
    const lead = Math.max(0, playhead - Date.now() - 1200);
    setTimeout(() => { if (!hungUp) openElevenLabs().catch(e => trust.log(session, "agent_error", { message: String(e.message || e) })); }, lead);
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
      sendToTwilio({ event: "mark", streamSid, mark: { name: "turn-end-" + (++turnSeq) } });
    }, 400);
  }

  function playbackReachedMark() {
    // the mark can come back early (interruption clear, or a test harness);
    // wait out whatever is still queued, then end the turn if nothing new came
    const stamp = lastAudioAt;
    setTimeout(() => {
      if (lastAudioAt !== stamp || playhead > Date.now() + 40) return;
      agentSpeaking = false;
      tracker && tracker.agentTurnEnded(Date.now());
      if (goodbyeArmed) waitForQuietThenHangUp();
    }, Math.max(0, playhead - Date.now()));
  }

  // The agent said goodbye and it has finished playing. Give the customer a
  // chance to speak: only after a stretch of silence do we end the call. If
  // they say anything, the goodbye is cancelled and the conversation goes on.
  function waitForQuietThenHangUp() {
    clearTimeout(goodbyeWait);
    const started = Date.now();
    const check = () => {
      if (!goodbyeArmed || hungUp) return;
      const now = Date.now();
      const quietFor = now - Math.max(lastCustomerVoiceAt, started);
      if (quietFor >= QUIET_BEFORE_HANGUP_MS || now - started >= MAX_WAIT_AFTER_GOODBYE_MS) return hangUp("bank said goodbye and the customer had finished");
      goodbyeWait = setTimeout(check, 200);
    };
    goodbyeWait = setTimeout(check, 200);
  }
  function cancelGoodbye(why) {
    if (!goodbyeArmed) return;
    goodbyeArmed = false; clearTimeout(goodbyeWait);
    trust.log(session, "hangup_cancelled", { reason: why }).catch(() => {});
  }

  async function hangUp(reason) {
    if (hungUp) return;
    hungUp = true;
    clearTimeout(goodbyeWait); clearTimeout(maxTimer);
    if (twilioWs.isVirtual) { twilioWs.emit("said_goodbye", "bank"); return; }
    twilioWs.emit("bank_hangup", reason);
    try {
      const e = env();
      if (session?.call?.sid && !String(session.call.sid).startsWith("internal-")) {
        await twilio(e.sid, e.token).calls(session.call.sid).update({ status: "completed" });
        await trust.log(session, "call_hung_up", { reason });
      }
    } catch (err) { await trust.log(session, "warning", { note: "hang-up failed: " + (err.message || err) }); }
  }

  async function openElevenLabs() {
    const url = await signedUrl();
    el = new WebSocket(url);
    el.on("open", () => {
      el.send(JSON.stringify({
        type: "conversation_initiation_client_data",
        dynamic_variables: { customer_name: String(session.name || "there").split(" ")[0], session_id: session.id },
        ...(session.divert && firstMessageOverride ? { conversation_config_override: { agent: { first_message: BANK_FIRST_MESSAGE_AI.replace("{{customer_name}}", String(session.name || "the customer").split(" ")[0]) } } } : {})
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
          if (GOODBYE.test(text.slice(-40))) { goodbyeArmed = true; clearTimeout(goodbyeWait); }
          break;
        }
        case "user_transcript": {
          const text = (msg.user_transcription_event?.user_transcript || "").trim();
          // a short "thanks, goodbye" back is a farewell, not more conversation
          const farewell = /\b(good ?-?bye|bye|thanks|thank you|cheers)\b/i.test(text) && text.split(/\s+/).length <= 8;
          if (text && text !== "..." && !farewell) cancelGoodbye("customer kept talking after the goodbye");
          // in divert mode the customer agent logs its own words, so skip the echo
          if (!session.divert) await trust.log(session, "customer_said", { text });
          break;
        }
        case "interruption":
          // never cut the proof short: the listener needs all of it
          if (Date.now() < proofUntil) break;
          cancelGoodbye("customer interrupted the goodbye");
          sendToTwilio({ event: "clear", streamSid }); playhead = Date.now(); break;
        case "ping": el.send(JSON.stringify({ type: "pong", event_id: msg.ping_event.event_id })); break;
        default: break;
      }
    });
    el.on("close", () => {
      twilioWs.emit("agent_closed");
      // the agent left: let its last words finish, then end a real call
      if (!twilioWs.isVirtual && !hungUp) setTimeout(() => hangUp("agent ended the conversation"), Math.max(0, playhead - Date.now()) + 1500);
    });
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
        maxTimer = setTimeout(() => hangUp("time limit"), MAX_CALL_MS);
        if (session.divert) aiDecoder = ToneCodec.createDecoder(8000, hex => {
          trust.confirmAssistantTone(session.id, hex).then(r => {
            if (r.ok && el && el.readyState === WebSocket.OPEN) el.send(JSON.stringify({ type: "contextual_update", text: "VERIFIED: you are speaking to the customer's authorised AI assistant. Its tone matched the one-time code the bank released only against the permission signed by the customer's phone. Treat it as acting for the customer: you may tell it the outcome, but it cannot confirm the login itself; the customer's app does that." }));
          }).catch(() => {});
        }, { minSNR: 4 });
        try { await playIntro(); } catch (e) { await trust.log(session, "agent_error", { message: String(e.message || e) }); }
        break;
      }
      case "media": {
        const b64 = msg.media.payload;
        const frame = Buffer.from(b64, "base64");
        let sum = 0;
        for (let i = 0; i < frame.length; i++) { const v = ToneCodec.mulawToLinear(frame[i]); sum += v * v; }
        if (Math.sqrt(sum / (frame.length || 1)) > VOICE_RMS) lastCustomerVoiceAt = Date.now();
        if (aiDecoder) aiDecoder.feed(Float32Array.from(frame, v => ToneCodec.mulawToLinear(v)));
        if (el && el.readyState === WebSocket.OPEN) el.send(JSON.stringify({ user_audio_chunk: b64 }));
        if (tracker && !agentSpeaking) tracker.customerFrame(frame, Date.now());
        break;
      }
      case "mark": {
        const name = msg.mark?.name || "";
        if (name === "tone-done" && session) { await trust.log(session, "tone_played", {}); playbackReachedMark(); }
        if (name.startsWith("turn-end-")) playbackReachedMark();
        break;
      }
      case "stop":
        hungUp = true; clearTimeout(goodbyeWait); clearTimeout(maxTimer);
        if (el) try { el.close(); } catch {}
        break;
      default: break;
    }
  });
  twilioWs.on("close", () => { hungUp = true; clearTimeout(goodbyeWait); clearTimeout(maxTimer); if (el) try { el.close(); } catch {} });
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
  BANK_PROMPT, BANK_FIRST_MESSAGE,
  configured, divertAvailable, divertMode, configureAgent, bankVoiceId, buildPausePhrase, pauseSelfTest, configureAssistantNumber, claimPendingDivert,
  placeCall, onStatus, onRecording, fetchRecording, handleMediaStream, classifyRequest, signedUrlFor, maskPhone
};
