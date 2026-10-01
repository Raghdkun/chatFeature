/**
 * Helpers for the cross-origin embed specs: build the URL of the "customer site" (e2e/support/host-server.mjs) and read
 * the widget out of its closed-looking-but-open shadow root.
 */
import type { Locator, Page } from '@playwright/test';
import type { Instance } from './scenarios';

export type HostOptions = {
    /** Widget public key (`wk_...`). */
    key: string;
    /** How the page includes the loader: `w` = /w/<key>.js (default), `generic` = /widget/v1/loader.js + data-widget-key, `none`. */
    src?: 'w' | 'generic' | 'none';
    /** data-* attributes of the script tag (names without the `data-` prefix). */
    attrs?: Record<string, string>;
    /** `window.ChatFeatureSettings`. */
    settings?: Record<string, unknown>;
    hostile?: boolean;
    rtl?: boolean;
    /** Strict page CSP: script-src / frame-src / connect-src to the app only, no inline styles. */
    csp?: boolean;
    twice?: boolean;
    /** Add the script N ms after the page loaded. */
    late?: number;
    /** Page height in px. */
    height?: number;
    title?: string;
    /** Which hostname the page is served from (same server, other origin): default `localhost`. */
    hostname?: string;
};

/** `http://<hostname>:<host port>/page.html?...` of the instance's host server. */
export function hostPage(instance: Instance, options: HostOptions): string {
    if (instance.hostPort === null) {
        throw new Error(`Scenario ${instance.key} has no host page server.`);
    }

    const query = new URLSearchParams({ key: options.key });

    if (options.src) {
        query.set('src', options.src);
    }

    if (options.attrs) {
        query.set('attrs', JSON.stringify(options.attrs));
    }

    if (options.settings) {
        query.set('settings', JSON.stringify(options.settings));
    }

    for (const flag of ['hostile', 'rtl', 'csp', 'twice'] as const) {
        if (options[flag]) {
            query.set(flag, '1');
        }
    }

    if (options.late) {
        query.set('late', String(options.late));
    }

    if (options.height !== undefined) {
        query.set('height', String(options.height));
    }

    if (options.title) {
        query.set('title', options.title);
    }

    return `http://${options.hostname ?? 'localhost'}:${instance.hostPort}/page.html?${query}`;
}

/** The origin (`http://host:port`) a page of `hostPage()` runs on. */
export function hostOrigin(instance: Instance, hostname = 'localhost'): string {
    return `http://${hostname}:${instance.hostPort}`;
}

/** The widget's custom element (light DOM, `<pne-chat-widget>`). */
export const widgetHost = (page: Page): Locator =>
    page.locator('pne-chat-widget');

/** Locators inside the open shadow root (Playwright pierces open shadow DOM). */
export const widget = (page: Page) => ({
    host: widgetHost(page),
    launcher: page.locator('pne-chat-widget button.launcher'),
    greeting: page.locator('pne-chat-widget .greet'),
    greetingBody: page.locator('pne-chat-widget .greet .g-body'),
    greetingName: page.locator('pne-chat-widget .greet .g-name'),
    greetingClose: page.locator('pne-chat-widget .greet .g-x'),
    greetingOpen: page.locator('pne-chat-widget .greet .g-main'),
    panel: page.locator('pne-chat-widget .panel'),
    iframe: page.locator('pne-chat-widget .panel iframe'),
    card: page.locator('pne-chat-widget .card'),
    root: page.locator('pne-chat-widget .root'),
});

export type RecordedEvent = {
    name: string;
    data: Record<string, unknown>;
    at: number;
};

/** The events the page recorded (`window.__events`). */
export function recordedEvents(page: Page): Promise<RecordedEvent[]> {
    return page.evaluate(
        () => (window as unknown as { __events: RecordedEvent[] }).__events,
    );
}

/** Calls the host's JS API from the page (`ChatFeature(...)`). */
export function chatFeature<T = unknown>(
    page: Page,
    command: string,
    ...args: unknown[]
): Promise<T> {
    return page.evaluate(
        ([name, rest]) =>
            (
                window as unknown as {
                    ChatFeature: (...call: unknown[]) => unknown;
                }
            ).ChatFeature(name, ...(rest as unknown[])) as T,
        [command, args] as const,
    );
}

/**
 * Waits until the widget's own entrance animations and transitions (launcher pop-in, flip, panel slide: 150-600 ms) are over,
 * so geometry and colours are measured at rest. Bounding boxes include transforms, so a mid-animation box is off by pixels.
 */
export async function settleWidget(page: Page): Promise<void> {
    await page.locator('pne-chat-widget').evaluate(async (host) => {
        const root = host.shadowRoot;

        for (let pass = 0; pass < 6; pass += 1) {
            await new Promise<void>((resolve) =>
                requestAnimationFrame(() =>
                    requestAnimationFrame(() => resolve()),
                ),
            );

            const running = (root?.getAnimations() ?? []).filter(
                (animation) =>
                    animation.effect?.getComputedTiming().iterations !==
                    Infinity,
            );

            if (running.length === 0) {
                return;
            }

            await Promise.all(
                running.map((animation) =>
                    animation.finished.catch(() => undefined),
                ),
            );
        }
    });
}
