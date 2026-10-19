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
    lib/analysis.js     Patent 2 measurements
    lib/tonecodec.js    narrowband codec shared by server and browser (copy in public/lib)
    public/index.html   the phone screen
    test/               codec and bridge self-tests

## Phase two

Inbound diversion: the customer forwards declined calls to the Twilio number,
the agent verifies the caller, then conferences the customer in with a muted
listen-in option. Same bridge, different TwiML.
