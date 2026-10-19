// In-server agent-to-agent call with the Patent 2 proof, no Twilio or
// ElevenLabs needed. Stub agents stand in for both ElevenLabs agents and a
// stub speech service returns a synthetic voice with word timings. Checks:
// the bank's sentence is played with the session's gap pattern, the
// customer's AI measures the gaps from the call audio and verifies the bank,
// the call is recorded, and live audio reaches a browser watching the session.
// A second session whose sentence carries another session's pattern (a
// replayed recording) must be rejected.
process.env.PORT = "3994";
process.env.TWILIO_ACCOUNT_SID = "ACtest"; process.env.TWILIO_AUTH_TOKEN = "t"; process.env.TWILIO_FROM_NUMBER = "+10000000000";
process.env.ELEVENLABS_AGENT_ID = "agent_bank"; process.env.ELEVENLABS_ASSISTANT_AGENT_ID = "agent_customer";
process.env.PUBLIC_HOST = "localhost:3994"; process.env.ELEVENLABS_API_KEY = "x";

const WebSocket = require("ws");
const { WebSocketServer } = require("ws");
const C = require("../lib/tonecodec");
const P = require("../lib/pausecodec");

// a voiced "word": 150 Hz fundamental with harmonics, soft edges
function word(ms) {
  const n = Math.round(ms * 8), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 160, (n - i) / 160);
    let v = 0; for (let h = 1; h <= 12; h++) v += Math.sin(2 * Math.PI * 150 * h * i / 8000) / h;
    out[i] = 0.18 * env * v;
  }
  return out;
}
function mulaw(f32) { return Buffer.from(Array.from(f32, v => C.linearToMulaw(v))); }

// stub speech service, behaving like the real one: each phrase is spoken as
// words 280 ms long with 30 ms natural gaps, and every <break time="x s" />
// tag becomes that much silence plus a little for the comma.
function speech(text) {
  const parts = [];
  const pieces = String(text).split(/<break time="([\d.]+)s" \/>/);
  for (let k = 0; k < pieces.length; k++) {
    if (k % 2 === 1) { parts.push(new Float32Array(Math.round((Number(pieces[k]) + 0.08) * 8000))); continue; }
    const words = pieces[k].replace(/[,.]/g, " ").trim().split(/\s+/).filter(Boolean);
    words.forEach((w, wi) => { parts.push(word(280)); if (wi < words.length - 1) parts.push(new Float32Array(240)); });
  }
  const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
  return mulaw(all);
}

// stub agents: the bank greets; the customer's AI says one line; both record contextual updates
const updates = [];
function stubAgent(port, greet) {
  const wss = new WebSocketServer({ port });
  wss.on("connection", ws => ws.on("message", raw => {
    const m = JSON.parse(raw);
    if (m.type === "contextual_update") {
      updates.push(m.text);
      if (!greet && m.text.startsWith("CALLER VERIFIED")) {   // the customer's AI wraps up
        ws.send(JSON.stringify({ type: "agent_response", agent_response_event: { agent_response: "Thank you, the app has the alert. Goodbye." } }));
        const g = mulaw(word(700));
        for (let i = 0; i < g.length; i += 800) ws.send(JSON.stringify({ type: "audio", audio_event: { audio_base_64: g.subarray(i, i + 800).toString("base64") } }));
      }
    }
    if (m.type === "conversation_initiation_client_data") {
      ws.send(JSON.stringify({ type: "conversation_initiation_metadata", conversation_initiation_metadata_event: { conversation_id: "c" + port, agent_output_audio_format: "ulaw_8000" } }));
      if (greet) {
        ws.send(JSON.stringify({ type: "agent_response", agent_response_event: { agent_response: "Hello, this is the Demo Bank fraud desk." } }));
        const g = mulaw(word(900));
        for (let i = 0; i < g.length; i += 800) ws.send(JSON.stringify({ type: "audio", audio_event: { audio_base_64: g.subarray(i, i + 800).toString("base64") } }));
      } else ws.send(JSON.stringify({ type: "agent_response", agent_response_event: { agent_response: "I'm confirming who is calling." } }));
    }
  }));
}
stubAgent(3992, true);
stubAgent(3993, false);

