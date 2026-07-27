'use strict';
const fs = require('fs');

function replaceOnce(source, from, to, label) {
  const i = source.indexOf(from);
  if (i < 0) throw new Error(label + ': source block not found');
  if (source.indexOf(from, i + from.length) >= 0) throw new Error(label + ': source block is not unique');
  return source.slice(0, i) + to + source.slice(i + from.length);
}

const serverPath = 'src/realtime/realtimeServer.js';
let server = fs.readFileSync(serverPath, 'utf8');

server = replaceOnce(server,
`        timeoutTimer: null,\n        timeoutLogged: false,`,
`        timeoutTimer: null,\n        transcribedNoOutputTimer: null,\n        timeoutLogged: false,`,
'createGeneration timer');

server = replaceOnce(server,
`    function clearGenerationTimeout(generation) {\n        if (!generation?.timeoutTimer) return;\n        clearTimeout(generation.timeoutTimer);\n        generation.timeoutTimer = null;\n    }\n\n    function armPttTurnTimeout(generation) {`,
`    function clearGenerationTimeout(generation) {\n        if (!generation) return;\n        if (generation.timeoutTimer) {\n            clearTimeout(generation.timeoutTimer);\n            generation.timeoutTimer = null;\n        }\n        if (generation.transcribedNoOutputTimer) {\n            clearTimeout(generation.transcribedNoOutputTimer);\n            generation.transcribedNoOutputTimer = null;\n        }\n    }\n\n    function armTranscribedNoOutputWatchdog(generation) {\n        if (!generation || currentMode !== 'push_to_talk') return;\n        if (generation.providerRetryAttempted || generation.firstModelEventAt || generation.responseCreatedSent) return;\n        if (generation.transcribedNoOutputTimer) clearTimeout(generation.transcribedNoOutputTimer);\n        const timeoutMs = Math.max(0, Number(process.env.PTT_TRANSCRIBED_NO_OUTPUT_TIMEOUT_MS || 1500));\n        if (timeoutMs <= 0) return;\n        generation.transcribedNoOutputTimer = setTimeout(() => {\n            generation.transcribedNoOutputTimer = null;\n            if (\n                generation !== currentGeneration\n                || generation.status !== 'pending'\n                || generation.cancel.cancelled\n                || generation.responseCreatedSent\n                || generation.firstModelEventAt\n                || generation.providerRetryAttempted\n            ) return;\n            log('provider_transcribed_no_output_timeout', {\n                generationId: generation.generationId,\n                turnId: generation.turnId,\n                timeoutMs,\n                inputEndToWatchdogMs: generation.inputEndedAt ? Date.now() - generation.inputEndedAt : 0,\n            });\n            retryGenerationOnFreshProvider(generation, 'provider_transcribed_but_no_output').catch((error) => {\n                log('turn_retry_recovery_error', {\n                    generationId: generation.generationId,\n                    turnId: generation.turnId,\n                    message: error.message,\n                });\n            });\n        }, timeoutMs);\n    }\n\n    function armPttTurnTimeout(generation) {`,
'watchdog functions');

server = replaceOnce(server,
`            log('provider_input_transcription_received', {\n                generationId: generation.generationId,\n                turnId: generation.turnId,\n                inputEndToInputTranscriptionMs: generation.firstInputTranscriptionAt - generation.inputEndedAt,\n            });\n            maybeHandleActiveActivityAnswer(generation, payload.text);`,
`            log('provider_input_transcription_received', {\n                generationId: generation.generationId,\n                turnId: generation.turnId,\n                inputEndToInputTranscriptionMs: generation.firstInputTranscriptionAt - generation.inputEndedAt,\n            });\n            armTranscribedNoOutputWatchdog(generation);\n            maybeHandleActiveActivityAnswer(generation, payload.text);`,
'arm watchdog');

server = replaceOnce(server,
`        if (startsGenerationEvents.has(eventType) && generation.inputEndedAt && !generation.firstModelEventAt) {\n            generation.firstModelEventAt = Date.now();`,
`        if (startsGenerationEvents.has(eventType) && generation.inputEndedAt && !generation.firstModelEventAt) {\n            if (generation.transcribedNoOutputTimer) {\n                clearTimeout(generation.transcribedNoOutputTimer);\n                generation.transcribedNoOutputTimer = null;\n            }\n            generation.firstModelEventAt = Date.now();`,
'clear watchdog on output');

server = replaceOnce(server,
`            'provider_turn_closed_during_input',\n            'provider_timeout',`,
`            'provider_turn_closed_during_input',\n            'provider_timeout',\n            'provider_transcribed_but_no_output',`,
'retry reason');

fs.writeFileSync(serverPath, server);

const testPath = 'scripts/ptt-lifecycle-regression.js';
let test = fs.readFileSync(testPath, 'utf8');

