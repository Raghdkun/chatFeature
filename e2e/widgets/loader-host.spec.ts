import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { type Page } from '@playwright/test';
import { ROOT } from '../support/scenarios';
import {
    chatFeature,
    hostPage,
    recordedEvents,
    settleWidget,
    widget,
    type RecordedEvent,
} from '../support/host';
import { collectConsole, liveWidget, POOL } from '../support/loader';
import { expect, test } from '../support/test';

/**
 * The REAL embeddable widget on a customer-site page of another origin (`http://localhost:<host port>` includes
 * `http://127.0.0.1:<app port>/w/<key>.js`): shadow-DOM launcher styled from the dashboard config, hostile host CSS,
 * `data-*` / `ChatFeatureSettings` overrides, the greeting popup and its dismiss policies, opening the chat iframe (the P3
 * panel stub never says `ready`, so the loader's handshake watchdog is exercised on desktop and on a phone viewport), and the
 * JS API. Origin and caching rules are in loader-origin.spec.ts.
 *
 * The page plays an anonymous visitor: no dashboard session in this browser (`adminApi` is a context of its own).
 */
test.use({ scenario: 'p3-host' });

const LAUNCHER_SIZE = { sm: 48, md: 60, lg: 72 } as const;

const names = async (page: Page) =>
    (await recordedEvents(page)).map((event) => event.name);

async function eventsNamed(page: Page, name: string): Promise<RecordedEvent[]> {
    return (await recordedEvents(page)).filter((event) => event.name === name);
}

/** Resolves when the page has recorded an event of that name. */
async function waitForEvent(
    page: Page,
    name: string,
    timeout = 15_000,
): Promise<RecordedEvent> {
    await expect
        .poll(async () => (await eventsNamed(page, name)).length, { timeout })
        .toBeGreaterThan(0);

    return (await eventsNamed(page, name))[0];
}

const windowSize = (page: Page) =>
    page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
    }));

test.describe('bundle', () => {
    test('stays within the 16 KB gzip budget and announces itself', () => {
        const file = readFileSync(`${ROOT}public/widget/v1/loader.js`);

        expect(gzipSync(file, { level: 9 }).length).toBeLessThanOrEqual(
            16 * 1024,
        );
        expect(file.subarray(0, 40).toString()).toContain(
            '/*! pne-chat-loader v1 */',
        );
    });
});

