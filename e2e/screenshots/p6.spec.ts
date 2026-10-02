/**
 * Phase 6 (WhatsApp) screenshots for the project deck: `E2E_SCREENSHOTS=1 E2E_ONLY=p6-wa E2E_SKIP_PIZZASYS=1 npx playwright test
 * e2e/screenshots/p6.spec.ts --project=desktop` (or `npm run e2e:screenshots`, which runs every phase). The OpenWA mock plays the gateway and the
 * phone, so everything shown is real product output on real (mock-fed) data.
 *
 * One story told on a laptop (1280 px) and on a phone (375 px @2x): Settings > WhatsApp with a connected number and the QR dialog of a second
 * one, the connection test, the inbox with a chat that came from the website (a picture, a document card, replies read / delivered / sent and one
 * that failed) and its details, the widget builder's WhatsApp tab, and the visitor's side on the customer site: the channel choice, the topic,
 * the code with its link, and the offline variant.
 *
 * Output: docs/screenshots/p6/NN-description-{desktop|mobile}-{light|dark}.png (git-ignored). Fixed names and messages, reduced motion, fonts and
 * transitions settled, toasts hidden. Times the product writes ("now", "Valid for 24 hours") are whatever the clock says.
 */
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { settlePanel } from '../support/chat-lab';
import { settleWidget } from '../support/host';
import { openCustomerSite } from '../support/panel';
import { ROOT } from '../support/scenarios';
import {
    captureElementTo,
    captureTo,
    newContext,
    type Viewport,
} from '../support/shots';
import { authStatePath } from '../support/users';
import { seedInbox } from '../support/wa-seed';
import { expect, test, uniqueName } from '../support/wa-test';
import { createWorld } from '../support/world';
import { WaInboxPage, WaSettingsPage } from '../support/wa-ui';
import { data, type WaSession } from '../support/whatsapp';

test.use({ scenario: 'p6-wa' });

const OUTPUT = `${ROOT}docs/screenshots/p6`;
const VIEWPORTS: Viewport[] = ['desktop', 'mobile'];

const HIDE_TOASTS = () => {
    const style = document.createElement('style');

    style.textContent = '[data-sonner-toaster] { display: none !important; }';
    document.addEventListener('DOMContentLoaded', () =>
        document.head.append(style),
    );
};

test.beforeAll(() => {
    mkdirSync(OUTPUT, { recursive: true });

    for (const file of readdirSync(OUTPUT)) {
        if (file.endsWith('.png')) {
            rmSync(`${OUTPUT}/${file}`);
        }
    }
});

async function shootSite(
    page: Page,
    viewport: Viewport,
    name: string,
    panel: Awaited<ReturnType<typeof openCustomerSite>>,
): Promise<void> {
    for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({
            colorScheme: theme,
            reducedMotion: 'reduce',
        });
        await settleWidget(page);
        await settlePanel(panel);
        await page.evaluate(() =>
            (document.activeElement as HTMLElement | null)?.blur(),
        );
        await page.screenshot({
            path: `${OUTPUT}/${name}-${viewport}-${theme}.png`,
            animations: 'disabled',
            caret: 'hide',
        });
    }

    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}

