/**
 * Browser side of `POST /setup/run/{step}` (JSON). Kept apart from the React components so
 * the status handling can be tested with a fake `fetch`.
 */
import { setupRoutes } from '@/lib/setup-routes';
import type { RunStepClient, RunStepResult } from '@/lib/setup-flow';

type RunClientDeps = {
    fetchImpl?: typeof fetch;
    xsrfToken?: () => string | null;
    urlFor?: (step: string) => string;
};

/** Laravel hands the CSRF token to JS through the (URL-encoded) XSRF-TOKEN cookie. */
export function readXsrfToken(
    cookies: string = document.cookie,
): string | null {
    const match = cookies
        .split('; ')
        .find((entry) => entry.startsWith('XSRF-TOKEN='));

    if (!match) {
        return null;
    }

    try {
        return decodeURIComponent(match.slice('XSRF-TOKEN='.length));
    } catch {
        return null;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/** `message`, or the per-field errors (`fields`) a failed step may carry, joined. */
function failureMessage(body: Record<string, unknown>): string | undefined {
    if (typeof body.message === 'string' && body.message !== '') {
        return body.message;
    }

    if (isRecord(body.fields)) {
        const messages = Object.values(body.fields)
            .flat()
            .filter((value): value is string => typeof value === 'string');

        return messages.length > 0 ? messages.join(' ') : undefined;
    }

    return undefined;
}

/** Maps an HTTP response of the run endpoint onto a {@link RunStepResult}. */
export async function interpretRunResponse(
    response: Response,
): Promise<RunStepResult> {
    switch (response.status) {
        case 403:
            return { status: 'failed', code: 'forbidden' };
        case 409:
            return { status: 'failed', code: 'conflict' };
        case 419:
            return { status: 'failed', code: 'session_expired' };
        case 429:
            return { status: 'failed', code: 'throttled' };
    }

    let body: unknown = null;

    try {
        body = await response.json();
    } catch {
        body = null;
    }

    // Only an explicit marker means "already installed"; any other 404 (wrong base path, proxy,
    // unknown step) is a real failure and must not be reported as success.
    if (response.status === 404) {
        return isRecord(body) && body.status === 'installed'
            ? { status: 'installed' }
            : { status: 'failed', code: 'server' };
    }

    if (response.ok && isRecord(body)) {
        if (body.status === 'ok') {
            return {
                status: 'ok',
                next: typeof body.next === 'string' ? body.next : null,
                redirect:
                    typeof body.redirect === 'string' ? body.redirect : null,
            };
        }

        if (body.status === 'failed') {
            return {
                status: 'failed',
                message: failureMessage(body),
            };
        }
    }

    return {
        status: 'failed',
        message:
            isRecord(body) && typeof body.message === 'string'
                ? body.message
                : undefined,
        code: response.ok ? 'invalid_response' : 'server',
    };
}

/** Network errors reject; the caller (`executeRun`) turns that into a `network` failure. */
export function createRunStepClient({
    fetchImpl = (...args) => fetch(...args),
    xsrfToken = () => readXsrfToken(),
    urlFor = setupRoutes.run,
}: RunClientDeps = {}): RunStepClient {
    return async (step) => {
        const headers: Record<string, string> = {
            Accept: 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
        };
        const token = xsrfToken();

        if (token) {
            headers['X-XSRF-TOKEN'] = token;
        }

        const response = await fetchImpl(urlFor(step), {
            method: 'POST',
            headers,
            credentials: 'same-origin',
        });

        return interpretRunResponse(response);
    };
}
