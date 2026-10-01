/**
 * The panel's side of "forget this token" in launcher mode. The loader keeps the visitor token in the HOST page's storage, which
 * every tab of that page shares, so the panel never wipes it blindly: it sends `session { drop: <token> }` and the loader removes
 * its copy only while that copy still holds the token. When another tab rotated the session meanwhile the loader answers with that
 * newer session (host `session`), which this tab adopts; `null` means "cleared, nothing newer".
 *
 * A loader that predates the answer never replies: the wait is bounded and means "cleared" (what an unconditional clear did).
 */
import type { StoredSession } from '@/embed/session/controller';

export const DROP_TIMEOUT_MS = 1500;

export type HostSessionLink = {
    drop(token: string): Promise<StoredSession | null>;
    /** Feeds the host's `session` answers in. */
    answer(session: StoredSession | null): void;
};

export function createHostSessionLink(
    sendDrop: (token: string) => void,
    timeoutMs: number = DROP_TIMEOUT_MS,
): HostSessionLink {
    const waiting: ((session: StoredSession | null) => void)[] = [];

    return {
        drop(token) {
            return new Promise((resolve) => {
                const done = (session: StoredSession | null): void => {
                    clearTimeout(timer);

                    const at = waiting.indexOf(done);

                    if (at !== -1) {
                        waiting.splice(at, 1);
                    }

                    resolve(session);
                };
                const timer = setTimeout(() => done(null), timeoutMs);

                waiting.push(done);
                sendDrop(token);
            });
        },

        answer(session) {
            waiting.shift()?.(session);
        },
    };
}
