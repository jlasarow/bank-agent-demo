// Untapped AI - Bank Agent Demo
//
// Fourth site in the series. Proves the "bank calls the customer" flow:
// a login that the customer's device cannot sign is flagged, the bank's
// voice agent calls the customer's real phone, the handset confirms the
// caller is the bank through the rendezvous tone plus the data-link
// handshake (Patent 1), and the customer's replies are measured for
// liveness (Patent 2, measurement only). Every step lands in a signed
// audit log the phone shows live.

const path = require("path");
const express = require("express");
const { WebSocketServer } = require("ws");
const trust = require("./lib/trust");
const tel = require("./lib/telephony");
const assistant = require("./lib/assistant");
const virtualcall = require("./lib/virtualcall");

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json({ limit: "64kb" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));
app.get("/healthz", (req, res) => res.send("ok"));

// ---- bank identity ----
app.get("/api/bank-key", (req, res) => res.json({ name: "Demo Bank", publicJwk: trust.bankPublicJwk() }));

// ---- what this server can do (the page hides the divert toggle if unavailable) ----
app.get("/api/config", (req, res) => res.json({ telephony: tel.configured(), divertAvailable: tel.divertAvailable() && assistant.assistantReady(), divertMode: tel.divertMode() }));

// ---- device enrolment ----
app.post("/api/enrol", (req, res) => {
  try { const d = trust.enrol(req.body); res.json({ ok: true, device: { deviceId: d.deviceId, keyVersion: d.keyVersion, enrolledAt: d.enrolledAt } }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- login: challenge then signature ----
app.post("/api/login/start", async (req, res) => {
  try {
    const s = await trust.startLogin(req.body.deviceId, req.body.context, { divert: !!req.body.divert, method: req.body.method });
    res.json({ sessionId: s.id, challenge: s.challenge, textToSign: `login:${s.id}:${s.challenge}` });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/login/finish", async (req, res) => {
  try {
    const { ok, session } = await trust.finishLogin(req.body.sessionId, req.body.signature);
    if (!ok) {
      // Flagged: the bank calls the customer now. No SMS, no OTP.
      if (tel.configured()) {
        try { await tel.placeCall(session); }
        catch (e) { await trust.log(session, "call_failed", { message: String(e.message || e) }); }
      } else {
        await trust.log(session, "call_skipped", { note: "telephony not configured on this server" });
      }
    }
    res.json({ ok, session: trust.publicView(session) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// handset heard the tone and reports the code over the data link
app.post("/api/session/:id/heard", async (req, res) => {
  try { res.json(await trust.confirmHeardCode(req.params.id, req.body.code)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// handset measured the gaps between the bank's words and reports them (Patent 2)
app.post("/api/session/:id/heard-pauses", async (req, res) => {
  try { res.json(await trust.confirmHeardPauses(req.params.id, req.body.gapsMs)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// play the recording of a diverted (agent-to-agent) call
app.get("/api/session/:id/recording", async (req, res) => {
  const s = trust.getSession(req.params.id);
  if (!s || !s.recording) return res.status(404).json({ error: "no recording" });
  if (s.recording.internal) {
    const w = virtualcall.getRecording(s.id);
    if (!w) return res.status(404).json({ error: "recording expired" });
    return res.set("content-type", "audio/wav").send(w);
  }
  try {
    const r = await tel.fetchRecording(s);
    if (!r) return res.status(502).json({ error: "recording not available yet" });
    res.set("content-type", "audio/mpeg");
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/api/session/:id", (req, res) => {
  const s = trust.getSession(req.params.id);
  if (!s) return res.status(404).json({ error: "unknown session" });
  res.json({ session: trust.publicView(s), log: s.log });
});

// ---- Twilio callbacks ----
app.post("/twilio/status", async (req, res) => {
  await tel.onStatus(req.query.session, req.body.CallStatus);
  res.sendStatus(204);
});

// the assistant number rings: hand the call to the customer agent
app.post("/twilio/assistant-inbound", (req, res) => {
  const host = process.env.PUBLIC_HOST || process.env.RENDER_EXTERNAL_HOSTNAME;
  res.type("text/xml").send(assistant.inboundTwiml(tel.claimPendingDivert(), host));
});

app.post("/twilio/recording", async (req, res) => {
  await tel.onRecording(req.query.session, req.body);
  res.sendStatus(204);
});

// ---- server boot ----
(async () => {
  await trust.initBankKey();
  const server = app.listen(PORT, () => console.log("Bank Agent Demo listening on " + PORT, "telephony:", tel.configured() ? "configured" : "not configured"));
  // configure the ElevenLabs agent in the background so a slow or failed
  // call never blocks the server from coming up
  tel.configureAgent().then(cfg => console.log("agent configure:", JSON.stringify(cfg)))
    .catch(e => console.log("agent configure failed:", e.message));
  assistant.ensureAssistantAgent().then(r => console.log("assistant agent:", JSON.stringify(r)))
    .catch(e => console.log("assistant agent failed:", e.message));
  tel.configureAssistantNumber().then(r => console.log("assistant number:", JSON.stringify(r)))
    .catch(e => console.log("assistant number failed:", e.message));

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/media" || url.pathname === "/assistant-media" || url.pathname === "/ws") {
      wss.handleUpgrade(req, socket, head, ws => {
        if (url.pathname === "/media") tel.handleMediaStream(ws);
        else if (url.pathname === "/assistant-media") assistant.handleAssistantStream(ws);
        else handleAppSocket(ws, url.searchParams.get("session"));
      });
    } else socket.destroy();
  });
})();

// Phone app subscribes to one session's audit log and gets each signed entry
// the moment it is written.
function handleAppSocket(ws, sessionId) {
  const s = trust.getSession(sessionId);
  if (!s) { ws.send(JSON.stringify({ type: "error", reason: "unknown session" })); ws.close(); return; }
  ws.send(JSON.stringify({ type: "snapshot", session: trust.publicView(s), log: s.log }));
  const unsub = trust.subscribe(sessionId, entry => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "entry", entry, session: trust.publicView(trust.getSession(sessionId)) }));
  });
  // live audio of an in-server agent-to-agent call, 100 ms mu-law chunks
  const unlisten = virtualcall.listen(sessionId, chunk => {
    if (ws.readyState === ws.OPEN && ws.bufferedAmount < 1e6) ws.send(JSON.stringify({ type: "audio", mulaw: chunk }));
  });
  ws.on("close", () => { unsub(); unlisten(); });
  ws.on("error", () => { unsub(); unlisten(); });
}
