import { type FrameLocator, type Page } from '@playwright/test';
import { createWidget, type Api } from '../support/api';
import { unique } from '../support/helpers';
import { expect, test } from '../support/test';

/**
 * The builder's live preview: the REAL loader (`/widget/v1/loader.js`) runs inside an `<iframe srcdoc>` fake host page with a boot
 * config built from the unsaved draft, in device frames, text directions and colour schemes; edits show up live; and when the
 * loader bundle cannot be served the static approximation takes over.
 */
test.use({ scenario: 'p3-widgets', role: 'admin' });

const DEVICE_SIZE = {
    desktop: { width: 1024, height: 640 },
    tablet: { width: 768, height: 880 },
    phone: { width: 375, height: 740 },
} as const;

async function previewWidget(
    api: Api,
    config: Record<string, unknown> = {},
    greetings: { body: string; agent_name?: string }[] = [],
) {
    return createWidget(api, {
        name: unique('Preview'),
        enabled: false,
        categories: ['general', 'billing'],
        greetings,
        config: {
            launcher: { style: 'pill', label: 'Talk to Acme' },
            theme: { primary: '#7c3aed' },
            greetings: { delaySeconds: 1, autoHideSeconds: 60 },
            ...config,
        },
    });
}

/** The narrow layout shows either the editor or the preview: bring the preview up. */
async function showPreview(page: Page) {
    const switcher = page.getByTestId('builder-view-switch');

    if (await switcher.isVisible()) {
        await switcher.getByText('Preview', { exact: true }).click();
    }

    await expect(page.getByTestId('builder-preview')).toBeVisible();
}

async function showEditor(page: Page) {
    const switcher = page.getByTestId('builder-view-switch');

    if (await switcher.isVisible()) {
        await switcher.getByText('Edit', { exact: true }).click();
    }
}

async function openBuilderWithPreview(page: Page, ulid: string) {
    await page.goto(`/widgets/${ulid}`);
    await expect(page.getByTestId('builder-page')).toBeVisible();
    await showPreview(page);
}

const frameOf = (page: Page): FrameLocator =>
    page.frameLocator('[data-testid="builder-preview-iframe"]');
const launcherIn = (frame: FrameLocator) =>
    frame.locator('pne-chat-widget button.launcher');

const choose = (page: Page, group: string, name: string | RegExp) =>
    page.getByTestId(group).getByRole('radio', { name }).check({ force: true });

