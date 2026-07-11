# Device Requirements

## Target Device

The first hardware target is a new realtime-oriented device, not the current base Lunara toy.

## Audio

- microphone with stable near-field capture
- speaker loud enough for a child room
- echo control strategy
- hardware mute path or equivalent safety control
- low-latency audio pipeline

## Network

- Wi-Fi connection with reconnect support
- persistent WebSocket session
- heartbeat and server-side timeout handling
- backpressure when uplink audio is faster than provider processing

## Codec

Preferred transport codec:

- Opus for realtime network transport

Fallback formats for lab testing:

- PCM16
- WAV upload for offline comparison

## Compute

Hardware should have enough memory for:

- audio capture buffer
- Opus encode/decode buffer
- WebSocket frame queue
- local playback queue
- reconnect state

ESP32-S3 with PSRAM is a likely early lab candidate, but final hardware is not locked.

## Latency Budget

Initial target:

- less than 300 ms local capture buffering
- less than 800 ms time to first server audio in ideal network conditions
- less than 1500 ms perceived response start in normal conditions

These numbers are lab targets, not product promises.