test.describe('launcher', () => {
    test('mounts in an open shadow root and is styled from the dashboard config', async ({
        page,
        adminApi,
        instance,
    }) => {
        const { key } = await liveWidget(adminApi, instance, {
            config: {
                theme: {
                    primary: '#0ea5e9',
                    launcherSize: 'lg',
                    radius: 12,
                    position: 'bottom-left',
                    offsetX: 24,
                    offsetY: 32,
                },
                launcher: {
                    style: 'pill',
                    label: 'Talk to Acme',
                    icon: 'sparkle',
                },
            },
        });
        const log = collectConsole(page);

        await page.goto(hostPage(instance, { key }));
        const ui = widget(page);

        await expect(ui.launcher).toBeVisible();
        await expect(ui.launcher).toContainText('Talk to Acme');
        await expect(ui.launcher).toHaveAttribute('data-style', 'pill');
        await expect(ui.launcher).toHaveAttribute('aria-expanded', 'false');
        await expect(ui.launcher).toHaveAccessibleName('Talk to Acme');

        // An open shadow root: nothing of it is reachable from the host page's own DOM queries.
        expect(
            await ui.host.evaluate((element) => element.shadowRoot?.mode),
        ).toBe('open');
        expect(
            await page.evaluate(
                () => document.querySelectorAll('button, svg, iframe').length,
            ),
        ).toBe(1);
        expect(
            await page.evaluate(
                () => document.querySelectorAll('pne-chat-widget').length,
            ),
        ).toBe(1);

        // Config -> custom properties of the widget root and geometry in the corner.
        await expect(ui.root).toHaveCSS('--primary', '#0ea5e9');
        await expect(ui.root).toHaveCSS('--radius', '12px');
        await expect(ui.root).toHaveAttribute('data-pos', 'bottom-left');
        await settleWidget(page);
        const box = (await ui.launcher.boundingBox())!;
        const view = await windowSize(page);

        expect(box.height).toBe(LAUNCHER_SIZE.lg);
        expect(box.x).toBeGreaterThanOrEqual(23);
        expect(box.x).toBeLessThanOrEqual(25);
        expect(Math.round(view.height - (box.y + box.height))).toBe(32);
        await expect(ui.launcher).toHaveCSS(
            'background-color',
            'rgb(14, 165, 233)',
        );

        // The loader said it was ready, exactly once, with only its own metadata.
        const ready = await waitForEvent(page, 'ready');

        expect(
            Object.keys(ready.data).sort((a, b) => a.localeCompare(b)),
        ).toEqual(['configVersion', 'widgetKey']);
        expect(ready.data.widgetKey).toBe(key);
        expect(log.errors).toEqual([]);
    });

    test('is a bubble with the chosen size, icon and corner', async ({
        page,
        adminApi,
        instance,
    }) => {
        const { key } = await liveWidget(adminApi, instance, {
            config: {
                theme: {
                    launcherSize: 'sm',
                    position: 'bottom-right',
                    offsetX: 10,
                    offsetY: 10,
                },
                launcher: { style: 'bubble', icon: 'help', label: 'Help' },
            },
        });

        await page.goto(hostPage(instance, { key }));
        const ui = widget(page);

        await expect(ui.launcher).toBeVisible();
        await expect(ui.launcher).toHaveAttribute('data-style', 'bubble');
        await settleWidget(page);
        const box = (await ui.launcher.boundingBox())!;
        const view = await windowSize(page);

        expect(box.width).toBe(LAUNCHER_SIZE.sm);
        expect(box.height).toBe(LAUNCHER_SIZE.sm);
        expect(Math.round(view.width - (box.x + box.width))).toBe(10);
        // The bubble shows the icon only; the label is its accessible name.
        await expect(ui.launcher).toHaveAccessibleName('Help');
        await expect(ui.launcher.locator('.lbl')).toHaveCount(0);
    });

    test('hostile host CSS cannot break it, and it does not disturb the page', async ({
        page,
        adminApi,
        instance,
    }) => {
        const { key } = await liveWidget(adminApi, instance);

        // The page without any widget: its layout is the reference.
        await page.goto(hostPage(instance, { key, src: 'none' }));
        const heightWithout = await page.evaluate(
            () => document.documentElement.scrollHeight,
        );

        // `* { all: unset }`, `div, button, span, img, iframe { display: none !important }`, pinned positions, a red iframe border.
        await page.goto(hostPage(instance, { key, hostile: true }));
        const ui = widget(page);

        await expect(ui.launcher).toBeVisible();
        await settleWidget(page);
        const box = (await ui.launcher.boundingBox())!;

        expect(box.width).toBeGreaterThan(100);
        expect(box.height).toBe(LAUNCHER_SIZE.lg);
        // The element the host styles is pinned by the loader (inline !important), the inside is out of the host CSS's reach.
        await expect(ui.host).toHaveCSS('display', 'block');
        await expect(ui.host).toHaveCSS('position', 'fixed');
        await expect(ui.launcher).toHaveCSS('display', 'block');
        await expect(ui.launcher).toHaveCSS('letter-spacing', 'normal');
        expect(
            await ui.launcher.evaluate(
                (element) => getComputedStyle(element).fontFamily,
            ),
        ).not.toContain('Comic Sans');
        await expect(ui.launcher).toHaveCSS(
            'background-color',
            'rgb(124, 58, 237)',
        );

        // It still works: the chat opens (and its iframe is not the host's red 10px sliver).
        await ui.launcher.click();
        await expect(ui.panel).toHaveAttribute('data-open', 'true');
        const frame = (await ui.iframe.boundingBox())!;

        expect(frame.width).toBeGreaterThan(200);
        await expect(ui.iframe).toHaveCSS('border-top-width', '0px');

        // Never a layout change of the page (the widget is `position: fixed` and out of the flow).
        await page.goto(hostPage(instance, { key }));
        await expect(ui.launcher).toBeVisible();
        expect(
            await page.evaluate(() => document.documentElement.scrollHeight),
        ).toBe(heightWithout);

        // And the page's own elements keep working next to it.
        await page.locator('#host-button').click();
        expect(
            await page.evaluate(
                () =>
                    (window as unknown as { __hostClicks: number })
                        .__hostClicks,
            ),
        ).toBe(1);
    });

    test('a strict host CSP (script, frame and connect sources of the app only, no inline styles) is enough', async ({
        page,
        adminApi,
        instance,
    }) => {
        const { key } = await liveWidget(adminApi, instance);
        const log = collectConsole(page);

        await page.goto(hostPage(instance, { key, csp: true, src: 'generic' }));
        const ui = widget(page);

        await expect(ui.launcher).toBeVisible();
        await expect(ui.root).toHaveCSS('--primary', '#7c3aed');
        await ui.launcher.click();
        await expect(ui.iframe).toHaveCount(1);
        await expect(ui.panel).toHaveAttribute('data-open', 'true');

        expect(
            log.all.filter((line) =>
                /content security policy|refused to/i.test(line),
            ),
        ).toEqual([]);
    });
});