test.describe('live preview', () => {
    test('runs the real loader: the bubble is mounted in a shadow root and styled from the draft', async ({
        page,
        api,
    }) => {
        const { ulid } = await previewWidget(api);

        await openBuilderWithPreview(page, ulid);

        const status = page.getByTestId('builder-preview-status');
        await expect(status).toHaveAttribute('data-loader', 'ready');
        await expect(status).toContainText('Live widget running');
        await expect(page.getByTestId('builder-preview-view')).toBeVisible();

        const frame = frameOf(page);
        const launcher = launcherIn(frame);
        await expect(launcher).toBeVisible();
        await expect(launcher).toContainText('Talk to Acme');
        await expect(launcher).toHaveAttribute('data-style', 'pill');

        // Not an approximation: the production custom element with an open shadow root, themed through custom properties.
        const widget = frame.locator('pne-chat-widget');
        expect(
            await widget.evaluate((element) => element.shadowRoot?.mode),
        ).toBe('open');
        await expect(frame.locator('pne-chat-widget .root')).toHaveCSS(
            '--primary',
            '#7c3aed',
        );
        await expect(page.getByTestId('preview-static')).toHaveCount(0);

        // The host document is the app's own origin (srcdoc), and the loader came from the generic bundle URL.
        const script = await frame
            .locator('script[data-widget-key]')
            .getAttribute('src');
        expect(script).toMatch(/\/widget\/v1\/loader\.js$/);
    });

    test('device frames: desktop, tablet and phone, each with the real widget', async ({
        page,
        api,
    }) => {
        const { ulid } = await previewWidget(api);

        await openBuilderWithPreview(page, ulid);
        const iframe = page.getByTestId('builder-preview-iframe');

        for (const device of ['desktop', 'tablet', 'phone'] as const) {
            await choose(
                page,
                'builder-preview-device',
                new RegExp(device, 'i'),
            );

            // The page inside is drawn at the device's natural size (and scaled to fit the column).
            await expect(iframe).toHaveCSS(
                'width',
                `${DEVICE_SIZE[device].width}px`,
            );
            await expect(iframe).toHaveCSS(
                'height',
                `${DEVICE_SIZE[device].height}px`,
            );
            await expect(
                page.getByTestId('builder-preview-status'),
            ).toHaveAttribute('data-loader', 'ready');
            await expect(launcherIn(frameOf(page))).toBeVisible();
        }

        // On the phone the widget sees a 375px viewport: that is where it goes full screen. The launcher sits in the corner.
        const box = await launcherIn(frameOf(page)).boundingBox();
        const frameBox = await iframe.boundingBox();

        expect(box).not.toBeNull();
        expect(frameBox).not.toBeNull();
        expect(box!.x + box!.width).toBeGreaterThan(
            frameBox!.x + frameBox!.width * 0.7,
        );
        expect(box!.y + box!.height).toBeGreaterThan(
            frameBox!.y + frameBox!.height * 0.7,
        );
    });

    test('text direction and colour scheme toggles rebuild the host page', async ({
        page,
        api,
    }) => {
        const { ulid } = await previewWidget(api);

        await openBuilderWithPreview(page, ulid);
        const frame = frameOf(page);
        const html = frame.locator('html');

        await expect(html).toHaveAttribute('dir', 'ltr');
        await expect(frame.locator('pne-chat-widget .root')).toHaveAttribute(
            'data-scheme',
            'light',
        );

        await choose(page, 'builder-preview-dir', 'RTL');
        await expect(html).toHaveAttribute('dir', 'rtl');
        await expect(
            page.getByTestId('builder-preview-status'),
        ).toHaveAttribute('data-loader', 'ready');
        // The physical corner of the launcher does not flip with the page direction.
        const box = await launcherIn(frame).boundingBox();
        const frameBox = await page
            .getByTestId('builder-preview-iframe')
            .boundingBox();
        expect(box!.x).toBeGreaterThan(frameBox!.x + frameBox!.width / 2);

        await choose(page, 'builder-preview-scheme', /dark/i);
        await expect(html).toHaveAttribute('style', /color-scheme:dark/);
        await expect(frame.locator('pne-chat-widget .root')).toHaveAttribute(
            'data-scheme',
            'dark',
        );

        await choose(page, 'builder-preview-dir', 'LTR');
        await choose(page, 'builder-preview-scheme', /light/i);
        await expect(html).toHaveAttribute('dir', 'ltr');
        await expect(frame.locator('pne-chat-widget .root')).toHaveAttribute(
            'data-scheme',
            'light',
        );
    });

    test('editing the primary colour and the launcher label updates the preview without reloading it', async ({
        page,
        api,
    }) => {
        test.skip(
            test.info().project.name === 'mobile',
            'The editor and the preview are not on screen together on a phone.',
        );

        const { ulid } = await previewWidget(api);

        await page.goto(`/widgets/${ulid}`);
        await page.getByTestId('builder-tab-branding').click();
        const panel = page.getByTestId('builder-panel-branding');
        const frame = frameOf(page);

        await expect(
            page.getByTestId('builder-preview-status'),
        ).toHaveAttribute('data-loader', 'ready');
        await expect(frame.locator('pne-chat-widget .root')).toHaveCSS(
            '--primary',
            '#7c3aed',
        );

        // Remember the very element: a live update must not rebuild the host document.
        await frame.locator('pne-chat-widget').evaluate((element) => {
            (element as HTMLElement & { __same?: boolean }).__same = true;
        });

        await panel
            .getByRole('textbox', { name: 'Primary color', exact: true })
            .fill('#e11d48');
        await expect(frame.locator('pne-chat-widget .root')).toHaveCSS(
            '--primary',
            '#e11d48',
        );

        await panel
            .getByRole('textbox', { name: 'Label', exact: true })
            .fill('Questions?');
        await expect(launcherIn(frame)).toContainText('Questions?');

        await pick(panel, 'Bubble');
        await expect(launcherIn(frame)).toHaveAttribute('data-style', 'bubble');
        await pick(panel, 'Bottom left');
        await expect(frame.locator('pne-chat-widget .root')).toHaveAttribute(
            'data-pos',
            'bottom-left',
        );

        expect(
            await frame
                .locator('pne-chat-widget')
                .evaluate(
                    (element) =>
                        (element as HTMLElement & { __same?: boolean })
                            .__same === true,
                ),
        ).toBe(true);

        // Nothing was saved: the preview shows the unsaved draft.
        await expect(page.getByTestId('builder-badge-dirty')).toBeVisible();
        expect(
            (await api.ok('GET', `/api/v1/widgets/${ulid}`)).data
                .has_unpublished_changes,
        ).toBe(false);
    });

    test('a greeting edited in the builder is what the preview greets with', async ({
        page,
        api,
    }) => {
        test.skip(
            test.info().project.name === 'mobile',
            'The editor and the preview are not on screen together on a phone.',
        );

        const { ulid } = await previewWidget(api, {}, [
            { body: 'First hello', agent_name: 'Nadia' },
        ]);

        await page.goto(`/widgets/${ulid}`);
        await page.getByTestId('builder-tab-greetings').click();
        const frame = frameOf(page);

        // delay 1 s: the popup shows up by itself, with the agent's name, and the launcher flips to the face.
        await expect(
            frame.locator('pne-chat-widget .greet .g-body'),
        ).toHaveText('First hello', { timeout: 15_000 });
        await expect(
            frame.locator('pne-chat-widget .greet .g-name'),
        ).toHaveText('Nadia');
        await expect(frame.locator('pne-chat-widget .card')).toHaveAttribute(
            'data-face',
            'agent',
        );

        // Changing the message rebuilds the host page (a pool is part of the boot config) after a short pause.
        await page
            .getByTestId('builder-greeting-0')
            .getByLabel('Message')
            .fill('Edited hello');
        await expect(
            frame.locator('pne-chat-widget .greet .g-body'),
        ).toHaveText('Edited hello', { timeout: 20_000 });
        await expect(page.getByTestId('builder-badge-dirty')).toBeVisible();
    });

    test('removing a text override puts the default back (the host page is rebuilt)', async ({
        page,
        api,
    }) => {
        test.skip(
            test.info().project.name === 'mobile',
            'The editor and the preview are not on screen together on a phone.',
        );

        const { ulid } = await previewWidget(api);

        await page.goto(`/widgets/${ulid}`);
        await page.getByTestId('builder-tab-texts').click();
        const frame = frameOf(page);
        const panel = frame.locator('pne-chat-widget .panel');
        const title = page.getByTestId('builder-text-title');

        await expect(
            page.getByTestId('builder-preview-status'),
        ).toHaveAttribute('data-loader', 'ready');
        const original = await panel.getAttribute('aria-label');
        expect(original).toBeTruthy();

        await title.fill('Help desk');
        await expect(panel).toHaveAttribute('aria-label', 'Help desk');

        // A runtime `update` can only add: emptying the field has to reboot the host to be seen, and the override is gone.
        // (An emptied title falls back to the loader's own default ("Chat") in the preview, where the saved widget gets the
        // server's English default ("Support"): the same words only for the keys whose two defaults agree.)
        await title.fill('');
        await expect(panel).not.toHaveAttribute('aria-label', 'Help desk', {
            timeout: 15_000,
        });
        await expect(panel).toHaveAttribute('aria-label', /^(Support|Chat)$/);
        await expect(
            page.getByTestId('builder-preview-status'),
        ).toHaveAttribute('data-loader', 'ready');
    });

    test('"Open chat" runs the real panel on canned data (no visitor API call); "Reload preview" starts the host page over', async ({
        page,
        api,
    }) => {
        const { ulid } = await previewWidget(api);
        const visitorCalls: string[] = [];

        // The preview panel plays a scripted conversation: nothing may reach the visitor API (or create a session / a conversation).
        page.on('request', (request) => {
            if (new URL(request.url()).pathname.startsWith('/api/v1/public/')) {
                visitorCalls.push(`${request.method()} ${request.url()}`);
            }
        });

        await openBuilderWithPreview(page, ulid);
        const frame = frameOf(page);
        await expect(
            page.getByTestId('builder-preview-status'),
        ).toHaveAttribute('data-loader', 'ready');

        await page.getByTestId('builder-preview-open-chat').click();

        // The chat iframe is the admin-only preview page of this widget (frame-ancestors 'self', no cookies set by it).
        const chat = frame.locator('pne-chat-widget .panel iframe');
        await expect(chat).toHaveAttribute(
            'src',
            new RegExp(`/embed/wk_[a-z0-9]+(\\?preview=1)?$`),
        );
        await expect(frame.locator('pne-chat-widget .panel')).toHaveAttribute(
            'data-open',
            'true',
        );
        const panel = chat.contentFrame();

        await expect(panel.getByTestId('chat-panel')).toBeVisible();
        await expect(panel.getByTestId('chat-state')).not.toHaveAttribute(
            'data-state',
            'booting',
        );
        expect(visitorCalls).toEqual([]);

        await page.getByTestId('builder-preview-reload').click();
        await expect(frame.locator('pne-chat-widget .panel')).toHaveAttribute(
            'data-open',
            'false',
        );
        await expect(
            page.getByTestId('builder-preview-status'),
        ).toHaveAttribute('data-loader', 'ready');
        await expect(launcherIn(frame)).toBeVisible();
    });
});

