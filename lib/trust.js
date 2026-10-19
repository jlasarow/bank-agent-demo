// Trust server core: device enrolment, login challenges, signature checks,
// rendezvous codes, bank identity signatures, and the signed audit log that
// the phone app watches live.
//
// Storage is in memory for the demonstration. Every entry the server writes
// to a session's log is signed with the bank key so the customer sees the
// same record the fraud team would later rely on.

const { webcrypto, randomBytes, createHash, createHmac } = require("crypto");
const subtle = webcrypto.subtle;
const ToneCodec = require("./tonecodec");
const PauseCodec = require("./pausecodec");

const devices = new Map();   // deviceId -> { deviceId, phone, name, publicJwk, enrolledAt, keyVersion }
const sessions = new Map();  // sessionId -> session
const listeners = new Map(); // sessionId -> Set<fn(event)>

let bankKey = null;          // { privateKey, publicKey, publicJwk }

async function initBankKey(pemOrNull) {
  // The demo generates a fresh bank key at boot unless BANK_PRIVATE_JWK is
  // supplied. Clients pin the public half when they enrol.
  if (process.env.BANK_PRIVATE_JWK) {
    const jwk = JSON.parse(process.env.BANK_PRIVATE_JWK);
    const privateKey = await subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
    const pub = { ...jwk }; delete pub.d; pub.key_ops = ["verify"];
    const publicKey = await subtle.importKey("jwk", pub, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
    bankKey = { privateKey, publicKey, publicJwk: pub };
  } else {
    const kp = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const publicJwk = await subtle.exportKey("jwk", kp.publicKey);
    bankKey = { privateKey: kp.privateKey, publicKey: kp.publicKey, publicJwk };
  }
  return bankKey.publicJwk;
}

function b64(buf) { return Buffer.from(buf).toString("base64"); }
function sha256hex(s) { return createHash("sha256").update(s).digest("hex"); }

async function bankSign(text) {
  const sig = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, bankKey.privateKey, Buffer.from(text));
  return b64(sig);
}

async function verifyDeviceSignature(publicJwk, text, signatureB64) {
  try {
    const key = await subtle.importKey("jwk", publicJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, Buffer.from(signatureB64, "base64"), Buffer.from(text));
  } catch { return false; }
}

// ---- audit log ----
async function log(session, type, data) {
  const entry = {
    seq: session.log.length + 1,
    sessionId: session.id,
    at: new Date().toISOString(),
    type,
    ...(data || {})
  };
  // chain each entry to the previous one and sign it
  const prev = session.log.length ? session.log[session.log.length - 1].hash : "genesis";
  entry.prevHash = prev;
  const body = JSON.stringify({ ...entry, hash: undefined, bankSignature: undefined });
  entry.hash = sha256hex(prev + body);
  entry.bankSignature = await bankSign(entry.hash);
  session.log.push(entry);
  console.log(`[${session.id}] ${type}`, JSON.stringify(data || {}));
  const subs = listeners.get(session.id);
  if (subs) for (const fn of subs) { try { fn(entry); } catch {} }
  return entry;
}

function subscribe(sessionId, fn) {
  if (!listeners.has(sessionId)) listeners.set(sessionId, new Set());
  listeners.get(sessionId).add(fn);
  return () => listeners.get(sessionId)?.delete(fn);
}

// ---- devices ----
function enrol({ deviceId, phone, name, publicJwk }) {
  if (!deviceId || !phone || !publicJwk) throw new Error("deviceId, phone and publicJwk required");
  const existing = devices.get(deviceId);
  const rec = {
    deviceId, phone, name: name || "Customer", publicJwk,
    enrolledAt: new Date().toISOString(),
    keyVersion: existing ? existing.keyVersion + 1 : 1
  };
  devices.set(deviceId, rec);
  console.log(`enrol ${deviceId} phone ${phone.slice(0, 4)}***** keyVersion ${rec.keyVersion}`);
  return rec;
}
function getDevice(deviceId) { return devices.get(deviceId); }

// ---- sessions ----
function newSessionId() { return "S-" + randomBytes(4).toString("hex").toUpperCase(); }

