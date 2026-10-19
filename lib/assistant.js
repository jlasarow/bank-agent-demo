// Customer-side AI assistant (the "Divert to my AI" flow).
//
// When divert is on, the bank's agent dials a second Twilio number instead of
// the customer's handset. That number is answered here by a second
// ElevenLabs agent speaking for the customer. Its job is narrow:
//
//   1. listen to the bank's audio for the proof: the rendezvous tone
//      (Patent 1) or the gaps between the words of the bank's sentence
//      (Patent 2), measured straight from the call audio,
//   2. report the code over the authenticated data link,
//   3. verify the bank's signature against the pinned bank key,
//   4. treat the caller as Demo Bank only after that, and never hand over
//      secrets either way.
//
// The bank leg of the same call still runs its own Patent 2 measurements, so
// the log also shows what the liveness layer sees when the "customer" is a
// machine.

const WebSocket = require("ws");
const ToneCodec = require("./tonecodec");
const PauseCodec = require("./pausecodec");
const trust = require("./trust");
const tel = require("./telephony");

const EL_API = "https://api.elevenlabs.io";
const ASSISTANT_NAME = "Untapped AI - Customer Assistant";
const VERIFY_DEADLINE_MS = 45000;   // no valid proof by then: caller is not verified

let assistantAgentId = process.env.ELEVENLABS_ASSISTANT_AGENT_ID || null;
let pinnedBankJwk = null;           // pinned at boot, like the handset pins at enrolment

const PROMPT = `You are {{customer_name}}'s personal AI assistant, answering a call that was diverted to you. You are an AI and say so plainly. Sound like a friendly, competent personal assistant on the phone: natural, warm, brief.

You only join the call once {{customer_name}}'s phone has checked the caller. You will get a system update first:
- "CALLER VERIFIED": the caller is really Demo Bank. Your own authorisation tone has also just been played so the bank can confirm you act for {{customer_name}}.
- "CALLER NOT VERIFIED": the caller could not prove it is the bank.

When the caller is verified:
- Start by saying who you are in one sentence, for example: "Hi, this is Judd's AI assistant. I've confirmed it's Demo Bank, and I've sent my own authorisation so you know I'm acting for Judd."
- Listen to what the bank says and answer it directly. If the bank asks whether the login was {{customer_name}}, say you can't confirm that yourself, but {{customer_name}} will confirm it in the banking app, which is the signed answer the bank relies on.
- If the bank tells you something or asks {{customer_name}} to do something, repeat it back briefly and say you will pass it on to {{customer_name}} straight away.
- Ask one useful question if something is unclear, for example how urgent it is.
- Do not repeat the same sentence twice in a call. Each reply moves the conversation on.

When the caller is not verified: say politely that you can't continue, that {{customer_name}} will call the bank on the number on the back of the card, and say goodbye.

Always:
- Never give out a PIN, password, one-time code, card number, CVV, ID number or account number, and never agree to move money, add a beneficiary or install anything.
- One or two short sentences per turn, then stop and let the bank speak.
- The bank ends the call. Only say goodbye after the bank has said goodbye, and then just a short "Thanks, goodbye."`;

// A voice that is clearly not the bank's, so a listener can tell the two
// parties apart. ElevenLabs premade voices; the first one that differs from
// the bank agent's voice is used, unless ELEVENLABS_ASSISTANT_VOICE_ID is set.
const VOICE_CANDIDATES = ["pNInz6obpgDQGcFmaJgB", "TxGEqnHWrfWFTfGW9XjX", "ErXwobaYiN019PkySvjV", "21m00Tcm4TlvDq8ikWAM"];
let assistantVoice = null;

// the phrase that ends a call
const GOODBYE = /\b(good ?-?bye|bye now|bye-bye)\b/i;

function agentConfig() {
  const tts = { agent_output_audio_format: "ulaw_8000", model_id: "eleven_flash_v2" };
  if (assistantVoice) tts.voice_id = assistantVoice;
  return {
    agent: { first_message: "", language: "en", prompt: { prompt: PROMPT } },
    asr: { user_input_audio_format: "ulaw_8000" },
    tts
  };
}

