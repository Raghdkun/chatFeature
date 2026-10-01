/**
 * Auth Portal sign-in problems the login page tells apart (docs/contracts/auth-pizzasys.md,
 * "Login (mode 2)"). "No chat access" is handled by `login-notice.ts`; this adds the other
 * outcome that deserves its own wording: the portal could not be reached (`AuthOutcome::Unavailable`),
 * which is not the user's fault and must not read like a wrong password.
 *
 * Accepted signals, any one of which is enough:
 *  - Inertia prop `reason: 'unavailable'` on the login page (the backend flashes it like
 *    `no_chat_access`),
 *  - a validation error under the key `unavailable`.
 */
export const PORTAL_UNAVAILABLE = 'unavailable';

export function hasPortalUnavailable({
    reason,
    errors,
}: {
    reason?: string | null;
    errors?: Record<string, string | undefined>;
}): boolean {
    return (
        reason === PORTAL_UNAVAILABLE ||
        errors?.[PORTAL_UNAVAILABLE] !== undefined
    );
}
