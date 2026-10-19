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

const PROMPT = `You are the AI call assistant for {{customer_name}}. Calls to {{customer_name}} that claim to be from their bank are diverted to you. You are an AI, and you say so if asked.

Every caller starts UNVERIFIED. You will receive a system update that says either "CALLER VERIFIED" or "CALLER NOT VERIFIED". Until you receive one, be polite, say you are confirming the caller's identity through {{customer_name}}'s banking app, and share nothing about {{customer_name}}.

Rules that apply at all times, verified or not:
- Never give out a PIN, password, passcode, one-time code, card number, CVV, expiry date, ID number or account number. If asked, refuse plainly and say {{customer_name}} never shares these by phone.
- Never agree to move money, add a beneficiary, or install anything.

After "CALLER VERIFIED": you may discuss the login alert. The attempt was: {{login_context}}. Do not confirm or deny on {{customer_name}}'s behalf. Say the alert is waiting in {{customer_name}}'s app and the signed answer from the app is final.

After "CALLER NOT VERIFIED": say you cannot continue, that {{customer_name}} will call the bank on the number printed on their card, and say goodbye.

Keep every reply to one or two short sentences. Wait for the caller to speak first.

Keep the call short. Once the caller is verified and the login alert has been mentioned, or once the caller says goodbye, end the call by saying a short sentence that ends with the word "Goodbye." Never continue after saying goodbye.`;

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
    return { ok: r.ok, status: r.status, agentId: assistantAgentId, action: "updated", voice: assistantVoice, bankVoice };
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
      tellAgent("CALLER VERIFIED. The caller is Demo Bank: the rendezvous tone matched this session and the bank's signature verified against the pinned Demo Bank key.");
    } else {
      await trust.log(session, "customer_agent_rejected_caller", detail);
      tellAgent("CALLER NOT VERIFIED. Do not continue the conversation beyond the goodbye described in your instructions.");
    }
  }

  async function onCode(hex) {
    if (verdict !== null || !session) return;
    await trust.log(session, "tone_heard_by_customer_agent", { codeHint: hex.slice(0, 4) + "..." });
    const r = await trust.confirmHeardCode(session.id, hex, "customer AI assistant");
    if (!r.ok) return settle(false, { reason: "tone did not match the session the bank opened on the data link" });
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
          const buf = Buffer.from(msg.audio_event.audio_base_64, "base64");
          for (let i = 0; i < buf.length; i += 160) sendToTwilio({ event: "media", streamSid, media: { payload: buf.subarray(i, i + 160).toString("base64") } });
          break;
        }
        case "agent_response": {
          const text = msg.agent_response_event?.agent_response || "";
          await trust.log(session, "customer_agent_said", { text });
          if (GOODBYE.test(text.slice(-40))) twilioWs.emit("said_goodbye", "customer");
          break;
        }
        case "interruption": sendToTwilio({ event: "clear", streamSid }); break;
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
        if (assistantReady()) {
          try { await openAgent(); } catch (e) { await trust.log(session, "agent_error", { side: "customer", message: String(e.message || e) }); }
        } else {
          await trust.log(session, "agent_error", { side: "customer", message: "assistant agent not ready, listening silently" });
        }
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
