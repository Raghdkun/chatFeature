import { describe, expect, it, vi } from 'vite-plus/test';
import {
    canGoBack,
    canLeaveWelcome,
    derivePhase,
    displayIdleTimeout,
    environmentFailures,
    executeRun,
    firstIncompleteIndex,
    IDLE_TIMEOUT,
    initialRunRows,
    nextStep,
    parseIdleTimeout,
    previousStep,
    resolveView,
    safeRedirect,
    stepperItems,
    stepProgress,
    tokenGateActive,
    visibleStepKeys,
    type RunStepClient,
    type RunStepResult,
} from '@/lib/setup-flow';
import type {
    SetupRunRow,
    SetupState,
    SetupStepKey,
    SetupStepSummary,
} from '@/types/setup';

const row = (
    key: string,
    status: SetupRunRow['status'] = 'pending',
): SetupRunRow => ({ key, label: key, status });

const fortifyRows = (): SetupRunRow[] => [
    row('run-migrations'),
    row('seed-defaults'),
    row('create-admin'),
    row('write-lock'),
];

const ok = (next: string | null = null, redirect?: string): RunStepResult => ({
    status: 'ok',
    next,
    redirect,
});

const statuses = (rows: SetupRunRow[]) => rows.map((r) => r.status);

describe('step transitions', () => {
    it('lists every step for fortify and when no mode is chosen yet', () => {
        const all = ['welcome', 'mode', 'admin', 'basics', 'run', 'done'];

        expect(visibleStepKeys('fortify')).toEqual(all);
        expect(visibleStepKeys(null)).toEqual(all);
    });

    it('drops the admin step for the Auth Portal mode', () => {
        expect(visibleStepKeys('pizzasys')).not.toContain('admin');
    });

    it('moves forward and backward along the visible steps', () => {
        expect(nextStep('welcome', 'fortify')).toBe('mode');
        expect(nextStep('mode', 'fortify')).toBe('admin');
        expect(nextStep('mode', 'pizzasys')).toBe('basics');
        expect(nextStep('run', 'fortify')).toBe('done');
        expect(previousStep('basics', 'fortify')).toBe('admin');
        expect(previousStep('basics', 'pizzasys')).toBe('mode');
    });

    it('has no step after done or before welcome', () => {
        expect(nextStep('done', 'fortify')).toBeNull();
        expect(previousStep('welcome', 'fortify')).toBeNull();
    });

    it('only offers Back between the first and the last step', () => {
        expect(canGoBack('welcome')).toBe(false);
        expect(canGoBack('done')).toBe(false);
        expect(
            (['mode', 'admin', 'basics', 'run'] as SetupStepKey[]).every(
                canGoBack,
            ),
        ).toBe(true);
    });
});

describe('resolveView', () => {
    it('shows the server step when there is no override', () => {
        expect(resolveView('admin', null)).toBe('admin');
    });

    it('honours an override made for the current server step', () => {
        expect(resolveView('run', { from: 'run', view: 'basics' })).toBe(
            'basics',
        );
    });

    it('drops the override as soon as the server moves on', () => {
        expect(resolveView('run', { from: 'basics', view: 'mode' })).toBe(
            'run',
        );
    });
});

describe('stepper', () => {
    const steps: SetupStepSummary[] = [
        { key: 'welcome', label: 'Welcome', status: 'done' },
        { key: 'mode', label: 'Mode', status: 'done' },
        { key: 'admin', label: 'Admin', status: 'current' },
        { key: 'basics', label: 'Basics', status: 'pending' },
        { key: 'run', label: 'Run', status: 'pending' },
        { key: 'done', label: 'Done', status: 'pending' },
    ];
    const statusOf = (items: SetupStepSummary[]) =>
        items.map((item) => item.status);

    it('marks the viewed step current and everything before it done', () => {
        expect(statusOf(stepperItems(steps, 'basics'))).toEqual([
            'done',
            'done',
            'done',
            'current',
            'pending',
            'pending',
        ]);
    });

    it('keeps server-done steps done while looking back, and demotes the server current step', () => {
        expect(statusOf(stepperItems(steps, 'mode'))).toEqual([
            'done',
            'current',
            'pending',
            'pending',
            'pending',
            'pending',
        ]);
    });

    it('does not mutate its input', () => {
        const copy = structuredClone(steps);

        stepperItems(steps, 'run');

        expect(steps).toEqual(copy);
    });

    it('reports 1-based progress with the step label', () => {
        expect(stepProgress(steps, 'admin')).toEqual({
            index: 3,
            total: 6,
            label: 'Admin',
        });
    });
});

