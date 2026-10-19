// Exercise the media bridge without Twilio or ElevenLabs: a fake Twilio
// stream connects to /media, a stub agent WebSocket plays a greeting, and
// we check the tone is injected and decodes to the session code, and that
// a simulated customer reply gets a latency measurement.
process.env.PORT = "3998";
process.env.TWILIO_ACCOUNT_SID = "ACtest"; process.env.TWILIO_AUTH_TOKEN = "t"; process.env.TWILIO_FROM_NUMBER = "+10000000000";
process.env.ELEVENLABS_AGENT_ID = "agent_test"; process.env.PUBLIC_HOST = "localhost:3998";

const WebSocket = require("ws");
const { WebSocketServer } = require("ws");
const C = require("../lib/tonecodec");
const tel = require("../lib/telephony");

// stub ElevenLabs: override signedUrl by pointing the module at our stub
const stub = new WebSocketServer({ port: 3997 });
stub.on("connection", ws => {
  ws.on("message", raw => {
    const m = JSON.parse(raw);
    if (m.type === "conversation_initiation_client_data") {
      ws.send(JSON.stringify({ type: "conversation_initiation_metadata", conversation_initiation_metadata_event: { conversation_id: "c1", agent_output_audio_format: "ulaw_8000", user_input_audio_format: "ulaw_8000" } }));
      // greeting: 1.0 s of a 400 Hz hum in 100 ms chunks
      const total = 8000; const pcm = new Float32Array(total);
      for (let i = 0; i < total; i++) pcm[i] = 0.3 * Math.sin(2 * Math.PI * 400 * i / 8000);
      const mu = Buffer.alloc(total); for (let i = 0; i < total; i++) mu[i] = C.linearToMulaw(pcm[i]);
      ws.send(JSON.stringify({ type: "agent_response", agent_response_event: { agent_response: "Hello, were you the one who just tried to log in?" } }));
      for (let i = 0; i < total; i += 800) setTimeout(() => ws.send(JSON.stringify({ type: "audio", audio_event: { audio_base_64: mu.subarray(i, i + 800).toString("base64"), event_id: i } })), i / 8);
    }
  });
});
// monkeypatch fetch for the signed url
global.fetch = async (url) => ({ ok: true, json: async () => ({ signed_url: "ws://localhost:3997" }) });
process.env.ELEVENLABS_API_KEY = "x";

const trust = require("../lib/trust");
require("../server.js");

(async () => {
  await new Promise(r => setTimeout(r, 800));
  // make a flagged session directly (no real call placed: placeCall would need twilio)
  const { webcrypto } = require("crypto");
  const kp = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  trust.enrol({ deviceId: "d", phone: "+27000000000", name: "Test", publicJwk: await webcrypto.subtle.exportKey("jwk", kp.publicKey) });
  const s = await trust.startLogin("d");
  await trust.finishLogin(s.id, null);

  // fake Twilio connects to /media
  const tw = new WebSocket("ws://localhost:3998/media");
  const outbound = [];  // mulaw bytes the server sends to the call
  let marks = [];
  tw.on("open", () => tw.send(JSON.stringify({ event: "start", start: { streamSid: "MZ1", customParameters: { session: s.id } } })));
  tw.on("message", raw => {
    const m = JSON.parse(raw);
    if (m.event === "media") outbound.push(Buffer.from(m.media.payload, "base64"));
    if (m.event === "mark") { marks.push(m.mark.name); tw.send(JSON.stringify({ event: "mark", mark: { name: m.mark.name } })); }
  });
  // send 20 ms silence frames continuously like a phone would, then a 1 s "reply" 2.3 s after start
  const silence = Buffer.alloc(160, 0xFF);
  const t0 = Date.now();
  const replyPcm = new Float32Array(8000); for (let i = 0; i < 8000; i++) replyPcm[i] = 0.3 * Math.sin(2 * Math.PI * (180 - 60 * i / 8000) * i / 8000); // falling pitch
  const replyMu = Buffer.alloc(8000); for (let i = 0; i < 8000; i++) replyMu[i] = C.linearToMulaw(replyPcm[i]);
  let replyPos = 0;
  const iv = setInterval(() => {
    const el = Date.now() - t0;
    let frame = silence;
    if (el > 7200 && replyPos < replyMu.length) { frame = replyMu.subarray(replyPos, replyPos + 160); replyPos += 160; }
    if (tw.readyState === WebSocket.OPEN) tw.send(JSON.stringify({ event: "media", media: { payload: frame.toString("base64") } }));
  }, 20);

  await new Promise(r => setTimeout(r, 10000));
  clearInterval(iv);
  const all = Buffer.concat(outbound);
  const pcm = new Float32Array(all.length); for (let i = 0; i < all.length; i++) pcm[i] = C.mulawToLinear(all[i]);
  const decoded = C.decodePCM(pcm, 8000);
  const types = s.log.map(e => e.type);
  console.log("log:", types.join(" > "));
  console.log("marks:", marks.join(","));
  console.log("tone decoded == session code:", decoded === s.code);
  const turn = s.log.find(e => e.type === "customer_turn_measured");
  console.log("turn:", turn && { latency: turn.replyLatencyMs, ms: turn.utteranceMs, contour: turn.contour, bits: turn.bitsOfEvidence });
  const req = s.log.find(e => e.type === "agent_turn");
  console.log("request classified:", req && req.request, req && req.authorised);
  const pass = decoded === s.code && types.includes("tone_played") && turn && turn.contour === "falling" && turn.replyLatencyMs > 0;
  console.log(pass ? "PASS" : "FAIL");
  process.exit(pass ? 0 : 1);
})();
