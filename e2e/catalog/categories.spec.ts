import { type Locator, type Page } from '@playwright/test';
import { openNavigation, unique } from '../support/helpers';
import { expect, test } from '../support/test';
import { type Category } from '../support/api';

/**
 * Support categories (`/categories`, admin only): create, edit (colour, icon, per-language name), search, reorder, deactivate,
 * delete, the 409 for a taken slug, and what agents may (not) do. Every test creates what it needs through the API under a
 * unique name, so tests (and retries) never depend on each other's leftovers.
 */
test.use({ scenario: 'p3-categories', role: 'admin' });

const rows = (page: Page): Locator => page.getByTestId(/^category-row-/);

/** The row of a category, found by its (exact) name. */
const rowOf = (page: Page, name: string): Locator =>
    rows(page).filter({
        has: page.getByRole('heading', { name, exact: true, level: 2 }),
    });

async function make(
    api: import('../support/api').Api,
    name: string,
    extra: Record<string, unknown> = {},
): Promise<Category> {
    return (await api.ok('POST', '/api/v1/categories', { name, ...extra }))
        .data;
}

async function fromApi(
    api: import('../support/api').Api,
    ulid: string,
): Promise<Category & Record<string, unknown>> {
    return (await api.ok('GET', `/api/v1/categories/${ulid}`)).data;
}

