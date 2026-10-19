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

// stub speech service: the sentence, words 280 ms, 30 ms natural gaps, with timings
function speech() {
  const words = P.PHRASE.split(" ");
  const parts = [], chars = [], st = [], en = [];
  let t = 0;
  words.forEach((w, wi) => {
    const dur = 0.28;
    for (let k = 0; k < w.length; k++) { chars.push(w[k]); st.push(t + dur * k / w.length); en.push(t + dur * (k + 1) / w.length); }
    parts.push(word(dur * 1000)); t += dur;
    if (wi < words.length - 1) { chars.push(" "); st.push(t); en.push(t + 0.03); parts.push(new Float32Array(240)); t += 0.03; }
  });
  const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
  return { audio_base64: mulaw(all).toString("base64"), alignment: { characters: chars, character_start_times_seconds: st, character_end_times_seconds: en } };
}

// stub agents: the bank greets; the customer's AI says one line; both record contextual updates
const updates = [];
function stubAgent(port, greet) {
  const wss = new WebSocketServer({ port });
  wss.on("connection", ws => ws.on("message", raw => {
    const m = JSON.parse(raw);
    if (m.type === "contextual_update") updates.push(m.text);
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
  if (u.includes("/text-to-speech/")) return { ok: true, json: async () => speech() };
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
  console.log("genuine:", good.types.join(" > "));
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
    bad.types.includes("customer_agent_rejected_caller") && !bad.s.bankVerified &&
    updates.some(u => u.startsWith("CALLER VERIFIED")) && updates.some(u => u.startsWith("CALLER NOT VERIFIED"));
  console.log(pass ? "PASS" : "FAIL");
  process.exit(pass ? 0 : 1);
})();