test.describe('overrides from the host page', () => {
    test('data-* attributes and ChatFeatureSettings restyle the widget (settings win over attributes)', async ({
        page,
        adminApi,
        instance,
    }) => {
        const { key } = await liveWidget(adminApi, instance, {
            config: { theme: { position: 'bottom-left', primary: '#7c3aed' } },
        });

        await page.goto(
            hostPage(instance, {
                key,
                attrs: {
                    position: 'right',
                    'theme-primary': '#e11d48',
                    'theme-radius': '4',
                    'launcher-label': 'Hello from data',
                    'offset-x': '40',
                    'offset-y': '60',
                    'z-index': '777',
                },
                settings: {
                    theme: { primary: '#16a34a' },
                    launcher: { style: 'bubble' },
                },
            }),
        );
        const ui = widget(page);

        await expect(ui.launcher).toBeVisible();
        // Dashboard < data-* < settings: the corner and label come from the attributes, the colour from the settings.
        await expect(ui.root).toHaveAttribute('data-pos', 'bottom-right');
        await expect(ui.root).toHaveCSS('--primary', '#16a34a');
        await expect(ui.root).toHaveCSS('--radius', '4px');
        await expect(ui.launcher).toHaveAttribute('data-style', 'bubble');
        await expect(ui.launcher).toHaveAccessibleName('Hello from data');
        await expect(ui.host).toHaveCSS('z-index', '777');
        await settleWidget(page);
        const box = (await ui.launcher.boundingBox())!;
        const view = await windowSize(page);

        expect(Math.round(view.width - (box.x + box.width))).toBe(40);
        expect(Math.round(view.height - (box.y + box.height))).toBe(60);

        // Values outside the allowed set are ignored, not applied: a javascript: icon URL, a non-hex colour, a made-up size.
        await chatFeature(page, 'update', {
            theme: {
                primary: 'url(javascript:alert(1))',
                radius: 9999,
                position: 'top-left',
            },
            launcher: { iconUrl: 'javascript:alert(1)' },
        });
        await expect(ui.root).toHaveCSS('--primary', '#16a34a');
        await expect(ui.root).toHaveCSS('--radius', '28px');
        await expect(ui.root).toHaveAttribute('data-pos', 'bottom-right');
    });

    test('a host cannot switch greetings on when the dashboard has them off, but can switch them off', async ({
        page,
        adminApi,
        instance,
    }) => {
        const off = await liveWidget(adminApi, instance, {
            config: { greetings: { enabled: false } },
        });
        const on = await liveWidget(adminApi, instance);

        // Dashboard off, host says on (attribute and settings): still off.
        await page.goto(
            hostPage(instance, {
                key: off.key,
                attrs: { greetings: 'on' },
                settings: { greetings: { enabled: true, delaySeconds: 0 } },
            }),
        );
        await expect(widget(page).launcher).toBeVisible();
        await page.waitForTimeout(2500);
        await expect(widget(page).greeting).toHaveCount(0);
        expect(await names(page)).not.toContain('greeting-shown');

        // Dashboard on, host says off: off.
        await page.goto(
            hostPage(instance, { key: on.key, attrs: { greetings: 'off' } }),
        );
        await expect(widget(page).launcher).toBeVisible();
        await page.waitForTimeout(2500);
        await expect(widget(page).greeting).toHaveCount(0);

        // Sanity: without an override the popup does come.
        await page.goto(hostPage(instance, { key: on.key }));
        await expect(widget(page).greeting).toBeVisible({ timeout: 10_000 });
    });

    test('categories can be narrowed to a subset of the dashboard offer, never widened', async ({
        page,
        adminApi,
        instance,
    }) => {
        const { key } = await liveWidget(adminApi, instance, {
            categories: ['general', 'billing'],
        });
        const log = collectConsole(page);
        const ui = widget(page);
        const panelFrames = () =>
            page.locator('pne-chat-widget .panel iframe').count();

        // No restriction: a category of the dashboard offer pre-selects it (which boots the panel in the background).
        await page.goto(hostPage(instance, { key }));
        await expect(ui.launcher).toBeVisible();
        await chatFeature(page, 'setCategory', 'billing');
        await expect.poll(panelFrames).toBe(1);

        // Narrowed to billing: general is no longer a choice, billing is.
        await page.goto(
            hostPage(instance, { key, settings: { categories: ['billing'] } }),
        );
        await expect(ui.launcher).toBeVisible();
        await chatFeature(page, 'setCategory', 'general');
        await expect
            .poll(() =>
                log.warnings.some((line) => line.includes('setCategory')),
            )
            .toBe(true);
        expect(await panelFrames()).toBe(0);
        await chatFeature(page, 'setCategory', 'billing');
        await expect.poll(panelFrames).toBe(1);

        // A category the dashboard does not offer cannot be added by the host: it is unknown, nothing is created.
        await page.goto(
            hostPage(instance, { key, settings: { categories: ['sales'] } }),
        );
        await expect(ui.launcher).toBeVisible();
        await chatFeature(page, 'setCategory', 'sales');
        expect(await panelFrames()).toBe(0);
        // (the restriction is empty, so the dashboard's own offer stays in force)
        await chatFeature(page, 'setCategory', 'general');
        await expect.poll(panelFrames).toBe(1);
    });
});

