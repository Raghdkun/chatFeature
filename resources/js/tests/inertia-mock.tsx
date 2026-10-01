/**
 * A tiny stand-in for `@inertiajs/react` in jsdom tests:
 *
 *   vi.mock('@inertiajs/react', async () => (await import('@/tests/inertia-mock')).inertiaMock());
 *
 * Tests steer it through `inertiaState` (page props, form errors, processing flag).
 */
import { createElement, type ReactNode } from 'react';
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
    ...rest
}: {
    href: string | { url: string };
    children?: ReactNode;
    className?: string;
    [key: string]: unknown;
}) {
    const passthrough = Object.fromEntries(
        Object.entries(rest).filter(([key]) =>
            ['tabIndex', 'data-test', 'data-testid', 'aria-label'].includes(
                key,
            ),
        ),
    );

    return createElement(
        'a',
        {
            href: typeof href === 'string' ? href : href.url,
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
}
