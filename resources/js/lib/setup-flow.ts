/**
 * Pure logic of the setup wizard: step transitions, stepper state, the run sequence
 * (with failure and resume) and form helpers. No React, no network: the HTTP call is
 * injected, so everything here is unit-testable (see setup-flow.test.ts).
 *
 * Contract: docs/contracts/setup-wizard.md.
 */
import { LOGIN_URL, type SetupRunStepKey } from '@/lib/setup-routes';
import type {
    SetupMode,
    SetupRunFailureCode,
    SetupRunRow,
    SetupState,
    SetupStepKey,
    SetupStepSummary,
} from '@/types/setup';

/* -------------------------------------------------------------------------- */
/* Steps                                                                      */
/* -------------------------------------------------------------------------- */

export const STEP_ORDER: readonly SetupStepKey[] = [
    'welcome',
    'mode',
    'admin',
    'basics',
    'run',
    'done',
];

/** The admin step only exists for the local (Fortify) auth mode. */
export function visibleStepKeys(mode: SetupMode | null): SetupStepKey[] {
    return STEP_ORDER.filter(
        (key) => !(key === 'admin' && mode === 'pizzasys'),
    );
}

export function nextStep(
    current: SetupStepKey,
    mode: SetupMode | null,
): SetupStepKey | null {
    const keys = visibleStepKeys(mode);
    const index = keys.indexOf(current);

    return index >= 0 && index < keys.length - 1 ? keys[index + 1] : null;
}

export function previousStep(
    current: SetupStepKey,
    mode: SetupMode | null,
): SetupStepKey | null {
    const keys = visibleStepKeys(mode);
    const index = keys.indexOf(current);

    return index > 0 ? keys[index - 1] : null;
}

/** Back is offered everywhere except the first and the final step. */
export function canGoBack(view: SetupStepKey): boolean {
    return view !== 'welcome' && view !== 'done';
}

export type ViewOverride = { from: SetupStepKey; view: SetupStepKey };

/**
 * The server decides the step (`setup.step`). The client may temporarily look at another
 * step (Back, or "Continue" on a ready welcome step). The override is only honoured while
 * the server step it was made for is still current, so any server response resets it.
 */
export function resolveView(
    serverStep: SetupStepKey,
    override: ViewOverride | null,
): SetupStepKey {
    return override !== null && override.from === serverStep
        ? override.view
        : serverStep;
}

/* -------------------------------------------------------------------------- */
/* Stepper                                                                    */
/* -------------------------------------------------------------------------- */

export function stepperItems(
    steps: SetupStepSummary[],
    view: SetupStepKey,
): SetupStepSummary[] {
    const viewIndex = steps.findIndex((step) => step.key === view);

    return steps.map((step, index) => {
        if (step.key === view) {
            return { ...step, status: 'current' };
        }

        if (step.status === 'done' || (viewIndex >= 0 && index < viewIndex)) {
            return { ...step, status: 'done' };
        }

        return { ...step, status: 'pending' };
    });
}

export function stepProgress(
    steps: SetupStepSummary[],
    view: SetupStepKey,
): { index: number; total: number; label: string } {
    const index = Math.max(
        steps.findIndex((step) => step.key === view),
        0,
    );

    return {
        index: index + 1,
        total: steps.length,
        label: steps[index]?.label ?? view,
    };
}

/* -------------------------------------------------------------------------- */
/* Welcome step                                                               */
/* -------------------------------------------------------------------------- */

export function tokenGateActive(
    state: Pick<SetupState, 'needsToken' | 'tokenVerified'>,
): boolean {
    return state.needsToken && !state.tokenVerified;
}

export function environmentFailures(
    environment: SetupState['environment'],
): number {
    return environment.checks.filter((check) => !check.ok).length;
}

/** The welcome step can be left once the token gate is open and every check passed. */
export function canLeaveWelcome(
    state: Pick<SetupState, 'needsToken' | 'tokenVerified' | 'environment'>,
): boolean {
    return !tokenGateActive(state) && state.environment.ok;
}

/* -------------------------------------------------------------------------- */
/* Basics step                                                                */
/* -------------------------------------------------------------------------- */

export const IDLE_TIMEOUT = { min: 5, max: 1440, fallback: 120 } as const;

/** Whole minutes within bounds, or `null` when the input is not acceptable. */
export function parseIdleTimeout(raw: string | number): number | null {
    const text = String(raw).trim();

    if (!/^\d+$/.test(text)) {
        return null;
    }

    const value = Number(text);

    return value >= IDLE_TIMEOUT.min && value <= IDLE_TIMEOUT.max
        ? value
        : null;
}

/** What the helper text should show while the field is being edited. */
export function displayIdleTimeout(raw: string | number): number {
    return parseIdleTimeout(raw) ?? IDLE_TIMEOUT.fallback;
}

