# Provider Adapters

Each provider adapter must hide provider-specific details behind one internal contract.

Required shape:

```js
{
  name,
  startSession(options),
  sendAudioFrame(session, frame),
  sendText(session, text),
  closeSession(session)
}
```

Rules:

- provider fallback must be explicit and logged
- provider credentials must come from environment variables
- adapters must not store child recordings
- each adapter should expose latency metrics

Next real adapter after the mock stand is verified: `GeminiLiveProvider`.
Do not leak Google-specific event names into the neutral `/realtime` protocol.
