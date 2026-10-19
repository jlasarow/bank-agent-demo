// Telephony bridge: Twilio outbound call -> Media Stream -> this server ->
// ElevenLabs Conversational AI agent, with the rendezvous tone injected into
// the call after the agent's greeting and Patent 2 timing captured on the
// customer's replies.

const WebSocket = require("ws");
const twilio = require("twilio");
const ToneCodec = require("./tonecodec");
const trust = require("./trust");
const { createTurnTracker } = require("./analysis");

const EL_API = "https://api.elevenlabs.io";
const FRAME_BYTES = 160;   // 20 ms of 8 kHz mu-law
const env = () => ({
  sid: process.env.TWILIO_ACCOUNT_SID,
  token: process.env.TWILIO_AUTH_TOKEN,
  from: process.env.TWILIO_FROM_NUMBER,
  elKey: process.env.ELEVENLABS_API_KEY,
  agentId: process.env.ELEVENLABS_AGENT_ID,
  publicHost: process.env.PUBLIC_HOST || process.env.RENDER_EXTERNAL_HOSTNAME   // Render sets the latter automatically
});

function configured() {
  const e = env();
  return !!(e.sid && e.token && e.from && e.agentId && e.publicHost);
}

// One-time agent configuration so audio matches Twilio's mu-law 8 kHz.
async function configureAgent() {
  const e = env();
  if (!e.elKey || !e.agentId) return { skipped: true };
  const res = await fetch(`${EL_API}/v1/convai/agents/${e.agentId}`, {
    method: "PATCH",
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

async function signedUrl() {
  const e = env();
  if (!e.elKey) return `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${e.agentId}`; // public agent
  const res = await fetch(`${EL_API}/v1/convai/conversation/get-signed-url?agent_id=${e.agentId}`, { headers: { "xi-api-key": e.elKey } });
  if (!res.ok) throw new Error("signed url failed " + res.status);
  return (await res.json()).signed_url;
}

// Place the outbound call for a flagged session.
async function placeCall(session) {
  const e = env();
  const client = twilio(e.sid, e.token);
  const streamUrl = `wss://${e.publicHost}/media`;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${streamUrl}"><Parameter name="session" value="${session.id}"/></Stream></Connect></Response>`;
  const call = await client.calls.create({
    to: session.phone,
    from: e.from,
    twiml,
    statusCallback: `https://${e.publicHost}/twilio/status?session=${session.id}`,
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed"]
  });
  session.call = { sid: call.sid, placedAt: new Date().toISOString() };
  await trust.log(session, "call_placed", { to: maskPhone(session.phone), callSid: call.sid });
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
      await trust.log(s, "session_closed", { outcome: s.bankVerified ? "bank verified to customer, re-enrolment allowed" : "bank not verified by handset, account remains frozen" });
    }
  }
}

// Handle one Twilio media stream connection.
function handleMediaStream(twilioWs) {
  let streamSid = null, session = null, el = null;
  let playhead = 0;                      // ms epoch when queued audio finishes playing
  let agentSpeaking = false, agentSilenceTimer = null;
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

  async function injectTone() {
    if (toneSent || !session) return;
    toneSent = true;
    const mu = ToneCodec.encodeMulaw8k(session.code, 0.5);
    queueMulaw(mu, "tone-done");
    await trust.log(session, "tone_sent", { airtimeMs: Math.round(ToneCodec.airtimeSeconds * 1000), band: "1.0-2.8 kHz" });
  }

  function agentAudioArrived(b64) {
    const buf = Buffer.from(b64, "base64");
    queueMulaw(buf);
    agentSpeaking = true;
    clearTimeout(agentSilenceTimer);
    // when no more audio arrives for a moment the agent's turn is over
    agentSilenceTimer = setTimeout(async () => {
      agentSpeaking = false;
      turns++;
      tracker && tracker.agentTurnEnded(playhead);
      if (!toneSent && session) {
        // greeting finished: play the rendezvous tone right after it
        const wait = Math.max(0, playhead - Date.now()) + 150;
        setTimeout(injectTone, wait);
      }
    }, 600);
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
          break;
        }
        case "user_transcript":
          await trust.log(session, "customer_said", { text: msg.user_transcription_event?.user_transcript || "" });
          break;
        case "interruption": sendToTwilio({ event: "clear", streamSid }); playhead = Date.now(); break;
        case "ping": el.send(JSON.stringify({ type: "pong", event_id: msg.ping_event.event_id })); break;
        default: break;
      }
    });
    el.on("close", () => { /* agent hung up or finished */ });
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
      case "mark":
        if (msg.mark?.name === "tone-done" && session) await trust.log(session, "tone_played", {});
        break;
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

module.exports = { configured, configureAgent, placeCall, onStatus, handleMediaStream, classifyRequest };
