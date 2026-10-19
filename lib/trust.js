// Trust server core: device enrolment, login challenges, signature checks,
// rendezvous codes, bank identity signatures, and the signed audit log that
// the phone app watches live.
//
// Storage is in memory for the demonstration. Every entry the server writes
// to a session's log is signed with the bank key so the customer sees the
// same record the fraud team would later rely on.

const { webcrypto, randomBytes, createHash } = require("crypto");
const subtle = webcrypto.subtle;
const ToneCodec = require("./tonecodec");

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
  return rec;
}
function getDevice(deviceId) { return devices.get(deviceId); }

// ---- sessions ----
function newSessionId() { return "S-" + randomBytes(4).toString("hex").toUpperCase(); }

async function startLogin(deviceId, context) {
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
    verifiedDevice: false,
    flagged: false,
    call: null,                        // { sid, placedAt, answeredAt, endedAt }
    turns: [],                         // Patent 2 measurements
    log: []
  };
  sessions.set(session.id, session);
  await log(session, "login_attempt", { context: context || "app", challenge: session.challenge.slice(0, 12) + "..." });
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
async function confirmHeardCode(sessionId, heardHex) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("unknown session");
  const match = heardHex && heardHex.toLowerCase() === session.code;
  if (!match) { await log(session, "tone_mismatch", { heard: heardHex }); return { ok: false }; }
  const text = `bank:${session.id}:${session.code}`;
  const bankSignature = await bankSign(text);
  session.bankVerified = true;
  await log(session, "bank_verified", { method: "tone heard on handset, matched session code, bank signature issued" });
  return { ok: true, text, bankSignature };
}

function publicView(session) {
  if (!session) return null;
  const { challenge, code, ...rest } = session;
  return { ...rest, codeHint: code.slice(0, 4) + "..." };
}

module.exports = {
  initBankKey, bankSign, log, subscribe, enrol, getDevice,
  startLogin, finishLogin, confirmHeardCode, publicView,
  getSession: id => sessions.get(id),
  bankPublicJwk: () => bankKey.publicJwk
};
