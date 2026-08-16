# gpt-voice

Minimal browser demo of OpenAI's **Realtime API** (`gpt-realtime`) — talk to a
voice agent over WebRTC with semantic turn detection (pauses handled like a
human), barge-in interruption, and a sample tool call (`flip_coin`).

No dependencies: stdlib Python server + one HTML file.

## Run

```bash
cp .env.example .env   # paste your OpenAI API key (platform.openai.com/api-keys)
python3 serve.py       # → http://127.0.0.1:8123
```

Open it in Chrome/Safari, hit **Start**, allow the mic, talk.

Things to try:
- Pause mid-sentence with "ummm…" — it waits instead of jumping in (semantic VAD).
- Interrupt it while it's talking — it stops.
- "Flip a coin" — watch the tool call round-trip in the log.

## How it works

- `serve.py` mints an **ephemeral client secret** (`POST /v1/realtime/client_secrets`)
  so your real API key never reaches the browser. Session config (model, voice,
  `semantic_vad`, instructions, tools) lives here.
- `index.html` does `getUserMedia` → `RTCPeerConnection` → SDP exchange with
  `https://api.openai.com/v1/realtime/calls`. Audio flows peer-to-peer; JSON
  events (transcripts, tool calls) ride a WebRTC data channel (`oai-events`).
- Tool calls arrive as `response.function_call_arguments.done` events; the page
  answers with a `function_call_output` item + `response.create`.

## Knobs

- `REALTIME_MODEL=gpt-realtime-mini` in `.env` — ~3× cheaper for prototyping
  (~$0.02–0.05/min vs $0.06–0.11/min).
- Voice: `audio.output.voice` in `serve.py` (`marin`, `cedar`, `alloy`, …).
- Turn-taking eagerness: `turn_detection.eagerness` (`low`/`auto`/`high`).

Background research: [RESEARCH.md](RESEARCH.md).