async function startLogin(deviceId, context, opts) {
  opts = opts || {};
  const device = devices.get(deviceId);
  if (!device) throw new Error("device not enrolled");
  const session = {
    id: newSessionId(),
    deviceId,
    phone: device.phone,
    name: device.name,
    createdAt: new Date().toISOString(),
    status: "open",
    challenge: randomBytes(32).toString("hex"),
    code: ToneCodec.randomCodeHex(),   // rendezvous code for the voice leg
    assistantCode: ToneCodec.randomCodeHex(),   // released only to the customer's authorised AI
    assistantVerified: false,
    verifiedDevice: false,
    flagged: false,
    call: null,                        // { sid, placedAt, answeredAt, endedAt }
    turns: [],                         // Patent 2 measurements
    loginContext: context || "app",
    divert: !!opts.divert,             // bank calls the customer's AI assistant, not the handset
    method: opts.method === "pauses" ? "pauses" : "tones",   // what carries the proof in the call
    recording: null,                   // { sid, durationS } once Twilio has it
    log: []
  };
  sessions.set(session.id, session);
  await log(session, "login_attempt", { context: context || "app", divert: session.divert, proof: session.method, challenge: session.challenge.slice(0, 12) + "..." });
  return session;
}

async function finishLogin(sessionId, signatureB64) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("unknown session");
  const device = devices.get(session.deviceId);
  const text = `login:${session.id}:${session.challenge}`;
  const ok = signatureB64 ? await verifyDeviceSignature(device.publicJwk, text, signatureB64) : false;
  if (ok) {
    session.verifiedDevice = true;
    session.status = "verified";
    await log(session, "signature_valid", { keyVersion: device.keyVersion });
    await log(session, "session_closed", { outcome: "silent login, no OTP" });
    session.status = "closed";
  } else {
    session.flagged = true;
    session.status = "flagged";
    await log(session, "signature_invalid", { reason: signatureB64 ? "signature did not verify against enrolled key" : "device could not sign (key invalidated)" });
  }
  return { ok, session };
}

// The handset heard a code on the microphone and reports it over the data
// link. If it matches this session the bank signs (code + session) so the
// handset can prove the voice on the line is the party on the data link.
async function confirmHeardCode(sessionId, heardHex, heardBy) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("unknown session");
  heardBy = heardBy || "handset";
  const match = heardHex && heardHex.toLowerCase() === session.code;
  if (!match) { await log(session, "tone_mismatch", { heard: heardHex, heardBy }); return { ok: false }; }
  const text = `bank:${session.id}:${session.code}`;
  const bankSignature = await bankSign(text);
  if (!session.bankVerified) {
    session.bankVerified = true;
    await log(session, "bank_verified", { heardBy, method: `tone heard by ${heardBy}, matched session code, bank signature issued` });
  }
  return { ok: true, text, bankSignature };
}

// Patent 2: the short/long pattern of the gaps between the bank's words,
// derived from this session's secret. Never sent to the listener in advance.
function expectedPauseBits(session) {
  const mac = createHmac("sha256", session.code).update("pauses:" + session.id).digest();
  const bits = [];
  for (let i = 0; i < PauseCodec.gapCount(); i++) bits.push((mac[i >> 3] >> (7 - (i & 7))) & 1);
  return bits;
}

// The sentence with each gap the listener measured written in: "·" for a
// short gap, "———" for a long one. This is where the code was in the words.
function readWords(bits) {
  const words = PauseCodec.PHRASES;
  return words.map((w, i) => i < words.length - 1 ? w + (bits[i] === undefined ? " ? " : bits[i] ? " ——— " : " · ") : w).join("");
}

// The listener measured the gaps between the words it heard and reports them
// over the data link. If they match the session's pattern the bank signs,
// exactly as for the tone: the voice on the line is the party on the data link.
async function confirmHeardPauses(sessionId, gapsMs, heardBy) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("unknown session");
  heardBy = heardBy || "handset";
  if (!Array.isArray(gapsMs) || gapsMs.length > 60 || !gapsMs.every(g => typeof g === "number" && g >= 0 && g < 10000)) throw new Error("bad gaps");
  const expected = expectedPauseBits(session);
  const heard = PauseCodec.gapsToBits(gapsMs);
  // a stretch of speech nowhere near the sentence's length is just conversation
  if (Math.abs(heard.length - expected.length) > 4) return { ok: false, ignored: true };
  // The bank's sentence is said once, so only the first report that looks
  // like it is judged; later speech on the call is conversation.
  if (session.pauseJudged) return { ok: false, ignored: true };
  session.pauseJudged = true;
  const m = PauseCodec.matchGaps(gapsMs, expected);
  if (!m.ok) { await log(session, "pause_mismatch", { heardBy, heard: heard.join(""), errors: m.distance, gapsMs: gapsMs.map(Math.round) }); return { ok: false, heardBits: heard.join(""), errors: m.distance }; }
  const text = `bank:${session.id}:${session.code}`;
  const bankSignature = await bankSign(text);
  if (!session.bankVerified) {
    session.bankVerified = true;
    await log(session, "pauses_matched", { heardBy, heard: heard.join(""), expected: expected.join(""), errors: m.distance, reading: readWords(heard) });
    await log(session, "bank_verified", { heardBy, method: `pause pattern heard by ${heardBy} matched the session key, bank signature issued` });
  }
  return { ok: true, text, bankSignature, heardBits: heard.join(""), expectedBits: expected.join(""), errors: m.distance, reading: readWords(heard) };
}

