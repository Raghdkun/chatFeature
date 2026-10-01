import { type Browser, type Page } from '@playwright/test';
import { Api, type Category } from '../support/api';
import { dismiss, openNavigation, unique } from '../support/helpers';
import { expect, test } from '../support/test';
import {
    ADMIN,
    ADMIN_ONLY,
    authStatePath,
    PASSWORD,
    SARA,
    TARIQ,
} from '../support/users';

/**
 * Staff and agents (`/agents`, admin only) in mode 1, the agents' own "My support categories" page, and (tagged `@pizzasys`)
 * what the page looks like when roles come from the Auth Portal. Names, emails and categories are created per test.
 */
test.use({ scenario: 'p3-agents', role: 'admin' });

type Staff = {
    id: number;
    name: string;
    email: string;
    is_admin: boolean;
    is_agent: boolean;
    is_active: boolean;
    category_ulids: string[];
    max_concurrent_chats: number;
    auth_source: string;
};

async function staff(api: Api): Promise<Staff[]> {
    return (await api.ok('GET', '/api/v1/agents')).data as Staff[];
}

async function staffByEmail(api: Api, email: string): Promise<Staff> {
    const found = (await staff(api)).find((member) => member.email === email);

    if (!found) {
        throw new Error(`No staff member ${email}`);
    }

    return found;
}

async function categories(api: Api): Promise<Record<string, Category>> {
    const list = (await api.ok('GET', '/api/v1/categories')).data as Category[];

    return Object.fromEntries(
        list.map((category) => [category.slug, category]),
    );
}

