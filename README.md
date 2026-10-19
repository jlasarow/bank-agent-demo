# Bank Agent Demo

Untapped AI, fourth site in the voice trust series. Proves the flow where
the bank calls the customer, the customer's phone confirms the caller is the
bank, and every step lands in a signed audit log the customer sees live.

Nothing here touches the earlier sites. The tone codec was rewritten for the
telephone band because a Twilio call is 8 kHz mu-law and the 6.8 to 8.2 kHz
tones in Voice Trust Call cannot survive it.

## What the demo shows

1. The customer enrols: an ECDSA key is generated in the phone, the public
   half is registered with the bank, the bank's public key is pinned.
2. A normal login signs the bank's challenge with that key. No OTP, no SMS.
3. "Log in with a broken key" simulates a phone whose biometric set changed,
   or a SIM swapped onto a stranger's handset. The signature fails, the
   login is flagged, and the server places an outbound call to the enrolled
   number within seconds.
4. The ElevenLabs agent greets the customer, then the server plays a 1.3 s
   rendezvous tone under the call (Patent 1). The phone's web page hears it
   on the microphone, reports the code over the data link, and the bank
   signs code plus session with its pinned key. The tick turns green with
   "Demo Bank, verified".
5. The agent asks two questions. Reply latency, utterance length and pitch
   contour are measured and logged, not judged (Patent 2, measurement only).
6. The session closes and the audit log shows initiated, placed, answered
   and closed timestamps, every request the agent made and whether it was
   authorised, each entry hash-chained and signed by the bank key.

## Running locally

    npm install
    npm test          # codec round trip through a simulated phone line, bridge test
    npm start         # http://localhost:3000, telephony disabled until env is set

## Deploying on Render

The repo carries `render.yaml`. Create the service from it, then set the
secret environment variables in the Render dashboard:

    TWILIO_ACCOUNT_SID    from the Twilio console home
    TWILIO_AUTH_TOKEN     same place, click Show
    TWILIO_FROM_NUMBER    the purchased US voice number, E.164, e.g. +14135551234
    TWILIO_ASSISTANT_NUMBER  second number, answered by the customer's AI
    ELEVENLABS_API_KEY    ElevenLabs profile menu, API Keys
    ELEVENLABS_AGENT_ID   already set in render.yaml

On boot the server configures the ElevenLabs agent for mu-law 8 kHz audio
and uses Render's hostname for Twilio callbacks automatically.

## Demo script

Open the site on the phone that will receive the call. Enrol with that
phone's number. Tap "Log in with a broken key". When the call arrives,
answer on speaker. Watch the tick go green under the agent's greeting, then
answer the agent's two questions normally. The log fills in as you go.

## Layout

    server.js           HTTP, WebSocket upgrade, API routes
    lib/trust.js        enrolment, challenges, signatures, signed audit chain
    lib/telephony.js    Twilio outbound call, media stream bridge, ElevenLabs agent, tone injection
    lib/assistant.js    customer-side AI agent for diverted calls, server-side tone decode
    lib/analysis.js     Patent 2 measurements
    lib/tonecodec.js    narrowband codec shared by server and browser (copy in public/lib)
    public/index.html   the phone screen
    test/               codec and bridge self-tests

## Divert to my AI

Tick "Divert bank calls to my AI" on the page. A flagged login then makes the
bank's agent dial `TWILIO_ASSISTANT_NUMBER` instead of the handset. That
number is answered by a second ElevenLabs agent speaking for the customer
(lib/assistant.js). It decodes the rendezvous tone straight from the call
audio, confirms the code over the data link, checks the bank's signature
against the pinned key, and only then treats the caller as Demo Bank. It
never gives out PINs, codes or card details either way. A forged or missing
tone is rejected after 30 seconds.

On boot the server finds or creates the assistant agent in ElevenLabs
(named "Untapped AI - Customer Assistant") and points the assistant number's
voice webhook at /twilio/assistant-inbound, so neither needs console setup.
Only these agent-to-agent calls are recorded; the page shows a player once
Twilio has the recording.

Real-world version: set conditional call forwarding (busy, no answer,
unreachable) on the customer's mobile to the assistant number.

Note: phones usually switch off the browser microphone during a call, so in
the handset flow keep this page open on a second device next to the phone.
