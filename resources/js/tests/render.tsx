/**
 * Minimal React rendering helpers for Vitest + jsdom (no testing-library dependency).
 * Not imported by the app; only by `*.test.tsx` files.
 */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach } from 'vite-plus/test';

(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; container: HTMLElement }[] = [];

export type Rendered = {
    container: HTMLElement;
    /** `[data-testid="..."]` lookup. */
    byTestId: (id: string) => HTMLElement | null;
    allByTestId: (id: string) => HTMLElement[];
    text: () => string;
    unmount: () => Promise<void>;
};

export async function render(ui: ReactElement): Promise<Rendered> {
    const container = document.createElement('div');

    document.body.append(container);

    const root = createRoot(container);

    mounted.push({ root, container });

    await act(async () => {
        root.render(ui);
    });

    return {
        container,
        byTestId: (id) =>
            container.querySelector<HTMLElement>(`[data-testid="${id}"]`),
        allByTestId: (id) =>
            Array.from(
                container.querySelectorAll<HTMLElement>(
                    `[data-testid="${id}"]`,
                ),
            ),
        text: () => container.textContent ?? '',
        unmount: () =>
            act(async () => {
                root.unmount();
            }),
    };
}

export async function click(element: HTMLElement | null): Promise<void> {
    if (!element) {
        throw new Error('click(): element not found');
    }

    await act(async () => {
        element.click();
    });
}

/** Sets a controlled input's value the way a user typing would (fires React's onChange). */
export async function typeInto(
    input: HTMLInputElement | null,
    value: string,
): Promise<void> {
    if (!input) {
        throw new Error('typeInto(): input not found');
    }

    // The prototype's setter bypasses React's value tracking, like a real keystroke.
    const { set: setValue } = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
    ) as { set: (this: HTMLInputElement, next: string) => void };

    await act(async () => {
        setValue.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

/** Lets queued promises (mock fetches, state updates) settle. */
export async function flush(): Promise<void> {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

afterEach(async () => {
    while (mounted.length > 0) {
        const entry = mounted.pop();

        if (entry) {
            await act(async () => {
                entry.root.unmount();
            });
            entry.container.remove();
        }
    }
});