/** A new local agent through the API (setup for tests that are not about creating one). */
async function newAgent(
    api: Api,
    label: string,
    categoryUlids: string[] = [],
): Promise<Staff> {
    const name = unique(label);
    const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@example.test`;
    const created = await api.ok('POST', '/api/v1/agents', {
        name,
        email,
        password: PASSWORD,
        is_agent: true,
        category_ulids: categoryUlids,
    });

    return created.data as Staff;
}

const row = (page: Page, id: number) => page.getByTestId(`agent-row-${id}`);

async function signIn(
    browser: Browser,
    baseURL: string,
    email: string,
    password: string,
) {
    const context = await browser.newContext({
        baseURL,
        storageState: { cookies: [], origins: [] },
    });
    const page = await context.newPage();

    await page.goto('/login');
    await page.locator('#email').fill(email);
    await page.locator('#password').fill(password);
    await page.locator('[data-test="login-button"]').click();

    return { context, page };
}

test.describe('staff list (mode 1)', () => {
    test('shows everyone with roles, categories and the local-account badge, and filters them', async ({
        page,
        api,
    }) => {
        const all = await staff(api);
        const sara = all.find((member) => member.email === SARA.email)!;
        const tariq = all.find((member) => member.email === TARIQ.email)!;
        const khalid = all.find((member) => member.email === ADMIN_ONLY.email)!;
        const amira = all.find((member) => member.email === ADMIN.email)!;

        await page.goto('/agents');
        await expect(page.getByTestId('agents-page')).toBeVisible();
        await expect(page.getByTestId('agents-portal-notice')).toHaveCount(0);
        await expect(page.getByTestId('agent-create')).toBeVisible();

        // Roles: Amira is an admin who takes chats, Khalid an admin who does not, Sara a plain agent.
        await expect(
            page.getByTestId(`agent-badge-admin-${amira.id}`),
        ).toBeVisible();
        await expect(
            page.getByTestId(`agent-badge-agent-${amira.id}`),
        ).toBeVisible();
        await expect(
            page.getByTestId(`agent-badge-admin-${khalid.id}`),
        ).toBeVisible();
        await expect(
            page.getByTestId(`agent-badge-agent-${khalid.id}`),
        ).toHaveCount(0);
        await expect(
            page.getByTestId(`agent-badge-agent-${sara.id}`),
        ).toBeVisible();
        await expect(
            page.getByTestId(`agent-badge-admin-${sara.id}`),
        ).toHaveCount(0);
        await expect(page.getByTestId(`agent-source-${sara.id}`)).toHaveText(
            'Local account',
        );

        // Categories served (Sara: Billing + Sales, Tariq: Technical support).
        await expect(
            page.getByTestId(`agent-categories-${sara.id}`),
        ).toContainText('Billing');
        await expect(
            page.getByTestId(`agent-categories-${sara.id}`),
        ).toContainText('Sales');
        await expect(
            page.getByTestId(`agent-categories-${tariq.id}`),
        ).toContainText('Technical support');
        await expect(
            page.getByTestId(`agent-categories-${khalid.id}`),
        ).toContainText('No categories');
        await expect(page.getByTestId(`agent-max-${sara.id}`)).toHaveValue('5');
        await expect(page.getByTestId('agents-count')).toHaveText(
            `${all.length} agents`,
        );

        // Search by name or email.
        await page.getByTestId('agent-search').fill('sara.ibrahim');
        await expect(page.getByTestId(/^agent-row-/)).toHaveCount(1);
        await expect(row(page, sara.id)).toBeVisible();
        await expect(page.getByTestId('agents-count')).toHaveText(
            `Showing 1 of ${all.length} agents`,
        );
        await page.getByTestId('agent-search').fill('tariq');
        await expect(row(page, tariq.id)).toBeVisible();
        await page.getByTestId('agent-search').fill('nobody-like-this');
        await expect(page.getByTestId('agents-no-match')).toBeVisible();
        await page.getByTestId('agent-search').fill('');

        // Filter by category: only the people who serve it.
        const cats = await categories(api);
        await page
            .getByTestId('agent-filter-category')
            .selectOption(cats.billing.ulid);
        await expect(page.getByTestId(/^agent-row-/)).toHaveCount(1);
        await expect(row(page, sara.id)).toBeVisible();
        await page.getByTestId('agent-filter-category').selectOption('none');
        await expect(row(page, sara.id)).toHaveCount(0);
        await expect(row(page, khalid.id)).toBeVisible();
        await page.getByTestId('agent-filter-category').selectOption('all');

        // Filter by role: admins only, then the people with no role at all (nobody here).
        await page.getByTestId('agent-filter-role').selectOption('admin');
        await expect(row(page, amira.id)).toBeVisible();
        await expect(row(page, khalid.id)).toBeVisible();
        await expect(row(page, sara.id)).toHaveCount(0);
        await page.getByTestId('agent-filter-role').selectOption('none');
        await expect(page.getByTestId('agents-no-match')).toBeVisible();
        await page.getByTestId('agent-filter-role').selectOption('all');
        await expect(row(page, sara.id)).toBeVisible();
    });
});

test.describe('creating staff', () => {
    test('validates the form, creates an agent with categories, who can then sign in', async ({
        page,
        api,
        browser,
        instance,
    }) => {
        const cats = await categories(api);
        const name = unique('New Agent');
        const email = `new.agent.${Date.now().toString(36)}@example.test`;

        await page.goto('/agents');
        await page.getByTestId('agent-create').click();

        const dialog = page.getByTestId('agent-create-dialog');
        await expect(dialog).toBeVisible();

        // Client-side validation: everything is required, the email must be an email, the password 8+ characters.
        await page.getByTestId('agent-create-submit').click();
        await expect(dialog.getByText('Enter a name.')).toBeVisible();
        await expect(
            dialog.getByText('Enter a valid email address.'),
        ).toBeVisible();
        await expect(
            dialog.getByText('Use at least 8 characters.'),
        ).toBeVisible();

        await dialog.getByLabel('Full name').fill(name);
        await dialog.getByLabel('Email address').fill('not-an-email');
        await dialog.getByLabel('Temporary password').fill('short');
        await page.getByTestId('agent-create-submit').click();
        await expect(
            dialog.getByText('Enter a valid email address.'),
        ).toBeVisible();
        await expect(
            dialog.getByText('Use at least 8 characters.'),
        ).toBeVisible();

        // A taken email is refused by the server and shown under the field (SARA already exists).
        await dialog.getByLabel('Email address').fill(SARA.email);
        await dialog.getByLabel('Temporary password').fill(PASSWORD);
        await page.getByTestId('agent-create-submit').click();
        await expect(
            dialog.getByText('The email has already been taken.'),
        ).toBeVisible();
        await expect(dialog).toBeVisible();

        await dialog.getByLabel('Email address').fill(email);
        await page
            .getByTestId(`agent-create-category-${cats.sales.ulid}`)
            .click();
        await page
            .getByTestId(
                `agent-create-category-${cats['technical-support'].ulid}`,
            )
            .click();
        await page.getByTestId('agent-create-submit').click();

        await expect(dialog).toBeHidden();
        await expect(page.getByText(`${name} was added`)).toBeVisible();

        const created = await staffByEmail(api, email);
        expect(created).toMatchObject({
            name,
            is_agent: true,
            is_admin: false,
            is_active: true,
            auth_source: 'local',
        });
        expect(
            [...created.category_ulids].sort((a, b) => a.localeCompare(b)),
        ).toEqual(
            [cats.sales.ulid, cats['technical-support'].ulid].sort((a, b) =>
                a.localeCompare(b),
            ),
        );

        const created$ = row(page, created.id);
        await expect(created$).toBeVisible();
        await expect(
            created$.getByTestId(`agent-categories-${created.id}`),
        ).toContainText('Sales');
        await expect(
            created$.getByTestId(`agent-categories-${created.id}`),
        ).toContainText('Technical support');

        // The new account signs in with the temporary password and lands on the agent dashboard.
        const session = await signIn(browser, instance.url, email, PASSWORD);

        try {
            await expect(session.page).toHaveURL(/\/dashboard$/);
            await expect(
                session.page.getByTestId('dashboard-agent-waiting'),
            ).toBeVisible();
        } finally {
            await session.context.close();
        }
    });

    test('API: the envelope of a created agent, duplicate emails, weak passwords, unknown categories', async ({
        api,
    }) => {
        const email = `shape.${Date.now().toString(36)}@example.test`;

        const created = await api.post('/api/v1/agents', {
            name: 'Shape Agent',
            email,
            password: PASSWORD,
        });
        expect(created.status).toBe(201);
        expect(
            Object.keys(created.data).sort((a, b) => a.localeCompare(b)),
        ).toEqual(
            [
                'auth_source',
                'avatar',
                'category_ulids',
                'email',
                'id',
                'is_active',
                'is_admin',
                'is_agent',
                'last_seen_at',
                'max_concurrent_chats',
                'name',
            ].sort((a, b) => a.localeCompare(b)),
        );
        // Nothing secret is ever part of the answer.
        expect(JSON.stringify(created.body)).not.toMatch(
            /password|remember|two_factor/i,
        );

        const duplicate = await api.post('/api/v1/agents', {
            name: 'Dup',
            email,
            password: PASSWORD,
        });
        expect(duplicate.status).toBe(422);
        expect(duplicate.error?.details?.email).toBeDefined();

        const weak = await api.post('/api/v1/agents', {
            name: 'Weak',
            email: `weak.${email}`,
            password: 'short',
        });
        expect(weak.status).toBe(422);
        expect(weak.error?.details?.password).toBeDefined();

        const unknown = await api.post('/api/v1/agents', {
            name: 'Unknown',
            email: `unknown.${email}`,
            password: PASSWORD,
            category_ulids: ['01ARZ3NDEKTSV4RRFFQ69G5FAV'],
        });
        expect(unknown.status).toBe(422);
        expect(Object.keys(unknown.error?.details ?? {}).join()).toContain(
            'category_ulids',
        );
    });
});

test.describe('category assignment', () => {
    test('is applied at once, persists, and rolls back with a message when the server refuses', async ({
        page,
        api,
    }) => {
        const cats = await categories(api);
        const agent = await newAgent(api, 'Assign Agent');
        const trigger = page.getByTestId(`agent-categories-${agent.id}`);
        const option = (slug: string) =>
            page.getByTestId(
                `agent-category-option-${agent.id}-${cats[slug].ulid}`,
            );

        await page.goto('/agents');
        await expect(trigger).toContainText('No categories');

        // Optimistic: the chip shows up while the request is still in flight.
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        await page.route(
            `**/api/v1/agents/${agent.id}/categories`,
            async (route) => {
                await gate;
                await route.continue();
            },
        );

        await trigger.click();
        await option('billing').click();
        await expect(trigger).toContainText('Billing');
        expect((await staffByEmail(api, agent.email)).category_ulids).toEqual(
            [],
        );

        release();
        await expect
            .poll(
                async () =>
                    (await staffByEmail(api, agent.email)).category_ulids,
            )
            .toEqual([cats.billing.ulid]);
        await page.unroute(`**/api/v1/agents/${agent.id}/categories`);

        await option('sales').click();
        await option('technical-support').click();
        await option('general').click();
        // More than three chips collapse into "+N more".
        await expect(trigger).toContainText('+1 more');
        await expect
            .poll(
                async () =>
                    (await staffByEmail(api, agent.email)).category_ulids
                        .length,
            )
            .toBe(4);
        await dismiss(page);

        await page.reload();
        await expect(
            page.getByTestId(`agent-categories-${agent.id}`),
        ).toContainText('+1 more');

        // A refused change rolls back and says why.
        await page.route(
            `**/api/v1/agents/${agent.id}/categories`,
            async (route) => {
                await route.fulfill({
                    status: 409,
                    contentType: 'application/json',
                    json: { error: { code: 'refused', message: 'Boom.' } },
                });
            },
        );
        await page.getByTestId(`agent-categories-${agent.id}`).click();
        await option('general').click();
        await expect(page.getByText('Boom.').first()).toBeVisible();
        await expect(
            page.getByTestId(
                `agent-category-option-${agent.id}-${cats.general.ulid}`,
            ),
        ).toBeChecked();
        await page.unroute(`**/api/v1/agents/${agent.id}/categories`);

        // Unticking everything clears the set.
        await dismiss(page);
        for (const slug of [
            'billing',
            'sales',
            'technical-support',
            'general',
        ]) {
            await page.getByTestId(`agent-categories-${agent.id}`).click();
            await option(slug).click();
            await dismiss(page);
        }

        await expect
            .poll(
                async () =>
                    (await staffByEmail(api, agent.email)).category_ulids,
            )
            .toEqual([]);
        await expect(
            page.getByTestId(`agent-categories-${agent.id}`),
        ).toContainText('No categories');
    });

    test('an admin who does not take chats cannot be given categories (409 not_an_agent)', async ({
        page,
        api,
    }) => {
        const cats = await categories(api);
        const khalid = await staffByEmail(api, ADMIN_ONLY.email);

        const refused = await api.patch(
            `/api/v1/agents/${khalid.id}/categories`,
            {
                category_ulids: [cats.billing.ulid],
            },
        );
        expect(refused.status).toBe(409);
        expect(refused.error?.code).toBe('not_an_agent');

        // The UI shows the server's explanation and keeps the row as it was.
        await page.goto('/agents');
        await page.getByTestId(`agent-categories-${khalid.id}`).click();
        await page
            .getByTestId(
                `agent-category-option-${khalid.id}-${cats.billing.ulid}`,
            )
            .click();
        await expect(
            page
                .getByText(/does not take chats, so it cannot serve categories/)
                .first(),
        ).toBeVisible();
        await expect(
            page.getByTestId(`agent-categories-${khalid.id}`),
        ).toContainText('No categories');
    });
});

test.describe('roles and status (mode 1)', () => {
    test('"Takes chats" is only offered on admin rows, switching it off drops their categories', async ({
        page,
        api,
    }) => {
        const cats = await categories(api);
        const khalid = await staffByEmail(api, ADMIN_ONLY.email);
        const sara = await staffByEmail(api, SARA.email);
        const amira = await staffByEmail(api, ADMIN.email);

        // Khalid must end as he started (an admin who does not take chats), also when this test fails halfway.
        test.info().annotations.push({
            type: 'restores',
            description: 'Khalid is_agent=false',
        });
        await api.patch(`/api/v1/agents/${khalid.id}`, { is_agent: false });

        await page.goto('/agents');

        // Admin rows have the switch, plain agents never do (agents always take chats).
        await expect(page.getByTestId(`agent-role-${khalid.id}`)).toBeVisible();
        await expect(page.getByTestId(`agent-role-${amira.id}`)).toBeVisible();
        await expect(page.getByTestId(`agent-role-${sara.id}`)).toHaveCount(0);
        await expect(
            page.getByTestId(`agent-role-${khalid.id}`),
        ).not.toBeChecked();
        await expect(page.getByTestId(`agent-role-${amira.id}`)).toBeChecked();

        // Khalid starts taking chats: the Agent badge appears and he can now serve categories.
        await page.getByTestId(`agent-role-${khalid.id}`).click();
        await expect(
            page.getByTestId(`agent-badge-agent-${khalid.id}`),
        ).toBeVisible();
        await expect
            .poll(
                async () =>
                    (await staffByEmail(api, ADMIN_ONLY.email)).is_agent,
            )
            .toBe(true);

        await page.getByTestId(`agent-categories-${khalid.id}`).click();
        await page
            .getByTestId(
                `agent-category-option-${khalid.id}-${cats.sales.ulid}`,
            )
            .click();
        await dismiss(page);
        await expect(
            page.getByTestId(`agent-categories-${khalid.id}`),
        ).toContainText('Sales');
        await expect
            .poll(
                async () =>
                    (await staffByEmail(api, ADMIN_ONLY.email)).category_ulids,
            )
            .toEqual([cats.sales.ulid]);

        // ... and switching it off again drops what he served.
        await page.getByTestId(`agent-role-${khalid.id}`).click();
        await expect(
            page.getByTestId(`agent-badge-agent-${khalid.id}`),
        ).toHaveCount(0);
        await expect
            .poll(
                async () =>
                    (await staffByEmail(api, ADMIN_ONLY.email)).category_ulids,
            )
            .toEqual([]);
        await expect(
            page.getByTestId(`agent-categories-${khalid.id}`),
        ).toContainText('No categories');

        await page.reload();
        await expect(
            page.getByTestId(`agent-role-${khalid.id}`),
        ).not.toBeChecked();

        // The API agrees: a plain agent cannot stop taking chats.
        const refused = await api.patch(`/api/v1/agents/${sara.id}`, {
            is_agent: false,
        });
        expect(refused.status).toBe(422);
        expect(refused.error?.details?.is_agent?.[0]).toBe(
            'Agents always take chats. Deactivate the account instead.',
        );
    });

    test('deactivating an agent locks them out, reactivating lets them back in', async ({
        page,
        api,
        browser,
        instance,
    }) => {
        const agent = await newAgent(api, 'Leaver');

        await page.goto('/agents');
        const toggle = page.getByTestId(`agent-active-${agent.id}`);

        await expect(toggle).toBeChecked();
        await toggle.click();
        await expect(toggle).not.toBeChecked();
        await expect(row(page, agent.id)).toHaveAttribute(
            'data-active',
            'false',
        );
        await expect(row(page, agent.id)).toContainText('Inactive');
        await expect
            .poll(async () => (await staffByEmail(api, agent.email)).is_active)
            .toBe(false);

        await page.reload();
        await expect(
            page.getByTestId(`agent-active-${agent.id}`),
        ).not.toBeChecked();

        // A deactivated account cannot sign in.
        const blocked = await signIn(
            browser,
            instance.url,
            agent.email,
            PASSWORD,
        );

        try {
            await expect(blocked.page).not.toHaveURL(/\/dashboard/);
            await expect(blocked.page).toHaveURL(/\/login/);
        } finally {
            await blocked.context.close();
        }

        await page.getByTestId(`agent-active-${agent.id}`).click();
        await expect(row(page, agent.id)).toHaveAttribute(
            'data-active',
            'true',
        );
        await expect
            .poll(async () => (await staffByEmail(api, agent.email)).is_active)
            .toBe(true);

        const back = await signIn(browser, instance.url, agent.email, PASSWORD);

        try {
            await expect(back.page).toHaveURL(/\/dashboard$/);
        } finally {
            await back.context.close();
        }
    });

    test('an administrator cannot deactivate their own account', async ({
        page,
        api,
    }) => {
        const amira = await staffByEmail(api, ADMIN.email);

        const refused = await api.patch(`/api/v1/agents/${amira.id}`, {
            is_active: false,
        });
        expect(refused.status).toBe(409);
        expect(refused.error?.code).toBe('cannot_deactivate_self');

        await page.goto('/agents');
        await page.getByTestId(`agent-active-${amira.id}`).click();
        await expect(
            page.getByText('You cannot deactivate your own account.').first(),
        ).toBeVisible();
        await expect(
            page.getByTestId(`agent-active-${amira.id}`),
        ).toBeChecked();
        expect((await staffByEmail(api, ADMIN.email)).is_active).toBe(true);
    });

    test('the concurrent-chats limit is saved on Enter or blur and bad values snap back', async ({
        page,
        api,
    }) => {
        const agent = await newAgent(api, 'Limit Agent');
        const input = page.getByTestId(`agent-max-${agent.id}`);

        await page.goto('/agents');
        await expect(input).toHaveValue('5');

        await input.fill('8');
        await input.press('Enter');
        await expect
            .poll(
                async () =>
                    (await staffByEmail(api, agent.email)).max_concurrent_chats,
            )
            .toBe(8);

        await input.fill('3');
        await input.blur();
        await expect
            .poll(
                async () =>
                    (await staffByEmail(api, agent.email)).max_concurrent_chats,
            )
            .toBe(3);

        // Out of range or not a number: nothing is sent, the field snaps back.
        let patches = 0;
        page.on('request', (request) => {
            if (request.method() === 'PATCH') {
                patches += 1;
            }
        });
        await input.fill('99');
        await input.blur();
        await expect(input).toHaveValue('3');
        await input.fill('0');
        await input.blur();
        await expect(input).toHaveValue('3');
        expect(patches).toBe(0);

        await page.reload();
        await expect(page.getByTestId(`agent-max-${agent.id}`)).toHaveValue(
            '3',
        );

        // The server enforces the same range.
        const tooMany = await api.patch(`/api/v1/agents/${agent.id}`, {
            max_concurrent_chats: 99,
        });
        expect(tooMany.status).toBe(422);
        expect(tooMany.error?.details?.max_concurrent_chats).toBeDefined();
    });
});

test.describe('"My support categories" (agent)', () => {
    test.use({ role: 'agent' });

    test('an agent picks categories, they persist and show on the admin Agents page', async ({
        page,
        api,
        browser,
        instance,
    }) => {
        const cats = await categories(api);

        // A leftover of an earlier attempt must not matter.
        await api.ok('PUT', '/api/v1/me/categories', { category_ulids: [] });

        await page.goto('/settings/support-categories');
        await expect(page.getByTestId('support-categories-page')).toBeVisible();
        await expect(
            page.getByTestId('support-categories-not-agent'),
        ).toHaveCount(0);

        const save = page.getByTestId('support-categories-save');
        const check = (slug: string) =>
            page.getByTestId(`support-category-check-${cats[slug].ulid}`);
        const status = page.getByTestId('support-categories-status');

        // Nothing is selected yet and there is nothing to save.
        await expect(status).toContainText('0 categories selected');
        await expect(save).toBeDisabled();

        await check('billing').click();
        await check('technical-support').click();
        await expect(status).toHaveText('You have unsaved changes.');
        await expect(save).toBeEnabled();
        // Where each category is offered is part of the card (the seed has no widget yet).
        await expect(
            page.getByTestId(`support-category-widgets-${cats.billing.ulid}`),
        ).toContainText('Not offered in any widget yet');

        await save.click();
        await expect(page.getByText('Support categories saved')).toBeVisible();
        await expect(status).toHaveText(
            'Saved. You now serve these categories.',
        );
        await expect(save).toBeDisabled();

        await page.reload();
        await expect(check('billing')).toBeChecked();
        await expect(check('technical-support')).toBeChecked();
        await expect(check('sales')).not.toBeChecked();
        await expect(status).toContainText('2 categories selected');

        // The API of the agent ("me") and the admin's view of the same person agree.
        const mine = await api.get('/api/v1/me/categories');
        expect(mine.status).toBe(200);
        expect(
            [...mine.data.category_ulids].sort((a, b) => a.localeCompare(b)),
        ).toEqual(
            [cats.billing.ulid, cats['technical-support'].ulid].sort((a, b) =>
                a.localeCompare(b),
            ),
        );

        const adminContext = await browser.newContext({
            baseURL: instance.url,
            storageState: authStatePath(instance, 'admin'),
        });

        try {
            const admin = await adminContext.newPage();

            await admin.goto('/agents');
            const omar = admin
                .getByTestId(/^agent-row-/)
                .filter({ hasText: 'omar.nasser@example.test' });
            await expect(omar).toContainText('Billing');
            await expect(omar).toContainText('Technical support');
            await expect(omar).not.toContainText('Sales');
        } finally {
            await adminContext.close();
        }

        // Unticking everything is saved as an empty set.
        await check('billing').click();
        await check('technical-support').click();
        await expect(status).toHaveText('You have unsaved changes.');
        await save.click();
        await expect(status).toHaveText(
            'Saved. You now serve these categories.',
        );
        expect((await api.ok('GET', '/api/v1/me/categories')).data).toEqual({
            category_ulids: [],
        });
    });

    test('inactive categories are not offered and the API refuses unknown or admin-only calls', async ({
        page,
        api,
        browser,
        instance,
    }) => {
        // An administrator deactivates a category: agents no longer see it.
        const adminContext = await browser.newContext({
            baseURL: instance.url,
            storageState: authStatePath(instance, 'admin'),
        });
        const name = unique('Hidden topic');
        let hidden: Category;

        try {
            const adminApi = new Api(adminContext.request, instance.url);

            hidden = (
                await adminApi.ok('POST', '/api/v1/categories', {
                    name,
                    is_active: false,
                })
            ).data;
        } finally {
            await adminContext.close();
        }

        await page.goto('/settings/support-categories');
        await expect(
            page.getByTestId(`support-category-check-${hidden.ulid}`),
        ).toHaveCount(0);

        // Unknown categories are a validation error, a deactivated one cannot be served.
        const unknown = await api.put('/api/v1/me/categories', {
            category_ulids: ['01ARZ3NDEKTSV4RRFFQ69G5FAV'],
        });
        expect(unknown.status).toBe(422);

        const inactive = await api.put('/api/v1/me/categories', {
            category_ulids: [hidden.ulid],
        });
        expect(inactive.status).toBe(422);

        // The agent API surface stops at the agent's own data.
        expect((await api.get('/api/v1/agents')).status).toBe(403);
        expect(
            (
                await api.patch('/api/v1/agents/1/categories', {
                    category_ulids: [],
                })
            ).status,
        ).toBe(403);
    });
});

test.describe('an administrator who does not take chats', () => {
    test.use({ role: 'admin-only' });

    test('sees the explanation instead of the picker, with a link to the Agents page', async ({
        page,
        api,
    }) => {
        await page.goto('/settings/support-categories');

        const notice = page.getByTestId('support-categories-not-agent');
        await expect(notice).toContainText('Your account does not take chats');
        await expect(page.getByTestId('support-categories-save')).toHaveCount(
            0,
        );

        await page.getByTestId('support-categories-agents-link').click();
        await expect(page).toHaveURL(/\/agents$/);
        await expect(page.getByTestId('agents-page')).toBeVisible();

        // Saving would be refused anyway.
        const refused = await api.put('/api/v1/me/categories', {
            category_ulids: [],
        });
        expect(refused.status).toBe(403);
    });
});

test.describe('agents are kept out of the admin pages', () => {
    test.use({ role: 'agent' });

    test('no Agents entry, a 403 page and API refusals', async ({
        page,
        api,
    }) => {
        await page.goto('/dashboard');
        const nav = await openNavigation(page);

        await expect(
            nav.getByRole('link', { name: 'Agents', exact: true }),
        ).toHaveCount(0);
        await expect(
            nav.getByRole('link', { name: /support categories/i }),
        ).toHaveCount(0);

        expect((await page.goto('/agents'))?.status()).toBe(403);
        expect((await api.get('/api/v1/agents')).status).toBe(403);
        expect(
            (
                await api.post('/api/v1/agents', {
                    name: 'x',
                    email: 'x@example.test',
                    password: PASSWORD,
                })
            ).status,
        ).toBe(403);
    });
});

/**
 * The Auth Portal (mode 2): roles and activation come from the portal. Needs the pizzasys harness (docs/testing.md).
 */
test.describe('roles from the Auth Portal @pizzasys', () => {
    test.use({ scenario: 'installed-pizzasys', role: 'admin' });

    test('the Agents page says so and its role controls are disabled', async ({
        page,
        api,
    }) => {
        await page.goto('/agents');

        await expect(page.getByTestId('agents-page')).toBeVisible();
        await expect(page.getByTestId('agents-portal-notice')).toContainText(
            'Roles are managed in the Auth Portal',
        );
        // Nothing to create or switch here...
        await expect(page.getByTestId('agent-create')).toHaveCount(0);
        await expect(page.getByTestId(/^agent-role-/)).toHaveCount(0);

        const rows = page.getByTestId(/^agent-row-/);
        await expect(rows.first()).toBeVisible();
        const activeSwitches = page.getByTestId(/^agent-active-/);
        const count = await activeSwitches.count();

        expect(count).toBeGreaterThan(0);

        for (let index = 0; index < count; index += 1) {
            await expect(activeSwitches.nth(index)).toBeDisabled();
        }

        await expect(page.getByTestId(/^agent-source-/).first()).toHaveText(
            'Auth Portal',
        );

        // ... but categories and chat limits are still edited here.
        await expect(
            page.getByTestId(/^agent-categories-/).first(),
        ).toBeEnabled();
        await expect(page.getByTestId(/^agent-max-/).first()).toBeEnabled();

        // The API says the same: no accounts, no activation, no role flags (409 managed_by_auth_portal).
        const listed = (await api.ok('GET', '/api/v1/agents')).data as Staff[];
        const target = listed[0];

        const create = await api.post('/api/v1/agents', {
            name: 'Portal Nope',
            email: 'portal.nope@example.test',
            password: PASSWORD,
        });
        expect(create.status).toBe(409);
        expect(create.error?.code).toBe('managed_by_auth_portal');

        const deactivate = await api.patch(`/api/v1/agents/${target.id}`, {
            is_active: false,
        });
        expect(deactivate.status).toBe(409);
        expect(deactivate.error?.code).toBe('managed_by_auth_portal');

        // Limits stay editable in mode 2.
        const limit = await api.patch(`/api/v1/agents/${target.id}`, {
            max_concurrent_chats: 7,
        });
        expect(limit.status).toBe(200);
        expect(limit.data.max_concurrent_chats).toBe(7);
        expect(
            (
                await api.patch(`/api/v1/agents/${target.id}`, {
                    max_concurrent_chats: 5,
                })
            ).ok,
        ).toBe(true);
    });
});