// ---- the customer's AI proving who it acts for ----
// The customer's phone signs a permission for its AI assistant with the same
// enrolled key it logs in with. During a diverted call, once the AI has
// verified the bank, it asks for this session's assistant code; the bank
// releases it only if that signed permission checks out against the enrolled
// key. The AI plays the code as a tone, the bank hears it on the line and
// matches it: the voice answering for the customer is the AI the customer
// authorised, on this call.
const ASSISTANT_ID = "customer-ai";
function delegationText(deviceId) { return `delegate:${deviceId}:${ASSISTANT_ID}`; }

async function registerDelegation(deviceId, signatureB64) {
  const device = devices.get(deviceId);
  if (!device) throw new Error("device not enrolled");
  const text = delegationText(deviceId);
  if (!(await verifyDeviceSignature(device.publicJwk, text, signatureB64))) throw new Error("permission signature did not verify against the enrolled key");
  device.delegation = { text, signature: signatureB64, at: new Date().toISOString(), keyVersion: device.keyVersion };
  return { ok: true, text };
}

async function issueAssistantCode(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("unknown session");
  const device = devices.get(session.deviceId);
  const d = device && device.delegation;
  const valid = !!(d && session.divert && await verifyDeviceSignature(device.publicJwk, delegationText(device.deviceId), d.signature));
  if (!valid) { await log(session, "assistant_not_authorised", { reason: d ? "permission no longer matches the enrolled key" : "the customer's phone has not signed a permission for an AI assistant" }); return null; }
  await log(session, "assistant_authorised", { permission: d.text, signedBy: `customer's enrolled key, version ${d.keyVersion}`, note: "one-time assistant code released to the customer's AI" });
  return session.assistantCode;
}

// The bank's side heard a tone from the customer's end of the line.
async function confirmAssistantTone(sessionId, heardHex) {
  const session = sessions.get(sessionId);
  if (!session || session.assistantVerified) return { ok: !!(session && session.assistantVerified) };
  if (!heardHex || heardHex.toLowerCase() !== session.assistantCode) {
    await log(session, "assistant_tone_mismatch", { heardBy: "bank", heard: heardHex });
    return { ok: false };
  }
  session.assistantVerified = true;
  await log(session, "customer_agent_verified_by_bank", { heardBy: "bank", method: "tone from the customer's AI matched the one-time code released only against the customer's signed permission" });
  if (session.bankVerified) await log(session, "ai_to_ai_verified", { note: "both agents proved who they act for: the bank's agent to the customer's AI, and the customer's AI to the bank" });
  return { ok: true };
}

// Verify a bank signature against a pinned public key (the customer agent
// pins the bank key the same way the handset does at enrolment).
async function verifyBankSignature(pinnedJwk, text, signatureB64) {
  return verifyDeviceSignature(pinnedJwk, text, signatureB64);
}

function publicView(session) {
  if (!session) return null;
  const { challenge, code, assistantCode, ...rest } = session;
  return { ...rest, codeHint: code.slice(0, 4) + "..." };
}

module.exports = {
  initBankKey, bankSign, log, subscribe, enrol, getDevice,
  delegationText, registerDelegation, issueAssistantCode, confirmAssistantTone,
  startLogin, finishLogin, confirmHeardCode, confirmHeardPauses, expectedPauseBits, verifyBankSignature, publicView,
  getSession: id => sessions.get(id),
  bankPublicJwk: () => bankKey.publicJwk
};
