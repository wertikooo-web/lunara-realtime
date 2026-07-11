# API Contract

## Transport

Primary transport:

```text
WebSocket /realtime
```

All control messages are JSON. Audio frames may be binary after the session is opened.
The mock server currently returns audio chunks as JSON events with base64 WAV payloads so the browser lab can decode and play each chunk immediately.

## Session Start

Client sends:

```json
{
  "type": "session.start",
  "deviceId": "lab-device-001",
  "lang": "ru-RU",
  "codec": "opus",
  "sampleRate": 16000
}
```

The server may also send `session.ready` immediately after the WebSocket connection is accepted.

Server replies:

```json
{
  "type": "session.ready",
  "sessionId": "opaque-session-id",
  "provider": "mock"
}
```

## Audio Upload

Start input:

```json
{
  "type": "input_audio.start",
  "turn_id": "optional-client-turn-id"
}
```

Binary frames:

```text
<audio frame bytes>
```

End input:

```json
{
  "type": "input_audio.end"
}
```

Server confirms:

```json
{
  "type": "input_audio.end",
  "turn_id": "turn_123",
  "duration_ms": 1200,
  "bytes": 65536
}
```

Then creates a response:

```json
{
  "type": "response.created",
  "response_id": "response_123",
  "turn_id": "turn_123",
  "input_bytes": 65536
}
```

Optional JSON wrapper for early debugging:

```json
{
  "type": "audio.frame",
  "sequence": 42,
  "timestampMs": 123456
}
```

## Server Audio Events

```json
{
  "type": "audio.start",
  "requestId": "opaque-request-id",
  "format": "opus"
}
```

Binary audio frames follow.

In the mock browser lab, audio chunks are JSON:

```json
{
  "type": "audio.chunk",
  "response_id": "response_123",
  "turn_id": "turn_123",
  "chunk_index": 0,
  "chunk_count": 8,
  "mime_type": "audio/wav",
  "audio_base64": "..."
}
```

```json
{
  "type": "audio.end",
  "requestId": "opaque-request-id",
  "durationMs": 1800
}
```

## Interrupt

Client sends:

```json
{
  "type": "session.interrupt",
  "reason": "child_started_speaking"
}
```

Server replies:

```json
{
  "type": "session.interrupted"
}
```

The mock server currently emits:

```json
{
  "type": "response.cancelled",
  "response_id": "response_123",
  "turn_id": "turn_123",
  "reason": "client_interrupt"
}
```

## Heartbeat

Client sends:

```json
{
  "type": "ping",
  "timestampMs": 123456
}
```

Server replies:

```json
{
  "type": "pong",
  "timestampMs": 123456
}
```

## Errors

```json
{
  "type": "error",
  "code": "provider_unavailable",
  "message": "Realtime provider is unavailable."
}
```

Errors must be recoverable unless the server closes the socket.
