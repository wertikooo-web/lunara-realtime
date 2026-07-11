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

## Project Shape

- `src/server.js` - minimal lab server with health and status endpoints.
- `docs/ARCHITECTURE.md` - target architecture and product boundaries.
- `docs/ROADMAP.md` - phased implementation plan.
