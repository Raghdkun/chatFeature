/**
 * A tiny stand-in for `@inertiajs/react` in jsdom tests:
 *
 *   vi.mock('@inertiajs/react', async () => (await import('@/tests/inertia-mock')).inertiaMock());
 *
 * Tests steer it through `inertiaState` (page props, form errors, processing flag).
 */
import { act, createElement, type ReactNode } from 'react';
import { vi } from 'vite-plus/test';

export const inertiaState: {
    props: Record<string, unknown>;
    formErrors: Record<string, string>;
    formProcessing: boolean;
} = { props: {}, formErrors: {}, formProcessing: false };

type RouterHandler = (event: { detail: Record<string, unknown> }) => void;

const routerHandlers = new Map<string, Set<RouterHandler>>();

export const routerMock = {
    reload: vi.fn(),
    visit: vi.fn(),
    /** `router.get(url, data, options)`: recorded (the history filters use it). */
    get: vi.fn(),
    /** `router.post|put(url, data, options)`: recorded; tests finish them with {@link completeVisit}. */
    post: vi.fn(),
    put: vi.fn(),
    /** Records the listeners so tests can fire Inertia events with {@link fireRouterEvent}. */
    on: vi.fn((event: string, handler: RouterHandler) => {
        const handlers = routerHandlers.get(event) ?? new Set<RouterHandler>();

        handlers.add(handler);
        routerHandlers.set(event, handlers);

        return () => {
            handlers.delete(handler);
        };
    }),
};

type VisitOptions = {
    onStart?: () => void;
    onSuccess?: (page: unknown) => void;
    onError?: (errors: Record<string, string>) => void;
    onFinish?: () => void;
};

export type RecordedVisit = {
    url: string;
    data: Record<string, unknown>;
    options: VisitOptions;
};

/** The most recent `router.post|put` call, as recorded by the mock. */
export function lastVisit(method: 'post' | 'put'): RecordedVisit {
    const calls = routerMock[method].mock.calls;
    const call = calls[calls.length - 1];

    if (!call) {
        throw new Error(`router.${method} was not called`);
    }

    return { url: call[0], data: call[1], options: call[2] ?? {} };
}

/**
 * Plays a recorded visit to its end the way Inertia would: `onStart`, then `onSuccess` (or
 * `onError` when `errors` is given), then `onFinish`.
 */
export async function completeVisit(
    visit: RecordedVisit,
    outcome: { errors?: Record<string, string> } = {},
): Promise<void> {
    await act(async () => {
        visit.options.onStart?.();
    });
    await act(async () => {
        if (outcome.errors) {
            visit.options.onError?.(outcome.errors);
        } else {
            visit.options.onSuccess?.({});
        }
    });
    await act(async () => {
        visit.options.onFinish?.();
    });
}

/** Fire an Inertia router event (`start`, `success`, ...) at the registered listeners. */
export function fireRouterEvent(
    event: string,
    detail: Record<string, unknown> = {},
): void {
    routerHandlers.get(event)?.forEach((handler) => handler({ detail }));
}

type FormProps = {
    action?: string;
    method?: string;
    className?: string;
    children: ReactNode | ((slot: Record<string, unknown>) => ReactNode);
};

function Form({ action, method, className, children }: FormProps) {
    return createElement(
        'form',
        { action, method, className, 'data-mock-form': true },
        typeof children === 'function'
            ? children({
                  errors: inertiaState.formErrors,
                  processing: inertiaState.formProcessing,
                  hasErrors: Object.keys(inertiaState.formErrors).length > 0,
              })
            : children,
    );
}

function Link({
    href,
    children,
    className,
    data,
    ...rest
}: {
    href: string | { url: string };
    children?: ReactNode;
    className?: string;
    /** A GET visit's query data: shown in the `href`, as Inertia would request it. */
    data?: Record<string, string>;
    [key: string]: unknown;
}) {
    const passthrough = Object.fromEntries(
        Object.entries(rest).filter(([key]) =>
            [
                'tabIndex',
                'data-test',
                'data-testid',
                'aria-label',
                'aria-current',
                'data-unseen',
            ].includes(key),
        ),
    );

    const base = typeof href === 'string' ? href : href.url;
    const query = data ? new URLSearchParams(data).toString() : '';

    return createElement(
        'a',
        {
            href: query === '' ? base : `${base}?${query}`,
            className,
            ...passthrough,
        },
        children,
    );
}

export function inertiaMock() {
    return {
        usePage: () => ({
            props: inertiaState.props,
            url: '/',
            component: 'test',
        }),
        Form,
        Link,
        Head: () => null,
        router: routerMock,
        setLayoutProps: vi.fn(),
        resetLayoutProps: vi.fn(),
    };
}

export function resetInertiaMock(props: Record<string, unknown> = {}) {
    inertiaState.props = {
        name: 'PNE Chat',
        locale: 'en',
        direction: 'ltr',
        ...props,
    };
    inertiaState.formErrors = {};
    inertiaState.formProcessing = false;
    routerMock.reload.mockClear();
    routerMock.visit.mockClear();
    routerMock.get.mockClear();
    routerMock.post.mockClear();
    routerMock.put.mockClear();
}
