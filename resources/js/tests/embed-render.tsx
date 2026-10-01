/** Rendering helpers for the embed panel: the real `App` on top of a harness controller, plus act-aware waiting. */
import '@/tests/dom-polyfills';
import { act } from 'react';
import { App } from '@/embed/components/app';
import { preloadHeavy } from '@/embed/components/lazy';
import type { PanelEnv } from '@/embed/components/context';
import { until, type Harness } from '@/tests/embed-harness';
import { render, type Rendered } from '@/tests/render';

// jsdom has no layout: the panel only needs these not to throw.
if (typeof Element.prototype.scrollTo !== 'function') {
    Element.prototype.scrollTo = function scrollTo(
        this: Element,
        options?: ScrollToOptions | number,
    ): void {
        if (typeof options === 'object') {
            this.scrollTop = options.top ?? 0;
        }
    } as typeof Element.prototype.scrollTo;
}

let objectUrls = 0;

if (typeof URL.createObjectURL !== 'function') {
    URL.createObjectURL = () => `blob:test/${++objectUrls}`;
    URL.revokeObjectURL = () => undefined;
}

// The split chunks (conversation, offline form, overlays) are loaded up front so a test never renders a Suspense fallback.
await preloadHeavy();

export const ENV: PanelEnv = {
    mode: 'launcher',
    preview: false,
    hasHost: true,
};

export async function renderPanel(
    harness: Harness,
    env: PanelEnv = ENV,
): Promise<Rendered> {
    return render(<App controller={harness.controller} env={env} />);
}

/** Wait for a condition while letting React flush the store updates that cause it. */
export async function waitFor(
    predicate: () => boolean,
    timeout = 2000,
): Promise<void> {
    await act(async () => {
        await until(predicate, timeout);
    });
}

/** Let pending store updates render. */
export async function flushUi(ms = 20): Promise<void> {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
    });
}

/** The panel focuses its first control on the next animation frame after opening or changing screen: let that happen. */
export async function settleFrame(): Promise<void> {
    await act(async () => {
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
        );
    });
}

/** Run something that updates the controller outside a React event (a socket event, a host message). */
export async function run(action: () => void | Promise<void>): Promise<void> {
    await act(async () => {
        await action();
    });
}

export function text(element: Element | null): string {
    return element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

/** A keyboard event on an element (React listens at the root, so bubbling must be on). */
export async function press(
    element: HTMLElement | null,
    key: string,
    init: KeyboardEventInit = {},
): Promise<KeyboardEvent> {
    if (!element) {
        throw new Error('press(): element not found');
    }

    const event = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        ...init,
    });

    await act(async () => {
        element.dispatchEvent(event);
    });

    return event;
}
