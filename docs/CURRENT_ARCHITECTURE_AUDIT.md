# Lunara Realtime: Current Architecture Audit

Date: 2026-07-13
Scope: factual audit of `D:\AI\lunara-realtime` current code. No implementation changes are proposed here.

## Executive Summary

`lunara-realtime` is currently an isolated Browser Lab and realtime audio server. It is not a full production toy backend yet. The running system serves a browser test page at `/lab`, accepts a raw WebSocket at `/realtime`, streams browser microphone PCM to either a mock provider or Gemini Live, and streams provider audio chunks back to the browser.

There is no persistent database, no persistent child memory, no content library, and no production parent profile store in the current codebase. The only conversation state is in memory inside one WebSocket session and is lost on disconnect/server restart.

## 1. Entry Point: Browser Lab

Actual entry point:

- `src/server.js:55` creates the HTTP server.
- `src/server.js:96` serves `public/lab.html` for `GET /lab`.
- `public/lab.html:257` is the Browser Lab page title area.
- `public/lab.html:288` contains the Realtime Prompt Lab UI.

Browser responsibilities in `public/lab.html`:

- Connect/disconnect/reconnect to `/realtime`: `connect()` at `public/lab.html:684`.
- Capture microphone audio: `ensureMic()` at `public/lab.html:753`.
- Start PTT turn: `startTurn()` at `public/lab.html:803`.
- End PTT turn: `endTurn()` at `public/lab.html:851`.
- Manual interrupt: `manualInterrupt()` at `public/lab.html:892`.
- Handle server/provider events: `handleEvent()` at `public/lab.html:981`.
- Decode and play audio chunks: `handleAudioChunk()` at `public/lab.html:1093`.
- Pointer-event PTT button wiring: `public/lab.html:1294` to `public/lab.html:1297`.

The Browser Lab is a test harness, not a persistent app. It keeps local UI state and recent-turn preview in JS variables only.

## 2. WebSocket Flow

Endpoint:

- `src/realtime/realtimeServer.js:100` attaches an upgrade handler.
- `src/realtime/realtimeServer.js:105` listens for HTTP upgrade requests.
- Only `/realtime` is accepted; other upgrade paths get 404.
- `src/realtime/wsProtocol.js:7` performs the WebSocket handshake.
- `src/realtime/wsProtocol.js:48` parses WebSocket frames.
- `src/realtime/wsProtocol.js:116` sends JSON frames.
- `src/realtime/wsProtocol.js:122` can send binary frames, though server responses currently use JSON-wrapped audio payloads.

Client to server messages:

- JSON commands: `session.start`, `input_audio.start`, `input_audio.end`, `session.interrupt`, `ping` handled in `handleCommand()` at `src/realtime/realtimeServer.js:843`.
- Binary audio frames handled in `onBinary()` at `src/realtime/realtimeServer.js:917`.

Server to client events include:

- `session.ready` emitted at `src/realtime/realtimeServer.js:975`.
- `input_audio.start`, `input_audio.end`, `response.created`, `audio.start`, `audio.chunk`, `audio.end`, `transcript.user`, `transcript.model`, `response.cancelled`, `response.failed`, `provider.rotated`, `provider.ready`, `language.switch_detected`, errors.

## 3. Realtime Server

Core session creation:

- `createRealtimeSession()` starts at `src/realtime/realtimeServer.js:118`.
- Per-session state is stored in local variables in that function, including `currentTurnId`, `currentGeneration`, `recentTurns`, `promptBlocks`, `providerSession`, `sessionLanguage`, and counters.

Important functions:

- `rememberTurn()` at `src/realtime/realtimeServer.js:167` stores recent user/model text in memory only.
- `buildPromptBundle()` at `src/realtime/realtimeServer.js:174` creates the full prompt for a provider session.
- `buildProviderSessionOptions()` at `src/realtime/realtimeServer.js:188` passes voice, prompt text, prompt meta, source, rotation reason, and rotation mode to provider sessions.
- `emitProviderEvent()` at `src/realtime/realtimeServer.js:496` maps provider events to browser events and manages `response.created`, turn completion, retries, metrics, and provider reuse/rotation behavior.
- `rotateProviderSession()` at `src/realtime/realtimeServer.js:630` closes the old provider session and creates a new provider session using the current prompt bundle and same session voice.