describe('welcome step', () => {
    const base = (
        overrides: Partial<
            Pick<SetupState, 'needsToken' | 'tokenVerified' | 'environment'>
        >,
    ) => ({
        needsToken: true,
        tokenVerified: false,
        environment: { ok: true, checks: [] },
        ...overrides,
    });

    it('gates on the token only when one is needed and not yet verified', () => {
        expect(tokenGateActive(base({}))).toBe(true);
        expect(tokenGateActive(base({ tokenVerified: true }))).toBe(false);
        expect(tokenGateActive(base({ needsToken: false }))).toBe(false);
    });

    it('can be left once the gate is open and the environment is ok', () => {
        expect(canLeaveWelcome(base({ tokenVerified: true }))).toBe(true);
        expect(canLeaveWelcome(base({ needsToken: false }))).toBe(true);
        expect(canLeaveWelcome(base({}))).toBe(false);
        expect(
            canLeaveWelcome(
                base({
                    needsToken: false,
                    environment: {
                        ok: false,
                        checks: [{ key: 'db', label: 'DB', ok: false }],
                    },
                }),
            ),
        ).toBe(false);
    });

    it('counts failed checks', () => {
        expect(
            environmentFailures({
                ok: false,
                checks: [
                    { key: 'a', label: 'A', ok: true },
                    { key: 'b', label: 'B', ok: false },
                    { key: 'c', label: 'C', ok: false },
                ],
            }),
        ).toBe(2);
    });
});

describe('idle timeout', () => {
    it('accepts whole minutes inside the bounds', () => {
        expect(parseIdleTimeout('120')).toBe(120);
        expect(parseIdleTimeout(' 45 ')).toBe(45);
        expect(parseIdleTimeout(IDLE_TIMEOUT.min)).toBe(IDLE_TIMEOUT.min);
        expect(parseIdleTimeout(IDLE_TIMEOUT.max)).toBe(IDLE_TIMEOUT.max);
    });

    it('rejects out-of-range, fractional and non-numeric input', () => {
        for (const bad of ['', '4', '1441', '12.5', '-3', 'abc', '1e3']) {
            expect(parseIdleTimeout(bad)).toBeNull();
        }
    });

    it('falls back to the 120 minute default for the helper text', () => {
        expect(displayIdleTimeout('30')).toBe(30);
        expect(displayIdleTimeout('')).toBe(120);
        expect(displayIdleTimeout('99999')).toBe(120);
    });
});

describe('initialRunRows', () => {
    it('uses the server rows and treats a stale running as pending', () => {
        const rows = initialRunRows(
            [row('run-migrations', 'done'), row('seed-defaults', 'running')],
            'fortify',
        );

        expect(statuses(rows)).toEqual(['done', 'pending']);
    });

    it('falls back to the contract sequence, without create-admin for the portal mode', () => {
        expect(initialRunRows([], 'fortify').map((r) => r.key)).toEqual([
            'run-migrations',
            'seed-defaults',
            'create-admin',
            'write-lock',
        ]);
        expect(initialRunRows([], 'pizzasys').map((r) => r.key)).toEqual([
            'run-migrations',
            'seed-defaults',
            'write-lock',
        ]);
    });
});

describe('derivePhase', () => {
    it('is idle, running, failed or completed', () => {
        expect(derivePhase(fortifyRows(), false)).toBe('idle');
        expect(derivePhase(fortifyRows(), true)).toBe('running');
        expect(derivePhase([row('a', 'done'), row('b', 'failed')], false)).toBe(
            'failed',
        );
        expect(derivePhase([row('a', 'done'), row('b', 'done')], false)).toBe(
            'completed',
        );
    });

    it('reports the first row that is not done', () => {
        expect(
            firstIncompleteIndex([row('a', 'done'), row('b'), row('c')]),
        ).toBe(1);
        expect(firstIncompleteIndex([row('a', 'done')])).toBe(-1);
    });
});

describe('safeRedirect', () => {
    it('keeps same-origin paths', () => {
        expect(safeRedirect('/login')).toBe('/login');
        expect(safeRedirect('/dashboard?x=1')).toBe('/dashboard?x=1');
    });

    it('falls back to /login for anything else', () => {
        for (const bad of [
            null,
            undefined,
            '',
            'https://evil.test',
            '//evil.test',
            'javascript:alert(1)',
            '/\\evil.test',
        ]) {
            expect(safeRedirect(bad)).toBe('/login');
        }
    });
});