test.describe('administrator', () => {
    test('lists the seeded categories with their counts and the admin nav', async ({
        page,
    }) => {
        await page.goto('/categories');

        await expect(page.getByTestId('categories-page')).toBeVisible();
        await expect(
            page.getByRole('heading', { name: 'Categories', level: 1 }),
        ).toBeVisible();

        for (const name of [
            'General',
            'Billing',
            'Sales',
            'Technical support',
        ]) {
            await expect(rowOf(page, name)).toHaveCount(1);
        }

        // Sara serves Billing and Sales, Tariq Technical support (see the seed in e2e/global-setup.ts).
        await expect(rowOf(page, 'Billing')).toContainText('1 agent');
        await expect(rowOf(page, 'Technical support')).toContainText('1 agent');
        await expect(rowOf(page, 'General')).toContainText('0 agents');

        const nav = await openNavigation(page);
        for (const name of ['Widgets', 'Categories', 'Agents']) {
            await expect(
                nav.getByRole('link', { name, exact: true }),
            ).toBeVisible();
        }
    });

    test('creates a category with colour, icon and a translated name', async ({
        page,
        api,
    }) => {
        const name = unique('Shipping');

        await page.goto('/categories');
        await page.getByTestId('category-create').click();

        const dialog = page.getByTestId('category-dialog');
        await expect(dialog).toBeVisible();

        // A name is required (client-side check, nothing is sent).
        await page.getByTestId('category-submit').click();
        await expect(dialog.getByText('Enter a name.')).toBeVisible();

        await dialog.getByLabel('Name', { exact: true }).fill(name);

        // The slug follows the name until the admin types one.
        const slug = dialog.getByLabel('Slug');
        await expect(slug).toHaveValue(/^shipping-[a-z0-9]{5}$/);

        await dialog
            .getByLabel('Description')
            .fill('Delivery times and tracking.');
        await dialog.getByRole('button', { name: '#e11d48' }).click();
        await expect(
            dialog.getByRole('button', { name: '#e11d48' }),
        ).toHaveAttribute('aria-pressed', 'true');
        await dialog.getByTitle('Shipping', { exact: true }).click();

        await page.getByTestId('category-add-translation').click();
        await dialog.getByLabel('Language code of translation 1').fill('ar');
        await dialog.getByLabel('Name in translation 1').fill('الشحن');

        await page.getByTestId('category-submit').click();

        await expect(dialog).toBeHidden();
        await expect(page.getByText(`Saved ${name}`)).toBeVisible();

        const row = rowOf(page, name);
        await expect(row).toHaveCount(1);
        await expect(row).toContainText('Delivery times and tracking.');
        await expect(row).toContainText('0 agents');
        await expect(row).toContainText('0 widgets');

        // What was stored: the contract's CategoryData, with the colour, icon and the per-locale name.
        const list = await api.ok('GET', '/api/v1/categories');
        const created = (list.data as Category[]).find((c) => c.name === name);

        expect(created).toMatchObject({
            color: '#e11d48',
            icon: 'truck',
            is_active: true,
            description: 'Delivery times and tracking.',
            name_i18n: { ar: 'الشحن' },
            agents_count: 0,
            widgets_count: 0,
        });
        expect(created?.slug).toMatch(/^shipping-[a-z0-9]{5}$/);

        // And it survives a reload.
        await page.reload();
        await expect(rowOf(page, name)).toContainText(
            'Delivery times and tracking.',
        );
    });

    test('edits colour, icon and the per-language names and keeps them', async ({
        page,
        api,
    }) => {
        const name = unique('Returns');
        const category = await make(api, name, {
            color: '#0f766e',
            icon: 'package',
        });

        await page.goto('/categories');
        await page.getByTestId(`category-edit-${category.ulid}`).click();

        const dialog = page.getByTestId('category-dialog');
        await expect(
            dialog.getByRole('heading', { name: 'Edit category' }),
        ).toBeVisible();
        await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue(
            name,
        );
        // Editing keeps the slug: it is not regenerated from the changed name.
        await expect(dialog.getByLabel('Slug')).toHaveValue(category.slug);

        const renamed = `${name} desk`;
        await dialog.getByLabel('Name', { exact: true }).fill(renamed);
        await expect(dialog.getByLabel('Slug')).toHaveValue(category.slug);

        await dialog.getByRole('button', { name: '#7c3aed' }).click();
        await dialog.getByTitle('Quick help', { exact: true }).click();

        await page.getByTestId('category-add-translation').click();
        await dialog.getByLabel('Language code of translation 1').fill('fr');
        await dialog.getByLabel('Name in translation 1').fill('Retours');
        await page.getByTestId('category-add-translation').click();
        await dialog.getByLabel('Language code of translation 2').fill('fr');
        await dialog.getByLabel('Name in translation 2').fill('Retour');

        // The same language twice is refused before anything is sent.
        await page.getByTestId('category-submit').click();
        await expect(
            dialog.getByText('This language is already listed.'),
        ).toBeVisible();

        await dialog.getByLabel('Language code of translation 2').fill('de');
        await dialog.getByLabel('Name in translation 2').fill('Rücksendungen');
        await page.getByTestId('category-submit').click();

        await expect(dialog).toBeHidden();
        await expect(rowOf(page, renamed)).toHaveCount(1);

        const stored = await fromApi(api, category.ulid);
        expect(stored).toMatchObject({
            name: renamed,
            slug: category.slug,
            color: '#7c3aed',
            icon: 'zap',
            name_i18n: { fr: 'Retours', de: 'Rücksendungen' },
        });

        await page.reload();
        await page.getByTestId(`category-edit-${category.ulid}`).click();
        await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue(
            renamed,
        );
        await expect(
            dialog.getByRole('button', { name: '#7c3aed' }),
        ).toHaveAttribute('aria-pressed', 'true');
        // The database keeps the JSON keys sorted: `de` before `fr`.
        await expect(
            dialog.getByLabel('Language code of translation 1'),
        ).toHaveValue('de');
        await expect(dialog.getByLabel('Name in translation 1')).toHaveValue(
            'Rücksendungen',
        );
        await expect(
            dialog.getByLabel('Language code of translation 2'),
        ).toHaveValue('fr');
        await expect(dialog.getByLabel('Name in translation 2')).toHaveValue(
            'Retours',
        );
    });

    test('searches by name, slug and description', async ({ page, api }) => {
        const tag = unique('Zebra').replace(' ', '-').toLowerCase();
        const one = await make(api, `Alpha ${tag}`, {
            description: 'first topic',
        });
        await make(api, `Beta ${tag}`, { description: 'needle in here' });

        await page.goto('/categories');
        const search = page.getByTestId('category-search');

        await search.fill(tag);
        await expect(rows(page)).toHaveCount(2);

        await search.fill(`beta ${tag}`);
        await expect(rows(page)).toHaveCount(1);
        await expect(rows(page).first()).toContainText(`Beta ${tag}`);

        // The slug and the description are searched too.
        await search.fill(one.slug);
        await expect(rowOf(page, `Alpha ${tag}`)).toHaveCount(1);
        await search.fill('needle in here');
        await expect(rowOf(page, `Beta ${tag}`)).toHaveCount(1);

        // Reordering only makes sense on the full list.
        await expect(
            rows(page)
                .first()
                .getByRole('button', { name: /Move .* down/ }),
        ).toBeDisabled();

        await search.fill('no-such-category-xyz');
        await expect(page.getByTestId('categories-no-match')).toContainText(
            'No category matches "no-such-category-xyz".',
        );

        await search.fill('');
        await expect(rows(page).first()).toBeVisible();
        expect(await rows(page).count()).toBeGreaterThanOrEqual(6);
    });

    test('reorders with the up/down buttons and the order persists', async ({
        page,
        api,
    }) => {
        const a = await make(api, unique('Order A'));
        const b = await make(api, unique('Order B'));
        const c = await make(api, unique('Order C'));

        await page.goto('/categories');

        const order = async () =>
            (
                await rows(page).evaluateAll((items) =>
                    items.map((item) => item.getAttribute('data-testid')),
                )
            ).map((id) => id?.replace('category-row-', ''));
        const tail = async () => (await order()).slice(-3);

        await expect.poll(tail).toEqual([a.ulid, b.ulid, c.ulid]);

        // Count the PATCHes of a move: a move swaps two sort orders.
        let saved = 0;
        page.on('response', (response) => {
            if (
                response.request().method() === 'PATCH' &&
                response.url().includes('/api/v1/categories/') &&
                response.ok()
            ) {
                saved += 1;
            }
        });

        await page.getByTestId(`category-move-up-${c.ulid}`).click();
        await expect.poll(tail).toEqual([a.ulid, c.ulid, b.ulid]);
        await expect.poll(() => saved).toBeGreaterThanOrEqual(2);
        await expect(
            page.getByTestId(`category-move-up-${c.ulid}`),
        ).toBeEnabled();

        await page.getByTestId(`category-move-down-${a.ulid}`).click();
        await expect.poll(tail).toEqual([c.ulid, a.ulid, b.ulid]);
        await expect(
            page.getByTestId(`category-move-down-${a.ulid}`),
        ).toBeEnabled();

        // Persisted: after a reload and from the API (which sorts by sort_order).
        await page.reload();
        await expect.poll(tail).toEqual([c.ulid, a.ulid, b.ulid]);

        const listed = (await api.ok('GET', '/api/v1/categories'))
            .data as Category[];
        expect(listed.map((category) => category.ulid).slice(-3)).toEqual([
            c.ulid,
            a.ulid,
            b.ulid,
        ]);
        // Sort orders are distinct (a tie would make the order depend on the database).
        expect(
            new Set(listed.map((category) => category.sort_order)).size,
        ).toBe(listed.length);
    });

    test('deactivates and reactivates a category', async ({ page, api }) => {
        const name = unique('Seasonal');
        const category = await make(api, name);

        await page.goto('/categories');
        const row = rowOf(page, name);
        const toggle = page.getByTestId(`category-active-${category.ulid}`);

        await expect(toggle).toBeChecked();
        await toggle.click();
        await expect(toggle).not.toBeChecked();
        await expect(row.getByText('Inactive', { exact: true })).toBeVisible();
        await expect
            .poll(async () => (await fromApi(api, category.ulid)).is_active)
            .toBe(false);

        await page.reload();
        await expect(
            rowOf(page, name).getByText('Inactive', { exact: true }),
        ).toBeVisible();

        await page.getByTestId(`category-active-${category.ulid}`).click();
        await expect(
            rowOf(page, name).getByText('Inactive', { exact: true }),
        ).toBeHidden();
        await expect
            .poll(async () => (await fromApi(api, category.ulid)).is_active)
            .toBe(true);
    });

    test('deletes a category after confirming', async ({ page, api }) => {
        const name = unique('Obsolete');
        const category = await make(api, name);

        await page.goto('/categories');
        await page.getByTestId(`category-delete-${category.ulid}`).click();

        const dialog = page.getByTestId('category-delete-dialog');
        await expect(dialog).toContainText(`Delete ${name}?`);
        await expect(dialog).toContainText(
            'It is served by 0 agents and offered in 0 widgets',
        );

        // Cancelling keeps it.
        await dialog.getByRole('button', { name: 'Keep category' }).click();
        await expect(dialog).toBeHidden();
        await expect(rowOf(page, name)).toHaveCount(1);

        await page.getByTestId(`category-delete-${category.ulid}`).click();
        await page.getByTestId('category-delete-confirm').click();

        await expect(dialog).toBeHidden();
        await expect(page.getByText('Category deleted')).toBeVisible();
        await expect(rowOf(page, name)).toHaveCount(0);

        const gone = await api.get(`/api/v1/categories/${category.ulid}`);
        expect(gone.status).toBe(404);
        expect(gone.error?.code).toBe('not_found');

        await page.reload();
        await expect(rowOf(page, name)).toHaveCount(0);
    });

    test('a category in use cannot be deleted and offers to deactivate it instead', async ({
        page,
        api,
    }) => {
        // Chats arrive in P4; until then nothing is "in use". The server's answer for that case is simulated so the dialog's
        // path is covered (the 409 shape is the contract: docs/contracts/rest-shapes.md).
        const name = unique('Busy');
        const category = await make(api, name);

        await page.route(
            `**/api/v1/categories/${category.ulid}`,
            async (route) => {
                if (route.request().method() === 'DELETE') {
                    await route.fulfill({
                        status: 409,
                        contentType: 'application/json',
                        json: {
                            error: {
                                code: 'category_in_use',
                                message:
                                    'An active conversation uses this category.',
                            },
                        },
                    });

                    return;
                }

                await route.continue();
            },
        );

        await page.goto('/categories');
        await page.getByTestId(`category-delete-${category.ulid}`).click();
        await page.getByTestId('category-delete-confirm').click();

        const notice = page.getByTestId('category-in-use-notice');
        await expect(notice).toContainText('This category is in use');
        await expect(
            page.getByTestId('category-delete-confirm'),
        ).toBeDisabled();

        await page.getByTestId('category-deactivate-instead').click();
        await expect(page.getByTestId('category-delete-dialog')).toBeHidden();
        await expect(
            rowOf(page, name).getByText('Inactive', { exact: true }),
        ).toBeVisible();
        await expect
            .poll(async () => (await fromApi(api, category.ulid)).is_active)
            .toBe(false);
    });

    test('a taken slug is refused with a readable message', async ({
        page,
        api,
    }) => {
        const name = unique('Billing copy');

        // API: a taken slug is a field error (422); the 409 `slug_taken` is only the answer of a lost race (below).
        const taken = await api.post('/api/v1/categories', {
            name,
            slug: 'billing',
        });
        expect(taken.status).toBe(422);
        expect(taken.error?.code).toBe('validation_failed');
        expect(taken.error?.details?.slug).toEqual([
            'The slug has already been taken.',
        ]);

        // UI: the field error sits under the slug input.
        await page.goto('/categories');
        await page.getByTestId('category-create').click();

        const dialog = page.getByTestId('category-dialog');
        await dialog.getByLabel('Name', { exact: true }).fill(name);
        await dialog.getByLabel('Slug').fill('billing');
        await page.getByTestId('category-submit').click();

        await expect(
            dialog.getByText('The slug has already been taken.'),
        ).toBeVisible();
        await expect(dialog).toBeVisible();
        await expect(rowOf(page, name)).toHaveCount(0);

        // A malformed slug is caught on the client.
        await dialog.getByLabel('Slug').fill('Not A Slug!');
        await page.getByTestId('category-submit').click();
        await expect(
            dialog.getByText(
                'Use lowercase letters, numbers and single dashes.',
            ),
        ).toBeVisible();

        // The race: two admins pick the same slug, the loser gets `409 slug_taken` and the dialog shows its message.
        await page.route('**/api/v1/categories', async (route) => {
            if (route.request().method() === 'POST') {
                await route.fulfill({
                    status: 409,
                    contentType: 'application/json',
                    json: {
                        error: {
                            code: 'slug_taken',
                            message:
                                'This slug is already used by another category.',
                        },
                    },
                });

                return;
            }

            await route.continue();
        });
        await dialog.getByLabel('Slug').fill('race-slug');
        await page.getByTestId('category-submit').click();
        await expect(page.getByTestId('category-form-error')).toContainText(
            'This slug is already used by another category.',
        );
        await page.unroute('**/api/v1/categories');

        // Fix it: the category is created.
        await dialog
            .getByLabel('Slug')
            .fill(`billing-copy-${Date.now().toString(36)}`);
        await page.getByTestId('category-submit').click();
        await expect(dialog).toBeHidden();
        await expect(rowOf(page, name)).toHaveCount(1);
    });

    test('API envelopes: { data } on success, { error: { code, details } } on failure', async ({
        api,
    }) => {
        const listed = await api.get('/api/v1/categories');
        expect(listed.status).toBe(200);
        expect(Array.isArray(listed.body.data)).toBe(true);
        expect(
            Object.keys(listed.body.data[0]).sort((a, b) => a.localeCompare(b)),
        ).toEqual(
            [
                'agents_count',
                'color',
                'description',
                'icon',
                'is_active',
                'name',
                'name_i18n',
                'slug',
                'sort_order',
                'ulid',
                'widgets_count',
            ].sort((a, b) => a.localeCompare(b)),
        );
        // Public identifiers only: no integer primary keys.
        expect(JSON.stringify(listed.body)).not.toMatch(/"id":/);

        const invalid = await api.post('/api/v1/categories', { name: '' });
        expect(invalid.status).toBe(422);
        expect(invalid.error?.code).toBe('validation_failed');
        expect(invalid.error?.details?.name?.length).toBeGreaterThan(0);

        const badColor = await api.post('/api/v1/categories', {
            name: unique('Bad colour'),
            color: 'red',
        });
        expect(badColor.status).toBe(422);
        expect(badColor.error?.details).toHaveProperty('color');

        const missing = await api.get(
            '/api/v1/categories/01ARZ3NDEKTSV4RRFFQ69G5FAV',
        );
        expect(missing.status).toBe(404);
        expect(missing.error?.code).toBe('not_found');

        const created = await api.post('/api/v1/categories', {
            name: unique('Shape'),
        });
        expect(created.status).toBe(201);
        expect(created.data).toMatchObject({
            is_active: true,
            agents_count: 0,
        });
    });
});

