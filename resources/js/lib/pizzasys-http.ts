/**
 * Browser side of the JSON endpoints of auth mode 2 (docs/contracts/auth-pizzasys.md):
 *
 *  - `POST /setup/pizzasys/test` and `POST /settings/auth/environments/{key}/test`  -> `PortalTestResult`
 *  - `POST /setup/portal-admin`                                                    -> verified admin login
 *  - `POST /settings/auth/active-environment`                                      -> switch + redirect
 *
 * Same conventions as `setup-http.ts` (fetch + the XSRF cookie, injectable for tests): every
 * answer is mapped onto a small discriminated union so the UI never parses HTTP itself. Secrets
 * are only ever sent, never read back or logged.
 */
import { safeRedirect } from '@/lib/setup-flow';
import { readXsrfToken } from '@/lib/setup-http';
import type {
    PortalAdminCode,
    PortalCheck,
    PortalCheckKey,
    PortalTestResult,
    PizzasysEnvKey,
} from '@/types/pizzasys';

/** Why a request failed on the client; picks a translated message. */
export type PortalRequestError =
    | 'network'
    | 'forbidden'
    | 'session_expired'
    | 'throttled'
    | 'not_found'
    | 'validation'
    | 'server'
    | 'invalid_response';

export type RequestFailure = {
    status: 'error';
    code: PortalRequestError;
    message?: string;
    /** First message per field of a Laravel 422 `{ errors }` body. */
    fieldErrors?: Record<string, string>;
};

export type TestConnectionOutcome =
    | { status: 'done'; result: PortalTestResult }
    | RequestFailure;

export type PortalAdminOutcome =
    | { status: 'ok'; user: { name: string; email: string } }
    | {
          status: 'rejected';
          code: PortalAdminCode | 'unknown';
          message?: string;
      }
    | RequestFailure;

export type SwitchEnvironmentPayload = {
    env: PizzasysEnvKey;
    email: string;
    password: string;
    confirm: true;
};

export type SwitchEnvironmentOutcome =
    | { status: 'ok'; redirect: string }
    | { status: 'rejected'; message?: string }
    | RequestFailure;

export type PortalClient = {
    testConnection: (
        url: string,
        body?: Record<string, unknown>,
    ) => Promise<TestConnectionOutcome>;
    portalAdminLogin: (
        url: string,
        credentials: { email: string; password: string },
    ) => Promise<PortalAdminOutcome>;
    switchEnvironment: (
        url: string,
        payload: SwitchEnvironmentPayload,
    ) => Promise<SwitchEnvironmentOutcome>;
};

type ClientDeps = {
    fetchImpl?: typeof fetch;
    xsrfToken?: () => string | null;
};

type Answer =
    | { kind: 'network' }
    | { kind: 'http'; status: number; body: unknown };

const KNOWN_CHECK_KEYS: readonly PortalCheckKey[] = [
    'reachable',
    'service_credential',
    'latency',
    'nats',
];
const ADMIN_CODES: readonly PortalAdminCode[] = [
    'invalid',
    'unavailable',
    'no_chat_access',
    'not_admin',
];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function messageOf(body: unknown): string | undefined {
    return isRecord(body) &&
        typeof body.message === 'string' &&
        body.message !== ''
        ? body.message
        : undefined;
}

/** `{ errors: { field: ['msg', ...] } }` -> `{ field: 'msg' }` (nested paths keep their dots). */
export function fieldErrorsOf(
    body: unknown,
): Record<string, string> | undefined {
    if (!isRecord(body) || !isRecord(body.errors)) {
        return undefined;
    }

    const found: Record<string, string> = {};

    for (const [field, value] of Object.entries(body.errors)) {
        const first = Array.isArray(value) ? value[0] : value;

        if (typeof first === 'string' && first !== '') {
            found[field] = first;
        }
    }

    return Object.keys(found).length > 0 ? found : undefined;
}

/** Status codes that mean the same thing for every endpoint here. */
function failureForStatus(status: number): PortalRequestError | null {
    switch (true) {
        case status === 401 || status === 419:
            return 'session_expired';
        case status === 403:
            return 'forbidden';
        case status === 404:
            return 'not_found';
        case status === 429:
            return 'throttled';
        case status >= 500:
            return 'server';
        default:
            return null;
    }
}

