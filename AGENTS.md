# AGENTS.md - lunara-realtime

## Scope

These rules apply to this repository. Follow direct user constraints first, then these project rules, then narrower instructions in subdirectories.

This repository is an isolated realtime R&D lab for a separate Lunara device line. Do not treat it as the production Lunara Toy Server or as an automatic migration path for that product.

## Safety boundaries

- Start in read-only mode when the user requests analysis, audit, planning, or investigation.
- Change only files explicitly required by the task.
- Stop before production actions or external mutations unless the user explicitly approves them.
- External mutations include deploys, GitHub writes beyond the approved task, database writes, MCP or OAuth changes, access changes, package publishing, and remote configuration.
- Never use approval or sandbox bypass modes unless the user explicitly requests them for a proven isolated environment.
- Do not read, print, copy, summarize, or store secret values. Never print full `.env` files, tokens, passwords, private keys, cookies, OAuth stores, credentials, or authorization headers.
- Use synthetic data and controlled sample audio. Do not use or store real child data in this lab.

## Repository boundaries

Before editing:

- Confirm the repository root and current branch.
- Run `git status --short`.
- Preserve unrelated tracked and untracked work.
- Do not reset, clean, stash, move, delete, stage, or commit unrelated files without explicit permission.
- Do not touch the production Lunara repository, parent panel, production database, cache keys, content packs, or firmware from this repository.
- Keep migrations separate from cleanup, dependency upgrades, broad formatting, and unrelated refactoring.

## Architecture

The target flow is:

```text
Device or Browser Lab
  -> audio frames over WebSocket
  -> realtime session router
  -> provider adapter
  -> streaming audio response
  -> playback and latency metrics
```

Maintain clear boundaries between:

- WebSocket protocol and frame parsing;
- session and turn lifecycle;
- provider adapters;
- audio conversion and buffering;
- local content tools;
- memory and parent-rule enforcement;
- browser lab and device-facing behavior.

Provider-specific behavior belongs behind explicit adapters or dedicated modules. Do not spread provider assumptions through unrelated code.

## Turn and session lifecycle

- A user turn must have one authoritative lifecycle.
- Local tools and provider events must not independently finalize the same turn.
- Completion, cancellation, timeout, interruption, reconnect, and retry paths must be idempotent.
- Treat late provider events, duplicate completion signals, stale callbacks, and delayed tool results as expected failure cases.
- New child input must never enter a provider session already considered closed or invalid.
- Every exit path must leave session state in a known, inspectable state.
- Preserve correlation identifiers for sessions, turns, generations, responses, and provider events.
- Do not fix lifecycle problems with arbitrary delays when an explicit state transition or guard is possible.

## Audio pipeline

- Keep the accepted sample rate, channel count, sample format, frame size, and provider requirements explicit.
- Perform sample-rate conversion at the visible boundary where audio enters the realtime pipeline.
- Do not introduce hidden preload hooks, monkey patches, or `node -r` runtime injection when an explicit in-code integration is practical.
- Prevent silent double resampling.
- Preserve PCM16 byte alignment and streaming state across uneven chunk boundaries.
- Reset or flush per-turn resampler state on the correct lifecycle events.
- Test short frames, uneven chunks, silence tails, interruption, reconnect, repeated turns, and long sessions.
- Measure latency and CPU impact for audio changes.

## Child-facing behavior and privacy

- Keep responses age-appropriate, calm, and easy to understand.
- Preserve multilingual conversation behavior unless the task explicitly changes it.
- Parent restrictions, quiet hours, and safety rules must fail safely.
- Do not log raw child audio or unnecessary personal content.
- Any memory feature must remain explicit, guarded, testable, and disabled unless intentionally configured.

## Working style

- Prefer the smallest clear change that solves the demonstrated problem.
- Prefer readable control flow over hidden runtime behavior.
- Do not change providers, transport, prompts, memory, parent rules, and audio architecture in one change unless the task requires the combination.
- Do not raise instruction or context limits merely to hide poor structure.
- Record assumptions when behavior cannot be proven from code or tests.

## Subagents

- Use subagents only when independent review, parallel analysis, or specialist work has clear value.
- Give each subagent a narrow scope and the same safety boundaries.
- Do not delegate production changes, external mutations, secret handling, or final approval.
- The main agent must inspect the final diff, verify the result, and own the conclusion.

## Required verification

Inspect the final diff and run the narrowest relevant checks first. Available checks include:

```text
npm run smoke:http
npm run smoke:gemini-provider
npm run smoke:latency
npm run smoke:content-library
npm run smoke:riddle-tool
npm run smoke:ptt-button
npm run smoke:ptt-lifecycle
npm run smoke:ptt-tail
npm run smoke:realtime
npm run smoke:memory-guard
npm run smoke:pcm-resampler
npm run smoke:input-resample-pipeline
```

Choose checks based on the changed surface. For lifecycle or audio changes, run the relevant regression and resampling checks together. Report commands run, passed checks, skipped checks, failures, files changed, and remaining uncertainty.

## Rollback and completion

Before editing critical instructions or configuration, record the original path, size, checksum, permissions, and rollback method. Create backups only after write approval and never include exposed secrets.

A task is complete only when:

- the approved scope is satisfied;
- unrelated work remains untouched;
- syntax and relevant smoke checks pass;
- the final diff is reviewed;
- production and external systems were not changed without approval;
- rollback remains possible;
- limitations and unverified assumptions are stated honestly.
