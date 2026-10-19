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
    lib/assistant.js    customer-side AI agent for diverted calls, server-side tone and pause decode
    lib/virtualcall.js  in-server call between the two agents, recording, live audio
    lib/pausecodec.js   Patent 2 word-gap detector and matching (copy in public/lib)
    lib/analysis.js     Patent 2 measurements
    lib/tonecodec.js    narrowband codec shared by server and browser (copy in public/lib)
    public/index.html   the phone screen
    test/               codec and bridge self-tests

## Proof by pauses in the bank's weather update (Patent 2)

Choose "Pauses in the bank's weather update" on the page. After the greeting
the bank gives a quick weather update in its agent's voice, read as 15 short
phrases like a radio bulletin: "Weather update. Johannesburg, sunny and warm,
twenty six degrees ... Cape Town, cloudy, quite windy ... enjoy your day." Nothing in the words is special.
The 14 pauses between the phrases are each short (0.2 s) or long (0.6 s), and
that pattern is derived from the session secret with HMAC-SHA256, so it
differs on every call. The pauses are made by the voice engine itself through
`<break>` tags, so every word ends naturally and nothing is cut or spliced; it
sounds like a newsreader pacing a forecast. The listener (lib/pausecodec.js, shared by the browser and the server)
measures the pauses and reports them over the data link; the bank compares
them with the pattern it expected, tolerating up to two misjudged pauses, and
signs only if they match. A replayed recording carries an old session's
pattern and is rejected. If the speech service fails the call falls back to
tones. `GET /api/demo/pause-check` generates an update for a throwaway session
and decodes it (`?audio=1` returns the audio), to check the voice end to end.

Measured gaps run longer than the inserted ones, so the short/long split is
taken from each sentence's own gaps rather than a fixed threshold. Heavy
background noise fills the gaps; in a very noisy room the tone is more robust.

## How a call runs

1. The server plays the opening itself, in the agent's voice: "Hello Judd,
   this is Demo Bank calling." followed by the proof (the weather sentence or
   the tone). The ElevenLabs agent is connected only as that finishes, so it
   never sits through audio it didn't say.
2. The agent asks whether the login was the customer, listens, and follows
   the decision rules in `BANK_PROMPT` (lib/telephony.js). The prompt, first
   message and patient turn-taking settings are applied to the agent at every
   boot, so this repo is the source of truth, not the ElevenLabs dashboard.
3. The agent only says "Goodbye" once the customer has nothing else. The
   server hangs up only after that goodbye has finished playing and the
   customer has been quiet for 3 seconds; if the customer speaks, the hang-up
   is cancelled and the conversation carries on. Calls are capped at 4 minutes.

## Divert to my AI

Tick "Divert bank calls to my AI" on the page. A flagged login then connects
the bank's agent to a second ElevenLabs agent speaking for the customer
(lib/assistant.js). By default (`DIVERT_MODE=internal`) the two are joined
inside this server by lib/virtualcall.js, which plays each side to the other
in real time as 8 kHz phone audio, records the call, and streams it live to
the page. With `DIVERT_MODE=phone` the bank dials `TWILIO_ASSISTANT_NUMBER`
as a real call instead. It decodes the rendezvous tone straight from the call
audio, confirms the code over the data link, checks the bank's signature
against the pinned key, and only then treats the caller as Demo Bank. It
never gives out PINs, codes or card details either way. A forged or missing
tone is rejected after 30 seconds.

On boot the server finds or creates the assistant agent in ElevenLabs
(named "Untapped AI - Customer Assistant") and points the assistant number's
voice webhook at /twilio/assistant-inbound, so neither needs console setup.
Only these agent-to-agent calls are recorded; the page shows a player once
Twilio has the recording.

### AI talking to AI: the customer's AI proves itself too

When divert is on, the page signs a permission for the customer's AI with the
phone's enrolled key (`delegate:<deviceId>:customer-ai`). Once the customer's
AI has verified the bank, it asks for this call's assistant code; the bank
releases it only if that signed permission checks out against the enrolled
key. The AI plays the code as a short tone; the bank's leg decodes it from the
call audio and matches it, and the bank's agent is told it is speaking to the
customer's authorised AI. The page's "AI talking to AI" block shows both
checks, and the log records `ai_to_ai_verified` when both directions pass.

Real-world version: set conditional call forwarding (busy, no answer,
unreachable) on the customer's mobile to the assistant number.

Note: phones usually switch off the browser microphone during a call, so in
the handset flow keep this page open on a second device next to the phone.
