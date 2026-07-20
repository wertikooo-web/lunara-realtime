# Lunara Realtime Lab

Experimental realtime audio stack for a separate next-generation Lunara device.

This repository is intentionally isolated from the production Lunara Toy Server. It is a sandbox for a different device line built around realtime, low-latency, full-duplex voice interaction.

The current base Lunara device continues to evolve in the main server on the existing architecture. This lab must not be treated as a replacement or migration branch for that product.

## Goals

- Test full-duplex audio over WebSocket.
- Measure latency for STT + LLM + TTS versus audio-to-audio models.
- Evaluate Opus transport for ESP32-S3 class devices.
- Compare providers such as SenseVoice, Qwen-Audio, MiniMax, Fish Audio, and SiliconFlow.
- Keep all experiments reproducible and disposable.

## Non-goals

- No production traffic.
- No parent panel changes.
- No changes to the main server pipeline.
- No automatic migration path into the base device.
- No firmware changes until lab metrics pass.
- No child data storage.

## Quick Start

```bash
npm install
npm start
```

Health check:

```bash
curl http://localhost:3100/health
```

Browser lab:

```text
http://localhost:3100/lab
```

Realtime endpoint:

```text
ws://localhost:3100/realtime
```

## Diagnostic audio capture

Opt-in capture writes two WAV files for each selected device turn: the exact
PCM received from the device and the 16 kHz PCM produced by the server
resampler. It is disabled unless every required variable is configured.

```text
AUDIO_DEBUG_CAPTURE_ENABLED=true
AUDIO_DEBUG_DEVICE_ID=<exact-device-id>
AUDIO_DEBUG_TOKEN=<random-secret-with-at-least-24-characters>
AUDIO_DEBUG_MAX_TURNS=20
AUDIO_DEBUG_MAX_TURN_SECONDS=30
AUDIO_DEBUG_RETENTION_HOURS=24
AUDIO_DEBUG_CAPTURE_DIR=tmp/audio-debug
```

Send the secret only in the `X-Audio-Debug-Token` header. Never put it in a
URL. List captures with `GET /api/audio-debug/:deviceId`, download
`/:captureId/raw` or `/:captureId/resampled`, and delete a capture with
`DELETE /api/audio-debug/:deviceId/:captureId`. Capture files are local to the
running container and may disappear on a restart or deployment.

## Project Shape

- `src/server.js` - minimal lab server with health and status endpoints.
- `src/realtime/` - mock realtime WebSocket protocol and streaming provider.
- `public/lab.html` - browser lab for microphone, playback, interrupt, reconnect, and latency metrics.
- `docs/ARCHITECTURE.md` - target architecture and product boundaries.
- `docs/ROADMAP.md` - phased implementation plan.