Rotation modes:

- `GEMINI_ROTATION_MODE=per_turn|errors_only` is normalized at `src/realtime/realtimeServer.js:32` and `src/realtime/geminiLiveProvider.js:17`.
- In `per_turn`, normal output completion can rotate provider sessions.
- In `errors_only`, normal turns reuse the provider session; rotation still happens for interruptions, timeout/recovery, provider failures, session config, and language switch.

Language switch behavior:

- `detectLikelyLanguage()` at `src/realtime/realtimeServer.js:43` detects likely language from transcript text.
- `noteUserLanguage()` at `src/realtime/realtimeServer.js:242` updates `sessionLanguage` and schedules a language-switch rotation.
- `startInput()` at `src/realtime/realtimeServer.js:713` applies pending language-switch rotation before beginning the next input turn.

## 4. Gemini Live Provider

Provider selection:

- `src/server.js:20` creates either Gemini or mock provider factory based on `REALTIME_PROVIDER`.
- `src/server.js:24` uses `GeminiLiveProvider` when `REALTIME_PROVIDER=gemini`.

Gemini provider structure:

- `GeminiLiveProvider` class starts at `src/realtime/geminiLiveProvider.js:158`.
- `createSession()` starts at `src/realtime/geminiLiveProvider.js:167` and returns a new `GeminiLiveProviderSession`.
- `GeminiLiveProviderSession` starts at `src/realtime/geminiLiveProvider.js:184`.

Gemini session connection:

- `connect()` starts at `src/realtime/geminiLiveProvider.js:228`.
- `buildGeminiSpeechConfig()` at `src/realtime/geminiLiveProvider.js:35` builds `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`.
- `src/realtime/geminiLiveProvider.js:247` constructs `speechConfig`.
- `ai.live.connect()` is called at `src/realtime/geminiLiveProvider.js:264`.
- The config includes audio response modality, speech config, input/output transcription, server VAD config, and system instruction.

Audio flow:

- `sendAudio()` at `src/realtime/geminiLiveProvider.js:372` accepts PCM frames from the server.
- If Gemini is not connected yet, frames are buffered in `pendingAudio`; `flushPendingAudio()` at `src/realtime/geminiLiveProvider.js:402` sends them after connect.
- `sendAudioNow()` at `src/realtime/geminiLiveProvider.js:419` sends base64 PCM using `session.sendRealtimeInput({ audio: ... })`.
- `endInput()` at `src/realtime/geminiLiveProvider.js:429` connects if needed, flushes pending audio, and sends paced silence tail for PTT.
- `sendSilenceTail()` at `src/realtime/geminiLiveProvider.js:466` sends silence frames and then `audioStreamEnd`.

Provider output handling:

- `handleMessage()` at `src/realtime/geminiLiveProvider.js:678` converts Gemini messages into Lunara events.
- Input transcription is emitted as `transcript.user` around `src/realtime/geminiLiveProvider.js:702`.
- Output transcription is emitted as `transcript.model` around `src/realtime/geminiLiveProvider.js:711`.
- Audio parts become `audio.start` and `audio.chunk` around `src/realtime/geminiLiveProvider.js:721` onward.
- `generationComplete` and `turnComplete` are converted to `audio.end` through `emitOutputEnd()` at `src/realtime/geminiLiveProvider.js:798`.

## 5. PTT Lifecycle

Browser lifecycle:

1. User presses PTT.
2. `startTurn()` at `public/lab.html:803` ensures mic, resets IDs/metrics, sends `input_audio.start`.
3. Browser streams PCM frames over WebSocket binary frames.
4. User releases PTT.
5. `endTurn()` at `public/lab.html:851` sends `input_audio.end`.
6. Browser waits for transcript/model/audio events and plays audio chunks.
7. Manual interruption uses `manualInterrupt()` at `public/lab.html:892` and sends `session.interrupt`.

Server lifecycle:

