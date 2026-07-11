# Provider Adapters

Each provider adapter must hide provider-specific details behind one internal contract.

Provider factory creates one provider session per WebSocket connection.

Required session shape:

```js
{
  sendAudio(buffer),
  endInput(context),
  interrupt(reason),
  close()
}
```

Rules:

- provider fallback must be explicit and logged
- provider credentials must come from environment variables
- adapters must not store child recordings
- each adapter should expose latency metrics

Next real adapter after the mock stand is verified: `GeminiLiveProvider`.
Do not leak Google-specific event names into the neutral `/realtime` protocol.
