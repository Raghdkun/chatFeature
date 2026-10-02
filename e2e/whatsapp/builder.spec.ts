import type { Page } from '@playwright/test';
import { createWorld } from '../support/world';
import { openCustomerSite } from '../support/panel';
import { requestHandoff, handoffRefusal } from '../support/wa-flow';
import {
    expect,
    readySession,
    settleSettings,
    test,
    uniqueName,
} from '../support/wa-test';
import { WaSettingsPage } from '../support/wa-ui';
import { data, eventually } from '../support/whatsapp';

/**
 * The widget builder's WhatsApp tab (switch the channel on for a widget, choose the connected number, see why visitors do or do not get it),
 * proved against the real customer site: what the tab says is what a visitor gets. Plus the preview on canned data, the error state of the tab,
 * and the "Hand-off and replies" settings that shape the message and the code's lifetime.
 */
test.use({ scenario: 'p6-wa' });

const waMe = (phone: string, code = 'K7M2QX4P') =>
    new RegExp(
        `^https://wa\\.me/${phone}\\?text=Hi(!|%21)%20My%20support%20code%20is%20${code}$`,
    );

async function openTab(page: Page, ulid: string): Promise<void> {
    await page.goto(`/widgets/${ulid}`);
    await expect(page.getByTestId('builder-page')).toBeVisible();
    await page.getByTestId('builder-tab-whatsapp').click();
    await expect(page.getByTestId('builder-panel-whatsapp')).toBeVisible();
}

async function save(page: Page): Promise<void> {
    await page.getByTestId('builder-save').click();
    await expect(page.getByTestId('builder-status-message')).toHaveAttribute(
        'data-tone',
        'success',
    );
}

async function publish(page: Page): Promise<void> {
    await page.getByTestId('builder-publish').click();
    await page.getByTestId('builder-publish-confirm').click();
    await expect(page.getByTestId('builder-badge-published')).toBeVisible();
}

test('the tab links a connected number and switches the channel on: visitors get the chooser exactly when the checklist says serving', async ({
    actors,
    adminApi,
    instance,
    openWa,
    wa,
}) => {
    const session = await readySession(wa, openWa);
    // Nobody serves this widget's topic: its panel opens on the offline screen, where the WhatsApp alternative lives.
    const world = await createWorld(adminApi, instance, {
        agents: {},
        config: { features: { whatsapp: false } },
    });
    const admin = await actors.staff('admin');
    const page = admin.page;
    const checks = page.getByTestId('builder-whatsapp-checks');
    const row = (name: string) =>
        page.getByTestId(`builder-whatsapp-check-${name}`);

    await openTab(page, world.widget.ulid);

    // Nothing chosen, nothing on: the checklist says why.
    await expect(page.getByTestId('builder-whatsapp-session')).toHaveValue('');
    await expect(checks).toHaveAttribute('data-serving', 'false');
    await expect(row('global')).toHaveAttribute('data-ok', 'true');
    await expect(row('feature')).toHaveAttribute('data-ok', 'false');
    await expect(row('session')).toHaveAttribute('data-ok', 'false');
    await expect(page.getByTestId('builder-whatsapp-no-link')).toBeVisible();
    // The preview of the message is the global one, with the sample code.
    await expect(page.getByTestId('builder-whatsapp-message')).toHaveText(
        'Hi! My support code is K7M2QX4P',
    );

    // The visitor's side: no chooser.
    const before = await actors.visitor();
    const none = await openCustomerSite(before.page, instance, {
        key: world.widget.key,
        open: true,
    });

    await none.expectState('offline');
    await expect(none.tid('channel-chooser')).toHaveCount(0);

    // Choose the number: live at once (no Save needed), with the link the visitor's code will use.
    await page
        .getByTestId('builder-whatsapp-session')
        .selectOption(session.ulid);
    await expect(
        page.getByText(`Visitors of this widget are sent to ${session.name}.`),
    ).toBeVisible();
    await expect(page.getByTestId('builder-whatsapp-status')).toContainText(
        session.name,
    );
    await expect(page.getByTestId('builder-whatsapp-status')).toContainText(
        'Connected',
    );
    await expect(page.getByTestId('builder-whatsapp-link')).toHaveText(
        waMe(session.phone),
    );
    await expect(row('session')).toHaveAttribute('data-ok', 'true');
    expect(
        data<{ connected: boolean; session: { ulid: string } }>(
            await wa.api.get(`/api/v1/widgets/${world.widget.ulid}/whatsapp`),
            'link',
        ).session.ulid,
    ).toBe(session.ulid);

    // The channel is still off in the published design, so visitors still get nothing: the page says so.
    await expect(checks).toHaveAttribute('data-serving', 'false');

    // Switch it on in the draft: a note says it needs Publish; nothing changes for visitors yet.
    await page.getByTestId('builder-whatsapp-feature').click();
    await expect(
        page.getByTestId('builder-whatsapp-unpublished'),
    ).toBeVisible();
    await expect(row('feature')).toHaveAttribute('data-ok', 'false');
    await save(page);

    const mid = await actors.visitor();
    const still = await openCustomerSite(mid.page, instance, {
        key: world.widget.key,
        open: true,
    });

    await still.expectState('offline');
    await expect(still.tid('channel-chooser')).toHaveCount(0);

    // Publish: serving, and the next visitor is offered WhatsApp with the connected number.
    await publish(page);
    await expect(row('feature')).toHaveAttribute('data-ok', 'true');
    await expect(checks).toHaveAttribute('data-serving', 'true');
    await expect(page.getByTestId('builder-whatsapp-unpublished')).toHaveCount(
        0,
    );

    const after = await actors.visitor();
    const offered = await openCustomerSite(after.page, instance, {
        key: world.widget.key,
        open: true,
    });

    await expect(offered.tid('channel-chooser')).toBeVisible();
    await offered.tid('channel-whatsapp').click();
    await expect(offered.tid('whatsapp-open')).toHaveAttribute(
        'href',
        new RegExp(`^https://wa\\.me/${session.phone}\\?text=`),
    );

    // Unlink: the widget stops offering it at once (the link drops the cached answer), and linking again brings it back.
    await page.getByTestId('builder-whatsapp-session').selectOption('');
    await expect(
        page.getByText('This widget no longer offers WhatsApp.'),
    ).toBeVisible();
    await expect(checks).toHaveAttribute('data-serving', 'false');
    await expect(page.getByTestId('builder-whatsapp-no-link')).toBeVisible();

    const gone = await actors.visitor();
    const without = await openCustomerSite(gone.page, instance, {
        key: world.widget.key,
        open: true,
    });

    await without.expectState('offline');
    await expect(without.tid('channel-chooser')).toHaveCount(0);
    expect(await handoffRefusal(instance, world.widget)).toMatch(/409|403/);
    await page
        .getByTestId('builder-whatsapp-session')
        .selectOption(session.ulid);
    await expect(checks).toHaveAttribute('data-serving', 'true');

    // The Features tab agrees about the number: its warning is gone while a session is connected.
    await page.getByTestId('builder-tab-features').click();
    await expect(page.getByTestId('builder-whatsapp-notice')).toHaveCount(0);
});