1. `startInput()` at `src/realtime/realtimeServer.js:713` creates a new generation and calls provider `beginResponse()`.
2. `onBinary()` at `src/realtime/realtimeServer.js:917` forwards PCM chunks to `providerSession.sendAudio(payload)`.
3. `endInput()` at `src/realtime/realtimeServer.js:766` emits `input_audio.end`, arms PTT timeout, and calls provider `endInput()`.
4. Provider events are normalized by `emitProviderEvent()` at `src/realtime/realtimeServer.js:496`.
5. `response.created` is local Lunara state, not a raw Gemini event; `emitResponseCreated()` is inside `realtimeServer.js` and is called when first model/audio output arrives.
6. Timeouts and provider failures rotate provider session and return the client to usable state.

## 6. Prompt Blocks

Prompt source module:

- `src/realtime/realtimePrompt.js`.

Blocks:

| Block | Source | File/function evidence |
| --- | --- | --- |
| CORE SYSTEM PROMPT | Built-in default or Lab override | `DEFAULT_CORE_PROMPT` at `src/realtime/realtimePrompt.js:8` |
| CHILD PROFILE / CONFIRMED MEMORY | Built-in synthetic Lab child context or Lab override | `DEFAULT_CHILD_CONTEXT` at `src/realtime/realtimePrompt.js:53` |
| PARENT SETTINGS / RESTRICTIONS | Built-in synthetic Lab parent rules or Lab override | `DEFAULT_PARENT_RULES` at `src/realtime/realtimePrompt.js:61` |
| CURRENT CONTEXT | Generated from current mode, session language, and recent turns | `buildPromptBundle()` at `src/realtime/realtimeServer.js:174`; `buildCurrentContext()` at `src/realtime/realtimePrompt.js:97` |

Prompt assembly:

- `buildRealtimeSystemInstruction()` starts at `src/realtime/realtimePrompt.js:119`.
- It combines `[CORE SYSTEM PROMPT]`, `[CHILD PROFILE / CONFIRMED MEMORY]`, `[PARENT SETTINGS / RESTRICTIONS]`, and `[CURRENT CONTEXT]`.
- It also returns char counts and hashes for each block.

Prompt editability:

- `LAB_ALLOW_CUSTOM_PROMPT` is read from env at `src/realtime/realtimePrompt.js:6`.
- If not enabled, `sanitizePromptConfig()` at `src/realtime/realtimePrompt.js:173` returns default blocks.
- Browser Lab uses `applyPromptByReconnect()` at `public/lab.html:612`; the server handles `session.start` in `handleCommand()` at `src/realtime/realtimeServer.js:843`.

## 7. Where Conversation State Lives

Server-side WebSocket session state lives in closure-local variables inside `createRealtimeSession()`:

- `promptBlocks`, `promptSource`
- `recentTurns`
- `currentTurnId`
- `currentGeneration`
- `inputStartedAt`, `inputEndedAt`, `inputBytes`, `sessionInputBytes`
- `currentMode`
- `turnCounter`
- `providerSession`
- `providerSessionReuseCount`, `providerRotationCount`, `promptApplyCount`, `lateProviderEventsDropped`
- `sessionLanguage`, `pendingLanguageSwitch`

Evidence: declarations start around `src/realtime/realtimeServer.js:118`.

Browser-side UI state lives in `public/lab.html` script variables around `public/lab.html:351` onward, including lifecycle, IDs, mic stream, metrics, playback queue, cancelled IDs, Lab prompt defaults, and local recent turns.

## 8. What Persists Between Turns

Within one WebSocket session, these persist between turns:

- `recentTurns`, capped to 12 entries by `rememberTurn()` at `src/realtime/realtimeServer.js:167`.
- `promptBlocks` and `promptSource`.
- `sessionLanguage` and pending language switch state.
- `sessionVoiceName` and voice config source.
- `providerSession` when `GEMINI_ROTATION_MODE=errors_only` and no rotation condition occurs.
- counters such as session input bytes, turn count, reuse count, rotation count.

Not persisted between turns:

- `inputBytes` is reset at the start of each turn in `startInput()` at `src/realtime/realtimeServer.js:713`.
- `currentGeneration` is replaced each turn by `createGeneration()`.

## 9. What Persists Between Provider Rotations

When `rotateProviderSession()` runs at `src/realtime/realtimeServer.js:630`, the old provider session is closed/destroyed and a new provider session is created.