test = replaceOnce(test,
`        context.onEvent({\n            type: 'transcript.user',\n            response_id: context.responseId,\n            turn_id: context.turnId,\n            text: transcriptByTurn[context.turnId] || \`heard \${context.turnInputBytes}\`,\n        });\n        await sleep(context.turnInputBytes <= 2 ? 5 : 25);`,
`        context.onEvent({\n            type: 'transcript.user',\n            response_id: context.responseId,\n            turn_id: context.turnId,\n            text: transcriptByTurn[context.turnId] || \`heard \${context.turnInputBytes}\`,\n        });\n        if (context.turnId === 'transcribed_no_output_ptt' && this.rotationReason !== 'provider_transcribed_but_no_output') {\n            return;\n        }\n        await sleep(context.turnInputBytes <= 2 ? 5 : 25);`,
'test provider stall');

test = replaceOnce(test,
`    const originalTimeout = process.env.PTT_TURN_TIMEOUT_MS;\n    const originalRotationMode = process.env.GEMINI_ROTATION_MODE;\n    process.env.PTT_TURN_TIMEOUT_MS = '200';`,
`    const originalTimeout = process.env.PTT_TURN_TIMEOUT_MS;\n    const originalTranscribedTimeout = process.env.PTT_TRANSCRIBED_NO_OUTPUT_TIMEOUT_MS;\n    const originalRotationMode = process.env.GEMINI_ROTATION_MODE;\n    process.env.PTT_TURN_TIMEOUT_MS = '200';\n    process.env.PTT_TRANSCRIBED_NO_OUTPUT_TIMEOUT_MS = '60';`,
'test env');

test = replaceOnce(test,
`        const beforeTurnClosedSessions = provider.sessions.length;`,
`        const beforeTranscribedNoOutputSessions = provider.sessions.length;\n        errorsOnlyClient.sendJson({ type: 'input_audio.start', turn_id: 'transcribed_no_output_ptt', mode: 'push_to_talk' });\n        errorsOnlyClient.sendBinary(Buffer.alloc(1800, 7));\n        errorsOnlyClient.sendJson({ type: 'input_audio.end' });\n        const fastRecoveryRotation = await errorsOnlyClient.waitFor(\n            'provider.rotated',\n            (event) => event.reason === 'provider_transcribed_but_no_output',\n            2000,\n        );\n        if (provider.sessions.length !== beforeTranscribedNoOutputSessions + 1) {\n            throw new Error('Transcribed-no-output watchdog must rotate exactly one provider session');\n        }\n        const fastRecovered = await errorsOnlyClient.waitFor(\n            'response.created',\n            (event) => event.turn_id === 'transcribed_no_output_ptt',\n            2000,\n        );\n        await errorsOnlyClient.waitFor('audio.end', (event) => event.turn_id === 'transcribed_no_output_ptt', 2000);\n        if (!fastRecovered.response_id) throw new Error('Transcribed-no-output retry did not create a response');\n        if (errorsOnlyClient.events.some((event) => event.type === 'response.failed' && event.turn_id === 'transcribed_no_output_ptt')) {\n            throw new Error('Transcribed-no-output retry must be transparent to the client');\n        }\n        if (logs.some((line) => line.includes('stage=ptt_turn_timeout') && line.includes('transcribed_no_output_ptt'))) {\n            throw new Error('Transcribed-no-output watchdog must recover before the full PTT timeout');\n        }\n        if (!logs.some((line) => line.includes('stage=provider_transcribed_no_output_timeout') && line.includes('transcribed_no_output_ptt'))) {\n            throw new Error('Missing provider_transcribed_no_output_timeout log');\n        }\n        if (fastRecoveryRotation.old_provider_instance_id === fastRecoveryRotation.new_provider_instance_id) {\n            throw new Error('Transcribed-no-output recovery must create a fresh provider session');\n        }\n\n        const beforeTurnClosedSessions = provider.sessions.length;`,
'test case');

test = replaceOnce(test,
`        if (originalTimeout == null) delete process.env.PTT_TURN_TIMEOUT_MS;\n        else process.env.PTT_TURN_TIMEOUT_MS = originalTimeout;`,
`        if (originalTimeout == null) delete process.env.PTT_TURN_TIMEOUT_MS;\n        else process.env.PTT_TURN_TIMEOUT_MS = originalTimeout;\n        if (originalTranscribedTimeout == null) delete process.env.PTT_TRANSCRIBED_NO_OUTPUT_TIMEOUT_MS;\n        else process.env.PTT_TRANSCRIBED_NO_OUTPUT_TIMEOUT_MS = originalTranscribedTimeout;`,
'test cleanup');

fs.writeFileSync(testPath, test);
console.log('Applied transcribed-no-output watchdog and regression coverage.');
