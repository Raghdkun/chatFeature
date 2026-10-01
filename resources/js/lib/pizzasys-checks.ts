/**
 * Presentation rules for a `PortalTestResult` (docs/contracts/auth-pizzasys.md): which order the
 * checks appear in, how a failed one is toned, and which fix hint (translation key) explains it.
 * Pure, so the wording logic is testable without rendering.
 */
import type { PortalCheck, PortalTestResult } from '@/types/pizzasys';

export const CHECK_ORDER = [
    'reachable',
    'service_credential',
    'latency',
    'nats',
] as const;

export type CheckTone = 'ok' | 'failed' | 'warning';

export type TestSummary = 'passed' | 'warning' | 'failed';

/** Contract order first; checks the UI does not know stay at the end in server order. */
export function orderedChecks(result: PortalTestResult): PortalCheck[] {
    const rank = (check: PortalCheck): number => {
        const index = (CHECK_ORDER as readonly string[]).indexOf(check.key);

        return index === -1 ? CHECK_ORDER.length : index;
    };

    return result.checks
        .map((check, position) => ({ check, position }))
        .sort(
            (a, b) => rank(a.check) - rank(b.check) || a.position - b.position,
        )
        .map(({ check }) => check);
}

/**
 * NATS is optional (the app works without it, sign-outs are just slower), so a failing NATS
 * check next to an otherwise healthy result is a warning, not a failure.
 */
export function checkTone(
    check: PortalCheck,
    result: PortalTestResult,
): CheckTone {
    if (check.ok) {
        return 'ok';
    }

    return check.key === 'nats' && result.ok ? 'warning' : 'failed';
}

export function testSummary(result: PortalTestResult): TestSummary {
    if (!result.ok) {
        return 'failed';
    }

    return result.checks.some((check) => !check.ok) ? 'warning' : 'passed';
}

/**
 * Translation key of the "how to fix it" line for a failed check, or `null` when there is nothing
 * specific to say (passed, or a check this UI does not know).
 */
export function hintKeyFor(check: PortalCheck): string | null {
    if (check.ok) {
        return null;
    }

    return (CHECK_ORDER as readonly string[]).includes(check.key)
        ? `setup.pizzasys.hint.${check.key}`
        : null;
}
