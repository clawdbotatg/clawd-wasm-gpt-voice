# Adding gpt-realtime voice to your codebase — implementation guide

This is a portable recipe for giving any web project a live voice interface:
talk to it, it talks back, it can call your functions. It is written for an
AI agent (or human) implementing this in a **different** codebase. Everything
here was verified working live on 2026-08-16 in the reference implementation:
**github.com/clawdbotatg/gpt-voice** (~150 lines of Python, ~250 of HTML/JS,
zero dependencies). When in doubt, read that repo's `serve.py` and
`index.html` — they are the canonical working code, and `HANDOFF.md` there
records what is verified vs. assumed.

## What you get

- **Native speech-to-speech** (OpenAI `gpt-realtime` family): no STT→LLM→TTS
  pipeline, sub-300ms responses, hears tone, natural prosody.
- **Semantic VAD**: the model judges from your *words* whether you're done
  talking — trail off with "ummm…" and it waits. This is the feature that
  makes it feel human. Tunable (`eagerness`: low/medium/high/auto).
- **Barge-in**: interrupt it mid-sentence, it stops. Native, free.
- **Tool calling**: the voice model calls functions you define; you run them
  (client- or server-side) and it speaks the result. This is the hook for
  making it do real work in your project.

## Requirements

- An `OPENAI_API_KEY` (any funded platform.openai.com account; no ChatGPT
  subscription involved). Billing is per audio token: full model ≈
  $0.06–0.11/min, mini ≈ $0.02–0.05/min, output dominates.
- A browser client (this recipe is WebRTC). Server-to-server instead? Same
  events over WebSocket — see the realtime docs, not covered here.
- HTTPS or localhost — `getUserMedia` (mic) requires a secure context.
  `http://127.0.0.1` works; `http://<LAN-IP>` does NOT (see Traps).

## Architecture (3 pieces)

```
[your server]  --(1) POST /token: real API key mints ephemeral secret-->  [OpenAI]
[browser]      --(2) WebRTC SDP offer + ephemeral secret------------->  [OpenAI]
[browser]      <--(3) audio track (their voice) + data channel (JSON events)-->
```

The real API key lives ONLY on your server. The browser gets a short-lived
ephemeral secret per session. Never ship the real key to the client.

### Piece 1 — server: token minting endpoint

One endpoint. It calls `POST https://api.openai.com/v1/realtime/client_secrets`
with the real key and the **full session config** (model, voice, instructions,
VAD, tools — config is server-authoritative). Verified request body shape:

```json
{
  "session": {
    "type": "realtime",
    "model": "gpt-realtime",
    "instructions": "You are a concise voice assistant for <your project>...",
    "audio": {
      "input": {
        "turn_detection": { "type": "semantic_vad", "eagerness": "auto" },
        "transcription": { "model": "gpt-4o-mini-transcribe" }
      },
      "output": { "voice": "marin" }
    },
    "tools": [
      { "type": "function", "name": "flip_coin",
        "description": "Flip a coin and return heads or tails.",
        "parameters": { "type": "object", "properties": {} } }
    ]
  }
}
```

Headers: `Authorization: Bearer <REAL_KEY>`, `Content-Type: application/json`.

**Verified response shape (2026-08-16): top-level `{value, expires_at,
session}`** — the ephemeral secret is `response.value` (NOT nested under
`client_secret`). Return the whole JSON to the browser.

Notes:
- Without `audio.input.transcription` you get NO user-side transcripts —
  include it unless you truly don't want them.
- If the browser can pick options (voice, model, persona), validate against
  server-side allowlists; the client should never inject arbitrary session
  config with your key.

### Piece 2 — browser: WebRTC session (~40 lines)

```js
const tok = await fetch('/token', { method: 'POST' }).then(r => r.json());
const secret = tok.value;

const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
const pc = new RTCPeerConnection();
const audioEl = new Audio(); audioEl.autoplay = true;
pc.ontrack = e => { audioEl.srcObject = e.streams[0]; };
pc.addTrack(mic.getTracks()[0], mic);

const dc = pc.createDataChannel('oai-events');   // name is significant
dc.onmessage = e => handleEvent(JSON.parse(e.data));

const offer = await pc.createOffer();
await pc.setLocalDescription(offer);
const resp = await fetch('https://api.openai.com/v1/realtime/calls', {
  method: 'POST', body: offer.sdp,
  headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/sdp' },
});
await pc.setRemoteDescription({ type: 'answer', sdp: await resp.text() });
// live: audio flows on the media track, all JSON events on the data channel
```

Teardown: stop mic tracks, close data channel, close peer connection.

### Piece 3 — browser: event loop + tool calls

The GA event names (all verified live 2026-08-16):

| event `type`                                          | meaning / action |
|-------------------------------------------------------|------------------|
| `conversation.item.input_audio_transcription.completed`| user transcript in `.transcript` |
| `response.output_audio_transcript.done`                | assistant transcript in `.transcript` |
| `response.function_call_arguments.done`                | tool call: `.name`, `.arguments` (JSON string), `.call_id` |
| `input_audio_buffer.speech_started`                    | user began talking (good for UI state) |
| `response.created` / `response.done`                   | assistant turn start / end |
| `error`                                                | `.error` object — always log these |