// Find the assistant agent by name, or create it, using the existing API key.
// Its prompt is patched on every boot so this file stays the source of truth.
async function ensureAssistantAgent() {
  pinnedBankJwk = trust.bankPublicJwk();
  const bankVoice = await tel.bankVoiceId().catch(() => null);
  assistantVoice = process.env.ELEVENLABS_ASSISTANT_VOICE_ID || VOICE_CANDIDATES.find(v => v !== bankVoice);
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return { skipped: true, reason: "no ELEVENLABS_API_KEY" };
  const headers = { "xi-api-key": key, "content-type": "application/json" };
  const signal = () => AbortSignal.timeout(15000);

  if (!assistantAgentId) {
    const r = await fetch(`${EL_API}/v1/convai/agents?search=${encodeURIComponent(ASSISTANT_NAME)}&page_size=30`, { headers, signal: signal() });
    if (r.ok) {
      const hit = ((await r.json()).agents || []).find(a => a.name === ASSISTANT_NAME);
      if (hit) assistantAgentId = hit.agent_id;
    }
  }
  if (assistantAgentId) {
    const r = await fetch(`${EL_API}/v1/convai/agents/${assistantAgentId}`, {
      method: "PATCH", headers, signal: signal(),
      body: JSON.stringify({ name: ASSISTANT_NAME, conversation_config: agentConfig() })
    });
    const t = await fetch(`${EL_API}/v1/convai/agents/${assistantAgentId}`, {
      method: "PATCH", headers, signal: signal(),
      body: JSON.stringify({ conversation_config: { turn: { turn_timeout: 15 }, tts: { stability: 0.6, similarity_boost: 0.8, speed: 1.0 } } })
    }).catch(() => null);
    return { ok: r.ok, status: r.status, agentId: assistantAgentId, action: "updated", voice: assistantVoice, bankVoice, turn: t && t.status };
  }
  const r = await fetch(`${EL_API}/v1/convai/agents/create`, {
    method: "POST", headers, signal: signal(),
    body: JSON.stringify({ name: ASSISTANT_NAME, conversation_config: agentConfig() })
  });
  if (!r.ok) return { ok: false, status: r.status, body: (await r.text()).slice(0, 300) };
  assistantAgentId = (await r.json()).agent_id;
  return { ok: true, agentId: assistantAgentId, action: "created", voice: assistantVoice, bankVoice };
}

function assistantReady() { return !!assistantAgentId; }

// TwiML for the assistant number's inbound webhook.
function inboundTwiml(sessionId, publicHost) {
  if (!sessionId) return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>This assistant only takes calls linked to a pending bank session. Goodbye.</Say><Hangup/></Response>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://${publicHost}/assistant-media"><Parameter name="session" value="${sessionId}"/></Stream></Connect></Response>`;
}