test('the choice lists the connected numbers; a number that goes offline is shown as such and the widget is told it is not serving', async ({
    actors,
    adminApi,
    instance,
    openWa,
    wa,
}) => {
    const session = await readySession(wa, openWa);
    const world = await createWorld(adminApi, instance, {
        agents: {},
        config: { features: { whatsapp: true } },
    });
    const idle = uniqueName('idle');

    // A session that is not connected cannot be chosen.
    data(await wa.createSession(idle), 'create an idle session');
    expect((await wa.linkWidget(world.widget.ulid, session.ulid)).status).toBe(
        200,
    );

    const admin = await actors.staff('admin');
    const page = admin.page;
    const select = page.getByTestId('builder-whatsapp-session');

    await openTab(page, world.widget.ulid);
    await expect(select).toHaveValue(session.ulid);
    await expect(
        select.locator('option', { hasText: `${session.name} · +49` }),
    ).toHaveCount(1);
    await expect(select.locator('option', { hasText: idle })).toHaveCount(0);
    await expect(page.getByTestId('builder-whatsapp-checks')).toHaveAttribute(
        'data-serving',
        'true',
    );

    // The phone logs out: the tab (after a reload) keeps the choice, shows the state, and says visitors are not served.
    await openWa.setStatus(session.name, 'disconnected', { reason: 'LOGOUT' });
    await eventually(
        async () =>
            data<{ status: string }>(await wa.session(session.ulid), 'read')
                .status === 'disconnected' || undefined,
        'the session to be disconnected',
    );
    await openTab(page, world.widget.ulid);
    await expect(select).toHaveValue(session.ulid);
    await expect(
        select.locator(`option[value="${session.ulid}"]`),
    ).toContainText('(Disconnected)');
    await expect(page.getByTestId('builder-whatsapp-status')).toContainText(
        'Disconnected',
    );
    await expect(page.getByTestId('builder-whatsapp-checks')).toHaveAttribute(
        'data-serving',
        'false',
    );
    await expect(
        page.getByTestId('builder-whatsapp-check-session'),
    ).toHaveAttribute('data-ok', 'false');

    // The server refuses a session that does not exist or was deleted.
    const refused = await wa.linkWidget(
        world.widget.ulid,
        '01JZ0000000000000000000000',
    );

    expect(refused.status).toBe(422);
    expect(refused.error?.details).toHaveProperty('session');
});

