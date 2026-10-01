import { type Page } from '@playwright/test';
import { hostPage, widget } from '../support/host';
import { liveWidget } from '../support/loader';
import { expect, test } from '../support/test';
import { PASSWORD } from '../support/users';

/**
 * Everything an administrator types ends up on screen somewhere else: in the dashboard lists and the builder, in the preview and in
 * the widget on the customer's page. HTML in those values must show as text everywhere and never run.
 */
test.use({ scenario: 'p3-host', role: 'admin' });

const PAYLOAD = '<img src=x onerror="window.__xss=1">';
const TAGS =
    '"><svg onload=window.__xss=1></svg><script>window.__xss=1</script>';

async function expectNothingRan(page: Page, label: string): Promise<void> {
    expect(
        await page.evaluate(
            () => (window as unknown as { __xss?: number }).__xss,
        ),
        `${label}: script ran`,
    ).toBeUndefined();
}

test('HTML in names and texts is shown as text in the dashboard and in the widget', async ({
    page,
    browser,
    adminApi,
    instance,
}) => {
    // Unique per attempt: a retry must not meet the leftovers of the attempt before it.
    const RUN = Math.random().toString(36).slice(2, 7);
    const dialogs: string[] = [];

    page.on('dialog', async (dialog) => {
        dialogs.push(dialog.message());
        await dialog.dismiss();
    });

    const category = (
        await adminApi.ok('POST', '/api/v1/categories', {
            name: `${PAYLOAD}Cat ${RUN}`,
            description: `${TAGS} desc`,
            name_i18n: { fr: `${PAYLOAD}Chat` },
        })
    ).data as { ulid: string; slug: string };
    const agent = (
        await adminApi.ok('POST', '/api/v1/agents', {
            name: `${PAYLOAD}Agent ${RUN}`,
            email: `escaping.${Date.now().toString(36)}@example.test`,
            password: PASSWORD,
        })
    ).data as { id: number };
    const { key, ulid } = await liveWidget(adminApi, instance, {
        name: `${PAYLOAD}Widget ${RUN}`,
        categories: ['general', category.slug],
        greetings: [
            {
                body: `${PAYLOAD}${TAGS} hello`,
                agent_name: `${PAYLOAD}Ann`,
                weight: 1,
            },
        ],
        config: {
            launcher: { style: 'pill', label: `${PAYLOAD}Ask` },
            greetings: { delaySeconds: 1, autoHideSeconds: 60 },
            texts: {
                en: { title: `${PAYLOAD}Title`, dismiss: `${PAYLOAD}Close` },
            },
        },
    });

    // The dashboard: lists, dialogs, the builder (every tab) and its live preview.
    await page.goto('/categories');
    await expect(
        page.getByText(`${PAYLOAD}Cat ${RUN}`, { exact: true }),
    ).toBeVisible();
    await expectNothingRan(page, '/categories');
    await page.getByTestId(`category-edit-${category.ulid}`).click();
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue(
        `${PAYLOAD}Cat ${RUN}`,
    );
    await page.keyboard.press('Escape');

    await page.goto('/agents');
    await expect(page.getByTestId(`agent-row-${agent.id}`)).toContainText(
        `${PAYLOAD}Agent ${RUN}`,
    );
    await page.getByTestId(`agent-categories-${agent.id}`).click();
    await expect(
        page.getByTestId(`agent-category-option-${agent.id}-${category.ulid}`),
    ).toBeVisible();
    await expectNothingRan(page, '/agents');

    await page.goto('/widgets');
    await expect(page.getByTestId(`widget-card-${ulid}`)).toContainText(
        `${PAYLOAD}Widget ${RUN}`,
    );
    await expectNothingRan(page, '/widgets');

    await page.goto(`/widgets/${ulid}`);
    await expect(page.getByTestId('builder-title')).toHaveText(
        `${PAYLOAD}Widget ${RUN}`,
    );

    for (const tab of [
        'general',
        'branding',
        'texts',
        'features',
        'greetings',
        'hours',
        'domains',
        'categories',
        'embed',
    ]) {
        await page.getByTestId(`builder-tab-${tab}`).click();
        await expect(page.getByTestId(`builder-panel-${tab}`)).toBeVisible();
    }

    await page.getByTestId('builder-tab-categories').click();
    await expect(
        page.getByTestId(`builder-category-enabled-${category.ulid}`),
    ).toContainText(`${PAYLOAD}Cat ${RUN}`);

    // On a phone the editor and the preview take turns.
    const switcher = page.getByTestId('builder-view-switch');

    if (await switcher.isVisible()) {
        await switcher.getByText('Preview', { exact: true }).click();
    }

    await expect(page.getByTestId('builder-preview-status')).toHaveAttribute(
        'data-loader',
        'ready',
    );
    // The preview's fake site and the real widget inside it ran nothing either.
    await page.waitForTimeout(1500);
    await expectNothingRan(page, 'builder');
    expect(await page.locator('img[src="x"]').count()).toBe(0);
    expect(
        await page
            .frameLocator('[data-testid="builder-preview-iframe"]')
            .locator('img[src="x"]')
            .count(),
    ).toBe(0);
    expect(dialogs).toEqual([]);

    // The widget on a customer's page, as an anonymous visitor.
    const visitor = await browser.newContext({
        storageState: { cookies: [], origins: [] },
    });
    const host = await visitor.newPage();

    host.on('dialog', async (dialog) => {
        dialogs.push(dialog.message());
        await dialog.dismiss();
    });

    try {
        await host.goto(hostPage(instance, { key }));
        const ui = widget(host);

        await expect(ui.launcher).toBeVisible();
        await expect(ui.launcher).toContainText(`${PAYLOAD}Ask`);
        await expect(ui.greeting).toBeVisible({ timeout: 15_000 });
        await expect(ui.greetingBody).toHaveText(`${PAYLOAD}${TAGS} hello`);
        await expect(ui.greetingName).toHaveText(`${PAYLOAD}Ann`);
        await expect(ui.panel).toHaveAttribute('aria-label', `${PAYLOAD}Title`);
        await expect(ui.greetingClose).toHaveAccessibleName(`${PAYLOAD}Close`);
        await host.waitForTimeout(500);
        await expectNothingRan(host, 'host page');
        // Nothing was parsed into elements: no <img>/<svg>/<script> from the payloads inside the widget or the page.
        expect(
            await host.evaluate(
                () =>
                    document.querySelectorAll(
                        'img[src="x"], svg[onload], script:not([src])[nonce]',
                    ).length,
            ),
        ).toBe(0);
        expect(
            await ui.root.evaluate(
                (root) =>
                    root.querySelectorAll('img[src="x"], svg[onload], script')
                        .length,
            ),
        ).toBe(0);
        expect(dialogs).toEqual([]);
    } finally {
        await visitor.close();
    }
});