test.describe('approximation', () => {
    test('can be chosen by hand and follows the draft (including the greeting replay)', async ({
        page,
        api,
    }) => {
        const { ulid } = await previewWidget(api, {}, [
            { body: 'Static hello', agent_name: 'Omar' },
        ]);

        await openBuilderWithPreview(page, ulid);
        await expect(
            page.getByTestId('builder-preview-status'),
        ).toHaveAttribute('data-loader', 'ready');

        await page
            .getByTestId('builder-preview-view')
            .getByText('Approximation', { exact: true })
            .click();
        await expect(page.getByTestId('preview-static')).toBeVisible();
        await expect(page.getByTestId('builder-preview-iframe')).toHaveCount(0);
        await expect(page.getByTestId('preview-launcher')).toBeVisible();
        await expect(page.getByTestId('preview-launcher')).toContainText(
            'Talk to Acme',
        );

        // The greeting popup is drawn right away; "Show chat panel" swaps it for the open panel, "Replay greeting" brings it back.
        await expect(page.getByTestId('preview-greeting-body')).toHaveText(
            'Static hello',
        );
        await page.getByTestId('builder-preview-panel').click();
        await expect(page.getByTestId('preview-panel')).toBeVisible();
        await expect(page.getByTestId('preview-greeting')).toHaveCount(0);
        await page.getByTestId('builder-preview-panel').click();
        await expect(page.getByTestId('preview-panel')).toHaveCount(0);
        await page.getByTestId('builder-preview-replay').click();
        await expect(page.getByTestId('preview-greeting-body')).toHaveText(
            'Static hello',
        );

        // And back to the live widget.
        await page
            .getByTestId('builder-preview-view')
            .getByText('Live widget', { exact: true })
            .click();
        await expect(page.getByTestId('builder-preview-iframe')).toBeVisible();
    });

    test('takes over by itself when the loader bundle cannot be served', async ({
        page,
        api,
    }) => {
        const { ulid } = await previewWidget(api);

        // `npm run build:widget` was not run: the server answers 200 with a console-warning stub, not the real bundle.
        await page.route('**/widget/v1/loader.js', (route) =>
            route.fulfill({
                status: 200,
                contentType: 'application/javascript',
                body: 'console.warn("[chatfeature] public/widget/v1/loader.js is missing: run npm run build:widget");',
            }),
        );

        await openBuilderWithPreview(page, ulid);

        await expect(
            page.getByTestId('builder-preview-unavailable'),
        ).toContainText('Live preview is not available yet');
        await expect(
            page.getByTestId('builder-preview-view-static-only'),
        ).toBeVisible();
        await expect(page.getByTestId('preview-static')).toBeVisible();
        await expect(page.getByTestId('builder-preview-iframe')).toHaveCount(0);
        await expect(page.getByTestId('preview-launcher')).toBeVisible();

        // The approximation still follows the draft (editing the editor needs the editor on screen).
        await showEditor(page);
        await page.getByTestId('builder-tab-branding').click();
        await page
            .getByTestId('builder-panel-branding')
            .getByRole('textbox', { name: 'Label', exact: true })
            .fill('Still follows');
        await showPreview(page);
        await expect(page.getByTestId('preview-launcher')).toContainText(
            'Still follows',
        );
    });

    test('takes over as well when the loader request fails outright', async ({
        page,
        api,
    }) => {
        const { ulid } = await previewWidget(api);

        await page.route('**/widget/v1/loader.js', (route) => route.abort());

        await openBuilderWithPreview(page, ulid);

        await expect(
            page.getByTestId('builder-preview-unavailable'),
        ).toBeVisible();
        await expect(page.getByTestId('preview-static')).toBeVisible();
    });
});

async function pick(
    scope: Page | ReturnType<Page['getByTestId']>,
    name: string | RegExp,
) {
    await scope.getByRole('radio', { name }).check({ force: true });
}
