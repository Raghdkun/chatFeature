import {
    type APIRequestContext,
    type Locator,
    type Page,
} from '@playwright/test';
import { type Api, createWidget } from '../support/api';
import { hostOrigin } from '../support/host';
import { unique } from '../support/helpers';
import { expect, test } from '../support/test';

/**
 * The widgets list and the widget builder (admin only): create, walk every tab (change, save, reload, still there), the hours
 * validation, draft versus published, the sections that apply immediately, going live / offline, domains, the identity
 * secret, snippets, time zones and deleting. Every test creates its own widget through the API, so nothing depends on another
 * test's leftovers.
 */
test.use({ scenario: 'p3-widgets', role: 'admin' });

const TABS = [
    'general',
    'branding',
    'texts',
    'features',
    'greetings',
    'hours',
    'domains',
    'categories',
    'embed',
] as const;
type Tab = (typeof TABS)[number];

async function newWidget(
    api: Api,
    overrides: Parameters<typeof createWidget>[1] = { name: '' },
) {
    return createWidget(api, {
        enabled: false,
        ...overrides,
        name: overrides.name || unique('Widget'),
    });
}

/** Opens the builder (optionally on a tab). */
async function openBuilder(page: Page, ulid: string, tab?: Tab) {
    await page.goto(`/widgets/${ulid}`);
    await expect(page.getByTestId('builder-page')).toBeVisible();

    if (tab) {
        await goTab(page, tab);
    }
}

async function goTab(page: Page, tab: Tab) {
    await page.getByTestId(`builder-tab-${tab}`).click();
    await expect(page.getByTestId(`builder-panel-${tab}`)).toBeVisible();
}

/** A radio of a segmented choice: the native input is visually hidden, the label is the target. */
async function pick(scope: Page | Locator, name: string | RegExp) {
    await scope.getByRole('radio', { name }).check({ force: true });
}

/** Save changes and wait for the verdict in the status line. */
async function save(page: Page, tone: 'success' | 'error' = 'success') {
    await page.getByTestId('builder-save').click();
    await expect(page.getByTestId('builder-status-message')).toHaveAttribute(
        'data-tone',
        tone,
    );
}

async function publish(page: Page) {
    await page.getByTestId('builder-publish').click();
    await page.getByTestId('builder-publish-confirm').click();
    await expect(page.getByTestId('builder-badge-published')).toBeVisible();
}

/** The public config endpoint as a visitor's browser calls it (no cookies, with the host page's Origin). */
async function publicConfig(
    request: APIRequestContext,
    key: string,
    origin: string | null,
    headers: Record<string, string> = {},
) {
    return request.get(`/api/v1/public/widgets/${key}/config`, {
        headers: { ...(origin ? { Origin: origin } : {}), ...headers },
        failOnStatusCode: false,
    });
}

test.describe('widgets list', () => {
    test('creates a widget, which opens in the builder, and the card keeps it up to date', async ({
        page,
        api,
        context,
        instance,
    }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
            origin: instance.url,
        });
        const name = unique('Storefront');

        await page.goto('/widgets');
        await expect(page.getByTestId('widgets-page')).toBeVisible();
        // The installer's sample widget is there (disabled).
        await expect(
            page
                .getByTestId(/^widget-card-/)
                .filter({ hasText: 'Sample widget' }),
        ).toHaveAttribute('data-enabled', 'false');

        await page.getByTestId('widget-create').click();
        const dialog = page.getByTestId('widget-create-dialog');
        await dialog.getByTestId('widget-create-submit').click();
        await expect(dialog.getByText(/enter a name/i)).toBeVisible();

        await dialog.getByLabel('Widget name').fill(name);
        await dialog.getByTestId('widget-create-submit').click();

        // It opens straight in the builder: a fresh widget is published (v1), identical to its draft, and disabled.
        await expect(page).toHaveURL(/\/widgets\/[0-9a-z]{26}$/);
        await expect(page.getByTestId('builder-title')).toHaveText(name);
        await expect(page.getByTestId('builder-badge-published')).toHaveText(
            /Published v1/,
        );
        await expect(page.getByTestId('builder-badge-disabled')).toBeVisible();
        const ulid = page.url().split('/').pop()!;

        await page.goto('/widgets');
        const card = page.getByTestId(`widget-card-${ulid}`);
        await expect(card).toContainText(name);
        await expect(card).toHaveAttribute('data-enabled', 'false');
        await expect(page.getByTestId(`widget-version-${ulid}`)).toHaveText(
            'v1',
        );
        await expect(card).toContainText('0 domains');
        await expect(card).toContainText('0 categories');

        // The public key can be copied.
        const key = (await page
            .getByTestId(`widget-key-${ulid}`)
            .textContent())!;
        expect(key).toMatch(/^wk_[a-z0-9]{20}$/);
        await page.getByTestId(`widget-copy-key-${ulid}`).click();
        await expect(page.getByTestId(`widget-copy-key-${ulid}`)).toContainText(
            'Copied',
        );
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
            key,
        );

        // Taking it live from the card is immediate and persists.
        await page.getByTestId(`widget-enabled-${ulid}`).click();
        await expect(card).toHaveAttribute('data-enabled', 'true');
        await expect
            .poll(
                async () =>
                    (await api.ok('GET', `/api/v1/widgets/${ulid}`)).data
                        .is_enabled,
            )
            .toBe(true);
        await page.reload();
        await expect(page.getByTestId(`widget-card-${ulid}`)).toHaveAttribute(
            'data-enabled',
            'true',
        );

        // The card opens the builder.
        await page.getByTestId(`widget-edit-${ulid}`).click();
        await expect(page).toHaveURL(new RegExp(`/widgets/${ulid}$`));
    });

    test('deletes a widget after confirming, and its public endpoints stop answering', async ({
        page,
        api,
        request,
        instance,
    }) => {
        const origin = hostOrigin(instance);
        const { ulid, key } = await newWidget(api, {
            name: '',
            domains: ['localhost:' + instance.hostPort],
            enabled: true,
        });

        expect((await publicConfig(request, key, origin)).status()).toBe(200);
        expect((await request.get(`/w/${key}.js`)).status()).toBe(200);

        await page.goto('/widgets');
        await page.getByTestId(`widget-delete-${ulid}`).click();

        const dialog = page.getByTestId('widget-delete-dialog');
        await expect(dialog).toBeVisible();
        await dialog.getByRole('button', { name: /keep/i }).click();
        await expect(page.getByTestId(`widget-card-${ulid}`)).toBeVisible();

        await page.getByTestId(`widget-delete-${ulid}`).click();
        await page.getByTestId('widget-delete-confirm').click();
        await expect(page.getByTestId(`widget-card-${ulid}`)).toHaveCount(0);
        await expect(page.getByText('Widget deleted')).toBeVisible();

        expect((await api.get(`/api/v1/widgets/${ulid}`)).status).toBe(404);
        // For visitors the widget never existed.
        const gone = await publicConfig(request, key, origin);
        expect(gone.status()).toBe(404);
        expect((await gone.json()).error.code).toBe('widget_not_found');
        expect((await request.get(`/w/${key}.js`)).status()).toBe(404);
        expect((await request.get(`/embed/${key}`)).status()).toBe(404);

        await page.reload();
        await expect(page.getByTestId(`widget-card-${ulid}`)).toHaveCount(0);
    });

    test('API envelopes of the widget list: public identifiers only, never the identity secret', async ({
        api,
    }) => {
        const { ulid } = await newWidget(api);

        const listed = await api.get('/api/v1/widgets');
        expect(listed.status).toBe(200);
        const item = (listed.data as Record<string, unknown>[]).find(
            (widget) => widget.ulid === ulid,
        )!;
        expect(Object.keys(item).sort((a, b) => a.localeCompare(b))).toEqual(
            [
                'categories_count',
                'config_version',
                'domains_count',
                'has_unpublished_changes',
                'is_enabled',
                'name',
                'public_key',
                'ulid',
                'updated_at',
                'whatsapp_connected',
            ].sort((a, b) => a.localeCompare(b)),
        );

        const one = await api.get(`/api/v1/widgets/${ulid}`);
        expect(one.data).toMatchObject({
            ulid,
            is_enabled: false,
            has_identity_secret: false,
            has_unpublished_changes: false,
            config_version: 1,
        });
        expect(JSON.stringify(one.body)).not.toMatch(/"identity_secret"/);
        expect(JSON.stringify(one.body)).not.toMatch(/"id":/);

        const invalid = await api.post('/api/v1/widgets', { name: '' });
        expect(invalid.status).toBe(422);
        expect(invalid.error?.code).toBe('validation_failed');

        expect(
            (await api.get('/api/v1/widgets/01ARZ3NDEKTSV4RRFFQ69G5FAV'))
                .status,
        ).toBe(404);
    });
});