test.describe('greeting popup', () => {
    test('appears after the configured delay with the agent, flips the launcher and hides itself', async ({
        page,
        adminApi,
        instance,
    }) => {
        const { key } = await liveWidget(adminApi, instance, {
            config: { greetings: { delaySeconds: 2, autoHideSeconds: 3 } },
        });

        await page.goto(hostPage(instance, { key }));
        const ui = widget(page);

        await expect(ui.launcher).toBeVisible();
        const ready = await waitForEvent(page, 'ready');
        // Nothing before the delay...
        await page.waitForTimeout(800);
        await expect(ui.greeting).toHaveCount(0);

        // ... then the popup, the agent and the flip of the launcher to the agent's face.
        await expect(ui.greeting).toBeVisible({ timeout: 10_000 });
        const shown = await waitForEvent(page, 'greeting-shown');

        expect(shown.at - ready.at).toBeGreaterThanOrEqual(1500);
        expect(shown.at - ready.at).toBeLessThanOrEqual(3500);
        const pool = POOL.map((greeting) => greeting.body);
        const body = (await ui.greetingBody.textContent())!;

        expect(pool).toContain(body);
        const agent = POOL.find(
            (greeting) => greeting.body === body,
        )!.agent_name;

        await expect(ui.greetingName).toHaveText(agent);
        expect(
            Object.keys(shown.data).sort((a, b) => a.localeCompare(b)),
        ).toEqual(['agentName', 'id']);
        expect(shown.data.agentName).toBe(agent);
        await expect(ui.card).toHaveAttribute('data-face', 'agent');
        await expect(ui.card).toHaveAttribute('data-flip', 'agent');
        // The flip is a 3D rotation (a matrix), not a swap.
        expect(
            await ui.card.evaluate(
                (element) => getComputedStyle(element).transform,
            ),
        ).not.toBe('none');
        // The popup sits beside the launcher, inside the viewport.
        const popup = (await ui.greeting.boundingBox())!;
        const view = await windowSize(page);

        expect(popup.x).toBeGreaterThanOrEqual(0);
        expect(popup.x + popup.width).toBeLessThanOrEqual(view.width);

        // It goes away on its own after autoHideSeconds, and the launcher flips back.
        await expect(ui.greeting).toHaveCount(0, { timeout: 10_000 });
        await expect(ui.card).toHaveAttribute('data-face', 'front');
        const gone = await waitForEvent(page, 'greeting-dismissed');

        expect(gone.data.reason).toBe('timeout');
        expect(gone.data.id).toBe(shown.data.id);
        expect(gone.at - shown.at).toBeGreaterThanOrEqual(2500);
        expect(gone.at - shown.at).toBeLessThanOrEqual(5500);
    });

    test('picks by weight and never shows the same message twice in a row', async ({
        page,
        adminApi,
        instance,
    }) => {
        const { key } = await liveWidget(adminApi, instance);
        const shownBody = async () => {
            await expect(widget(page).greetingBody).toBeVisible({
                timeout: 10_000,
            });

            return (await widget(page).greetingBody.textContent())!;
        };

        // A fixed "random" number makes the pick deterministic: weights 3, 2, 1 (total 6).
        const withRandom = (value: number) =>
            page.addInitScript((fixed) => {
                Math.random = () => fixed;
            }, value);

        await withRandom(0);
        await page.goto(hostPage(instance, { key }));
        expect(await shownBody()).toBe(POOL[0].body);

        // The last shown id is remembered (localStorage of the host origin): the same roll cannot pick it again.
        await page.goto(hostPage(instance, { key }));
        expect(await shownBody()).toBe(POOL[1].body);

        // A roll of 0.99 lands on the lightest message (weight 1 of 6).
        await page.evaluate(() => localStorage.clear());
        await page.addInitScript(() => {
            Math.random = () => 0.99;
        });
        await page.goto(hostPage(instance, { key }));
        expect(await shownBody()).toBe(POOL[2].body);

        // 0.55 * 6 = 3.3: past the first message (weight 3), inside the second (weight 2).
        await page.evaluate(() => localStorage.clear());
        await page.addInitScript(() => {
            Math.random = () => 0.55;
        });
        await page.goto(hostPage(instance, { key }));
        expect(await shownBody()).toBe(POOL[1].body);
    });

    test('shows no agent face or name when the dashboard says so', async ({
        page,
        adminApi,
        instance,
    }) => {
        const { key } = await liveWidget(adminApi, instance, {
            config: { greetings: { showAgent: false } },
        });

        await page.goto(hostPage(instance, { key }));
        const ui = widget(page);

        await expect(ui.greeting).toBeVisible({ timeout: 10_000 });
        await expect(ui.greetingName).toHaveCount(0);
        await expect(ui.card).toHaveAttribute('data-face', 'front');
    });

    test('dismissPolicy "session": a dismissed greeting stays away for the rest of the session', async ({
        page,
        adminApi,
        instance,
    }) => {
        const { key } = await liveWidget(adminApi, instance, {
            config: {
                greetings: { dismissPolicy: 'session', autoHideSeconds: 60 },
            },
        });

        await page.goto(hostPage(instance, { key }));
        await expect(widget(page).greeting).toBeVisible({ timeout: 10_000 });
        await widget(page).greetingClose.click();
        await expect(widget(page).greeting).toHaveCount(0);

        const dismissed = await waitForEvent(page, 'greeting-dismissed');

        expect(dismissed.data.reason).toBe('dismissed');
        await expect(widget(page).card).toHaveAttribute('data-face', 'front');

        // Same session (sessionStorage survives a reload): no greeting, however long we wait for the delay.
        await page.reload();
        await expect(widget(page).launcher).toBeVisible();
        await page.waitForTimeout(2500);
        await expect(widget(page).greeting).toHaveCount(0);
        expect(await names(page)).not.toContain('greeting-shown');
    });

    test('dismissPolicy "never": the greeting comes back on the next page view', async ({
        page,
        adminApi,
        instance,
    }) => {
        const { key } = await liveWidget(adminApi, instance, {
            config: {
                greetings: { dismissPolicy: 'never', autoHideSeconds: 60 },
            },
        });

        await page.goto(hostPage(instance, { key }));
        await expect(widget(page).greeting).toBeVisible({ timeout: 10_000 });
        await widget(page).greetingClose.click();
        await expect(widget(page).greeting).toHaveCount(0);

        await page.reload();
        await expect(widget(page).greeting).toBeVisible({ timeout: 10_000 });
    });

    test('dismissPolicy "interval": the next greeting is due one full interval after the dismissal', async ({
        page,
        adminApi,
        instance,
    }) => {
        const { key } = await liveWidget(adminApi, instance, {
            config: {
                greetings: {
                    dismissPolicy: 'interval',
                    intervalMinutes: 1,
                    delaySeconds: 1,
                    autoHideSeconds: 120,
                },
            },
        });

        // A fake clock for the page: a minute of waiting takes no time.
        await page.clock.install();
        await page.goto(hostPage(instance, { key }));
        const ui = widget(page);

        await expect(ui.launcher).toBeVisible();
        await page.clock.runFor(1_500);
        await expect(ui.greeting).toBeVisible();

        // Dismissed 20 s in; the old timeline would greet again at 61 s, the rule is "one interval after the dismissal" (80 s).
        await page.clock.runFor(18_000);
        await ui.greetingClose.click();
        await expect(ui.greeting).toHaveCount(0);

        await page.clock.runFor(50_000);
        await expect(ui.greeting).toHaveCount(0);
        await page.clock.runFor(12_000);
        await expect(ui.greeting).toBeVisible();
        expect((await eventsNamed(page, 'greeting-shown')).length).toBe(2);
    });

    test('Escape closes the popup, and clicking it opens the chat', async ({
        page,
        adminApi,
        instance,
    }) => {
        const { key } = await liveWidget(adminApi, instance, {
            config: { greetings: { autoHideSeconds: 60 } },
        });

        await page.goto(hostPage(instance, { key }));
        const ui = widget(page);

        await expect(ui.greeting).toBeVisible({ timeout: 10_000 });
        await ui.greetingOpen.focus();
        await page.keyboard.press('Escape');
        await expect(ui.greeting).toHaveCount(0);
        expect(
            (await eventsNamed(page, 'greeting-dismissed'))[0].data.reason,
        ).toBe('dismissed');

        // A fresh page view, popup clicked: the panel opens and the greeting retires as "opened".
        await page.evaluate(() => sessionStorage.clear());
        await page.reload();
        await expect(ui.greeting).toBeVisible({ timeout: 10_000 });
        await ui.greetingOpen.click();
        await expect(ui.panel).toHaveAttribute('data-open', 'true');
        await expect(ui.greeting).toHaveCount(0);
        const retired = (await eventsNamed(page, 'greeting-dismissed'))[0];

        expect(retired.data.reason).toBe('opened');
        expect(await names(page)).toContain('open');
    });

    test('on a phone the popup fits the screen', async ({
        page,
        adminApi,
        instance,
    }) => {
        const { key } = await liveWidget(adminApi, instance, {
            config: { greetings: { autoHideSeconds: 60 } },
        });

        await page.setViewportSize({ width: 375, height: 700 });
        await page.goto(hostPage(instance, { key }));
        const ui = widget(page);

        await expect(ui.greeting).toBeVisible({ timeout: 10_000 });
        const popup = (await ui.greeting.boundingBox())!;
        const launcher = (await ui.launcher.boundingBox())!;

        expect(popup.x).toBeGreaterThanOrEqual(0);
        expect(popup.x + popup.width).toBeLessThanOrEqual(375);
        expect(launcher.x + launcher.width).toBeLessThanOrEqual(375);
        // Beside or above the launcher: never off the bottom of the screen.
        expect(popup.y + popup.height).toBeLessThanOrEqual(700);
    });

    test('reduced motion turns the flip into a crossfade', async ({
        page,
        adminApi,
        instance,
    }) => {
        const { key } = await liveWidget(adminApi, instance, {
            config: { greetings: { autoHideSeconds: 60 } },
        });

        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.goto(hostPage(instance, { key }));
        const ui = widget(page);

        await expect(ui.root).toHaveAttribute('data-motion', 'reduced');
        await expect(ui.greeting).toBeVisible({ timeout: 10_000 });
        await expect(ui.card).toHaveAttribute('data-face', 'agent');
        await expect(ui.card).toHaveAttribute('data-flip', 'agent');
        // No rotation, no entrance animation: just opacity.
        await expect(ui.card).toHaveCSS('transform', 'none');
        expect(
            await ui.launcher.evaluate(
                (element) => getComputedStyle(element).animationName,
            ),
        ).toBe('none');
    });
});