Preserved across provider rotation:

- WebSocket client session.
- `sessionVoiceName`; the same voice is passed into the new provider session through `buildProviderSessionOptions()`.
- `promptBlocks` and `promptSource`.
- `recentTurns` because `buildPromptBundle()` rebuilds current context from the server session closure.
- `sessionLanguage` and current language instruction.
- counters/log metadata.

Not preserved across provider rotation:

- Gemini Live network session/socket.
- Provider-local pending audio buffer.
- Provider-local `active` generation context.
- Gemini acoustic/session context. This is intentional for interrupt/error/language-switch cleanup.

## 10. What Persists Between Server Restarts

Nothing application-level is persisted by the current code.

Evidence:

- `package.json` dependencies include only `@google/genai` and no database packages.
- Search across `package.json`, `package-lock.json`, `src`, and `public` found no Postgres/SQLite/Supabase/Prisma/Mongoose usage and no server-side data write path.
- State is declared in memory inside `createRealtimeSession()` and browser JS variables.

After server restart, all sessions, prompt edits, recent turns, language state, provider state, and metrics are lost.

## 11. Persistent Database

There is no persistent database in the current codebase.

Confirmed by:

- `package.json` dependencies contain only `@google/genai`.
- No database connection module exists under `src`.
- No `pg`, `sqlite`, `supabase`, `prisma`, `mongoose`, or similar dependency is used.

## 12. Persistent Child Memory

There is no persistent child memory.

Current child memory is synthetic and prompt-only:

- `DEFAULT_CHILD_CONTEXT` at `src/realtime/realtimePrompt.js:53` includes sample facts such as a cat named Barsik.
- The prompt itself says not to save facts.
- There is no memory database, no write path, and no retrieval layer.

## 13. Parent Restrictions

Parent restrictions currently exist only as prompt text.

Evidence:

- `DEFAULT_PARENT_RULES` at `src/realtime/realtimePrompt.js:61` contains synthetic Lab parent settings.
- `buildRealtimeSystemInstruction()` at `src/realtime/realtimePrompt.js:119` injects them into the final system instruction.
- Browser Lab exposes `PARENT SETTINGS / RESTRICTIONS` textarea at `public/lab.html:288` onward.
- `sanitizePromptConfig()` at `src/realtime/realtimePrompt.js:173` accepts or rejects Lab edits based on `LAB_ALLOW_CUSTOM_PROMPT`.

There is no separate policy engine, no parent settings database, and no structured runtime enforcement outside the prompt.

## 14. Logical Place To Connect Content Library

Best integration point: after `transcript.user` is received and before the provider generates a freeform answer.

Current code path:

- Gemini provider emits `transcript.user` in `handleMessage()` at `src/realtime/geminiLiveProvider.js:702`.
- Server receives it through `emitProviderEvent()` at `src/realtime/realtimeServer.js:496`.
- The server currently calls `rememberTurn()` and language detection around `src/realtime/realtimeServer.js:519`.

Minimal future hook:

- Add an intent/content router in `emitProviderEvent()` when `eventType === 'transcript.user'`.
- If a deterministic content hit is found, either:
  - interrupt/skip provider output and stream library audio through the same client event protocol; or
  - include selected content as controlled context before the next generation.

Open design decision:

- Gemini Live is currently already receiving audio and may start answering. A real Content Library may need either a pre-LLM STT stage or a provider mode that waits for transcript before allowing model output.

## 15. Logical Place To Connect Child Memory

Best integration point: prompt construction, not raw provider access.

Current code path:

- `buildPromptBundle()` at `src/realtime/realtimeServer.js:174` passes `promptBlocks` and generated `currentContext` into `buildRealtimeSystemInstruction()`.
- `DEFAULT_CHILD_CONTEXT` at `src/realtime/realtimePrompt.js:53` is currently synthetic.

Minimal future hook:

- Add a memory retrieval service before `buildRealtimeSystemInstruction()`.
- Replace or augment `childContext` with confirmed, filtered memory facts.
- Keep memory retrieval server-side; do not expose DB directly to Gemini or Browser Lab.
- Store memory writes only after explicit confirmation, outside the realtime provider.