test.describe('builder: every tab saves and keeps its values', () => {
    test('General: name, language, time zone (Asia/Kolkata), timing, availability mode, non-browser clients', async ({
        page,
        api,
    }) => {
        const { ulid } = await newWidget(api);
        const name = unique('Renamed');

        await openBuilder(page, ulid, 'general');
        const panel = page.getByTestId('builder-panel-general');

        await expect(page.getByTestId('builder-save')).toBeDisabled();
        await panel.getByLabel('Widget name').fill(name);
        await expect(page.getByTestId('builder-badge-dirty')).toBeVisible();
        await panel.getByLabel('Default language').selectOption('fr');
        await panel.getByLabel('Time zone').selectOption('Asia/Kolkata');
        await panel.getByLabel('Idle timeout').fill('240');
        await panel.getByLabel('Waiting time').fill('120');
        await pick(panel, 'Always online');
        await panel
            .getByRole('switch', { name: 'Allow non-browser clients' })
            .click();

        await save(page);
        await expect(page.getByTestId('builder-title')).toHaveText(name);

        const stored = (await api.ok('GET', `/api/v1/widgets/${ulid}`)).data;
        expect(stored).toMatchObject({
            name,
            locale: 'fr',
            timezone: 'Asia/Kolkata',
            idle_timeout_minutes: 240,
            queue_timeout_seconds: 120,
            offline_mode: 'always_online',
            allow_non_browser_clients: true,
        });

        await page.reload();
        await goTab(page, 'general');
        await expect(panel.getByLabel('Widget name')).toHaveValue(name);
        await expect(panel.getByLabel('Default language')).toHaveValue('fr');
        await expect(panel.getByLabel('Time zone')).toHaveValue('Asia/Kolkata');
        await expect(panel.getByLabel('Idle timeout')).toHaveValue('240');
        await expect(panel.getByLabel('Waiting time')).toHaveValue('120');
        await expect(
            panel.getByRole('radio', { name: 'Always online' }),
        ).toBeChecked();
        await expect(
            panel.getByRole('switch', { name: 'Allow non-browser clients' }),
        ).toBeChecked();

        // An out-of-range number is flagged while typing and is not taken over (nothing to save); leaving the field
        // snaps it to the nearest allowed value.
        await panel.getByLabel('Idle timeout').fill('1');
        await expect(panel.getByText(/whole number from 5 to/)).toBeVisible();
        await expect(page.getByTestId('builder-save')).toBeDisabled();
        await panel.getByLabel('Idle timeout').blur();
        await expect(panel.getByLabel('Idle timeout')).toHaveValue('5');
        await expect(page.getByTestId('builder-badge-dirty')).toBeVisible();
        expect(
            (await api.ok('GET', `/api/v1/widgets/${ulid}`)).data
                .idle_timeout_minutes,
        ).toBe(240);
    });

    test('Branding: colours, type and shape, launcher, position', async ({
        page,
        api,
    }) => {
        const { ulid } = await newWidget(api);

        await openBuilder(page, ulid, 'branding');
        const panel = page.getByTestId('builder-panel-branding');

        await pick(panel, 'Dark');
        await panel
            .getByRole('textbox', { name: 'Primary color', exact: true })
            .fill('#7c3aed');
        await panel
            .getByRole('textbox', { name: 'Accent color', exact: true })
            .fill('#e11d48');
        await panel
            .getByRole('textbox', { name: 'Surface color', exact: true })
            .fill('#f8fafc');
        await panel
            .getByRole('textbox', { name: 'Font family' })
            .fill('Georgia, serif');
        await panel.getByRole('slider', { name: 'Corner radius' }).fill('24');
        await pick(panel, 'Strong');
        await pick(panel, 'Pill with label');
        await pick(panel, /Small/);
        await pick(panel, 'Sparkle');
        await panel
            .getByRole('textbox', { name: 'Label', exact: true })
            .fill('Ask us');
        await pick(panel, 'Bottom left');
        await panel.getByLabel('Horizontal offset').fill('32');
        await panel.getByLabel('Vertical offset').fill('48');
        await panel.getByLabel('Panel width').fill('420');
        await panel.getByLabel('Panel height').fill('560');

        await save(page);
        await expect(
            page.getByTestId('builder-badge-unpublished'),
        ).toBeVisible();

        await page.reload();
        await goTab(page, 'branding');
        await expect(panel.getByRole('radio', { name: 'Dark' })).toBeChecked();
        await expect(
            panel.getByRole('textbox', { name: 'Primary color', exact: true }),
        ).toHaveValue('#7c3aed');
        await expect(
            panel.getByRole('textbox', { name: 'Accent color', exact: true }),
        ).toHaveValue('#e11d48');
        await expect(
            panel.getByRole('textbox', { name: 'Font family' }),
        ).toHaveValue('Georgia, serif');
        await expect(
            panel.getByRole('slider', { name: 'Corner radius' }),
        ).toHaveValue('24');
        await expect(
            panel.getByRole('radio', { name: 'Strong' }),
        ).toBeChecked();
        await expect(
            panel.getByRole('radio', { name: 'Pill with label' }),
        ).toBeChecked();
        await expect(panel.getByRole('radio', { name: /Small/ })).toBeChecked();
        await expect(
            panel.getByRole('radio', { name: 'Sparkle' }),
        ).toBeChecked();
        await expect(
            panel.getByRole('textbox', { name: 'Label', exact: true }),
        ).toHaveValue('Ask us');
        await expect(
            panel.getByRole('radio', { name: 'Bottom left' }),
        ).toBeChecked();
        await expect(panel.getByLabel('Horizontal offset')).toHaveValue('32');
        await expect(panel.getByLabel('Vertical offset')).toHaveValue('48');
        await expect(panel.getByLabel('Panel width')).toHaveValue('420');
        await expect(panel.getByLabel('Panel height')).toHaveValue('560');

        // A colour that is not hex is flagged while typing and never taken over; leaving the field restores the saved one.
        const primary = panel.getByRole('textbox', {
            name: 'Primary color',
            exact: true,
        });
        await primary.fill('purple');
        await expect(
            panel.getByText(/hex color such as #0f766e/),
        ).toBeVisible();
        await expect(page.getByTestId('builder-save')).toBeDisabled();
        await primary.blur();
        await expect(primary).toHaveValue('#7c3aed');
    });

    test('Texts: default texts, an added language with its own texts, language detection', async ({
        page,
        api,
    }) => {
        const { ulid } = await newWidget(api);

        await openBuilder(page, ulid, 'texts');
        const panel = page.getByTestId('builder-panel-texts');

        await page.getByTestId('builder-text-title').fill('Help desk');
        await page
            .getByTestId('builder-text-welcome')
            .fill('Welcome to the help desk.');
        await panel
            .getByRole('switch', { name: "Match the visitor's language" })
            .click();

        await page.getByTestId('builder-texts-add-input').fill('fr');
        await page.getByTestId('builder-texts-add').click();
        await expect(page.getByTestId('builder-texts-fr')).toBeVisible();
        await page.getByTestId('builder-text-title').fill('Aide');
        await page.getByTestId('builder-text-welcome').fill('Bienvenue.');

        // An invalid code and a duplicate are refused with a message.
        await page.getByTestId('builder-texts-add-input').fill('not a code');
        await page.getByTestId('builder-texts-add').click();
        await expect(
            panel.getByText(/language code such as ar or pt-BR/).first(),
        ).toBeVisible();
        await page.getByTestId('builder-texts-add-input').fill('fr');
        await page.getByTestId('builder-texts-add').click();
        await expect(panel.getByText(/already/i).first()).toBeVisible();

        await save(page);
        await page.reload();
        await goTab(page, 'texts');

        await expect(
            panel.getByRole('switch', { name: "Match the visitor's language" }),
        ).not.toBeChecked();
        await expect(page.getByTestId('builder-text-title')).toHaveValue(
            'Help desk',
        );
        await pick(panel, /^Français|français/);
        await expect(page.getByTestId('builder-text-title')).toHaveValue(
            'Aide',
        );
        await expect(page.getByTestId('builder-text-welcome')).toHaveValue(
            'Bienvenue.',
        );
    });

    test('Features: switches and the pre-chat form', async ({ page, api }) => {
        const { ulid } = await newWidget(api);

        await openBuilder(page, ulid, 'features');
        const panel = page.getByTestId('builder-panel-features');

        await panel.getByRole('switch', { name: 'Sounds' }).click();
        await panel.getByRole('switch', { name: 'Image attachments' }).click();
        await panel
            .getByRole('switch', { name: 'Unread count in page title' })
            .click();
        await panel
            .getByRole('switch', { name: 'Require Email field' })
            .click();
        await panel.getByRole('switch', { name: 'Show Phone field' }).click();
        await panel
            .getByRole('switch', { name: 'Require Phone field' })
            .click();
        await panel
            .getByRole('textbox', { name: 'Consent text' })
            .fill('I accept the privacy policy.');

        await save(page);
        await page.reload();
        await goTab(page, 'features');

        await expect(
            panel.getByRole('switch', { name: 'Sounds' }),
        ).not.toBeChecked();
        await expect(
            panel.getByRole('switch', { name: 'Image attachments' }),
        ).not.toBeChecked();
        await expect(
            panel.getByRole('switch', { name: 'Unread count in page title' }),
        ).toBeChecked();
        await expect(
            panel.getByRole('switch', { name: 'Chat rating' }),
        ).toBeChecked();
        await expect(
            panel.getByRole('switch', { name: 'Require Email field' }),
        ).toBeChecked();
        await expect(
            panel.getByRole('switch', { name: 'Show Phone field' }),
        ).toBeChecked();
        await expect(
            panel.getByRole('switch', { name: 'Require Phone field' }),
        ).toBeChecked();
        await expect(
            panel.getByRole('textbox', { name: 'Consent text' }),
        ).toHaveValue('I accept the privacy policy.');

        // WhatsApp needs a connected session: the switch explains that instead of silently doing nothing.
        await panel.getByRole('switch', { name: 'WhatsApp hand-off' }).click();
        await expect(page.getByTestId('builder-whatsapp-notice')).toBeVisible();
    });

    test('Greetings: behaviour is a draft, the message pool is live', async ({
        page,
        api,
        request,
        instance,
    }) => {
        const origin = hostOrigin(instance);
        const { ulid, key } = await newWidget(api, {
            name: '',
            domains: [`localhost:${instance.hostPort}`],
            enabled: true,
        });

        await openBuilder(page, ulid, 'greetings');
        const panel = page.getByTestId('builder-panel-greetings');

        await panel.getByLabel('Delay', { exact: true }).fill('1');
        await panel.getByLabel('Repeat every').fill('2');
        await panel.getByLabel('Hide after').fill('9');
        await pick(panel, 'Wait for the next interval');
        await panel
            .getByRole('switch', { name: 'Show agent face and name' })
            .click();

        const pool = page.getByTestId('builder-greetings-pool');
        await expect(page.getByTestId('builder-greetings-empty')).toBeVisible();
        await page.getByTestId('builder-greeting-add').click();
        await page.getByTestId('builder-greeting-add').click();

        const first = page.getByTestId('builder-greeting-0');
        await first.getByLabel('Message').fill('Hello from the pool!');
        await first.getByLabel('Agent name').fill('Nadia');
        await first.getByLabel('Weight').fill('5');
        const second = page.getByTestId('builder-greeting-1');
        await second.getByLabel('Message').fill('Second message');
        await second.getByLabel('Language').selectOption('ar');

        // An empty message is refused client-side; saving works once it is filled.
        await page.getByTestId('builder-greeting-add').click();
        await page.getByTestId('builder-save').click();
        await expect(
            page.getByTestId('builder-status-message'),
        ).toHaveAttribute('data-tone', 'error');
        await expect(page.getByTestId('builder-greeting-2')).toContainText(
            'required',
        );
        await page.getByTestId('builder-greeting-2-remove').click();

        await save(page);
        await expect(pool).toBeVisible();

        // The pool is live at once, the behaviour (a config change) waits for Publish.
        const live = await (await publicConfig(request, key, origin)).json();
        expect(
            live.data.greetings.map((g: { body: string }) => g.body),
        ).toEqual(['Hello from the pool!', 'Second message']);
        expect(live.data.greetings[0]).toMatchObject({
            agentName: 'Nadia',
            weight: 5,
            locale: null,
        });
        expect(live.data.greetings[1]).toMatchObject({ locale: 'ar' });
        expect(live.data.config.greetings).toMatchObject({
            delaySeconds: 3,
            intervalMinutes: 30,
        });

        await page.reload();
        await goTab(page, 'greetings');
        await expect(panel.getByLabel('Delay', { exact: true })).toHaveValue(
            '1',
        );
        await expect(panel.getByLabel('Repeat every')).toHaveValue('2');
        await expect(panel.getByLabel('Hide after')).toHaveValue('9');
        await expect(
            panel.getByRole('radio', { name: 'Wait for the next interval' }),
        ).toBeChecked();
        await expect(
            panel.getByRole('switch', { name: 'Show agent face and name' }),
        ).not.toBeChecked();
        await expect(
            page.getByTestId('builder-greeting-0').getByLabel('Message'),
        ).toHaveValue('Hello from the pool!');

        // Reorder and remove, then publish: now the behaviour is live as well.
        await page.getByTestId('builder-greeting-0-down').click();
        await expect(
            page.getByTestId('builder-greeting-0').getByLabel('Message'),
        ).toHaveValue('Second message');
        await page.getByTestId('builder-greeting-1-remove').click();
        await save(page);
        await publish(page);

        const after = await (await publicConfig(request, key, origin)).json();
        expect(after.data.greetings).toHaveLength(1);
        expect(after.data.greetings[0].body).toBe('Second message');
        expect(after.data.config.greetings).toMatchObject({
            delaySeconds: 1,
            intervalMinutes: 2,
            autoHideSeconds: 9,
            dismissPolicy: 'interval',
            showAgent: false,
        });
    });

    test('Hours: weekly ranges, an overlap is flagged on its row, holidays (a name is optional), time zone', async ({
        page,
        api,
    }) => {
        const { ulid } = await newWidget(api);

        await openBuilder(page, ulid, 'hours');
        const panel = page.getByTestId('builder-panel-hours');

        await panel.getByLabel('Time zone').selectOption('Asia/Kolkata');
        await page.getByTestId('builder-hours-preset').click();
        await expect(panel.getByLabel('Monday opening time')).toHaveValue(
            '09:00',
        );
        await expect(panel.getByLabel('Friday closing time')).toHaveValue(
            '17:00',
        );
        await expect(panel.getByText('Closed', { exact: true })).toHaveCount(2);

        // A second Monday range that overlaps the first: flagged on the right row, nothing is sent.
        await page.getByTestId('builder-hours-add-1').click();
        const ranges = panel.getByLabel('Monday opening time');
        await expect(ranges).toHaveCount(2);
        await panel.getByLabel('Monday opening time').nth(1).fill('16:00');
        await panel.getByLabel('Monday closing time').nth(1).fill('18:00');

        await page.getByTestId('builder-save').click();
        await expect(
            page.getByTestId('builder-status-message'),
        ).toHaveAttribute('data-tone', 'error');
        await expect(
            page.getByTestId('builder-tab-hours-error'),
        ).toBeAttached();
        // Both overlapping ranges carry the message (index 0 = first Monday range, 1 = the new one in schedule order).
        const messages = panel.getByText(
            'These hours overlap another range on the same day.',
        );
        await expect(messages.first()).toBeVisible();
        const monday = page.getByTestId('builder-hours-day-1');
        await expect(
            monday
                .getByText('These hours overlap another range on the same day.')
                .first(),
        ).toBeVisible();
        // Tuesday is untouched.
        await expect(
            page
                .getByTestId('builder-hours-day-2')
                .getByText('These hours overlap'),
        ).toHaveCount(0);

        // Fix it: the second range starts after the first one ends.
        await panel.getByLabel('Monday opening time').nth(1).fill('17:30');
        await expect(messages).toHaveCount(0);

        // A holiday without a name is fine.
        await page.getByTestId('builder-holiday-add').click();
        await page.getByTestId('builder-holiday-date-0').fill('2027-12-25');
        await page.getByTestId('builder-holiday-add').click();
        await page.getByTestId('builder-holiday-date-1').fill('2027-01-01');
        await page.getByTestId('builder-holiday-label-1').fill('New Year');
        // The same date twice is flagged.
        await page.getByTestId('builder-holiday-add').click();
        await page.getByTestId('builder-holiday-date-2').fill('2027-01-01');
        await page.getByTestId('builder-save').click();
        await expect(
            page.getByTestId('builder-holiday-2-errors'),
        ).toContainText('This date is already listed.');
        await page.getByTestId('builder-holiday-remove-2').click();

        await save(page);
        await page.reload();
        await goTab(page, 'hours');

        await expect(panel.getByLabel('Time zone')).toHaveValue('Asia/Kolkata');
        await expect(panel.getByLabel('Monday opening time')).toHaveCount(2);
        await expect(
            panel.getByLabel('Monday opening time').nth(1),
        ).toHaveValue('17:30');
        await expect(
            panel.getByLabel('Monday closing time').nth(1),
        ).toHaveValue('18:00');
        const dates = panel.locator('[data-testid^="builder-holiday-date-"]');
        await expect(dates).toHaveCount(2);
        const values = await dates.evaluateAll((items) =>
            items.map((item) => (item as HTMLInputElement).value),
        );
        expect(values.sort((a, b) => a.localeCompare(b))).toEqual([
            '2027-01-01',
            '2027-12-25',
        ]);

        // The "inactive" notice shows when the widget does not follow business hours.
        await pick(panel, 'Always online');
        await expect(page.getByTestId('builder-hours-inactive')).toBeVisible();
    });

    test('Hours: a server-side validation error lands on the right row', async ({
        page,
        api,
    }) => {
        const { ulid } = await newWidget(api);

        await openBuilder(page, ulid, 'hours');
        const panel = page.getByTestId('builder-panel-hours');

        await page.getByTestId('builder-hours-preset').click();
        await panel.getByLabel('Wednesday closing time').fill('18:00');

        // Pretend the server found a problem with the third range (Wednesday): the message belongs under that row.
        await page.route(`**/api/v1/widgets/${ulid}/draft`, async (route) => {
            await route.fulfill({
                status: 422,
                contentType: 'application/json',
                json: {
                    error: {
                        code: 'validation_failed',
                        message: 'The given data was invalid.',
                        details: {
                            'config.hours.schedule.2.end': [
                                'The closing time of schedule entry 3 must be after its opening time.',
                            ],
                        },
                    },
                },
            });
        });
        await goTab(page, 'general');
        await goTab(page, 'hours');
        await save(page, 'error');

        await expect(
            page.getByTestId('builder-tab-hours-error'),
        ).toBeAttached();
        await expect(
            page.getByTestId('builder-hours-range-2-errors'),
        ).toContainText('must be after its opening time');
        await expect(
            page.getByTestId('builder-hours-range-1-errors'),
        ).toHaveCount(0);
        await expect(
            page
                .getByTestId('builder-hours-day-3')
                .getByText('must be after its opening time'),
        ).toBeVisible();
    });

    test('Domains: normalised, validated on the client and on the server, applied immediately', async ({
        page,
        api,
        request,
        instance,
    }) => {
        const origin = hostOrigin(instance);
        const { ulid, key } = await newWidget(api, { name: '', enabled: true });

        await openBuilder(page, ulid, 'domains');
        const panel = page.getByTestId('builder-panel-domains');
        const input = page.getByTestId('builder-domain-input');
        const problem = page.getByTestId('builder-domain-problem');
        const chips = page.getByTestId('builder-domains-list');

        await expect(page.getByTestId('builder-domains-empty')).toBeVisible();

        // Client-side rules, one by one.
        await input.fill('example.com/path');
        await page.getByTestId('builder-domain-add').click();
        await expect(problem).toContainText(
            'Remove everything after the host name',
        );
        await input.fill('user@example.com');
        await input.press('Enter');
        await expect(problem).toContainText(
            'Remove the user name and password',
        );
        await input.fill('a*.example.com');
        await input.press('Enter');
        await expect(problem).toContainText(
            'A wildcard is only allowed as the first label',
        );
        await input.fill('*.com');
        await input.press('Enter');
        await expect(problem).toBeVisible();
        await input.fill('example.com:99999');
        await input.press('Enter');
        await expect(problem).toContainText(
            'The port must be a number from 1 to 65535',
        );

        // Several at once, lower-cased, de-duplicated; punycode for non-ASCII names.
        await input.fill(
            `Shop.Example.com, *.Example.org  localhost:${instance.hostPort} shop.example.com`,
        );
        await input.press('Enter');
        await expect(
            chips.getByText('shop.example.com', { exact: true }),
        ).toHaveCount(1);
        await expect(
            chips.getByText('*.example.org', { exact: true }),
        ).toBeVisible();
        await expect(
            chips.getByText(`localhost:${instance.hostPort}`, { exact: true }),
        ).toBeVisible();

        // `*.co.uk` passes the client (it has no list of public suffixes) and is refused by the server, on that chip.
        await input.fill('*.co.uk');
        await input.press('Enter');
        await expect(chips.getByText('*.co.uk', { exact: true })).toBeVisible();
        await save(page, 'error');
        await expect(panel.getByText(/is not a valid domain/)).toBeVisible();
        // Nothing of that save reached visitors' list (the whole list is validated as one).
        const before = (await api.ok('GET', `/api/v1/widgets/${ulid}`)).data;
        expect(before.is_enabled).toBe(true);
        expect((await publicConfig(request, key, origin)).status()).toBe(403);

        await page.getByRole('button', { name: 'Remove *.co.uk' }).click();
        await save(page);

        // Applied immediately, no Publish: the host page's origin is allowed now, others are not.
        const allowed = await publicConfig(request, key, origin);
        expect(allowed.status()).toBe(200);
        expect(allowed.headers()['access-control-allow-origin']).toBe(origin);
        const refused = await publicConfig(
            request,
            key,
            'http://evil.example.net',
        );
        expect(refused.status()).toBe(403);
        expect((await refused.json()).error.code).toBe('origin_not_allowed');
        expect(
            refused.headers()['access-control-allow-origin'],
        ).toBeUndefined();

        await page.reload();
        await goTab(page, 'domains');
        await expect(
            chips.getByText('shop.example.com', { exact: true }),
        ).toBeVisible();
        await expect(page.getByTestId('builder-domains-empty')).toHaveCount(0);
    });

    test('Domains: an http:// entry (plain-http site) is kept, https:// is the default and dropped', async ({
        page,
        api,
    }) => {
        const { ulid } = await newWidget(api);

        await openBuilder(page, ulid, 'domains');
        const input = page.getByTestId('builder-domain-input');
        const chips = page.getByTestId('builder-domains-list');

        await input.fill(
            'http://legacy.example.org https://secure.example.org',
        );
        await input.press('Enter');

        await expect(
            chips.getByText('http://legacy.example.org', { exact: true }),
        ).toBeVisible();
        await expect(
            chips.getByText('secure.example.org', { exact: true }),
        ).toBeVisible();
        await expect(page.getByTestId('builder-domain-problem')).toHaveCount(0);

        await save(page);
        await page.reload();
        await goTab(page, 'domains');
        await expect(
            chips.getByText('http://legacy.example.org', { exact: true }),
        ).toBeVisible();
        await expect(
            chips.getByText('secure.example.org', { exact: true }),
        ).toBeVisible();
    });

    test('Categories: add, reorder and remove apply immediately and show up for visitors', async ({
        page,
        api,
        request,
        instance,
    }) => {
        const origin = hostOrigin(instance);
        const { ulid, key } = await newWidget(api, {
            name: '',
            domains: [`localhost:${instance.hostPort}`],
            categories: ['general'],
            enabled: true,
        });
        const all = (await api.ok('GET', '/api/v1/categories')).data as {
            ulid: string;
            slug: string;
        }[];
        const bySlug = Object.fromEntries(all.map((c) => [c.slug, c.ulid]));

        await openBuilder(page, ulid, 'categories');

        await page
            .getByTestId(`builder-category-add-${bySlug.billing}`)
            .click();
        await page.getByTestId(`builder-category-add-${bySlug.sales}`).click();
        await page.getByTestId(`builder-category-up-${bySlug.sales}`).click();
        await save(page);

        const slugs = async () =>
            (
                (await (await publicConfig(request, key, origin)).json()).data
                    .categories as {
                    slug: string;
                }[]
            ).map((c) => c.slug);

        // No Publish needed: visitors already get the new list, in this order.
        expect(await slugs()).toEqual(['general', 'sales', 'billing']);

        await page
            .getByTestId(`builder-category-remove-${bySlug.general}`)
            .click();
        await save(page);
        expect(await slugs()).toEqual(['sales', 'billing']);

        await page.reload();
        await goTab(page, 'categories');
        await expect(
            page.getByTestId(`builder-category-enabled-${bySlug.sales}`),
        ).toBeVisible();
        await expect(
            page.getByTestId(`builder-category-enabled-${bySlug.general}`),
        ).toHaveCount(0);
        await expect(
            page.getByTestId(`builder-category-add-${bySlug.general}`),
        ).toBeVisible();

        // A deactivated category disappears from what visitors get (but stays selected in the builder).
        await api.ok('PATCH', `/api/v1/categories/${bySlug.billing}`, {
            is_active: false,
        });
        await expect.poll(slugs).toEqual(['sales']);
        await api.ok('PATCH', `/api/v1/categories/${bySlug.billing}`, {
            is_active: true,
        });
        await expect.poll(slugs).toEqual(['sales', 'billing']);
    });
});

test.describe('builder: draft versus published', () => {
    test('visitors keep the old design until Publish, then get the new one with a bumped version', async ({
        page,
        api,
        request,
        instance,
    }) => {
        const origin = hostOrigin(instance);
        const { ulid, key } = await newWidget(api, {
            name: '',
            domains: [`localhost:${instance.hostPort}`],
            enabled: true,
        });
        const config = async () =>
            (await publicConfig(request, key, origin)).json() as Promise<{
                data: {
                    configVersion: number;
                    config: {
                        launcher: { label: string };
                        theme: { primary: string };
                    };
                };
            }>;

        const first = await publicConfig(request, key, origin);
        expect(first.status()).toBe(200);
        const firstBody = (await first.json()) as Awaited<
            ReturnType<typeof config>
        >;
        expect(firstBody.data.configVersion).toBe(1);
        expect(firstBody.data.config.launcher.label).toBe('Chat with us');
        const firstEtag = first.headers().etag;
        expect(firstEtag).toBeTruthy();

        await openBuilder(page, ulid, 'branding');
        const panel = page.getByTestId('builder-panel-branding');
        await panel
            .getByRole('textbox', { name: 'Label', exact: true })
            .fill('Talk to Acme');
        await panel
            .getByRole('textbox', { name: 'Primary color', exact: true })
            .fill('#c026d3');
        await save(page);
        await expect(
            page.getByTestId('builder-badge-unpublished'),
        ).toBeVisible();

        // The draft is saved, visitors still see version 1 (also through the cached script).
        const draftOnly = await config();
        expect(draftOnly.data.configVersion).toBe(1);
        expect(draftOnly.data.config.launcher.label).toBe('Chat with us');
        expect(draftOnly.data.config.theme.primary).toBe('#0f766e');
        expect(await (await request.get(`/w/${key}.js`)).text()).not.toContain(
            'Talk to Acme',
        );

        // The embed tab says so.
        await goTab(page, 'embed');
        await expect(
            page.getByTestId('builder-embed-unpublished'),
        ).toBeVisible();

        await publish(page);
        await expect(page.getByTestId('builder-badge-published')).toHaveText(
            /Published v2/,
        );
        await expect(page.getByTestId('builder-status-message')).toContainText(
            'Published as version 2',
        );

        const published = await publicConfig(request, key, origin);
        const body = (await published.json()) as Awaited<
            ReturnType<typeof config>
        >;
        expect(body.data.configVersion).toBe(2);
        expect(body.data.config.launcher.label).toBe('Talk to Acme');
        expect(body.data.config.theme.primary).toBe('#c026d3');
        expect(published.headers().etag).not.toBe(firstEtag);

        // The loader script carries the new boot config too (no stale cache).
        const script = await (await request.get(`/w/${key}.js`)).text();
        expect(script).toContain('Talk to Acme');
        expect(script).toContain('"configVersion":2');

        // The list shows the new version and no "unpublished" badge any more.
        await page.goto('/widgets');
        await expect(page.getByTestId(`widget-version-${ulid}`)).toHaveText(
            'v2',
        );
        await expect(
            page.getByTestId(`widget-unpublished-${ulid}`),
        ).toHaveCount(0);
    });

    test('Publish saves unsaved edits first, and publishing without changes is not offered', async ({
        page,
        api,
    }) => {
        const { ulid } = await newWidget(api);

        await openBuilder(page, ulid, 'branding');
        await expect(page.getByTestId('builder-publish')).toBeDisabled();

        await page
            .getByTestId('builder-panel-branding')
            .getByRole('textbox', { name: 'Label', exact: true })
            .fill('Publish me');
        await expect(page.getByTestId('builder-badge-dirty')).toBeVisible();
        await expect(page.getByTestId('builder-publish')).toBeEnabled();

        await page.getByTestId('builder-publish').click();
        await expect(page.getByTestId('builder-publish-dialog')).toContainText(
            'Your unsaved changes are saved first',
        );
        await page.getByTestId('builder-publish-confirm').click();
        await expect(page.getByTestId('builder-badge-published')).toHaveText(
            /Published v2/,
        );
        await expect(page.getByTestId('builder-publish')).toBeDisabled();
    });

    test('server-side field errors are put on their field and the tab with the problem opens', async ({
        page,
        api,
    }) => {
        const { ulid } = await newWidget(api);

        await openBuilder(page, ulid, 'general');
        await page.getByTestId('builder-tab-branding').click();
        await page
            .getByTestId('builder-panel-branding')
            .getByLabel('Panel height')
            .fill('800');
        await goTab(page, 'general');

        await page.route(`**/api/v1/widgets/${ulid}/draft`, async (route) => {
            await route.fulfill({
                status: 422,
                contentType: 'application/json',
                json: {
                    error: {
                        code: 'validation_failed',
                        message: 'The given data was invalid.',
                        details: {
                            'config.theme.panelHeight': [
                                'The panel height must be at most 700.',
                            ],
                        },
                    },
                },
            });
        });
        await page.getByTestId('builder-save').click();

        // The builder jumps to the tab that has the error and marks the field.
        await expect(page.getByTestId('builder-panel-branding')).toBeVisible();
        await expect(
            page.getByTestId('builder-tab-branding-error'),
        ).toBeAttached();
        await expect(page.getByTestId('builder-panel-branding')).toContainText(
            'The panel height must be at most 700.',
        );
        await expect(page.getByTestId('builder-badge-dirty')).toBeVisible();
    });
});

test.describe('builder: going live and offline', () => {
    test('takes the widget live and offline through its confirm dialog; visitors follow at once', async ({
        page,
        api,
        request,
        instance,
    }) => {
        const origin = hostOrigin(instance);
        const { ulid, key } = await newWidget(api, {
            name: '',
            domains: [`localhost:${instance.hostPort}`],
        });

        expect((await publicConfig(request, key, origin)).status()).toBe(404);
        expect((await request.get(`/w/${key}.js`)).status()).toBe(404);

        await openBuilder(page, ulid, 'general');
        const status = page.getByTestId('builder-enabled-status');
        await expect(status).toContainText('Offline');
        await expect(page.getByTestId('builder-badge-disabled')).toBeVisible();

        // Cancel changes nothing.
        await page.getByTestId('builder-enabled-toggle').click();
        const dialog = page.getByTestId('builder-enabled-dialog');
        await expect(dialog).toContainText('Take this widget live?');
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toBeHidden();
        expect((await publicConfig(request, key, origin)).status()).toBe(404);

        await page.getByTestId('builder-enabled-toggle').click();
        await page.getByTestId('builder-enabled-confirm').click();
        await expect(dialog).toBeHidden();
        await expect(status).toContainText('Live on your sites');
        await expect(page.getByTestId('builder-badge-disabled')).toHaveCount(0);
        await expect(page.getByTestId('builder-status-message')).toContainText(
            'The widget is live.',
        );

        expect((await publicConfig(request, key, origin)).status()).toBe(200);
        expect((await request.get(`/w/${key}.js`)).status()).toBe(200);
        expect((await request.get(`/embed/${key}`)).status()).toBe(200);

        await page.getByTestId('builder-enabled-toggle').click();
        await expect(page.getByTestId('builder-enabled-dialog')).toContainText(
            'Take this widget offline?',
        );
        await page.getByTestId('builder-enabled-confirm').click();
        await expect(dialog).toBeHidden();
        await expect(status).toContainText('Offline');
        await expect(page.getByTestId('builder-badge-disabled')).toBeVisible();

        // Offline: for visitors the widget does not exist.
        const offline = await publicConfig(request, key, origin);
        expect(offline.status()).toBe(404);
        expect((await offline.json()).error.code).toBe('widget_not_found');
        expect((await request.get(`/w/${key}.js`)).status()).toBe(404);
        expect((await request.get(`/embed/${key}`)).status()).toBe(404);

        await page.reload();
        await expect(page.getByTestId('builder-badge-disabled')).toBeVisible();
    });
});

test.describe('builder: embed codes and the identity secret', () => {
    test('snippets show the right URLs and copy to the clipboard', async ({
        page,
        api,
        context,
        instance,
    }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
            origin: instance.url,
        });
        const { ulid, key } = await newWidget(api);

        await openBuilder(page, ulid, 'embed');

        const script = page.getByTestId('builder-snippet-script');
        await expect(script).toHaveText(
            `<script async src="${instance.url}/w/${key}.js"></script>`,
        );
        await expect(page.getByTestId('builder-snippet-iframe')).toContainText(
            `${instance.url}/embed/${key}?mode=inline`,
        );
        await expect(page.getByTestId('builder-snippet-hosted')).toHaveText(
            `${instance.url}/c/${key}`,
        );

        for (const [id, expected] of [
            ['builder-snippet-script', await script.innerText()],
            ['builder-snippet-hosted', `${instance.url}/c/${key}`],
        ] as const) {
            await page.getByTestId(`${id}-copy`).click();
            await expect(page.getByTestId(`${id}-copy`)).toContainText(
                'Copied',
            );
            expect(
                await page.evaluate(() => navigator.clipboard.readText()),
            ).toBe(expected);
        }

        // The management API serves the same snippets.
        const snippets = (
            await api.ok('GET', `/api/v1/widgets/${ulid}/snippet`)
        ).data;
        expect(snippets.script).toBe(
            `<script async src="${instance.url}/w/${key}.js"></script>`,
        );
        expect(
            Object.keys(snippets.identity_example).sort((a, b) =>
                a.localeCompare(b),
            ),
        ).toEqual(['node', 'php', 'python']);

        // The identity example follows the language switch and names this widget's key.
        const example = page.getByTestId('builder-identity-example');
        await expect(example).toContainText(key);
        await pick(page.getByTestId('builder-panel-embed'), 'Node.js');
        await expect(example).toContainText('createHmac');
        await pick(page.getByTestId('builder-panel-embed'), 'Python');
        await expect(example).toContainText('hmac');
    });

    test('the identity secret is shown once, and never again', async ({
        page,
        api,
    }) => {
        const { ulid } = await newWidget(api);

        await openBuilder(page, ulid, 'embed');
        const status = page.getByTestId('builder-secret-status');
        await expect(status).toContainText('No secret yet');

        // First secret: generated at once and shown in a dialog that does not close by accident.
        await page.getByTestId('builder-rotate-secret').click();
        const dialog = page.getByTestId('builder-secret-dialog');
        await expect(dialog).toBeVisible();
        const first = (await page
            .getByTestId('builder-secret-value')
            .textContent())!.trim();
        expect(first.length).toBeGreaterThanOrEqual(32);
        await page.keyboard.press('Escape');
        await expect(dialog).toBeVisible();
        await page.getByTestId('builder-secret-done').click();
        await expect(dialog).toBeHidden();
        await expect(status).toContainText('Secret configured');
        // Gone from the page: nowhere in the DOM any more.
        await expect(page.locator('body')).not.toContainText(first);

        // A reload shows only that a secret exists; no endpoint returns it.
        await page.reload();
        await goTab(page, 'embed');
        await expect(page.getByTestId('builder-secret-status')).toContainText(
            'Secret configured',
        );
        expect(await page.content()).not.toContain(first);
        const widget = await api.ok('GET', `/api/v1/widgets/${ulid}`);
        expect(widget.data.has_identity_secret).toBe(true);
        expect(JSON.stringify(widget.body)).not.toContain(first);
        expect(
            JSON.stringify((await api.ok('GET', '/api/v1/widgets')).body),
        ).not.toContain(first);
        expect(
            JSON.stringify(
                (await api.ok('GET', `/api/v1/widgets/${ulid}/snippet`)).body,
            ),
        ).not.toContain(first);

        // Rotating asks first, then shows the new one once; the old one is replaced.
        await page.getByTestId('builder-rotate-secret').click();
        await expect(page.getByTestId('builder-rotate-dialog')).toContainText(
            'Rotate the identity secret?',
        );
        await page
            .getByTestId('builder-rotate-dialog')
            .getByRole('button', { name: 'Keep current secret' })
            .click();
        await expect(page.getByTestId('builder-secret-dialog')).toHaveCount(0);

        await page.getByTestId('builder-rotate-secret').click();
        await page.getByTestId('builder-rotate-confirm').click();
        const second = (await page
            .getByTestId('builder-secret-value')
            .textContent())!.trim();
        expect(second).not.toBe(first);
        await page.getByTestId('builder-secret-done').click();

        // The API: the plaintext is in the rotate answer only.
        const rotated = await api.ok(
            'POST',
            `/api/v1/widgets/${ulid}/rotate-secret`,
        );
        expect(Object.keys(rotated.data)).toEqual(['identity_secret']);
        expect(rotated.data.identity_secret).not.toBe(second);
        expect(rotated.headers['cache-control']).toMatch(
            /no-store|no-cache|private/,
        );
    });
});

