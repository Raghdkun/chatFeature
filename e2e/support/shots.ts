/**
 * Shared by the screenshot specs for the deck (e2e/screenshots/p*.spec.ts): the two viewports, contexts
 * with fixed locale/timezone/motion, and the capture helpers (full page or one element, light and dark).
 *
 * Deterministic on purpose: fixed names and data, reduced motion, web fonts and every finite transition
 * settled, animations disabled, caret hidden, no focus ring left behind.
 */
import {
    type Browser,
    type BrowserContext,
    type Locator,
    type Page,
} from '@playwright/test';
import { setTheme, settle } from './helpers';
import { ALL_INSTANCES, type Instance } from './scenarios';

export type Viewport = 'desktop' | 'mobile';

export const VIEWPORTS: Record<Viewport, Parameters<Browser['newContext']>[0]> =
    {
        desktop: {
            viewport: { width: 1280, height: 800 },
            deviceScaleFactor: 1,
        },
        mobile: {
            viewport: { width: 375, height: 812 },
            deviceScaleFactor: 2,
            isMobile: true,
            hasTouch: true,
        },
    };

export const instance = (key: string): Instance => {
    const found = ALL_INSTANCES.find((item) => item.key === key);

    if (!found) {
        throw new Error(`Unknown scenario ${key}`);
    }

    return found;
};

export async function newContext(
    browser: Browser,
    viewport: Viewport,
    target: Instance,
    storageState?: string,
): Promise<BrowserContext> {
    return browser.newContext({
        ...VIEWPORTS[viewport],
        baseURL: target.url,
        colorScheme: 'light',
        reducedMotion: 'reduce',
        locale: target.locale === 'ar' ? 'ar' : 'en-US',
        timezoneId: 'UTC',
        // An explicit empty state: `browser.newContext()` would inherit the saved session of a `role` otherwise.
        storageState: storageState ?? { cookies: [], origins: [] },
    });
}

async function prepareShot(page: Page, theme: 'light' | 'dark') {
    await setTheme(page, theme);
    await settle(page);
    await page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur();
    });
}

/** Saves the current screen (full page) in light and dark as `<output>/<name>-<viewport>-<theme>.png`. */
export async function captureTo(
    output: string,
    page: Page,
    viewport: Viewport,
    name: string,
): Promise<void> {
    for (const theme of ['light', 'dark'] as const) {
        await prepareShot(page, theme);

        await page.screenshot({
            path: `${output}/${name}-${viewport}-${theme}.png`,
            fullPage: true,
            animations: 'disabled',
            caret: 'hide',
        });
    }

    await setTheme(page, 'light');
}

/** Same, but only one element (a card, a dialog) in light and dark. */
export async function captureElementTo(
    output: string,
    page: Page,
    target: Locator,
    viewport: Viewport,
    name: string,
): Promise<void> {
    for (const theme of ['light', 'dark'] as const) {
        await prepareShot(page, theme);

        await target.screenshot({
            path: `${output}/${name}-${viewport}-${theme}.png`,
            animations: 'disabled',
            caret: 'hide',
        });
    }

    await setTheme(page, 'light');
}
