/**
 * Typed fetch wrapper for the management REST API (docs/contracts/rest-shapes.md).
 *
 * - Session cookie + `X-XSRF-TOKEN` (Laravel hands the token over in the XSRF-TOKEN cookie).
 * - Success: `{ data }` is unwrapped. Errors: `{ error: { code, message, details? } }` becomes an
 *   {@link ApiError}; `details` is `{ field: string[] }` for 422s.
 * - 401 reloads the page (the `auth` middleware then sends the visitor to the login screen),
 *   419 refreshes the CSRF cookie once and retries, 429 carries `Retry-After`.
 *
 * Framework-free so it can be tested with a fake `fetch`.
 */
import { widgetsRoutes } from '@/lib/widgets-routes';

/**
 * Laravel hands the CSRF token to JS through the (URL-encoded) `XSRF-TOKEN` cookie. (Same idea as
 * the setup wizard's reader; kept local so this module does not pull the wizard's route table.)
 */
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

export type ApiFieldErrors = Record<string, string[]>;

export type ApiErrorCode =
    | 'unauthenticated'
    | 'csrf_mismatch'
    | 'rate_limited'
    | 'network'
    | 'invalid_response'
    | 'server_error'
    | (string & {});

export class ApiError extends Error {
    readonly status: number;
    readonly code: ApiErrorCode;
    readonly details: ApiFieldErrors;
    /** Seconds from `Retry-After` on a 429, when the server sent it. */
    readonly retryAfter: number | null;

    constructor(init: {
        status: number;
        code: ApiErrorCode;
        message: string;
        details?: ApiFieldErrors;
        retryAfter?: number | null;
    }) {
        super(init.message);
        this.name = 'ApiError';
        this.status = init.status;
        this.code = init.code;
        this.details = init.details ?? {};
        this.retryAfter = init.retryAfter ?? null;
    }

    get isValidation(): boolean {
        return this.status === 422;
    }

    /** First message for a field, or the first message of any field when `field` is omitted. */
    firstMessage(field?: string): string | undefined {
        if (field !== undefined) {
            return this.details[field]?.[0];
        }

        return Object.values(this.details).flat()[0];
    }
}

export function isApiError(value: unknown): value is ApiError {
    return value instanceof ApiError;
}

type Query = Record<string, string | number | boolean | null | undefined>;

export type RequestOptions = {
    query?: Query;
    signal?: AbortSignal;
};