test.describe('opening the chat', () => {
    test('loads the panel iframe from the app; a panel that never says ready is given up after 10 s', async ({
        page,
        adminApi,
        instance,
    }) => {
        const { key } = await liveWidget(adminApi, instance, {
            config: { greetings: { enabled: false } },
        });
        const log = collectConsole(page);

        await page.setViewportSize({ width: 1280, height: 800 });
        await page.goto(hostPage(instance, { key }));
        const ui = widget(page);

        await expect(ui.launcher).toBeVisible();
        // The panel is lazy: no iframe until the first open.
        await expect(ui.iframe).toHaveCount(0);

        await ui.launcher.click();
        await expect(ui.panel).toHaveAttribute('data-open', 'true');
        await expect(ui.panel).toHaveAttribute('data-mode', 'panel');
        await expect(ui.launcher).toHaveAttribute('aria-expanded', 'true');
        await expect(ui.launcher).toHaveAccessibleName('Close chat');

        // The iframe: the app's /embed/<key>, sandboxed, and the P3 stub is what answers.
        await expect(ui.iframe).toHaveAttribute(
            'src',
            `${instance.url}/embed/${key}`,
        );
        const sandbox = (await ui.iframe.getAttribute('sandbox'))!;

        expect(sandbox.split(' ')).toEqual(
            expect.arrayContaining([
                'allow-scripts',
                'allow-same-origin',
                'allow-forms',
            ]),
        );
        expect(sandbox).not.toContain('allow-top-navigation');
        await expect(
            ui.iframe.contentFrame().getByText('Chat panel (coming in P4)'),
        ).toBeVisible();
        const box = (await ui.panel.boundingBox())!;

        expect(box.width).toBeLessThanOrEqual(380);
        expect(box.height).toBeLessThanOrEqual(620);

        // The stub never sends `ready`: the watchdog closes the panel and drops the iframe (about 10 s).
        const opened = Date.now();
        const timeout = await waitForEvent(page, 'error', 20_000);

        expect(timeout.data).toMatchObject({
            code: 'ready_timeout',
            message: 'Panel handshake failed',
        });
        expect(Date.now() - opened).toBeGreaterThanOrEqual(8_000);
        await expect(ui.panel).toHaveAttribute('data-open', 'false');
        await expect(ui.iframe).toHaveCount(0);
        await expect(ui.launcher).toHaveAttribute('aria-expanded', 'false');
        expect(await names(page)).toEqual(
            expect.arrayContaining(['ready', 'open', 'error', 'close']),
        );
        expect(
            await chatFeature<{ open: boolean; panelReady: boolean }>(
                page,
                'getState',
            ),
        ).toMatchObject({ open: false, panelReady: false });

        // Next open starts from scratch (a new iframe).
        await ui.launcher.click();
        await expect(ui.iframe).toHaveCount(1);
        await expect(ui.panel).toHaveAttribute('data-open', 'true');
        expect(
            log.errors.filter(
                (line) => !/ERR_|frame|Failed to load/i.test(line),
            ),
        ).toEqual([]);
    });

    test('on a phone the panel is full screen: the launcher stays on top as the close button, and the host scroll is unlocked again when the panel is given up', async ({
        page,
        adminApi,
        instance,
    }) => {
        const { key } = await liveWidget(adminApi, instance, {
            config: { greetings: { enabled: false } },
        });

        await page.setViewportSize({ width: 375, height: 700 });
        await page.goto(hostPage(instance, { key, height: 3000 }));
        const ui = widget(page);

        await expect(ui.launcher).toBeVisible();
        await page.evaluate(() => window.scrollTo(0, 400));
        const scrolled = await page.evaluate(() => window.scrollY);

        expect(scrolled).toBeGreaterThan(300);
        const overflow = () =>
            page.evaluate(() => document.documentElement.style.overflow);

        await ui.launcher.click();
        await expect(ui.panel).toHaveAttribute('data-open', 'true');
        await expect(ui.panel).toHaveAttribute('data-mode', 'fullscreen');
        // The host page cannot scroll behind it.
        expect(await overflow()).toBe('hidden');
        expect(await page.evaluate(() => document.body.style.overflow)).toBe(
            'hidden',
        );
        // The panel covers the viewport...
        await settleWidget(page);
        const panel = (await ui.panel.boundingBox())!;

        expect(panel.width).toBe(375);
        expect(panel.height).toBe(700);
        // ... but the launcher stays above it, so a dead panel can always be closed.
        await expect(ui.root).toHaveAttribute('data-fullscreen', 'false');
        const launcher = (await ui.launcher.boundingBox())!;
        const topmost = await page.evaluate(
            ([x, y]) => document.elementFromPoint(x, y)?.tagName.toLowerCase(),
            [
                launcher.x + launcher.width / 2,
                launcher.y + launcher.height / 2,
            ] as const,
        );

        expect(topmost).toBe('pne-chat-widget');

        // Nothing answers: the watchdog gives up after 10 s, closes the panel and unlocks the page.
        await waitForEvent(page, 'error', 20_000);
        await expect(ui.panel).toHaveAttribute('data-open', 'false');
        await expect(ui.iframe).toHaveCount(0);
        expect(await overflow()).toBe('');
        expect(await page.evaluate(() => document.body.style.overflow)).toBe(
            '',
        );
        expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(300);
        // The page really scrolls again.
        await page.mouse.wheel(0, 300);
        await expect
            .poll(() => page.evaluate(() => window.scrollY))
            .toBeGreaterThan(scrolled);
    });

    test('the launcher (close button) and Escape unlock the full-screen trap at once', async ({
        page,
        adminApi,
        instance,
    }) => {
        const { key } = await liveWidget(adminApi, instance, {
            config: { greetings: { enabled: false } },
        });

        await page.setViewportSize({ width: 375, height: 700 });
        await page.goto(hostPage(instance, { key, height: 3000 }));
        const ui = widget(page);
        const overflow = () =>
            page.evaluate(() => document.documentElement.style.overflow);

        await expect(ui.launcher).toBeVisible();

        // The launcher closes it.
        await ui.launcher.click();
        await expect(ui.panel).toHaveAttribute('data-open', 'true');
        expect(await overflow()).toBe('hidden');
        await ui.launcher.click();
        await expect(ui.panel).toHaveAttribute('data-open', 'false');
        expect(await overflow()).toBe('');

        // Escape on the host page closes it as well (focus is on the page, not inside the cross-origin frame).
        await ui.launcher.click();
        await expect(ui.panel).toHaveAttribute('data-open', 'true');
        await page.evaluate(() =>
            (document.activeElement as HTMLElement | null)?.blur(),
        );
        await page.locator('body').press('Escape');
        await expect(ui.panel).toHaveAttribute('data-open', 'false');
        expect(await overflow()).toBe('');
        expect((await eventsNamed(page, 'close')).length).toBe(2);
    });
});