test.describe('agent', () => {
    test.use({ role: 'agent' });

    test('has no admin navigation and is turned away from /categories', async ({
        page,
        api,
    }) => {
        await page.goto('/dashboard');
        await expect(page.getByTestId('dashboard-agent-waiting')).toBeVisible();

        const nav = await openNavigation(page);
        for (const name of ['Widgets', 'Categories', 'Agents']) {
            await expect(
                nav.getByRole('link', { name, exact: true }),
            ).toHaveCount(0);
        }

        const response = await page.goto('/categories');
        expect(response?.status()).toBe(403);
        await expect(page.getByTestId('categories-page')).toHaveCount(0);

        // The API: reading the list is open to every staff member, anything else is admin only.
        const listed = await api.get('/api/v1/categories');
        expect(listed.status).toBe(200);

        const write = await api.post('/api/v1/categories', {
            name: unique('Nope'),
        });
        expect(write.status).toBe(403);
        expect(write.error?.code).toBe('forbidden');

        const existing = (listed.data as Category[])[0].ulid;
        expect((await api.get(`/api/v1/categories/${existing}`)).status).toBe(
            403,
        );
        expect(
            (
                await api.patch(`/api/v1/categories/${existing}`, {
                    name: 'Hacked',
                })
            ).status,
        ).toBe(403);
        expect(
            (await api.delete(`/api/v1/categories/${existing}`)).status,
        ).toBe(403);

        for (const path of ['/widgets', '/agents']) {
            expect((await page.goto(path))?.status()).toBe(403);
        }
    });
});