## 16. Temporary/Demo Components

| Component | Status | Evidence |
| --- | --- | --- |
| Browser Lab UI | Temporary/demo | `public/lab.html` is a standalone test page served by `/lab` at `src/server.js:96` |
| Editable prompt fields | Lab-only | Controlled by `LAB_ALLOW_CUSTOM_PROMPT` at `src/realtime/realtimePrompt.js:6` |
| Synthetic child profile | Demo | `DEFAULT_CHILD_CONTEXT` at `src/realtime/realtimePrompt.js:53` explicitly says synthetic Browser Lab |
| Synthetic parent rules | Demo | `DEFAULT_PARENT_RULES` at `src/realtime/realtimePrompt.js:61` explicitly says synthetic Browser Lab |
| Mock provider | Demo/test | `MockRealtimeProvider` in `src/realtime/mockRealtimeProvider.js` generates tones |
| Raw provider trace | Diagnostic | `GEMINI_RAW_TRACE` in `src/realtime/geminiLiveProvider.js` is instrumentation |
| In-browser current context preview | Demo/debug | Browser builds a local preview in `public/lab.html`, server builds the actual prompt separately |

## 17. Production-Ready Components

| Component | Status | Evidence / caveat |
| --- | --- | --- |
| WebSocket frame parser | Reasonably production-oriented low-level implementation | `src/realtime/wsProtocol.js`; still lacks auth/rate limits |
| Provider adapter boundary | Good foundation | `GeminiLiveProvider.createSession()` and `MockRealtimeProvider.createSession()` expose session-like adapters |
| PTT lifecycle | Good lab-grade foundation | Start/end/interrupt/timeout/recovery paths are tested by smoke scripts |
| Gemini speech config shape | Production-useful | `buildGeminiSpeechConfig()` uses explicit prebuilt voice config |
| Provider rotation/reuse controls | Production-useful | `GEMINI_ROTATION_MODE`, interrupt/error/language rotation behavior |
| Prompt block assembly with hashes | Production-useful | `buildRealtimeSystemInstruction()` returns text plus per-block metadata |

Not production-ready yet:

- No auth.
- No device identity.
- No parent/user persistence.
- No content library.
- No persistent child memory.
- No audit-grade safety enforcement beyond prompt text.
- No privacy/data retention layer.
- Browser Lab is not a device client.

## Data Flow Diagram

```text
Browser /lab
  | pointerdown
  | JSON input_audio.start
  v
/realtime WebSocket -> createRealtimeSession()
  | binary PCM 16 kHz frames
  v
providerSession.sendAudio()
  | if Gemini not ready: pendingAudio buffer
  v
Gemini Live session.sendRealtimeInput(audio)
  | provider serverContent messages
  v
GeminiLiveProvider.handleMessage()
  | transcript.user / transcript.model / audio.start / audio.chunk / audio.end
  v
realtimeServer.emitProviderEvent()
  | response.created synthesized on first model/audio output
  | rotation/reuse/timeout/language switch decisions
  v
WebSocket JSON events
  v
Browser handleEvent() / handleAudioChunk()
  | decode PCM/WAV
  v
AudioContext playback
```

## Component Table

| Component | File | Role | Current maturity |
| --- | --- | --- | --- |
| HTTP server | `src/server.js` | Serves `/`, `/health`, `/lab-config`, `/lab`; attaches realtime WS | Lab-ready |
| Browser Lab | `public/lab.html` | UI for PTT, prompt blocks, mic, playback, metrics | Demo/test harness |
| WebSocket protocol | `src/realtime/wsProtocol.js` | Minimal WS handshake/frame parse/send | Useful foundation |
| Realtime server | `src/realtime/realtimeServer.js` | Session state, PTT lifecycle, provider routing, prompt context, rotation | Core foundation |
| Gemini provider | `src/realtime/geminiLiveProvider.js` | Google Live adapter, audio streaming, speech config, raw trace | Core provider adapter |
| Mock provider | `src/realtime/mockRealtimeProvider.js` | Deterministic fake streaming audio provider | Test/demo |
| Prompt builder | `src/realtime/realtimePrompt.js` | Builds CORE/CHILD/PARENT/CURRENT prompt with hashes | Core foundation, data sources still demo |
| Smoke tests | `scripts/*.js` | Protocol, lifecycle, provider, PTT regression checks | Important test harness |