test.describe('builder: time zones', () => {
    test('a legacy zone name saved earlier shows under its canonical name and round-trips', async ({
        page,
        api,
        request,
        instance,
    }) => {
        // `Asia/Calcutta` is the legacy spelling of `Asia/Kolkata`: the server accepts both.
        const origin = hostOrigin(instance);
        const { ulid, key } = await newWidget(api, {
            name: '',
            domains: [`localhost:${instance.hostPort}`],
            settings: { timezone: 'Asia/Calcutta' },
            enabled: true,
        });
        expect(
            (await api.ok('GET', `/api/v1/widgets/${ulid}`)).data.timezone,
        ).toBe('Asia/Calcutta');

        await openBuilder(page, ulid, 'general');
        const select = page
            .getByTestId('builder-panel-general')
            .getByLabel('Time zone');

        await expect(select).toHaveValue('Asia/Kolkata');
        // Opening alone changes nothing.
        await expect(page.getByTestId('builder-save')).toBeDisabled();

        // Saving another field keeps the widget valid (the zone is sent under the canonical name or stays as it was).
        await page
            .getByTestId('builder-panel-general')
            .getByLabel('Idle timeout')
            .fill('200');
        await save(page);
        const stored = (await api.ok('GET', `/api/v1/widgets/${ulid}`)).data;
        expect(['Asia/Kolkata', 'Asia/Calcutta']).toContain(stored.timezone);
        expect(stored.idle_timeout_minutes).toBe(200);

        // Picking Asia/Kolkata explicitly (after another zone) is accepted and shown after a reload.
        await select.selectOption('Europe/Paris');
        await select.selectOption('Asia/Kolkata');
        await save(page);
        await page.reload();
        await expect(
            page.getByTestId('builder-panel-general').getByLabel('Time zone'),
        ).toHaveValue('Asia/Kolkata');
        expect(
            (await api.ok('GET', `/api/v1/widgets/${ulid}`)).data.timezone,
        ).toBe('Asia/Kolkata');

        // Visitors still get a valid config (the hours use that zone).
        const config = (await (await publicConfig(request, key, origin)).json())
            .data;
        expect(config.availability).toBeDefined();
    });
});