// One diverted call: Twilio media stream <-> assistant agent, plus the tone
// decoder running on the raw inbound audio (which is the bank's voice).
function handleAssistantStream(twilioWs) {
  let streamSid = null, session = null, el = null;
  let decoder = null, pauses = null, verdict = null, deadline = null, pendingUpdate = null;
  let lastAgentAudioAt = 0, toneUntil = 0, toneMismatches = 0, agentOpening = false;

  const sendToTwilio = obj => { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.send(JSON.stringify(obj)); };
  const tellAgent = text => {
    if (el && el.readyState === WebSocket.OPEN) el.send(JSON.stringify({ type: "contextual_update", text }));
    else pendingUpdate = text;
  };

  async function settle(ok, detail) {
    if (verdict !== null) return;
    verdict = ok;
    clearTimeout(deadline);
    if (ok) {
      await trust.log(session, "customer_agent_verified_bank", detail);
      await proveSelfToBank();
      startAgent();
      tellAgent(`CALLER VERIFIED. The caller is Demo Bank: the bank's proof matched this session and its signature verified against the pinned Demo Bank key. You have also just played your own authorisation tone so the bank can confirm you act for ${session.name}; mention that once, briefly.`);
    } else {
      await trust.log(session, "customer_agent_rejected_caller", detail);
      startAgent();
      tellAgent("CALLER NOT VERIFIED. Do not continue the conversation beyond the goodbye described in your instructions.");
    }
  }

  // The other direction: prove to the bank that this AI is the one the
  // customer authorised. The bank releases this call's assistant code only
  // against the permission the customer's phone signed; play it as a tone
  // in a gap in our own speech.
  // The AI stays silent while the bank gives its proof (greeting, weather
  // update or tone) and only joins the conversation once it has a verdict.
  // That keeps it from talking over the proof, and its own tone is queued
  // before it says anything, so nothing it says can cut the tone short.
  function startAgent() {
    if (agentOpening || !assistantReady()) return;
    agentOpening = true;
    openAgent().catch(e => trust.log(session, "agent_error", { side: "customer", message: String(e.message || e) }));
  }

  async function proveSelfToBank() {
    const code = await trust.issueAssistantCode(session.id);
    if (!code) return;
    const until = Date.now() + 3000;
    while (Date.now() < until && Date.now() - lastAgentAudioAt < 400) await new Promise(r => setTimeout(r, 100));
    const tone = Buffer.concat([Buffer.alloc(2400, 0xFF), Buffer.from(ToneCodec.encodeMulaw8k(code, 0.5, ToneCodec.DEFAULT_REPEATS)), Buffer.alloc(2400, 0xFF)]);
    for (let i = 0; i < tone.length; i += 160) sendToTwilio({ event: "media", streamSid, media: { payload: tone.subarray(i, i + 160).toString("base64") } });
    toneUntil = Date.now() + tone.length / 8 + 500;
    await trust.log(session, "customer_agent_sent_tone", { airtimeMs: Math.round(tone.length / 8), note: "the customer's AI plays its one-time code so the bank can confirm who it acts for" });
  }

  async function onCode(hex) {
    if (verdict !== null || !session) return;
    await trust.log(session, "tone_heard_by_customer_agent", { codeHint: hex.slice(0, 4) + "..." });
    const r = await trust.confirmHeardCode(session.id, hex, "customer AI assistant");
    // A misread tone gets one more chance: the bank sends two copies, so if
    // the right code has not arrived within 4 s the caller is rejected.
    if (!r.ok) {
      if (++toneMismatches === 1) setTimeout(() => settle(false, { reason: "tone did not match the session the bank opened on the data link" }), 4000);
      return;
    }
    const sigOk = await trust.verifyBankSignature(pinnedBankJwk, r.text, r.bankSignature);
    if (sigOk) settle(true, { method: "tone decoded from call audio, code confirmed over data link, bank signature valid against pinned key" });
    else settle(false, { reason: "bank signature failed against the pinned key" });
  }

  async function onPauses(u) {
    if (verdict !== null || !session) return;
    const r = await trust.confirmHeardPauses(session.id, u.gapsMs, "customer AI assistant");
    if (r.ignored) return;                       // ordinary speech, not the proof sentence
    await trust.log(session, "pauses_heard_by_customer_agent", { heard: r.heardBits, errors: r.errors });
    if (!r.ok) return settle(false, { reason: "the gaps between the bank's words did not match the session key" });
    const sigOk = await trust.verifyBankSignature(pinnedBankJwk, r.text, r.bankSignature);
    if (sigOk) settle(true, { method: "word-gap pattern measured from call audio matched the session key, bank signature valid against pinned key" });
    else settle(false, { reason: "bank signature failed against the pinned key" });
  }

  async function openAgent() {
    el = new WebSocket(await tel.signedUrlFor(assistantAgentId));
    el.on("open", () => {
      el.send(JSON.stringify({
        type: "conversation_initiation_client_data",
        dynamic_variables: { customer_name: session.name, login_context: session.loginContext || "a login from an unrecognised device" }
      }));
      if (pendingUpdate) { tellAgent(pendingUpdate); pendingUpdate = null; }
    });
    el.on("message", async raw => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      switch (msg.type) {
        case "conversation_initiation_metadata":
          await trust.log(session, "customer_agent_connected", { conversationId: msg.conversation_initiation_metadata_event?.conversation_id });
          break;
        case "audio": {
          lastAgentAudioAt = Date.now();
          const buf = Buffer.from(msg.audio_event.audio_base_64, "base64");
          for (let i = 0; i < buf.length; i += 160) sendToTwilio({ event: "media", streamSid, media: { payload: buf.subarray(i, i + 160).toString("base64") } });
          break;
        }
        case "agent_response": {
          const text = msg.agent_response_event?.agent_response || "";
          if (text.trim() && text.trim() !== "...") await trust.log(session, "customer_agent_said", { text });
          if (GOODBYE.test(text.slice(-40))) twilioWs.emit("said_goodbye", "customer");
          break;
        }
        case "interruption":
          // the bank talking over our tone must not cut it off
          if (Date.now() < toneUntil) break;
          sendToTwilio({ event: "clear", streamSid }); break;
        case "ping": el.send(JSON.stringify({ type: "pong", event_id: msg.ping_event.event_id })); break;
        default: break;
      }
    });
    el.on("error", async err => { if (session) await trust.log(session, "agent_error", { side: "customer", message: String(err.message || err) }); });
    el.on("close", () => twilioWs.emit("agent_closed"));
  }

  twilioWs.on("message", async raw => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    switch (msg.event) {
      case "start": {
        streamSid = msg.start.streamSid;
        session = trust.getSession(msg.start.customParameters?.session);
        if (!session) { twilioWs.close(); return; }
        await trust.log(session, "customer_agent_answered", { note: "call diverted to the customer's AI assistant" });
        decoder = ToneCodec.createDecoder(8000, hex => { onCode(hex).catch(() => {}); }, { minSNR: 4 });
        if (session.method === "pauses") pauses = PauseCodec.createDetector(8000, u => { onPauses(u).catch(() => {}); });
        deadline = setTimeout(() => settle(false, { reason: `no valid proof from the caller within ${VERIFY_DEADLINE_MS / 1000} s` }), VERIFY_DEADLINE_MS);
        if (!assistantReady()) await trust.log(session, "agent_error", { side: "customer", message: "assistant agent not ready, listening silently" });
        break;
      }
      case "media": {
        const mu = Buffer.from(msg.media.payload, "base64");
        if (el && el.readyState === WebSocket.OPEN) el.send(JSON.stringify({ user_audio_chunk: msg.media.payload }));
        if (decoder) {
          const pcm = new Float32Array(mu.length);
          for (let i = 0; i < mu.length; i++) pcm[i] = ToneCodec.mulawToLinear(mu[i]);
          decoder.feed(pcm);
          if (pauses) pauses.feed(pcm);
        }
        break;
      }
      case "stop":
        clearTimeout(deadline);
        if (el) try { el.close(); } catch {}
        break;
      default: break;
    }
  });
  twilioWs.on("close", () => { clearTimeout(deadline); if (el) try { el.close(); } catch {} });
}

module.exports = { ensureAssistantAgent, assistantReady, inboundTwiml, handleAssistantStream, ASSISTANT_NAME };