test('the WhatsApp story for the deck: settings, QR, inbox, builder and the customer site, on a laptop and on a phone', async ({
    actors,
    adminApi,
    browser,
    instance,
    openWa,
    wa,
}) => {
    test.setTimeout(600_000);

    const inbox = await seedInbox(adminApi, wa, openWa, instance);
    const scan = data<WaSession>(
        await wa.createSession(uniqueName('second-line')),
        'create',
    );

    expect((await wa.startSession(scan.ulid)).status).toBe(202);

    const world = await createWorld(adminApi, instance, {
        categories: ['billing', 'sales'],
        agents: { ann: ['billing', 'sales'] },
        config: {
            features: { whatsapp: true },
            texts: {
                en: {
                    title: 'Acme Support',
                    subtitle: 'We usually reply in a few minutes',
                },
            },
        },
    });
    const offline = await createWorld(adminApi, instance, {
        agents: {},
        config: { features: { whatsapp: true } },
    });

    await wa.linkWidget(world.widget.ulid, inbox.session.ulid);
    await wa.linkWidget(offline.widget.ulid, inbox.session.ulid);
    await actors.account(world.agents.ann, {
        presence: 'online',
        keepAlive: true,
    });

    const problems: string[] = [];

    for (const viewport of VIEWPORTS) {
        const context = await newContext(
            browser,
            viewport,
            instance,
            authStatePath(instance, 'admin'),
        );

        await context.addInitScript(HIDE_TOASTS);

        const page = await context.newPage();

        page.on('pageerror', (error) =>
            problems.push(`${viewport}: ${error.message}`),
        );

        // 01-02: Settings with the connected number and a second one waiting for a scan; the QR dialog.
        const settings = new WaSettingsPage(page);

        await settings.goto();
        await settings.expectStatus(inbox.session.ulid, 'ready');
        await settings.expectStatus(scan.ulid, 'qr');
        await captureTo(OUTPUT, page, viewport, '01-settings-sessions');
        await settings.button('qr', scan.ulid).click();
        await expect(page.getByTestId('wa-qr-image')).toBeVisible();
        await captureElementTo(
            OUTPUT,
            page,
            page.getByTestId('wa-qr-dialog'),
            viewport,
            '02-settings-qr-dialog',
        );
        await page.getByTestId('wa-qr-close').click();
        await page.getByTestId('wa-connection-test').click();
        await expect(page.getByTestId('wa-test-result')).toHaveAttribute(
            'data-status',
            'ok',
        );
        await captureElementTo(
            OUTPUT,
            page,
            page.getByTestId('wa-connection-card'),
            viewport,
            '03-settings-connection-test',
        );

        // 04-06: The inbox: the list, the conversation that came from the website, its details.
        const view = new WaInboxPage(page);

        await view.goto();
        await expect(view.row(inbox.linked.ulid)).toBeVisible();
        await captureTo(OUTPUT, page, viewport, '04-inbox-list');
        await view.goto(inbox.main.ulid);
        await expect(
            page
                .getByTestId(`wa-message-image-${inbox.main.pictureUlid}`)
                .locator('img'),
        ).toBeVisible();
        await captureTo(OUTPUT, page, viewport, '05-inbox-conversation');
        await view.goto(inbox.linked.ulid);
        await page.getByTestId('wa-chat-info').click();
        await expect(page.getByTestId('wa-details-code')).toBeVisible();
        await captureTo(OUTPUT, page, viewport, '06-inbox-linked-details');

        // 07: The builder's WhatsApp tab, serving.
        await page.goto(`/widgets/${world.widget.ulid}`);
        await expect(page.getByTestId('builder-page')).toBeVisible();
        await page.getByTestId('builder-tab-whatsapp').click();
        await expect(
            page.getByTestId('builder-whatsapp-checks'),
        ).toHaveAttribute('data-serving', 'true');
        await captureTo(OUTPUT, page, viewport, '07-builder-whatsapp-tab');
        await context.close();

        // 08-11: The customer's side.
        const visitor = await newContext(browser, viewport, instance);
        const site = await visitor.newPage();

        site.on('pageerror', (error) =>
            problems.push(`${viewport} site: ${error.message}`),
        );

        const panel = await openCustomerSite(site, instance, {
            key: world.widget.key,
            open: true,
        });

        await expect(panel.tid('channel-chooser')).toBeVisible();
        await shootSite(site, viewport, '08-site-channel-choice', panel);
        await panel.tid('channel-whatsapp').click();
        await expect(
            panel.tid(`category-option-${world.categories.billing.slug}`),
        ).toBeVisible();
        await shootSite(site, viewport, '09-site-topic', panel);
        await panel
            .tid(`category-option-${world.categories.billing.slug}`)
            .click();
        await expect(panel.tid('whatsapp-code')).toBeVisible();
        await shootSite(site, viewport, '10-site-code', panel);
        await visitor.close();

        const lonely = await newContext(browser, viewport, instance);
        const second = await lonely.newPage();
        const offlinePanel = await openCustomerSite(second, instance, {
            key: offline.widget.key,
            open: true,
        });

        await offlinePanel.expectState('offline');
        await expect(offlinePanel.tid('channel-chooser')).toBeVisible();
        await shootSite(
            second,
            viewport,
            '11-site-offline-choice',
            offlinePanel,
        );
        await lonely.close();
    }

    expect(problems).toEqual([]);
    expect(
        readdirSync(OUTPUT).filter((file) => file.endsWith('.png')),
    ).toHaveLength(VIEWPORTS.length * 11 * 2);
});
