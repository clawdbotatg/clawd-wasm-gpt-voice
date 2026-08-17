# clawd-wasm-gpt-voice — full-duplex browser voice via WASM echo cancellation

> ## ❌ FINAL: FAILED the acceptance test (2026-08-17)
> Every component works (spike passed on iPhone: wasm AEC, remote-track tap,
> delay tracking, 26dB cancellation) — but live conversation on an iPhone
> speaker self-interrupted at that suppression level, and the echo-gate that
> stopped it made turn-taking feel gated and unnatural. Conclusion: browser
> WASM AEC cannot deliver the natural GPT-app speaker experience on iOS;
> OS-level echo cancellation (native iOS/macOS shells — demos 1 and 2) is
> the path. Kept as a flagged experiment: works with headphones and on
> desktop. Full write-up: clawd-harness `docs/voice/BUILD-WASM-AEC.md`.

Fork of [clawdbotatg/gpt-voice](https://github.com/clawdbotatg/gpt-voice)
(the verified-working `gpt-realtime` WebRTC demo — see `UPSTREAM-README.md` /
`INTEGRATION.md`) that changes ONLY the audio path: instead of trusting the
browser's `echoCancellation` (which dies on a phone speaker — the model hears
itself, interrupts itself, and loops), the mic runs **raw** through our own
echo canceller — speexdsp's MDF adaptive filter compiled to WASM, running in
an `AudioWorklet`, with a reference tap of the assistant's remote audio track.

```
mic getUserMedia (echoCancellation: FALSE)
        │
        ▼                        remote WebRTC track (assistant voice)
  AudioWorkletNode  ◄── reference ── MediaStreamAudioSourceNode
  (speexdsp AEC, 48kHz mono, 128↔480-sample ring bridge, 200ms tail)
        │
        ▼
  MediaStreamAudioDestinationNode ──► pc.addTrack   (cleaned mic to OpenAI)
```

The remote track *also* stays attached to the `<audio>` element — that is both
the speaker output and a hard requirement: a WebAudio tap of a remote WebRTC
track yields **silence** unless some media element consumes the stream
(verified on desktop Chrome, spike test 1).

## Run

```
cp .env.example .env   # OPENAI_API_KEY=...   (or inherit from environment)
python3 serve.py       # http://127.0.0.1:8123 + https://<LAN-IP>:8443 (self-signed)
```

- `/` — the demo. "🔇 WASM echo cancel" toggle (default on) picks the wasm
  path; off = plain browser AEC. The AEC line under the status shows live
  cancellation depth. Falls back to browser AEC automatically if
  worklet/wasm setup fails.
- `/spike.html` — the go/no-go tests, phone-friendly, results auto-POST to
  `/report` → `spike-results.jsonl`:
  - **test 0** synthetic pipeline (no mic/speaker): real wasm + worklet vs a
    simulated 50ms/-6dB echo. Validates the whole in-browser pipeline.
  - **test 1** remote-track tap: does `MediaStreamAudioSourceNode` on a remote
    WebRTC track produce samples (plain and with the muted-element workaround)?
  - **test 2** speaker loop: looped voice clip out the speaker, raw mic through
    the canceller, ERLE measured + raw/cleaned recordings to audition.

## aec/

- `build.sh` — clones speexdsp, compiles `mdf.c` (+ `preprocess.c` residual
  suppression) with emscripten to standalone `aec.wasm` (67KB, no JS glue;
  4 trivial WASI stubs). The artifact is committed.
- `aec-worklet.js` — 2-in/1-out `AudioWorkletProcessor`: instantiates the wasm
  (bytes passed via `processorOptions` — worklets can't fetch), ring-buffers
  128-sample quanta into 10ms frames, posts ERLE stats each second.
- `test_aec.mjs` — `node aec/test_aec.mjs`: numeric convergence test
  (simulated 12ms/-6dB echo, speech-shaped noise). Expect >60dB settled.
  NB pure sine tones are a known-pathological far end for MDF — don't "simplify"
  the test signal.

## tools/

- `spikeprobe.mjs` — drives spike.html in a local Chromium
  (`--no-audio-out` for machines with broken/no audio out; `--t1-only` skips
  the audible test 2).
- `demoprobe.mjs` — drives the real demo with stubbed token/SDP/WebRTC/mic and
  asserts the wiring: cleaned track (not raw mic) sent to the peer connection,
  remote tapped into the reference input, wasm instantiated, fallback works.
  Both need `playwright-core` (`ln -s` or `npm i` it under `tools/`).

## Status

See the Status block in clawd-harness `docs/voice/BUILD-WASM-AEC.md` for the
authoritative per-device spike + speaker-loop results.

- 2026-08-16 numeric: wasm canceller converges to ~68dB ERLE (node) and ~44dB
  in-browser (test 0, desktop Chrome).
- 2026-08-16 desktop Chrome: test 0 PASS, test 1 PASS **only with** the
  element-consumer workaround (plain tap silent), test 2 not runnable on the
  build box (system CoreAudio wedged — `AudioQueueStart -66681`).
- 2026-08-16 **iPhone (iOS 18.7 Safari): SPIKE PASSED** — test 0 PASS
  (40.8dB), test 1 PASS with the *plain* tap (no workaround needed on iOS),
  test 2 PASS (17.4dB settled / 33.3 peak) after fixing a worklet
  ring-alignment bug the first run exposed (empty far quanta shifted the
  echo alignment → ERLE sawtooth, 8.5dB FAIL; now zero-padded lockstep).
- Real-OpenAI E2E from desktop (`tools/e2eprobe.mjs`): all green.
- Remaining: the ten-minute speaker-loop conversation test on the live demo.
