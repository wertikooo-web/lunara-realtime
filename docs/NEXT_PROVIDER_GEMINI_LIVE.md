# Next Provider: Gemini Live

After the mock realtime stand is manually verified, the first real provider adapter should be `GeminiLiveProvider`.

## Why This Provider First

- free tier is useful for demand testing
- low paid test cost
- true bidirectional audio-to-audio streaming
- interruption support
- suitable for 20-30 browser conversations before hardware work

## Boundary

Do not change the public `/realtime` protocol to match Google-specific event names or payloads.

Gemini events must be translated inside the provider adapter into the neutral Lunara realtime events:

- `response.created`
- `audio.start`
- `audio.chunk`
- `audio.end`
- `response.cancelled`
- `error`

## Not In This Phase

Do not add OpenAI, MiniMax, or SiliconFlow before the Gemini Live adapter is evaluated.

Do not connect hardware before browser testing covers:

- first audio latency
- interruption behavior
- Russian conversation
- Romanian conversation
- reconnect behavior