function failureFrom(answer: Answer): RequestFailure {
    if (answer.kind === 'network') {
        return { status: 'error', code: 'network' };
    }

    const code = failureForStatus(answer.status);

    if (code) {
        return { status: 'error', code, message: messageOf(answer.body) };
    }

    const fieldErrors = fieldErrorsOf(answer.body);

    return {
        status: 'error',
        code: answer.status === 422 ? 'validation' : 'invalid_response',
        message: messageOf(answer.body),
        ...(fieldErrors ? { fieldErrors } : {}),
    };
}

/** Keeps only well-formed checks; unknown keys still render (with the server's label). */
export function parseTestResult(body: unknown): PortalTestResult | null {
    if (!isRecord(body) || typeof body.ok !== 'boolean') {
        return null;
    }

    if (!Array.isArray(body.checks)) {
        return null;
    }

    const checks: PortalCheck[] = [];

    for (const entry of body.checks) {
        if (
            isRecord(entry) &&
            typeof entry.key === 'string' &&
            typeof entry.ok === 'boolean'
        ) {
            checks.push({
                key: entry.key as PortalCheckKey,
                label:
                    typeof entry.label === 'string' ? entry.label : entry.key,
                ok: entry.ok,
                ...(typeof entry.message === 'string' && entry.message !== ''
                    ? { message: entry.message }
                    : {}),
            });
        }
    }

    return { ok: body.ok, checks };
}

export function isKnownCheckKey(key: string): key is PortalCheckKey {
    return (KNOWN_CHECK_KEYS as readonly string[]).includes(key);
}

export function createPortalClient({
    fetchImpl = (...args) => fetch(...args),
    xsrfToken = () => readXsrfToken(),
}: ClientDeps = {}): PortalClient {
    async function post(url: string, payload?: unknown): Promise<Answer> {
        const headers: Record<string, string> = {
            Accept: 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
        };
        const token = xsrfToken();

        if (token) {
            headers['X-XSRF-TOKEN'] = token;
        }

        if (payload !== undefined) {
            headers['Content-Type'] = 'application/json';
        }

        let response: Response;

        try {
            response = await fetchImpl(url, {
                method: 'POST',
                headers,
                credentials: 'same-origin',
                body:
                    payload === undefined ? undefined : JSON.stringify(payload),
            });
        } catch {
            return { kind: 'network' };
        }

        let body: unknown = null;

        try {
            body = await response.json();
        } catch {
            body = null;
        }

        return { kind: 'http', status: response.status, body };
    }

    return {
        async testConnection(url, body) {
            const answer = await post(url, body ?? {});

            if (answer.kind === 'http' && answer.status === 200) {
                const result = parseTestResult(answer.body);

                return result
                    ? { status: 'done', result }
                    : { status: 'error', code: 'invalid_response' };
            }

            return failureFrom(answer);
        },

        async portalAdminLogin(url, credentials) {
            const answer = await post(url, credentials);

            if (answer.kind === 'http' && isRecord(answer.body)) {
                const { body, status } = answer;

                if (
                    status === 200 &&
                    body.ok === true &&
                    body.isAdmin !== false
                ) {
                    const user = isRecord(body.user) ? body.user : {};

                    return {
                        status: 'ok',
                        user: {
                            name:
                                typeof user.name === 'string'
                                    ? user.name
                                    : credentials.email,
                            email:
                                typeof user.email === 'string'
                                    ? user.email
                                    : credentials.email,
                        },
                    };
                }

                if (body.ok === false || body.isAdmin === false) {
                    const code = (ADMIN_CODES as readonly unknown[]).includes(
                        body.code,
                    )
                        ? (body.code as PortalAdminCode)
                        : body.isAdmin === false
                          ? 'not_admin'
                          : 'unknown';

                    return {
                        status: 'rejected',
                        code,
                        message: messageOf(body),
                    };
                }
            }

            return failureFrom(answer);
        },

        async switchEnvironment(url, payload) {
            const answer = await post(url, payload);

            if (answer.kind === 'http' && isRecord(answer.body)) {
                const { body, status } = answer;

                if (status === 200 && body.ok === true) {
                    return {
                        status: 'ok',
                        redirect: safeRedirect(
                            typeof body.redirect === 'string'
                                ? body.redirect
                                : null,
                        ),
                    };
                }

                if (body.ok === false) {
                    return { status: 'rejected', message: messageOf(body) };
                }
            }

            return failureFrom(answer);
        },
    };
}

/** The client the pages use; tests pass their own. */
export const portalClient: PortalClient = createPortalClient();