test.describe('JavaScript API', () => {
    test('open, close, toggle, getState, show/hide and the events with their whitelisted payloads', async ({
        page,
        adminApi,
        instance,
    }) => {
        const { key, widget: created } = await liveWidget(adminApi, instance, {
            config: { greetings: { enabled: false } },
        });

        await page.setViewportSize({ width: 1280, height: 800 });
        await page.goto(hostPage(instance, { key }));
        const ui = widget(page);

        await expect(ui.launcher).toBeVisible();
        await waitForEvent(page, 'ready');

        const state = () =>
            chatFeature<Record<string, unknown>>(page, 'getState');

        expect(await state()).toMatchObject({
            status: 'idle',
            open: false,
            unread: 0,
            ready: true,
            panelReady: false,
            widgetKey: key,
            configVersion: created.config_version,
        });

        await chatFeature(page, 'open');
        await expect(ui.panel).toHaveAttribute('data-open', 'true');
        expect(await state()).toMatchObject({ open: true });

        await chatFeature(page, 'close');
        await expect(ui.panel).toHaveAttribute('data-open', 'false');
        await chatFeature(page, 'toggle');
        await expect(ui.panel).toHaveAttribute('data-open', 'true');
        await chatFeature(page, 'toggle');
        await expect(ui.panel).toHaveAttribute('data-open', 'false');

        // Events: `open` and `close` carry nothing; `ready` has only the widget's identity.
        const events = await recordedEvents(page);

        expect(events.map((event) => event.name)).toEqual([
            'ready',
            'open',
            'close',
            'open',
            'close',
        ]);
        expect(events[1].data).toEqual({});
        expect(events[2].data).toEqual({});

        // Also delivered as DOM events (`chatfeature:<name>`) to document and window listeners, without bubbling further.
        const fromDom = await page.evaluate(
            () =>
                new Promise<string[]>((resolve) => {
                    const seen: string[] = [];

                    document.addEventListener('chatfeature:open', () =>
                        seen.push('document'),
                    );
                    window.addEventListener('chatfeature:open', () => {
                        seen.push('window');
                        resolve(seen);
                    });
                    (
                        window as unknown as {
                            ChatFeature: (c: string) => void;
                        }
                    ).ChatFeature('open');
                }),
        );

        expect(fromDom).toEqual(['document', 'window']);
        await chatFeature(page, 'close');

        // `on` returns an unsubscribe function, `off` removes a handler: a removed handler hears nothing more.
        const heard = await page.evaluate(async () => {
            const api = (
                window as unknown as {
                    ChatFeature: (...a: unknown[]) => unknown;
                }
            ).ChatFeature;
            const calls: string[] = [];
            const handler = () => calls.push('open');

            api('on', 'open', handler);
            api('open');
            api('close');
            api('off', 'open', handler);
            api('open');
            api('close');

            const unsubscribe = api('on', 'close', () =>
                calls.push('close'),
            ) as () => void;

            api('open');
            api('close');
            unsubscribe();
            api('open');
            api('close');

            return calls;
        });

        expect(heard).toEqual(['open', 'close']);

        // Hide / show the launcher; hiding closes an open panel.
        await chatFeature(page, 'open');
        await expect(ui.panel).toHaveAttribute('data-open', 'true');
        await chatFeature(page, 'hide');
        await expect(ui.host).toHaveCSS('display', 'none');
        await expect(ui.panel).toHaveAttribute('data-open', 'false');
        await chatFeature(page, 'show');
        await expect(ui.launcher).toBeVisible();

        // `update` restyles at runtime.
        await chatFeature(page, 'update', {
            launcher: { label: 'Updated label' },
            theme: { primary: '#db2777' },
        });
        await expect(ui.launcher).toHaveAccessibleName('Updated label');
        await expect(ui.root).toHaveCSS('--primary', '#db2777');
    });

    test('commands given before the loader arrived are replayed; unknown commands and junk are harmless', async ({
        page,
        adminApi,
        instance,
    }) => {
        const { key } = await liveWidget(adminApi, instance, {
            config: { greetings: { enabled: false } },
        });
        const log = collectConsole(page);

        // The stub of the documented snippet queues these calls: the loader runs them in order once it is there.
        await page.addInitScript(() => {
            const w = window as unknown as {
                ChatFeature?: (...a: unknown[]) => void;
            };

            w.ChatFeature =
                w.ChatFeature ||
                (function (this: unknown) {
                    // eslint-disable-next-line prefer-rest-params
                    ((w.ChatFeature as unknown as { q: unknown[] }).q ||=
                        []).push(arguments);
                } as unknown as (...a: unknown[]) => void);
        });
        await page.goto(hostPage(instance, { key, src: 'none' }));
        await page.evaluate(
            ([source]) => {
                const w = window as unknown as {
                    ChatFeature: (...a: unknown[]) => void;
                };

                w.ChatFeature('open');
                w.ChatFeature('definitelyNotACommand', { x: 1 });
                w.ChatFeature('init', {
                    theme: { primary: '#0d9488' },
                    launcher: { label: 'From init' },
                });
                const script = document.createElement('script');

                script.async = true;
                script.src = source as string;
                document.body.append(script);
            },
            [`${instance.url}/w/${key}.js`],
        );
        const ui = widget(page);

        await expect(ui.launcher).toBeVisible();
        await expect(ui.panel).toHaveAttribute('data-open', 'true');
        await expect(ui.launcher).toHaveAccessibleName('Close chat');
        await expect(ui.root).toHaveCSS('--primary', '#0d9488');
        expect(
            log.warnings.some((line) =>
                line.includes('Unknown command: definitelyNotACommand'),
            ),
        ).toBe(true);
        await chatFeature(page, 'close');
        await expect(ui.launcher).toHaveAccessibleName('From init');
    });

    test('including the script twice is idempotent', async ({
        page,
        adminApi,
        instance,
    }) => {
        const { key } = await liveWidget(adminApi, instance, {
            config: { greetings: { enabled: false } },
        });

        await page.goto(hostPage(instance, { key, twice: true }));
        await expect(widget(page).launcher).toBeVisible();
        await waitForEvent(page, 'ready');
        // Let a possible second instance finish booting before counting.
        await page.waitForTimeout(800);

        expect(
            await page.evaluate(
                () => document.querySelectorAll('pne-chat-widget').length,
            ),
        ).toBe(1);
        expect((await eventsNamed(page, 'ready')).length).toBe(1);
        await chatFeature(page, 'open');
        await expect(widget(page).iframe).toHaveCount(1);
    });

    test('shutdown removes everything the widget put on the page', async ({
        page,
        adminApi,
        instance,
    }) => {
        const { key } = await liveWidget(adminApi, instance, {
            config: { greetings: { enabled: false } },
        });

        await page.setViewportSize({ width: 375, height: 700 });
        await page.goto(hostPage(instance, { key, height: 3000 }));
        const ui = widget(page);

        await expect(ui.launcher).toBeVisible();
        await chatFeature(page, 'open');
        await expect(ui.panel).toHaveAttribute('data-open', 'true');
        // A stored visitor session (what the panel would have handed over) goes away with it.
        await page.evaluate(
            (storageKey) =>
                localStorage.setItem(
                    storageKey,
                    JSON.stringify({
                        token: 'x',
                        expiresAt: new Date(
                            Date.now() + 3_600_000,
                        ).toISOString(),
                        id: 'anonymous',
                    }),
                ),
            `chatfeature:${key}:session`,
        );

        await chatFeature(page, 'shutdown');

        await expect(ui.host).toHaveCount(0);
        expect(
            await page.evaluate(
                () =>
                    document.querySelectorAll('pne-chat-widget, iframe').length,
            ),
        ).toBe(0);
        expect(
            await page.evaluate(
                (k) => localStorage.getItem(`chatfeature:${k}:session`),
                key,
            ),
        ).toBeNull();
        expect(
            await page.evaluate(() => document.documentElement.style.overflow),
        ).toBe('');
        expect(
            await chatFeature<Record<string, unknown>>(page, 'getState'),
        ).toMatchObject({
            ready: false,
            open: false,
        });

        // Escape no longer reaches a widget that is gone, and no timers resurrect it (greetings are off here).
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
        await expect(ui.host).toHaveCount(0);
    });
});
