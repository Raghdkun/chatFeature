/**
 * Phase 5 screenshots for the project deck: `E2E_SCREENSHOTS=1 E2E_ONLY=p5-notify,p5-chat E2E_SKIP_PIZZASYS=1 npx playwright test
 * e2e/screenshots/p5.spec.ts --project=desktop` (or `npm run e2e:screenshots`, which runs every phase).
 *
 * The new screens of presence, notifications and the launcher alert, on a laptop (1280 px) and on a phone (375 px @2x, a context of its own),
 * in light and dark: Settings > Notifications with notifications on (this browser marked, two registered devices) and blocked by the browser,
 * the first-login dialog, the agents page with its Online / Away / Offline dots, the inbox with the presence selector and its hint, and the
 * launcher on a customer's site with an unread badge (at rest, and in the middle of the alert).
 *
 * Output: docs/screenshots/p5/NN-description-{desktop|mobile}-{light|dark}.png (git-ignored). Deterministic where the product allows it:
 * fixed names, reduced motion except for the launcher's alert, fonts and transitions settled, carets hidden, toasts hidden. The browser's
 * push APIs are the stubs of e2e/support/push.ts (headless Chrome has no push service).
 */
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import type { Page } from '@playwright/test';
import {
    agentsPage,
    dialogOpen,
    inboxIn,
    launcherWithBadge,
    settingsIn,
    type Rig,
} from '../support/p5-views';
import { ROOT } from '../support/scenarios';
import { captureTo, type Viewport } from '../support/shots';
import { settle } from '../support/helpers';
import { expect, test } from '../support/test';

const OUTPUT = `${ROOT}docs/screenshots/p5`;
const VIEWPORTS: { name: Viewport; device: Rig['device'] }[] = [
    { name: 'desktop', device: 'desktop' },
    { name: 'mobile', device: 'phone' },
];

test.describe.configure({ mode: 'serial', timeout: 300_000 });

test.beforeAll(() => {
    mkdirSync(OUTPUT, { recursive: true });

    for (const file of readdirSync(OUTPUT)) {
        if (file.endsWith('.png')) {
            rmSync(`${OUTPUT}/${file}`);
        }
    }
});

test.describe('notifications and presence', () => {
    test.use({ scenario: 'p5-notify' });

    for (const { name, device } of VIEWPORTS) {
        test(`Settings, the dialog, the agents page and the inbox on a ${name}`, async ({
            actors,
            adminApi,
            instance,
        }) => {
            const rig: Rig = { actors, adminApi, instance, device };

            // 01 / 02: Settings > Notifications, working and blocked.
            const granted = await settingsIn(rig, 'on-clean');

            await granted.page.addStyleTag({
                content: '[data-sonner-toaster] { display: none !important; }',
            });
            await expect(
                granted.page.getByTestId('notifications-status'),
            ).toContainText('on for this browser');
            await captureTo(
                OUTPUT,
                granted.page,
                name,
                '01-notifications-granted',
            );

            const blocked = await settingsIn(rig, 'blocked');

            await blocked.page.addStyleTag({
                content: '[data-sonner-toaster] { display: none !important; }',
            });
            await captureTo(
                OUTPUT,
                blocked.page,
                name,
                '02-notifications-blocked',
            );

            // 03: the first-login dialog.
            const dialog = await dialogOpen(rig);

            await dialog.page.addStyleTag({
                content: '[data-sonner-toaster] { display: none !important; }',
            });
            await settle(dialog.page);
            await captureTo(
                OUTPUT,
                dialog.page,
                name,
                '03-notification-prompt',
            );

            // 04: the agents page with Online / Away / Offline dots.
            const roster = await agentsPage(rig);

            await roster.admin.page.addStyleTag({
                content: '[data-sonner-toaster] { display: none !important; }',
            });
            await captureTo(
                OUTPUT,
                roster.admin.page,
                name,
                '04-agents-presence-dots',
            );

            // 05: the inbox with the presence selector and its hint (Online, the automatic status).
            const inbox = await inboxIn(rig, 'online');

            await inbox.page.addStyleTag({
                content: '[data-sonner-toaster] { display: none !important; }',
            });
            await expect(inbox.agent.inbox.tid('presence-hint')).toBeVisible();
            await captureTo(OUTPUT, inbox.page, name, '05-inbox-presence-hint');
        });
    }
});

test.describe('the launcher alert', () => {
    test.use({ scenario: 'p5-chat' });

    for (const { name } of VIEWPORTS) {
        test(`the launcher with an unread badge on a ${name}`, async ({
            actors,
            adminApi,
            instance,
        }) => {
            const rig: Rig = { actors, adminApi, instance };
            const { launcher, panel } = await launcherWithBadge(rig, 1, {
                width: name === 'mobile' ? 375 : 1280,
            });
            const page: Page = panel.page;

            await page.setViewportSize(
                name === 'mobile'
                    ? { width: 375, height: 812 }
                    : { width: 1280, height: 800 },
            );

            const corner = async (
                file: string,
                scheme: 'light' | 'dark',
            ): Promise<void> => {
                await page.emulateMedia({ colorScheme: scheme });
                await expect(launcher.root).toHaveAttribute(
                    'data-scheme',
                    scheme,
                );

                const size = page.viewportSize()!;

                await page.screenshot({
                    path: `${OUTPUT}/${file}-${name}-${scheme}.png`,
                    clip: {
                        x: Math.max(0, size.width - 420),
                        y: Math.max(0, size.height - 300),
                        width: Math.min(420, size.width),
                        height: Math.min(300, size.height),
                    },
                    animations: 'allow',
                    caret: 'hide',
                });
            };

            // 06: in the middle of the alert (the reply that just arrived runs the hop and the expanding ring for about three seconds).
            await page.emulateMedia({
                colorScheme: 'light',
                reducedMotion: 'no-preference',
            });
            await expect(launcher.button).toHaveAttribute('data-alert', 'true');
            await corner('06-launcher-alert', 'light');

            // 07: the badge at rest, in both colour schemes.
            await expect(launcher.button).toHaveAttribute(
                'data-alert',
                'false',
                { timeout: 10_000 },
            );
            await corner('07-launcher-badge', 'light');
            await corner('07-launcher-badge', 'dark');
        });
    }
});