/* -------------------------------------------------------------------------- */
/* Run step                                                                   */
/* -------------------------------------------------------------------------- */

export const RUN_STEP_KEYS: readonly SetupRunStepKey[] = [
    'run-migrations',
    'seed-defaults',
    'create-admin',
    'write-lock',
];

export type RunPhase = 'idle' | 'running' | 'failed' | 'completed';

export type RunStepResult =
    | { status: 'ok'; next: string | null; redirect?: string | null }
    | { status: 'failed'; message?: string; code?: SetupRunFailureCode }
    /** HTTP 404: setup is locked, i.e. another tab or process already finished it. */
    | { status: 'installed' };

export type RunStepClient = (step: string) => Promise<RunStepResult>;

export type ExecuteRunResult = {
    rows: SetupRunRow[];
    outcome: 'completed' | 'failed';
    redirect: string | null;
    failedKey: string | null;
};

/**
 * Rows for the progress list. The server list wins; before the server has one we fall
 * back to the contract's fixed sequence. A stale `running` (page reloaded mid-run) is
 * shown as pending because the client is no longer driving it.
 */
export function initialRunRows(
    serverRows: SetupRunRow[],
    mode: SetupMode | null,
): SetupRunRow[] {
    if (serverRows.length > 0) {
        return serverRows.map((row) =>
            row.status === 'running' ? { ...row, status: 'pending' } : row,
        );
    }

    return RUN_STEP_KEYS.filter(
        (key) => !(key === 'create-admin' && mode === 'pizzasys'),
    ).map((key) => ({ key, label: key, status: 'pending' }));
}

export function firstIncompleteIndex(rows: SetupRunRow[]): number {
    return rows.findIndex((row) => row.status !== 'done');
}

export function derivePhase(rows: SetupRunRow[], busy: boolean): RunPhase {
    if (busy) {
        return 'running';
    }

    if (rows.length > 0 && rows.every((row) => row.status === 'done')) {
        return 'completed';
    }

    return rows.some((row) => row.status === 'failed') ? 'failed' : 'idle';
}

function patchRow(
    rows: SetupRunRow[],
    key: string,
    patch: Partial<SetupRunRow>,
): SetupRunRow[] {
    return rows.map((row) => (row.key === key ? { ...row, ...patch } : row));
}

/** Only same-origin absolute paths are followed; anything else falls back to login. */
export function safeRedirect(target: string | null | undefined): string {
    if (
        typeof target === 'string' &&
        target.startsWith('/') &&
        !target.startsWith('//') &&
        !target.includes('\\')
    ) {
        return target;
    }

    return LOGIN_URL;
}

/**
 * Runs the steps one after another, resuming at the first step that is not done yet
 * (so "Retry" after a failure skips everything that already succeeded). Stops at the
 * first failure. `onChange` receives every intermediate state for the UI.
 */
export async function executeRun({
    rows,
    runStep,
    onChange,
}: {
    rows: SetupRunRow[];
    runStep: RunStepClient;
    onChange?: (rows: SetupRunRow[]) => void;
}): Promise<ExecuteRunResult> {
    let current: SetupRunRow[] = rows.map((row) =>
        row.status === 'done'
            ? row
            : {
                  ...row,
                  status: 'pending',
                  message: undefined,
                  code: undefined,
              },
    );
    const emit = () => onChange?.(current);
    const start = firstIncompleteIndex(current);

    if (start === -1) {
        return {
            rows: current,
            outcome: 'completed',
            redirect: LOGIN_URL,
            failedKey: null,
        };
    }

    emit();

    let redirect: string | null = null;

    for (let index = start; index < current.length; index++) {
        const { key } = current[index];

        current = patchRow(current, key, { status: 'running' });
        emit();

        let result: RunStepResult;

        try {
            result = await runStep(key);
        } catch {
            result = { status: 'failed', code: 'network' };
        }

        if (result.status === 'installed') {
            current = current.map((row) => ({ ...row, status: 'done' }));
            emit();

            return {
                rows: current,
                outcome: 'completed',
                redirect: LOGIN_URL,
                failedKey: null,
            };
        }

        if (result.status === 'failed') {
            current = patchRow(current, key, {
                status: 'failed',
                message: result.message,
                code: result.code,
            });
            emit();

            return {
                rows: current,
                outcome: 'failed',
                redirect: null,
                failedKey: key,
            };
        }

        current = patchRow(current, key, { status: 'done' });
        emit();

        if (result.redirect) {
            redirect = result.redirect;
        }
    }

    return {
        rows: current,
        outcome: 'completed',
        redirect: safeRedirect(redirect),
        failedKey: null,
    };
}
