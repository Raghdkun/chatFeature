import { describe, expect, it } from 'vite-plus/test';
import {
    checkTone,
    hintKeyFor,
    orderedChecks,
    problemCheckKey,
    testSummary,
} from '@/lib/pizzasys-checks';
import type { PortalCheck, PortalTestResult } from '@/types/pizzasys';

const check = (
    key: PortalCheck['key'],
    ok: boolean,
    message?: string,
): PortalCheck => ({ key, label: key, ok, ...(message ? { message } : {}) });

describe('orderedChecks', () => {
    it('lists checks in the contract order whatever order the server used', () => {
        const result: PortalTestResult = {
            ok: true,
            checks: [
                check('nats', true),
                check('latency', true),
                check('service_credential', true),
                check('reachable', true),
            ],
        };

        expect(orderedChecks(result).map((c) => c.key)).toEqual([
            'reachable',
            'service_credential',
            'latency',
            'nats',
        ]);
    });

    it('keeps checks it does not know at the end, in server order', () => {
        const result = {
            ok: true,
            checks: [
                { key: 'zzz', label: 'Z', ok: true },
                check('reachable', true),
                { key: 'aaa', label: 'A', ok: true },
            ],
        } as unknown as PortalTestResult;

        expect(orderedChecks(result).map((c) => c.key)).toEqual([
            'reachable',
            'zzz',
            'aaa',
        ]);
    });
});

describe('tones and summary', () => {
    it('is ok when the check passed', () => {
        const result = { ok: true, checks: [check('reachable', true)] };

        expect(checkTone(result.checks[0], result)).toBe('ok');
        expect(testSummary(result)).toBe('passed');
    });

    it('fails the summary when a required check fails', () => {
        const result = {
            ok: false,
            checks: [
                check('reachable', true),
                check('service_credential', false),
            ],
        };

        expect(checkTone(result.checks[1], result)).toBe('failed');
        expect(testSummary(result)).toBe('failed');
    });

    it('treats a failing NATS check next to an ok result as a warning (NATS is optional)', () => {
        const result = {
            ok: true,
            checks: [
                check('reachable', true),
                check('nats', false, 'connection refused'),
            ],
        };

        expect(checkTone(result.checks[1], result)).toBe('warning');
        expect(testSummary(result)).toBe('warning');
    });

    it('still fails NATS when the whole result failed', () => {
        const result = { ok: false, checks: [check('nats', false)] };

        expect(checkTone(result.checks[0], result)).toBe('failed');
    });
});

describe('hints', () => {
    it('points failed contract checks at a fix hint', () => {
        expect(hintKeyFor(check('service_credential', false))).toBe(
            'setup.pizzasys.hint.service_credential',
        );
        expect(hintKeyFor(check('reachable', false))).toBe(
            'setup.pizzasys.hint.reachable',
        );
    });

    it('has no hint for a passed check or an unknown one', () => {
        expect(hintKeyFor(check('reachable', true))).toBeNull();
        expect(
            hintKeyFor({
                key: 'tls',
                label: 'TLS',
                ok: false,
            } as unknown as PortalCheck),
        ).toBeNull();
    });
});

describe('problemCheckKey', () => {
    it('finds the check an error key names, however it is nested', () => {
        expect(problemCheckKey('reachable')).toBe('reachable');
        expect(problemCheckKey('checks.service_credential')).toBe(
            'service_credential',
        );
        expect(problemCheckKey('environments.production.nats')).toBe('nats');
        expect(problemCheckKey('connection.latency')).toBe('latency');
    });

    it('is null for anything else', () => {
        expect(problemCheckKey('connection')).toBeNull();
        expect(problemCheckKey('service_token')).toBeNull();
        expect(problemCheckKey('')).toBeNull();
    });
});