Tool-call handling — execute the function, then send TWO events back on the
data channel (the second one is easy to forget and without it the model
never speaks the result):

```js
case 'response.function_call_arguments.done': {
  const output = JSON.stringify(await runTool(ev.name, JSON.parse(ev.arguments || '{}')));
  dc.send(JSON.stringify({ type: 'conversation.item.create', item: {
    type: 'function_call_output', call_id: ev.call_id, output } }));
  dc.send(JSON.stringify({ type: 'response.create' }));   // <- makes it speak the result
  break;
}
```

Tools can be async (fetch an API, hit your backend) — just guard that the
data channel is still open when the result arrives. **This is where you
integrate your project**: replace `flip_coin` with functions that query your
app's state, backend, or an outside API. The model handles "when to call"
from the `description` fields.

## Configuration space (all verified accepted)

- **Models**: `gpt-realtime` (alias → latest full), `gpt-realtime-2.1`
  (pinned full), `gpt-realtime-mini` (~3× cheaper — try it; the Dec-2025
  snapshot is good at tools/instructions). Pin for prod, alias for play.
- **Voices on realtime**: `marin`, `cedar` (newest/best), `alloy`, `echo`,
  `sage`, `shimmer`, `verse`. The TTS-only voices (`ash`, `ballad`, `coral`,
  `fable`, `onyx`, `nova`) are NOT valid here. Custom/cloned voices are
  sales-gated at OpenAI (not self-serve as of 2026-08).
- **Turn detection**: `semantic_vad` (+ `eagerness`) or `server_vad`
  (plain silence — set it to feel why semantic is better).
- **Speech speed**: `audio.output.speed`, 0.25–1.5 (verified accepted).
- **Instructions**: the persona. Biggest lever on feel; keep it short and
  voice-specific ("keep answers short and conversational" matters — default
  behavior is too chatty for voice).

## Traps (each of these cost real debugging time — read before starting)

1. **Mic needs a secure context.** `127.0.0.1` is fine; a LAN IP over http
   is not — `getUserMedia` throws. For phone/off-box demos, serve HTTPS with
   a self-signed cert (SAN must include the LAN IP; accept the warning once
   per device) or use a tunnel. Reference repo's `serve.py` `ensure_cert()`
   does exactly this with one `openssl` call.
2. **Both post-tool events.** Sending only `conversation.item.create` after a
   tool call = the model knows the answer but never says it. Send
   `response.create` too.
3. **Transcription is opt-in.** No `audio.input.transcription` in the session
   config → user transcript events never arrive. Looks like an event-name
   bug; isn't.
4. **Token shape.** The secret is top-level `value` on the client_secrets
   response. Older samples show `client_secret.value` — dead shape.
5. **Voice allowlist.** A TTS-only voice name in the session config fails the
   mint. Stick to the seven above.
6. **Port collisions.** Don't blindly bind a common dev port; if a smoke-test
   curl returns unexpected content, check *which server* answered
   (`lsof -nP -iTCP:<port> -sTCP:LISTEN`).
7. **Autoplay policy.** Start sessions from a user gesture (button click) so
   the `<audio>` element is allowed to play.

## Nice-to-haves proven in the reference repo

- **Voice preview**: `POST /v1/audio/speech` (`model: gpt-4o-mini-tts`) with
  the candidate voice + one sample sentence → mp3, cache per voice. All 7
  realtime voices exist on the TTS endpoint (verified) — same voice, slightly
  different delivery than realtime, fine for previews.
- **Live reconfigure**: config changes re-mint + reconnect (~2s). Voice/model
  cannot change mid-session; don't try, just reconnect.
- **A "smarter brain" tool**: give the realtime model an
  `ask_<agent>(question)` tool that forwards hard questions to a stronger
  model/agent (Claude, your backend agent) and speaks the answer. The voice
  layer keeps its turn-taking magic; the tool adds the brains. Have the
  persona say "let me check" while it waits.

## Verification checklist (do these in order)

1. Server mints: `curl -s -X POST <your>/token | jq .value` → non-null.
2. Browser: Start → mic prompt → status reaches live, no console errors.
3. Say something → user transcript renders (if not: trap #3).
4. It answers audibly (if silent: check autoplay / `pc.ontrack` wiring).
5. Interrupt it mid-answer → it stops (free — confirms VAD wiring).
6. Trigger a tool ("flip a coin") → call logged, result **spoken** (if
   logged but not spoken: trap #2).
7. Watch the `error` events — a wrong config usually surfaces there, not as
   an HTTP failure.

## Sources

- Realtime guide: https://developers.openai.com/api/docs/guides/realtime
- VAD/turn-taking: https://developers.openai.com/api/docs/guides/realtime-vad
- Costs: https://developers.openai.com/api/docs/guides/realtime-costs
- Reference implementation: https://github.com/clawdbotatg/gpt-voice