describe('executeRun', () => {
    it('runs the steps strictly one after another, in order', async () => {
        const log: string[] = [];
        let inFlight = 0;
        let maxInFlight = 0;
        const runStep: RunStepClient = async (step) => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            log.push(`start:${step}`);
            await Promise.resolve();
            log.push(`end:${step}`);
            inFlight--;

            return ok();
        };

        const result = await executeRun({ rows: fortifyRows(), runStep });

        expect(maxInFlight).toBe(1);
        expect(log).toEqual([
            'start:run-migrations',
            'end:run-migrations',
            'start:seed-defaults',
            'end:seed-defaults',
            'start:create-admin',
            'end:create-admin',
            'start:write-lock',
            'end:write-lock',
        ]);
        expect(result.outcome).toBe('completed');
        expect(statuses(result.rows)).toEqual(['done', 'done', 'done', 'done']);
    });

    it('reports every intermediate state (running then done) to the UI', async () => {
        const seen: string[][] = [];

        await executeRun({
            rows: [row('run-migrations'), row('write-lock')],
            runStep: async () => ok(),
            onChange: (rows) => seen.push(statuses(rows)),
        });

        expect(seen).toEqual([
            ['pending', 'pending'],
            ['running', 'pending'],
            ['done', 'pending'],
            ['done', 'running'],
            ['done', 'done'],
        ]);
    });

    it('stops at the first failure and keeps the server message', async () => {
        const runStep = vi.fn<RunStepClient>(async (step) =>
            step === 'seed-defaults'
                ? {
                      status: 'failed',
                      message: 'Could not connect to the database',
                  }
                : ok(),
        );

        const result = await executeRun({ rows: fortifyRows(), runStep });

        expect(runStep.mock.calls.map(([step]) => step)).toEqual([
            'run-migrations',
            'seed-defaults',
        ]);
        expect(result.outcome).toBe('failed');
        expect(result.failedKey).toBe('seed-defaults');
        expect(result.redirect).toBeNull();
        expect(statuses(result.rows)).toEqual([
            'done',
            'failed',
            'pending',
            'pending',
        ]);
        expect(result.rows[1].message).toBe(
            'Could not connect to the database',
        );
    });

    it('resumes at the failed step and skips steps that already succeeded', async () => {
        let seedAttempts = 0;
        const calls: string[] = [];
        const runStep: RunStepClient = async (step) => {
            calls.push(step);

            if (step === 'seed-defaults' && ++seedAttempts === 1) {
                return { status: 'failed', message: 'Disk full' };
            }

            return step === 'write-lock' ? ok(null, '/login') : ok();
        };

        const first = await executeRun({ rows: fortifyRows(), runStep });

        expect(first.outcome).toBe('failed');

        const second = await executeRun({ rows: first.rows, runStep });

        expect(calls).toEqual([
            'run-migrations',
            'seed-defaults',
            'seed-defaults',
            'create-admin',
            'write-lock',
        ]);
        expect(second.outcome).toBe('completed');
        expect(second.rows.every((r) => r.status === 'done')).toBe(true);
        expect(second.rows[1].message).toBeUndefined();
    });

    it('returns the redirect from write-lock, or /login without one', async () => {
        const withRedirect = await executeRun({
            rows: [row('write-lock')],
            runStep: async () => ok(null, '/login'),
        });
        const without = await executeRun({
            rows: [row('write-lock')],
            runStep: async () => ok(),
        });
        const hostile = await executeRun({
            rows: [row('write-lock')],
            runStep: async () => ok(null, 'https://evil.test'),
        });

        expect(withRedirect.redirect).toBe('/login');
        expect(without.redirect).toBe('/login');
        expect(hostile.redirect).toBe('/login');
    });

    it('treats a rejected request as a network failure that can be retried', async () => {
        const result = await executeRun({
            rows: [row('run-migrations')],
            runStep: async () => {
                throw new TypeError('Failed to fetch');
            },
        });

        expect(result.outcome).toBe('failed');
        expect(result.rows[0]).toMatchObject({
            status: 'failed',
            code: 'network',
        });
    });

    it('finishes right away when setup was already completed elsewhere (404)', async () => {
        const runStep = vi.fn<RunStepClient>(async () => ({
            status: 'installed',
        }));

        const result = await executeRun({ rows: fortifyRows(), runStep });

        expect(runStep).toHaveBeenCalledTimes(1);
        expect(result.outcome).toBe('completed');
        expect(result.redirect).toBe('/login');
        expect(result.rows.every((r) => r.status === 'done')).toBe(true);
    });

    it('does nothing when every step is already done', async () => {
        const runStep = vi.fn<RunStepClient>(async () => ok());

        const result = await executeRun({
            rows: [row('run-migrations', 'done'), row('write-lock', 'done')],
            runStep,
        });

        expect(runStep).not.toHaveBeenCalled();
        expect(result.outcome).toBe('completed');
    });

    it('does not mutate the rows it was given', async () => {
        const rows = fortifyRows();

        await executeRun({ rows, runStep: async () => ok() });

        expect(statuses(rows)).toEqual([
            'pending',
            'pending',
            'pending',
            'pending',
        ]);
    });
});