global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("get-signed-url")) return { ok: true, json: async () => ({ signed_url: u.includes("agent_bank") ? "ws://localhost:3992" : "ws://localhost:3993" }) };
  if (u.includes("/text-to-speech/")) {
    const audio = speech(JSON.parse(opts.body).text);
    return { ok: true, json: async () => ({ audio_base64: audio.toString("base64") }), arrayBuffer: async () => audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.length) };
  }
  if (u.includes("/convai/agents/") && (!opts || !opts.method)) return { ok: true, json: async () => ({ conversation_config: { tts: { voice_id: "v1" } } }) };
  return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
};

const trust = require("../lib/trust");
const tel = require("../lib/telephony");
require("../server.js");

async function runCall(label) {
  const { webcrypto } = require("crypto");
  const kp = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  trust.enrol({ deviceId: "d-" + label, phone: "+27000000000", name: "Test", publicJwk: await webcrypto.subtle.exportKey("jwk", kp.publicKey) });
  // the customer's phone signs a permission for its AI
  const delegationSig = Buffer.from(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, Buffer.from(trust.delegationText("d-" + label)))).toString("base64");
  await trust.registerDelegation("d-" + label, delegationSig);
  const s = await trust.startLogin("d-" + label, "website login", { divert: true, method: "pauses" });
  // a browser watching the session
  let audioChunks = 0;
  const page = new WebSocket("ws://localhost:3994/ws?session=" + s.id);
  page.on("message", raw => { if (JSON.parse(raw).type === "audio") audioChunks++; });
  await new Promise(r => page.on("open", r));
  await trust.finishLogin(s.id, null);
  await tel.placeCall(s);
  const until = Date.now() + 40000;
  while (Date.now() < until && !s.log.some(e => e.type === "customer_agent_verified_bank" || e.type === "customer_agent_rejected_caller")) await new Promise(r => setTimeout(r, 250));
  page.close();
  return { s, types: s.log.map(e => e.type), audioChunks };
}

(async () => {
  await new Promise(r => setTimeout(r, 800));

  const good = await runCall("good");
  // the AI said goodbye: the call must end on its own, not loop
  const hangBy = Date.now() + 15000;
  while (Date.now() < hangBy && !good.s.log.some(e => e.type === "call_hung_up")) await new Promise(r => setTimeout(r, 250));
  const hung = good.s.log.find(e => e.type === "call_hung_up");
  good.types = good.s.log.map(e => e.type);
  console.log("genuine:", good.types.join(" > "));
  console.log("hung up:", hung && hung.reason);
  console.log("reading:", (good.s.log.find(e => e.type === "pauses_matched") || {}).reading);
  const sent = good.s.log.find(e => e.type === "pause_sentence_sent");
  const matched = good.s.log.find(e => e.type === "pauses_matched");
  console.log("sentence airtime:", sent && sent.airtimeMs, "ms; heard", matched && matched.heard, "expected", matched && matched.expected, "errors", matched && matched.errors);
  console.log("live audio chunks to the page:", good.audioChunks);

  // replay: this session's sentence carries the previous session's gap pattern,
  // as if a recording of the earlier call were played. One-shot swap used only
  // while the sentence is built; verification then uses the true pattern.
  const realExpected = trust.expectedPauseBits;
  trust.expectedPauseBits = sess => { trust.expectedPauseBits = realExpected; return realExpected(good.s); };
  const bad = await runCall("replay");
  console.log("replayed:", bad.types.join(" > "));

  const pass =
    good.types.includes("pause_sentence_sent") && good.types.includes("pauses_matched") &&
    good.types.includes("customer_agent_verified_bank") && good.s.bankVerified === true &&
    good.audioChunks > 10 &&
    good.types.includes("assistant_authorised") && good.types.includes("customer_agent_sent_tone") &&
    good.types.includes("customer_agent_verified_by_bank") && good.types.includes("ai_to_ai_verified") &&
    !bad.types.includes("customer_agent_verified_by_bank") &&
    !!hung && /said goodbye/.test(hung.reason) && good.types.includes("recording_ready") &&
    /———/.test((good.s.log.find(e => e.type === "pauses_matched") || {}).reading || "") &&
    bad.types.includes("customer_agent_rejected_caller") && !bad.s.bankVerified &&
    updates.some(u => u.startsWith("CALLER VERIFIED")) && updates.some(u => u.startsWith("CALLER NOT VERIFIED"));
  console.log(pass ? "PASS" : "FAIL");
  process.exit(pass ? 0 : 1);
})();
