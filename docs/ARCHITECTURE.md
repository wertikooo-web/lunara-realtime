# Architecture

## Boundary

This project is a separate R&D repository for a different device line. It must not import production modules from the current Lunara Toy Server and must not mutate production database tables, cache keys, parent panel files, content packs, or firmware.

The base Lunara device continues in the main repository on the existing request/response architecture. This lab explores a different hardware and realtime interaction model in parallel.

## Target Pipeline

```text
Next-generation Device / Browser Lab Client
  -> Opus frames over WebSocket
  -> Realtime session router
  -> provider adapter
  -> streaming audio response
  -> playback / latency metrics
```

## Provider Adapter Contract

Each adapter should eventually expose the same shape:

```js
{
  name,
  startSession(options),
  sendAudioFrame(session, frame),
  sendText(session, text),
  closeSession(session)
}
```

## Metrics

Every experiment should record:

- time to first audio byte
- end-to-end response latency
- interruption handling
- packet loss behavior
- provider cost estimate
- perceived voice quality

## Safety

No real child data should be used in this lab. Use synthetic text and controlled sample audio only.

## Product Rule

Do not design this repo as a replacement for the base Lunara server. Any future sharing between the two products must be explicit, reviewed, and limited to reusable utilities that do not couple their runtimes.