test('the live preview offers the chooser on canned data as soon as the draft has the channel on, never calling the real hand-off', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: {},
        config: { features: { whatsapp: false } },
    });
    const admin = await actors.staff('admin');
    const page = admin.page;
    const requests: string[] = [];

    page.on('request', (request) => {
        if (request.url().includes('whatsapp-handoff')) {
            requests.push(request.url());
        }
    });
    await page.goto(`/widgets/${world.widget.ulid}`);
    await expect(page.getByTestId('builder-page')).toBeVisible();

    const switcher = page.getByTestId('builder-view-switch');
    const toPreview = async () => {
        if (await switcher.isVisible()) {
            await switcher.getByText('Preview', { exact: true }).click();
        }
    };
    const toEditor = async () => {
        if (await switcher.isVisible()) {
            await switcher.getByText('Edit', { exact: true }).click();
        }
    };
    const preview = page.frameLocator('[data-testid="builder-preview-iframe"]');
    const panel = preview.frameLocator('pne-chat-widget .panel iframe');

    // Off: the preview's panel has no chooser.
    await toPreview();
    await expect(page.getByTestId('builder-preview-status')).toHaveAttribute(
        'data-loader',
        'ready',
    );
    await page.getByTestId('builder-preview-open-chat').click();
    await expect(panel.getByTestId('chat-panel')).toBeVisible();
    await expect(panel.getByTestId('chat-state')).not.toHaveAttribute(
        'data-state',
        'booting',
    );
    await expect(panel.getByTestId('channel-chooser')).toHaveCount(0);

    // On, unsaved: the preview follows the draft (it rebuilds the host page a moment after the edit; "Reload preview" is the visitor's way to be
    // sure, so the check retries through it).
    await toEditor();
    await page.getByTestId('builder-tab-whatsapp').click();
    await page.getByTestId('builder-whatsapp-feature').click();
    await toPreview();
    await expect(async () => {
        await page.getByTestId('builder-preview-reload').click();
        await expect(
            page.getByTestId('builder-preview-status'),
        ).toHaveAttribute('data-loader', 'ready');
        await page.getByTestId('builder-preview-open-chat').click();
        await expect(panel.getByTestId('chat-panel')).toBeVisible();
        await expect(panel.getByTestId('channel-chooser')).toBeVisible({
            timeout: 3_000,
        });
    }).toPass({ timeout: 30_000 });
    await expect(panel.getByTestId('channel-whatsapp')).toContainText(
        'Continue on WhatsApp',
    );
    await panel.getByTestId('channel-whatsapp').click();

    // Canned code screen: a code, but nothing real can be opened from the builder.
    await expect(panel.getByTestId('whatsapp-code')).toBeVisible();
    await expect(panel.getByTestId('whatsapp-open')).toHaveAttribute(
        'aria-disabled',
        'true',
    );
    await expect(panel.getByTestId('whatsapp-open')).not.toHaveAttribute(
        'href',
        /.+/,
    );
    expect(requests).toEqual([]);
});

test('the tab says what went wrong when the sessions cannot be read, and Try again works', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: {},
        config: { features: { whatsapp: false } },
    });
    const admin = await actors.staff('admin', {
        allow: [/HTTP 503/, /request failed/],
    });
    const page = admin.page;
    let broken = true;

    await page.route('**/api/v1/widgets/*/whatsapp', async (route) => {
        if (broken && route.request().method() === 'GET') {
            await route.fulfill({
                status: 503,
                contentType: 'application/json',
                body: JSON.stringify({
                    error: {
                        code: 'openwa_unavailable',
                        message: 'OpenWA could not be reached.',
                    },
                }),
            });

            return;
        }

        await route.continue();
    });
    await openTab(page, world.widget.ulid);
    await expect(page.getByTestId('builder-whatsapp-error')).toBeVisible();
    await expect(page.getByTestId('builder-whatsapp-session')).toHaveCount(0);
    broken = false;
    await page.getByTestId('builder-whatsapp-retry').click();
    await expect(page.getByTestId('builder-whatsapp-session')).toBeVisible();
    await expect(page.getByTestId('builder-whatsapp-error')).toHaveCount(0);
});

