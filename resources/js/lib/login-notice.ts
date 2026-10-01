/**
 * Has the backend told us that the credentials were fine but the account has no chat
 * access (`AuthOutcome::NoChatAccess`, i.e. neither admin nor agent)?
 *
 * Accepted signals, any one of which is enough:
 *  - Inertia prop `reason: 'no_chat_access'` on the login page,
 *  - a validation error under the key `access` or `no_chat_access`.
 */
export const NO_CHAT_ACCESS = 'no_chat_access';

export function hasNoChatAccess({
    reason,
    errors,
}: {
    reason?: string | null;
    errors?: Record<string, string | undefined>;
}): boolean {
    return (
        reason === NO_CHAT_ACCESS ||
        errors?.access !== undefined ||
        errors?.[NO_CHAT_ACCESS] !== undefined
    );
}
