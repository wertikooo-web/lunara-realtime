'use strict';

const fs = require('fs');

const path = 'src/realtime/realtimeServer.js';
let source = fs.readFileSync(path, 'utf8');

const oldRecover = `    async function recoverFromTurnTimeout(generation, timeoutMs) {
        if (generation !== currentGeneration) {
            droppedProviderEvent(generation, 'ptt_turn_timeout', 'stale_generation');
            return;
        }
        generation.timeoutLogged = true;
        generation.status = 'failed';
        generation.cancel.cancel('provider_timeout');
        clearGenerationTimeout(generation);
        log('ptt_turn_timeout', {
            generationId: generation.generationId,
            responseId: generation.responseId,
            turnId: generation.turnId,
            timeoutMs,
            turnInputBytes: inputBytes,
            sessionInputBytes,
        });
        emit({
            type: 'response.failed',
            generation_id: generation.generationId,
            response_id: generation.responseId,
            turn_id: generation.turnId,
            reason: 'provider_timeout',
            timeout_ms: timeoutMs,
        });

        const startedAt = Date.now();
        const oldProviderInstanceId = providerSession?.instanceId || 'unknown';
        log('turn_timeout_recovery_started', {
            failedGenerationId: generation.generationId,
            oldProviderInstanceId,
        });
        rotateProviderSession('provider_timeout');
        await warmProviderSession('provider_timeout');
        log('turn_timeout_recovery_completed', {
            failedGenerationId: generation.generationId,
            oldProviderInstanceId,
            newProviderInstanceId: providerSession?.instanceId || 'unknown',
            elapsedMs: Date.now() - startedAt,
        });
    }
`;

const newRecover = `    async function recoverFromTurnTimeout(generation, timeoutMs) {
        if (generation !== currentGeneration) {
            droppedProviderEvent(generation, 'ptt_turn_timeout', 'stale_generation');
            return;
        }
        generation.timeoutLogged = true;
        clearGenerationTimeout(generation);
        log('ptt_turn_timeout', {
            generationId: generation.generationId,
            responseId: generation.responseId,
            turnId: generation.turnId,
            timeoutMs,
            turnInputBytes: inputBytes,
            sessionInputBytes,
            providerRetryAttempted: generation.providerRetryAttempted,
        });

        // A timeout after a complete audio turn is still recoverable while the
        // original PCM replay buffer is available. Retry once on a fresh
        // provider before exposing a terminal failure to the client.
        if (currentMode !== 'text' && await retryGenerationOnFreshProvider(generation, 'provider_timeout')) {
            log('turn_timeout_retry_dispatched', {
                generationId: generation.generationId,
                turnId: generation.turnId,
                timeoutMs,
            });
            return;
        }

        generation.status = 'failed';
        generation.cancel.cancel('provider_timeout');
        emit({
            type: 'response.failed',
            generation_id: generation.generationId,
            response_id: generation.responseId,
            turn_id: generation.turnId,
            reason: 'provider_timeout',
            timeout_ms: timeoutMs,
        });

        const startedAt = Date.now();
        const oldProviderInstanceId = providerSession?.instanceId || 'unknown';
        log('turn_timeout_recovery_started', {
            failedGenerationId: generation.generationId,
            oldProviderInstanceId,
        });
        rotateProviderSession('provider_timeout');
        await warmProviderSession('provider_timeout');
        log('turn_timeout_recovery_completed', {
            failedGenerationId: generation.generationId,
            oldProviderInstanceId,
            newProviderInstanceId: providerSession?.instanceId || 'unknown',
            elapsedMs: Date.now() - startedAt,
        });
    }
`;

const oldReasons = `        const retryableReasons = new Set([
            'provider_turn_closed_before_output',
            'provider_turn_closed_during_input',
        ]);`;

const newReasons = `        const retryableReasons = new Set([
            'provider_turn_closed_before_output',
            'provider_turn_closed_during_input',
            'provider_timeout',
        ]);`;

function replaceExactlyOnce(haystack, needle, replacement, label) {
    const first = haystack.indexOf(needle);
    if (first < 0) throw new Error(`${label}: expected source block not found`);
    if (haystack.indexOf(needle, first + needle.length) >= 0) {
        throw new Error(`${label}: source block occurs more than once`);
    }
    return haystack.slice(0, first) + replacement + haystack.slice(first + needle.length);
}

source = replaceExactlyOnce(source, oldRecover, newRecover, 'recoverFromTurnTimeout');
source = replaceExactlyOnce(source, oldReasons, newReasons, 'retryableReasons');

fs.writeFileSync(path, source);
console.log('Applied one-shot provider_timeout replay fix.');
