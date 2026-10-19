// The call must not end while the customer is still talking.
// 1. The bank's greeting and tone play before the agent joins.
// 2. The agent says goodbye; the customer speaks straight after it, so the
//    hang-up is cancelled and the call stays up.
// 3. The agent says goodbye again; the customer stays quiet, so the call
//    ends about 3 s after the goodbye has finished playing.
process.env.TWILIO_ACCOUNT_SID = "ACtest"; process.env.TWILIO_AUTH_TOKEN = "t"; process.env.TWILIO_FROM_NUMBER = "+10000000000";
process.env.ELEVENLABS_AGENT_ID = "agent_bank"; process.env.ELEVENLABS_API_KEY = "x"; process.env.PUBLIC_HOST = "localhost";

const { EventEmitter } = require("events");
const { WebSocketServer } = require("ws");
const C = require("../lib/tonecodec");

const AGENT_PORT = 3981;
function tone(ms, amp) {
  const n = Math.round(ms * 8), b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = C.linearToMulaw(amp * Math.sin(2 * Math.PI * 180 * i / 8000));
  return b;
}
global.fetch = async (url) => {
  const u = String(url);
  if (u.includes("get-signed-url")) return { ok: true, json: async () => ({ signed_url: "ws://localhost:" + AGENT_PORT }) };
  if (u.includes("/text-to-speech/")) return { ok: true, json: async () => ({ audio_base64: tone(900, 0.3).toString("base64"), alignment: null }) };
  if (u.includes("/convai/agents/")) return { ok: true, json: async () => ({ conversation_config: { tts: { voice_id: "v1" } } }) };
  return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
};

let agentWs = null;
const wss = new WebSocketServer({ port: AGENT_PORT });
wss.on("connection", ws => {
  agentWs = ws;
  ws.on("message", raw => {
    const m = JSON.parse(raw);
    if (m.type === "conversation_initiation_client_data")
      ws.send(JSON.stringify({ type: "conversation_initiation_metadata", conversation_initiation_metadata_event: { conversation_id: "c1", agent_output_audio_format: "ulaw_8000", user_input_audio_format: "ulaw_8000" } }));
  });
});
function agentSays(text, ms) {
  agentWs.send(JSON.stringify({ type: "agent_response", agent_response_event: { agent_response: text } }));
  const a = tone(ms, 0.3);
  for (let i = 0; i < a.length; i += 800) agentWs.send(JSON.stringify({ type: "audio", audio_event: { audio_base_64: a.subarray(i, i + 800).toString("base64") } }));
}

// stand-in for Twilio: returns each mark when its audio would have finished
class FakeTwilio extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.OPEN = 1; this.queuedMs = 0; this.playEnd = 0; }
  send(raw) {
    const m = JSON.parse(raw);
    if (m.event === "media") { this.playEnd = Math.max(this.playEnd, Date.now()) + 20; }
    if (m.event === "mark") setTimeout(() => this.deliver({ event: "mark", mark: m.mark }), Math.max(0, this.playEnd - Date.now()));
    if (m.event === "clear") this.playEnd = Date.now();
  }
  deliver(o) { this.emit("message", Buffer.from(JSON.stringify(o))); }
  close() { this.readyState = 3; }
}

const trust = require("../lib/trust");
const tel = require("../lib/telephony");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(50); } return false; };

(async () => {
  await trust.initBankKey();
  const { webcrypto } = require("crypto");
  const kp = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  trust.enrol({ deviceId: "d1", phone: "+27000000000", name: "Judd Lasarow", publicJwk: await webcrypto.subtle.exportKey("jwk", kp.publicKey) });
  const s = await trust.startLogin("d1", "test", { method: "tones" });
  await trust.finishLogin(s.id, null);
  s.call = { sid: "CAtest" };

  const tw = new FakeTwilio();
  let hungUpAt = null, hangReason = null;
  tw.on("bank_hangup", r => { hungUpAt = Date.now(); hangReason = r; });
  tel.handleMediaStream(tw);
  // the customer's line: silence every 20 ms unless they are talking
  let talking = false;
  const line = setInterval(() => tw.deliver({ event: "media", media: { payload: (talking ? tone(20, 0.25) : Buffer.alloc(160, 0xFF)).toString("base64") } }), 20);
  tw.deliver({ event: "start", start: { streamSid: "MZ1", customParameters: { session: s.id } } });

  const introFirst = await waitFor(() => agentWs, 15000);
  const types = () => s.log.map(e => e.type);
  await waitFor(() => types().includes("agent_connected"), 5000);

  // first goodbye, customer talks over the end of it
  agentSays("Your account is frozen and a specialist will call you. Goodbye.", 1500);
  await sleep(1700);
  talking = true;
  agentWs.send(JSON.stringify({ type: "user_transcript", user_transcription_event: { user_transcript: "No wait, I have a question." } }));
  await sleep(1200);
  talking = false;
  await sleep(4000);
  const stayedUp = hungUpAt === null && types().includes("hangup_cancelled");

  // second goodbye, customer quiet
  const t0 = Date.now();
  agentSays("You're welcome. Goodbye.", 1000);
  // the other side answers the goodbye with its own; that must not restart the call
  await sleep(1300);
  talking = true;
  agentWs.send(JSON.stringify({ type: "user_transcript", user_transcription_event: { user_transcript: "Thanks, goodbye." } }));
  await sleep(600);
  talking = false;
  const ended = await waitFor(() => hungUpAt !== null, 12000);
  const afterMs = hungUpAt - t0;

  clearInterval(line); wss.close();
  console.log("log:", types().join(" > "));
  console.log("intro before agent:", introFirst && types().indexOf("bank_greeting") < types().indexOf("agent_connected"));
  console.log("stayed up while customer talked:", stayedUp);
  console.log("ended after second goodbye:", ended, afterMs + " ms", hangReason);
  const pass = introFirst && types().indexOf("bank_greeting") < types().indexOf("agent_connected") &&
    types().indexOf("tone_sent") < types().indexOf("agent_connected") &&
    stayedUp && ended && afterMs >= 3800 && afterMs <= 9000 &&
    types().filter(t => t === "hangup_cancelled").length === 1;
  console.log(pass ? "PASS" : "FAIL");
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error("FAIL", e); process.exit(1); });
