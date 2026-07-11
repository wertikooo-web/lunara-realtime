# Roadmap

## Phase 0 - Repository Scaffold

- Create isolated repo.
- Add health endpoint.
- Document architecture and boundaries.

## Phase 1 - Mock Realtime Loop

- Add WebSocket endpoint.
- Accept fake PCM or Opus-like frames.
- Stream deterministic mock audio events back to the client.
- Measure round-trip latency.

## Phase 2 - Browser Lab Client

- Add local browser test page.
- Capture microphone audio.
- Display live latency and connection state.
- Support interruption tests.

## Phase 3 - Provider Adapters

- Add one adapter at a time.
- Keep each provider behind the same interface.
- Log fallback clearly.
- Compare quality, latency, and cost.
- First real provider after mock verification: Gemini Live.

## Phase 4 - New Device Lab Firmware

- Add a separate firmware branch or repo.
- Test Opus encode/decode.
- Verify reconnect and backpressure behavior.

## Phase 5 - Decision Report

- Decide whether the realtime stack is strong enough for a separate device prototype.
- Keep the base Lunara product on its current architecture.
- Document only explicit reusable learnings, not an automatic migration.