test.describe('with no connected number at all', () => {
    test.use({ waMode: 'exclusive', waWipe: true });

    test('the tab says to connect one first, and the choice has only "None"', async ({
        actors,
        adminApi,
        instance,
    }) => {
        const world = await createWorld(adminApi, instance, {
            agents: {},
            config: { features: { whatsapp: true } },
        });
        const admin = await actors.staff('admin');

        await openTab(admin.page, world.widget.ulid);
        await expect(
            admin.page.getByTestId('builder-whatsapp-no-session'),
        ).toContainText('No session is connected');
        await expect(
            admin.page
                .getByTestId('builder-whatsapp-no-session')
                .getByRole('link', { name: 'Open WhatsApp settings' }),
        ).toHaveAttribute('href', '/settings/whatsapp');
        await expect(
            admin.page
                .getByTestId('builder-whatsapp-session')
                .locator('option'),
        ).toHaveCount(1);
        await expect(
            admin.page.getByTestId('builder-whatsapp-checks'),
        ).toHaveAttribute('data-serving', 'false');
        // The Features tab warns as well when the channel is on and no number is connected.
        await admin.page.getByTestId('builder-tab-features').click();
        await expect(
            admin.page.getByTestId('builder-whatsapp-notice'),
        ).toContainText('No WhatsApp session is connected to this widget yet');
    });
});

test.describe('hand-off and replies (Settings > WhatsApp)', () => {
    test.use({ waMode: 'exclusive' });

    test("the hand-off message and a code's lifetime are validated and saved, shape the visitor's link, and show in the builder preview", async ({
        actors,
        adminApi,
        instance,
        openWa,
        wa,
    }) => {
        const session = await readySession(wa, openWa);
        const world = await createWorld(adminApi, instance, {
            agents: {},
            config: { features: { whatsapp: true } },
        });

        await wa.linkWidget(world.widget.ulid, session.ulid);

        const admin = await actors.staff('admin');
        const settings = new WaSettingsPage(admin.page);
        const text = admin.page.getByTestId('wa-setting-handoff-text');

        await settings.goto();

        // The text needs :code, one line, at most 200 characters; the preview shows the link of the connected number.
        await expect(text).toHaveValue('Hi! My support code is :code');
        await expect(
            admin.page.getByTestId('wa-handoff-preview'),
        ).toContainText('Hi! My support code is K7M2QX4P');
        await expect(admin.page.getByTestId('wa-handoff-link')).toContainText(
            `https://wa.me/${session.phone}?text=`,
        );
        await text.fill('Hello without the placeholder');
        await admin.page.getByTestId('wa-behavior-save').click();
        await expect(
            admin.page.getByText('The message must contain :code', {
                exact: false,
            }),
        ).toBeVisible();
        expect(
            (await wa.saveSettings({ handoff_text: 'no placeholder' })).status,
        ).toBe(422);
        expect(
            (
                await wa.saveSettings({
                    handoff_text: `Line one :code\nline two`,
                })
            ).status,
        ).toBe(422);
        expect(
            (
                await wa.saveSettings({
                    handoff_text: `:code ${'x'.repeat(200)}`,
                })
            ).status,
        ).toBe(422);
        expect((await wa.saveSettings({ handoff_ttl_minutes: 4 })).status).toBe(
            422,
        );
        expect(
            (await wa.saveSettings({ handoff_ttl_minutes: 10_081 })).status,
        ).toBe(422);

        // A good one, a short life.
        await text.fill('Support please, code :code');
        await admin.page.getByLabel('How long a code works').fill('90');
        await admin.page.getByTestId('wa-behavior-save').click();
        await expect(
            admin.page.getByText('WhatsApp settings saved.'),
        ).toBeVisible();
        await expect(
            admin.page.getByTestId('wa-handoff-preview'),
        ).toContainText('Support please, code K7M2QX4P');
        await settleSettings();

        // The visitor's link and the ticket follow: the new text, the new lifetime.
        const { handoff, visitor } = await requestHandoff(
            instance,
            world.widget,
        );
        const href = new URL(handoff.waUrl);

        expect(href.searchParams.get('text')).toBe(
            `Support please, code ${handoff.code}`,
        );

        const left = Date.parse(handoff.expiresAt) - Date.now();

        expect(left).toBeGreaterThan(80 * 60_000);
        expect(left).toBeLessThanOrEqual(90 * 60_000);
        await visitor.dispose();

        // The builder shows the same message.
        await openTab(admin.page, world.widget.ulid);
        await expect(
            admin.page.getByTestId('builder-whatsapp-message'),
        ).toHaveText('Support please, code K7M2QX4P');
        await expect(
            admin.page.getByTestId('builder-whatsapp-link'),
        ).toContainText('Support%20please%2C%20code%20K7M2QX4P');
    });
});