## Storage / Lifetime Table

| Data | Stored where | Lifetime | Persistent after restart? |
| --- | --- | --- | --- |
| Browser UI state | JS variables in `public/lab.html` | Browser page session | No |
| Mic stream / AudioContext | Browser runtime | Browser page session | No |
| WebSocket session ID | `createRealtimeSession()` closure | One WS connection | No |
| Recent turns | Server `recentTurns` array | One WS connection | No |
| Current generation | Server `currentGeneration` object | One turn / until replaced | No |
| Prompt blocks | Server `promptBlocks` variable | One WS connection | No |
| Lab custom prompt | Server memory after `session.start` | One WS connection | No |
| Child profile | Synthetic prompt block | Process code/defaults or current WS override | No DB |
| Parent restrictions | Synthetic prompt block | Process code/defaults or current WS override | No DB |
| Provider session | Gemini/mock session object | Until rotation/close | No |
| Provider voice name | Server session variable and provider options | One WS connection; preserved across rotations | No |
| Language state | `sessionLanguage` variable | One WS connection | No |
| Raw trace logs | stdout only | Container log retention | Not app storage |

## Architecture Gaps

1. No authentication or parent/device identity.
2. No persistent database.
3. No persistent child memory.
4. No structured parent settings store.
5. Parent restrictions are prompt-only, not enforced by a policy layer.
6. No content library or deterministic content router.
7. No durable conversation history.
8. No privacy/retention controls for transcripts beyond not persisting them in app code.
9. No device protocol yet; Browser Lab is the only client.
10. No structured safety classifier outside prompt behavior.
11. Current language detection is heuristic and server-local.
12. Prompt updates require session-level handling and are not tied to production parent profiles.
13. No observability store; logs are stdout only.
14. No explicit cost/token accounting layer for Live usage.

## Minimal Target Architecture (No Implementation)

1. Keep current `/realtime` neutral protocol and provider adapter boundary.
2. Add authenticated device/session identity before accepting `/realtime`.
3. Add a server-side profile service:
   - child profile;
   - confirmed memory;
   - parent settings;
   - toy voice settings.
4. Add a memory retrieval layer used only by `buildRealtimeSystemInstruction()`.
5. Add a content router after stable user transcript is available.
6. Add structured policy checks before content/LLM response where possible.
7. Keep provider-specific logic inside adapters such as `GeminiLiveProvider`.
8. Preserve prompt block hashes and provider voice logs for observability.
9. Add persistent event/audit logging with redaction rules.
10. Keep Browser Lab as a sandbox that can load synthetic profiles but cannot write production memory.

## Source Evidence Index

- HTTP entry and provider factory: `src/server.js:20`, `src/server.js:55`, `src/server.js:96`, `src/server.js:116`.
- WebSocket session: `src/realtime/realtimeServer.js:100`, `src/realtime/realtimeServer.js:118`.
- Server state and prompt bundle: `src/realtime/realtimeServer.js:167`, `src/realtime/realtimeServer.js:174`, `src/realtime/realtimeServer.js:188`.
- PTT start/end: `src/realtime/realtimeServer.js:713`, `src/realtime/realtimeServer.js:766`.
- Provider event handling: `src/realtime/realtimeServer.js:496`.
- Provider rotation: `src/realtime/realtimeServer.js:630`.
- Gemini session connect: `src/realtime/geminiLiveProvider.js:228`, `src/realtime/geminiLiveProvider.js:264`.
- Gemini audio input: `src/realtime/geminiLiveProvider.js:372`, `src/realtime/geminiLiveProvider.js:419`.
- Gemini message conversion: `src/realtime/geminiLiveProvider.js:678`.
- Prompt blocks: `src/realtime/realtimePrompt.js:8`, `src/realtime/realtimePrompt.js:53`, `src/realtime/realtimePrompt.js:61`, `src/realtime/realtimePrompt.js:119`.
- Browser Lab PTT: `public/lab.html:803`, `public/lab.html:851`, `public/lab.html:892`, `public/lab.html:981`, `public/lab.html:1093`.
