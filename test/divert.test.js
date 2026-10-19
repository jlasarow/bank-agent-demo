// Divert flow without Twilio or ElevenLabs: a fake Twilio stream connects to
// /assistant-media and plays the bank's greeting plus the rendezvous tone as
// inbound audio. The customer agent must decode it from the call audio,
// confirm over the data link, verify the bank signature against the pinned
// key, and say so in the log. A second call plays a forged tone and must be
// rejected.
process.env.PORT = "3996";
process.env.TWILIO_ACCOUNT_SID = "ACtest"; process.env.TWILIO_AUTH_TOKEN = "t"; process.env.TWILIO_FROM_NUMBER = "+10000000000";
process.env.TWILIO_ASSISTANT_NUMBER = "+10000000001";
process.env.ELEVENLABS_AGENT_ID = "agent_test"; process.env.ELEVENLABS_ASSISTANT_AGENT_ID = "agent_assistant_test";
process.env.PUBLIC_HOST = "localhost:3996"; process.env.ELEVENLABS_API_KEY = "x";

const WebSocket = require("ws");
const { WebSocketServer } = require("ws");
const C = require("../lib/tonecodec");

// stub assistant agent: says one line, records any contextual updates
const updates = [];
const stub = new WebSocketServer({ port: 3995 });
stub.on("connection", ws => ws.on("message", raw => {
  const m = JSON.parse(raw);
  if (m.type === "contextual_update") updates.push(m.text);
  if (m.type === "conversation_initiation_client_data") {
    ws.send(JSON.stringify({ type: "conversation_initiation_metadata", conversation_initiation_metadata_event: { conversation_id: "c-assist" } }));
    ws.send(JSON.stringify({ type: "agent_response", agent_response_event: { agent_response: "Hello, I'm checking who is calling." } }));
  }
}));
global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ signed_url: "ws://localhost:3995" }), text: async () => "" });

// twilio client stub so boot-time number configuration does not hit the network
const Module = require("module");
const realLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === "twilio") return () => ({ incomingPhoneNumbers: Object.assign(() => ({ update: async () => ({}) }), { list: async () => [] }) });
  return realLoad.call(this, req, ...rest);
};

const trust = require("../lib/trust");
require("../server.js");

function lineAudio(codeHex) {
  // 1 s of greeting hum, the tone, then 1 s of quiet line noise
  const greet = new Float32Array(8000).map((_, i) => 0.25 * Math.sin(2 * Math.PI * 220 * i / 8000));
  const tone = C.encodePCM(codeHex, 8000, 0.5);
  const tail = new Float32Array(8000).map(() => (Math.random() - 0.5) * 0.01);
  const all = new Float32Array(greet.length + tone.length + tail.length);
  all.set(greet); all.set(tone, greet.length); all.set(tail, greet.length + tone.length);
  return Buffer.from(all.map(v => C.linearToMulaw(v)));
}

async function runCall(session, codeHex) {
  const tw = new WebSocket("ws://localhost:3996/assistant-media");
  await new Promise(r => tw.on("open", r));
  tw.send(JSON.stringify({ event: "start", start: { streamSid: "MZa", customParameters: { session: session.id } } }));
  await new Promise(r => setTimeout(r, 300));
  const mu = lineAudio(codeHex);
  for (let i = 0; i < mu.length; i += 160) {
    tw.send(JSON.stringify({ event: "media", media: { payload: mu.subarray(i, i + 160).toString("base64") } }));
    await new Promise(r => setTimeout(r, 2));   // faster than real time is fine for the decoder
  }
  await new Promise(r => setTimeout(r, 600));
  tw.close();
}

(async () => {
  await new Promise(r => setTimeout(r, 800));
  const { webcrypto } = require("crypto");
  const kp = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  trust.enrol({ deviceId: "d", phone: "+27000000000", name: "Test", publicJwk: await webcrypto.subtle.exportKey("jwk", kp.publicKey) });

  // genuine bank tone
  const good = await trust.startLogin("d", "website login from a laptop", { divert: true });
  await trust.finishLogin(good.id, null);
  await runCall(good, good.code);
  const goodTypes = good.log.map(e => e.type);
  console.log("genuine:", goodTypes.join(" > "));

  // forged tone: right format, wrong code
  const bad = await trust.startLogin("d", "app", { divert: true });
  await trust.finishLogin(bad.id, null);
  await runCall(bad, C.randomCodeHex());
  const badTypes = bad.log.map(e => e.type);
  console.log("forged: ", badTypes.join(" > "));
  console.log("updates to assistant:", updates.map(u => u.split(".")[0]).join(" | "));

  const pass =
    goodTypes.includes("customer_agent_answered") &&
    goodTypes.includes("tone_heard_by_customer_agent") &&
    goodTypes.includes("bank_verified") &&
    goodTypes.includes("customer_agent_verified_bank") &&
    good.bankVerified === true &&
    badTypes.includes("customer_agent_rejected_caller") &&
    !bad.bankVerified &&
    updates[0].startsWith("CALLER VERIFIED") && updates[1].startsWith("CALLER NOT VERIFIED");
  console.log(pass ? "PASS" : "FAIL");
  process.exit(pass ? 0 : 1);
})();