export type ApiClientDeps = {
    fetchImpl?: typeof fetch;
    xsrfToken?: () => string | null;
    /** 401 handler. Default: reload so the `auth` middleware redirects to the login page. */
    onUnauthenticated?: () => void;
    /** Where Sanctum issues the CSRF cookie; `null` disables the 419 retry. */
    csrfCookieUrl?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function normaliseDetails(raw: unknown): ApiFieldErrors {
    if (!isRecord(raw)) {
        return {};
    }

    const details: ApiFieldErrors = {};

    for (const [field, value] of Object.entries(raw)) {
        const messages = (Array.isArray(value) ? value : [value]).filter(
            (item): item is string => typeof item === 'string' && item !== '',
        );

        if (messages.length > 0) {
            details[field] = messages;
        }
    }

    return details;
}

function parseRetryAfter(header: string | null): number | null {
    if (!header) {
        return null;
    }

    const seconds = Number(header);

    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.ceil(seconds);
    }

    const date = Date.parse(header);

    return Number.isNaN(date)
        ? null
        : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function withQuery(path: string, query?: Query): string {
    if (!query) {
        return path;
    }

    const params = new URLSearchParams();

    for (const [key, value] of Object.entries(query)) {
        if (value !== null && value !== undefined) {
            params.set(key, String(value));
        }
    }

    const qs = params.toString();

    return qs === '' ? path : `${path}${path.includes('?') ? '&' : '?'}${qs}`;
}

async function readBody(response: Response): Promise<unknown> {
    if (response.status === 204) {
        return null;
    }

    try {
        return await response.json();
    } catch {
        return undefined;
    }
}

function toError(response: Response, body: unknown): ApiError {
    const envelope =
        isRecord(body) && isRecord(body.error) ? body.error : undefined;
    const message =
        envelope && typeof envelope.message === 'string'
            ? envelope.message
            : '';
    const serverCode =
        envelope && typeof envelope.code === 'string' ? envelope.code : '';
    const details = normaliseDetails(envelope?.details);

    // Laravel's own validation response (no envelope) still has `errors`.
    const fallbackDetails =
        !envelope && isRecord(body) ? normaliseDetails(body.errors) : {};

    switch (response.status) {
        case 401:
            return new ApiError({
                status: 401,
                code: serverCode || 'unauthenticated',
                message: message || 'You are signed out.',
            });
        case 419:
            return new ApiError({
                status: 419,
                code: 'csrf_mismatch',
                message: message || 'Your session token expired.',
            });
        case 429:
            return new ApiError({
                status: 429,
                code: serverCode || 'rate_limited',
                message: message || 'Too many requests.',
                retryAfter: parseRetryAfter(
                    response.headers.get('Retry-After'),
                ),
            });
    }

    return new ApiError({
        status: response.status,
        code:
            serverCode ||
            (response.status >= 500
                ? 'server_error'
                : response.status === 422
                  ? 'validation_failed'
                  : 'request_failed'),
        message: message || `Request failed (${response.status}).`,
        details: Object.keys(details).length > 0 ? details : fallbackDetails,
    });
}

export function createApiClient({
    fetchImpl = (...args) => fetch(...args),
    xsrfToken = () => readXsrfToken(),
    onUnauthenticated = () => window.location.reload(),
    csrfCookieUrl = widgetsRoutes.csrfCookie(),
}: ApiClientDeps = {}) {
    async function send(
        method: string,
        path: string,
        body: unknown,
        options: RequestOptions,
    ): Promise<Response> {
        const headers: Record<string, string> = {
            Accept: 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
        };
        const token = xsrfToken();

        if (token) {
            headers['X-XSRF-TOKEN'] = token;
        }

        const init: RequestInit = {
            method,
            headers,
            credentials: 'same-origin',
            signal: options.signal,
        };

        if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(body);
        }

        try {
            return await fetchImpl(withQuery(path, options.query), init);
        } catch (cause) {
            if (cause instanceof DOMException && cause.name === 'AbortError') {
                throw cause;
            }

            throw new ApiError({
                status: 0,
                code: 'network',
                message: 'The server could not be reached.',
            });
        }
    }

    async function refreshCsrfCookie(options: RequestOptions): Promise<void> {
        if (csrfCookieUrl === null) {
            return;
        }

        try {
            await fetchImpl(csrfCookieUrl, {
                method: 'GET',
                headers: { Accept: 'application/json' },
                credentials: 'same-origin',
                signal: options.signal,
            });
        } catch {
            // The retry below reports the real failure.
        }
    }

    async function request<T>(
        method: string,
        path: string,
        body?: unknown,
        options: RequestOptions = {},
    ): Promise<T> {
        let response = await send(method, path, body, options);

        if (response.status === 419 && csrfCookieUrl !== null) {
            await refreshCsrfCookie(options);
            response = await send(method, path, body, options);
        }

        const payload = await readBody(response);

        if (!response.ok) {
            const error = toError(response, payload);

            if (response.status === 401) {
                onUnauthenticated();
            }

            throw error;
        }

        if (payload === undefined) {
            throw new ApiError({
                status: response.status,
                code: 'invalid_response',
                message: 'The server sent an unexpected answer.',
            });
        }

        if (isRecord(payload) && 'data' in payload) {
            return payload.data as T;
        }

        return payload as T;
    }

    return {
        get: <T>(path: string, options?: RequestOptions) =>
            request<T>('GET', path, undefined, options),
        post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
            request<T>('POST', path, body ?? {}, options),
        put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
            request<T>('PUT', path, body ?? {}, options),
        patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
            request<T>('PATCH', path, body ?? {}, options),
        delete: <T = void>(path: string, options?: RequestOptions) =>
            request<T>('DELETE', path, undefined, options),
    };
}

export type ApiClient = ReturnType<typeof createApiClient>;

/** The client the screens use. It resolves `fetch` lazily, so tests simply `vi.stubGlobal('fetch', ...)`. */
export const api: ApiClient = createApiClient();

type Translate = (
    key: string,
    replacements?: Record<string, string | number>,
) => string;

/**
 * A sentence for the toast / inline alert. Server messages win for domain errors
 * (`category_in_use`, ...), while transport problems get a translated, actionable text.
 */
export function describeApiError(error: unknown, t: Translate): string {
    if (!isApiError(error)) {
        return t('widgets.api.error.unknown');
    }

    switch (error.code) {
        case 'network':
            return t('widgets.api.error.network');
        case 'unauthenticated':
            return t('widgets.api.error.unauthenticated');
        case 'csrf_mismatch':
            return t('widgets.api.error.csrf');
        case 'rate_limited':
            return error.retryAfter !== null
                ? t('widgets.api.error.rate_limited_after', {
                      seconds: error.retryAfter,
                  })
                : t('widgets.api.error.rate_limited');
        case 'forbidden':
            return t('widgets.api.error.forbidden');
        case 'server_error':
            return t('widgets.api.error.server');
        case 'invalid_response':
            return t('widgets.api.error.invalid_response');
    }

    if (error.isValidation) {
        return error.firstMessage() ?? error.message;
    }

    return error.message || t('widgets.api.error.unknown');
}
