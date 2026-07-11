# API Contract

## Transport

Primary transport:

```text
WebSocket /realtime
```

All control messages are JSON. Audio frames may be binary after the session is opened.

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

Server replies:

```json
{
  "type": "session.ready",
  "sessionId": "opaque-session-id",
  "provider": "mock"
}
```

## Audio Upload

Binary frames:

```text
<audio frame bytes>
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

