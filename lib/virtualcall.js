// In-server call between the bank's agent and the customer's AI assistant.
//
// Each side is handled by exactly the same code that handles a real Twilio
// media stream (telephony.handleMediaStream for the bank, assistant.
// handleAssistantStream for the customer). This module stands in for the
// phone network between them: it plays each side's audio to the other in
// real time as 20 ms frames of 8 kHz mu-law, returns playback marks the way
// Twilio does, honours "clear" when an agent is interrupted, records the
// call, and streams the mixed audio to anyone watching the session's page.

const { EventEmitter } = require("events");
const trust = require("./trust");
const ToneCodec = require("./tonecodec");

const FRAME = 160;                       // 20 ms at 8 kHz
const SILENCE = Buffer.alloc(FRAME, 0xFF);
const MAX_CALL_MS = 120000;                // safety net if nobody says goodbye
const recordings = new Map();            // sessionId -> WAV buffer
const listeners = new Map();             // sessionId -> Set<fn(b64 mulaw chunk)>

// A stand-in for the Twilio WebSocket that a handler talks to.
class Leg extends EventEmitter {
  constructor(name, onSend) { super(); this.name = name; this.readyState = 1; this.OPEN = 1; this.isVirtual = true; this.onSend = onSend; }
  send(raw) { if (this.readyState === 1) this.onSend(JSON.parse(raw)); }
  deliver(obj) { if (this.readyState === 1) this.emit("message", Buffer.from(JSON.stringify(obj))); }
  close() { this.readyState = 3; this.emit("_hangup"); }
}

function start(session) {
  const tel = require("./telephony");
  const assistant = require("./assistant");
  const queues = { bank: [], customer: [] };      // audio each side has sent, waiting to play to the other
  const pcm = [];                                  // mixed recording, 16-bit
  let ended = false, sent = 0, t0 = 0, timer = null, hardStop = null, liveBuf = [];

  const bank = new Leg("bank", msg => fromLeg("bank", msg));
  const customer = new Leg("customer", msg => fromLeg("customer", msg));
  const other = { bank: customer, customer: bank };
  const legs = { bank, customer };

  function fromLeg(name, msg) {
    if (msg.event === "media") {
      const buf = Buffer.from(msg.media.payload, "base64");
      for (let i = 0; i < buf.length; i += FRAME) {
        const f = Buffer.alloc(FRAME, 0xFF); buf.copy(f, 0, i, Math.min(buf.length, i + FRAME));
        queues[name].push({ frame: f });
      }
    } else if (msg.event === "mark") queues[name].push({ mark: msg.mark.name });
    else if (msg.event === "clear") {
      // an interrupted agent: drop what it hasn't said yet, return its marks
      const marks = queues[name].filter(q => q.mark);
      queues[name] = [];
      for (const m of marks) legs[name].deliver({ event: "mark", mark: { name: m.mark } });
    }
  }

  // Release one frame per side every 20 ms, like a phone line.
  function tick() {
    const due = Math.floor((Date.now() - t0) / 20);
    while (sent < due && !ended) {
      const out = {};
      for (const name of ["bank", "customer"]) {
        const q = queues[name];
        while (q.length && q[0].mark) legs[name].deliver({ event: "mark", mark: { name: q.shift().mark } });
        const item = q.length ? q.shift() : null;
        out[name] = item ? item.frame : SILENCE;
        while (q.length && q[0].mark && !q.slice(1).some(x => x.frame)) legs[name].deliver({ event: "mark", mark: { name: q.shift().mark } });
        other[name].deliver({ event: "media", media: { payload: out[name].toString("base64") } });
      }
      mix(out.bank, out.customer);
      sent++;
    }
  }

  function mix(a, b) {
    const s = Buffer.alloc(FRAME * 2), m = Buffer.alloc(FRAME);
    for (let i = 0; i < FRAME; i++) {
      const v = Math.max(-1, Math.min(1, ToneCodec.mulawToLinear(a[i]) + ToneCodec.mulawToLinear(b[i])));
      s.writeInt16LE(Math.round(v * 32767), i * 2);
      m[i] = ToneCodec.linearToMulaw(v);
    }
    pcm.push(s);
    liveBuf.push(m);
    if (liveBuf.length >= 5) {                     // 100 ms chunks to the page
      const chunk = Buffer.concat(liveBuf).toString("base64"); liveBuf = [];
      const subs = listeners.get(session.id);
      if (subs) for (const fn of subs) { try { fn(chunk); } catch {} }
    }
  }

  async function hangup(reason) {
    if (ended) return;
    ended = true;
    clearInterval(timer); clearTimeout(hardStop);
    for (const leg of [bank, customer]) { leg.deliver({ event: "stop" }); leg.readyState = 3; leg.emit("close"); }
    recordings.set(session.id, wav(Buffer.concat(pcm)));
    setTimeout(() => recordings.delete(session.id), 60 * 60 * 1000);
    await trust.log(session, "call_hung_up", { reason });
    await tel.onStatus(session.id, "completed");
    session.recording = { internal: true, durationS: Math.round(sent / 50) };
    await trust.log(session, "recording_ready", { durationS: session.recording.durationS });
  }

  // Whoever says goodbye: wait for their goodbye audio to arrive and finish
  // playing to the other side, then hang up. Stops the agents from looping.
  function hangupAfterGoodbye(name) {
    const started = Date.now();
    let quiet = 0;
    const check = () => {
      if (ended) return;
      const playing = queues[name].some(q => q.frame);
      quiet = playing ? 0 : quiet + 1;
      if ((Date.now() - started > 1200 && quiet >= 4) || Date.now() - started > 20000) setTimeout(() => hangup(name + " said goodbye"), 600);
      else setTimeout(check, 200);
    };
    setTimeout(check, 200);
  }

  // either agent finishing the conversation ends the call shortly after
  for (const leg of [bank, customer]) {
    leg.on("said_goodbye", who => hangupAfterGoodbye(who || leg.name));
    leg.on("agent_closed", () => setTimeout(() => hangup("agent ended the conversation"), 1500));
    leg.on("_hangup", () => hangup("closed"));
  }

  tel.handleMediaStream(bank);
  assistant.handleAssistantStream(customer);
  setTimeout(async () => {
    await tel.onStatus(session.id, "in-progress");
    const startMsg = name => ({ event: "start", start: { streamSid: "VS-" + name + "-" + session.id, customParameters: { session: session.id } } });
    bank.deliver(startMsg("bank"));
    customer.deliver(startMsg("customer"));
    t0 = Date.now();
    timer = setInterval(tick, 10);
    hardStop = setTimeout(() => hangup("time limit"), MAX_CALL_MS);
  }, 800);
  return { hangup };
}

function wav(pcm16) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm16.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(8000, 24); h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm16.length, 40);
  return Buffer.concat([h, pcm16]);
}

function listen(sessionId, fn) {
  if (!listeners.has(sessionId)) listeners.set(sessionId, new Set());
  listeners.get(sessionId).add(fn);
  return () => listeners.get(sessionId)?.delete(fn);
}

module.exports = { start, listen, getRecording: id => recordings.get(id) };
