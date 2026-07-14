# ESP32 24 kHz hardware mode with server-side input resampling

## Fixed device format

The ESP32 microphone and speaker share one codec and one I2S sample rate.
Use PCM16LE mono at 24000 Hz for both capture and playback.

## Data path

1. ESP32 captures microphone audio at 24000 Hz.
2. ESP32 sends binary WebSocket audio frames to `/realtime` at 24000 Hz.
3. The server performs stateful streaming resampling from 24000 Hz to 16000 Hz.
4. Gemini Live receives PCM16LE mono at 16000 Hz.
5. Gemini Live returns native PCM16LE mono at 24000 Hz.
6. The server returns Gemini output to ESP32 unchanged.

## Session declaration

ESP32 must declare its input sample rate in `session.start`:

```json
{
  "type": "session.start",
  "deviceId": "YOUR_DEVICE_ID",
  "sampleRate": 24000
}
```

Browser Lab remains compatible. If `sampleRate` is omitted, the server defaults to 16000 Hz and uses a byte-for-byte pass-through path.

Protocol V1 supports only these client input rates:

- `16000`: pass-through to Gemini Live.
- `24000`: stateful server-side resampling to 16000.

Other rates are rejected with `unsupported_input_sample_rate`.
