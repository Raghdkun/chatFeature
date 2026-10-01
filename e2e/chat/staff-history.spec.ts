import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import type { Actors, StaffActor } from '../support/actors';
import type { Api } from '../support/api';
import { expect, test } from '../support/test';
import { must, VisitorApi } from '../support/chat-api';
import { ageConversation, runSweep } from '../support/chat-db';
import { openNavigation } from '../support/helpers';
import { shiftConversationDays } from '../support/staff-db';
import { isPhone } from '../support/staff-ui';
import type { Instance } from '../support/scenarios';
import { createWorld, type World } from '../support/world';

/**
 * The administrator's history (`/history`): filters (status, type, category, widget, agent, dates), search by message text AND by the
 * visitor's e-mail / name / phone / ticket number, pagination, the ratings column, and the CSV export (a header row, a row per
 * conversation, formula injection neutralised). Agents get a 403 and no navigation entry. The `p4-staff` scenario is shared by every
 * spec file, so each test scopes the page to its own widget with the widget filter and compares by conversation ulid, never by total.
 */
test.use({ scenario: 'p4-staff' });

const PRECHAT = {
    fields: {
        name: { enabled: true, required: true },
        email: { enabled: true, required: false },
        phone: { enabled: true, required: false },
    },
};

const FORMULA_NAME = "=cmd|' /C calc'!A0";

type Seeded = {
    world: World;
    live: string;
    other: string;
    missed: string;
    ticket: string;
    closedTicket: string;
    ticketNos: Record<string, string>;
};

/** Five conversations in one widget: two rated chats, a missed one, an open ticket and a closed ticket. */
async function seedHistory(
    actors: Actors,
    adminApi: Api,
    instance: Instance,
): Promise<Seeded & { ann: StaffActor; ben: StaffActor }> {
    const world = await createWorld(adminApi, instance, {
        categories: ['main', 'other'],
        agents: { ann: ['main'], ben: ['other'] },
        config: { preChat: PRECHAT },
    });
    const ann = await actors.account(world.agents.ann, { presence: 'online' });
    const ben = await actors.account(world.agents.ben, { presence: 'online' });
    const key = world.widget.key;
    const main = world.categories.main.slug;
    const other = world.categories.other.slug;
    const ticketNos: Record<string, string> = {};

    const finished = async (
        agent: StaffActor,
        category: string,
        visitor: {
            name: string;
            email: string;
            phone?: string;
            message: string;
        },
        rating: { score: number; comment: string },
    ): Promise<string> => {
        const api = await VisitorApi.start(instance, { key });
        const { ulid, ticketNo } = must<{ ulid: string; ticketNo: string }>(
            await api.startChat({ category, ...visitor }),
            `chat of ${visitor.name}`,
        );

        ticketNos[ulid] = ticketNo;
        must(await agent.api.claim(ulid), `${agent.name} claims`);
        must(await agent.api.end(ulid), `${agent.name} ends`);
        must(
            await api.rate(ulid, rating.score, rating.comment),
            `${visitor.name} rates`,
        );
        await api.dispose();

        return ulid;
    };

    const live = await finished(
        ann,
        main,
        {
            name: 'Vera Visitor',
            email: 'vera@example.test',
            message: 'Where is my refund payment?',
        },
        { score: 5, comment: 'Great help' },
    );
    const second = await finished(
        ben,
        other,
        {
            name: 'Omar Order',
            email: 'omar@example.test',
            phone: '+971501234567',
            message: 'I need a tracking number please',
        },
        { score: 2, comment: 'Slow' },
    );

    // A chat nobody accepted before the queue ran out.
    const waiting = await VisitorApi.start(instance, { key });
    const missed = must<{ ulid: string; ticketNo: string }>(
        await waiting.startChat({
            category: main,
            name: 'Mia Missed',
            email: 'mia@example.test',
        }),
        'the chat that is missed',
    );

    ticketNos[missed.ulid] = missed.ticketNo;
    await ageConversation(instance, missed.ulid, { queueExpired: true });
    await runSweep(instance, 'chat:expire-queued');
    await waiting.dispose();

    // An open ticket (its visitor's name starts like a spreadsheet formula) and a ticket Ben answered and closed.
    const first = await VisitorApi.start(instance, { key });
    const ticket = must<{ ulid: string; ticketNo: string }>(
        await first.offlineTicket({
            name: FORMULA_NAME,
            email: 'evil@example.test',
            message: 'Please call me back about the warranty.',
            category: main,
        }),
        'the open ticket',
    );

    ticketNos[ticket.ulid] = ticket.ticketNo;
    await first.dispose();

    const third = await VisitorApi.start(instance, { key });
    const closedTicket = must<{ ulid: string; ticketNo: string }>(
        await third.offlineTicket({
            name: 'Tess Ticket',
            email: 'tess@example.test',
            message: 'What are your closing hours?',
            category: other,
        }),
        'the ticket Ben closes',
    );

    ticketNos[closedTicket.ulid] = closedTicket.ticketNo;
    must(await ben.api.claim(closedTicket.ulid), 'Ben claims the ticket');
    must(await ben.api.close(closedTicket.ulid), 'Ben closes the ticket');
    await third.dispose();

    return {
        world,
        live,
        other: second,
        missed: missed.ulid,
        ticket: ticket.ulid,
        closedTicket: closedTicket.ulid,
        ticketNos,
        ann,
        ben,
    };
}

/** The ulids on screen, whichever layout is showing (a table from `md` up, cards below). */
async function listed(page: Page): Promise<string[]> {
    const ids = await page
        .locator(
            '[data-testid^="history-row-"]:visible, [data-testid^="history-card-"]:visible',
        )
        .evaluateAll((elements) =>
            elements.map((element) =>
                element
                    .getAttribute('data-testid')!
                    .replace(/^history-(row|card)-/, ''),
            ),
        );

    return ids.sort();
}

async function expectListed(page: Page, ulids: string[]): Promise<void> {
    await expect
        .poll(() => listed(page), { message: 'the history rows' })
        .toEqual([...ulids].sort());
}

/** Scopes the page to the widget of the test (everything else in the shared scenario drops out). */
async function scopeToWidget(page: Page, world: World): Promise<void> {
    await page.goto('/history');
    await expect(page.getByTestId('history-page')).toBeVisible();
    await page
        .getByTestId('history-filter-widget')
        .selectOption(world.widget.ulid);
    await expect(page).toHaveURL(new RegExp(`widget=${world.widget.ulid}`));
}

/** A minimal CSV reader (quoted cells, doubled quotes, line breaks inside quotes). */
function parseCsv(text: string): string[][] {
    const out: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let quoted = false;

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];

        if (quoted) {
            if (char === '"' && text[index + 1] === '"') {
                cell += '"';
                index += 1;
            } else if (char === '"') {
                quoted = false;
            } else {
                cell += char;
            }
        } else if (char === '"') {
            quoted = true;
        } else if (char === ',') {
            row.push(cell);
            cell = '';
        } else if (char === '\n' || char === '\r') {
            if (char === '\r' && text[index + 1] === '\n') {
                index += 1;
            }

            row.push(cell);
            out.push(row);
            row = [];
            cell = '';
        } else {
            cell += char;
        }
    }

    if (cell !== '' || row.length > 0) {
        row.push(cell);
        out.push(row);
    }

    return out;
}

test('filters narrow the list by status, type, category, agent and date, and the ratings column shows the scores', async ({
    actors,
    adminApi,
    instance,
}) => {
    const data = await seedHistory(actors, adminApi, instance);
    const { world } = data;
    const admin = await actors.staff('admin');
    const page = admin.page;
    const everything = [
        data.live,
        data.other,
        data.missed,
        data.ticket,
        data.closedTicket,
    ];

    // One conversation is old: three days back (its messages too), for the date filters.
    await shiftConversationDays(instance, data.live, 3, { conversation: true });

    await scopeToWidget(page, world);
    await expectListed(page, everything);
    await expect(page.getByTestId('history-count')).toHaveText(
        'Showing 1 to 5 of 5',
    );

    const select = (id: string, value: string) =>
        page.getByTestId(`history-filter-${id}`).selectOption(value);

    // Status.
    await select('status', 'closed');
    await expectListed(page, [data.live, data.other, data.closedTicket]);
    await select('status', 'missed');
    await expectListed(page, [data.missed]);
    await select('status', 'queued');
    await expectListed(page, [data.ticket]);
    await select('status', '');
    await expectListed(page, everything);

    // Type.
    await select('type', 'offline');
    await expectListed(page, [data.ticket, data.closedTicket]);
    await select('type', 'live');
    await expectListed(page, [data.live, data.other, data.missed]);
    await select('type', '');
    await expectListed(page, everything);

    // Category and agent.
    await select('category', world.categories.main.ulid);
    await expectListed(page, [data.live, data.missed, data.ticket]);
    await select('category', world.categories.other.ulid);
    await expectListed(page, [data.other, data.closedTicket]);
    await select('category', '');
    await expectListed(page, everything);
    await select('agent', String(world.agents.ann.id));
    await expectListed(page, [data.live]);
    await select('agent', String(world.agents.ben.id));
    await expectListed(page, [data.other, data.closedTicket]);
    await page.getByTestId('history-reset').click();
    await expect(page.getByTestId('history-filter-agent')).toHaveValue('');

    // Dates: everything but the old chat is from today; the old one is three days back.
    const day = (offset: number): string =>
        new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

    await scopeToWidget(page, world);
    await page.getByTestId('history-filter-to').fill(day(-1));
    await expectListed(page, [data.live]);
    await page.getByTestId('history-filter-to').fill('');
    await expectListed(page, everything);
    await page.getByTestId('history-filter-from').fill(day(-1));
    await expectListed(page, [
        data.other,
        data.missed,
        data.ticket,
        data.closedTicket,
    ]);
    await page.getByTestId('history-filter-from').fill(day(2));
    await expect(page.getByTestId('history-empty')).toBeVisible();
    await expect(page.getByTestId('history-count')).toHaveText('No results');
    await page.getByTestId('history-filter-from').fill('');
    await page.getByTestId('history-filter-to').fill('');
    await expectListed(page, everything);

    // The ratings column: a star and the score on the rated chats, a dash elsewhere.
    const entry = (ulid: string) =>
        page
            .locator(
                `[data-testid="history-row-${ulid}"]:visible, [data-testid="history-card-${ulid}"]:visible`,
            )
            .first();

    await expect(entry(data.live)).toContainText('5');
    await expect(entry(data.other)).toContainText('2');
    await expect(entry(data.live).getByText('Rated 5 out of 5')).toHaveCount(1);
    await expect(entry(data.other).getByText('Rated 2 out of 5')).toHaveCount(
        1,
    );
    await expect(entry(data.missed).getByText(/Rated \d out of 5/)).toHaveCount(
        0,
    );

    // Each row says who had it and what became of it.
    await expect(entry(data.live)).toContainText('Vera Visitor');
    await expect(entry(data.live)).toContainText('Closed');
    await expect(entry(data.missed)).toContainText('Missed');
    await expect(entry(data.ticket)).toContainText('Waiting');
});

test('search finds a conversation by what was said and by who the visitor is: message text, e-mail, name, phone, ticket number', async ({
    actors,
    adminApi,
    instance,
}) => {
    const data = await seedHistory(actors, adminApi, instance);
    const admin = await actors.staff('admin');
    const page = admin.page;
    const search = page.getByTestId('history-search');

    await scopeToWidget(page, data.world);
    await expectListed(page, [
        data.live,
        data.other,
        data.missed,
        data.ticket,
        data.closedTicket,
    ]);

    const find = async (text: string, ulids: string[]): Promise<void> => {
        await search.fill(text);
        await expectListed(page, ulids);
    };

    // What was said (FULLTEXT on MySQL: every word a prefix, all words required).
    await find('refund', [data.live]);
    await find('tracking number', [data.other]);
    await find('warranty', [data.ticket]);
    await find('closing hours', [data.closedTicket]);
    await find('refund tracking', []);
    await expect(page.getByTestId('history-empty')).toBeVisible();

    // Who the visitor is.
    await find('omar@example', [data.other]);
    await find('Mia Missed', [data.missed]);
    await find('501234', [data.other]);
    await find('evil@example.test', [data.ticket]);
    await find(FORMULA_NAME, [data.ticket]);

    // The ticket number (a part of it).
    await find(data.ticketNos[data.live].slice(-5), [data.live]);

    // Search and filters combine; clearing both brings everything back.
    await find('example.test', [
        data.live,
        data.other,
        data.missed,
        data.ticket,
        data.closedTicket,
    ]);
    await page.getByTestId('history-filter-type').selectOption('offline');
    await expectListed(page, [data.ticket, data.closedTicket]);
    await page.getByTestId('history-reset').click();
    await expect(search).toHaveValue('');
});

test('the CSV export: a header row, one row per conversation of the filter, and formulas neutralised', async ({
    actors,
    adminApi,
    instance,
}, testInfo) => {
    const data = await seedHistory(actors, adminApi, instance);
    const admin = await actors.staff('admin');
    const page = admin.page;
    const everything = [
        data.live,
        data.other,
        data.missed,
        data.ticket,
        data.closedTicket,
    ];

    await scopeToWidget(page, data.world);
    await expectListed(page, everything);

    const download = async (): Promise<string[][]> => {
        const pending = page.waitForEvent('download');

        await page.getByTestId('history-export').click();

        const file = await pending;

        expect(file.suggestedFilename()).toMatch(/\.csv$/);

        const path = testInfo.outputPath(file.suggestedFilename());

        await file.saveAs(path);

        return parseCsv(await readFile(path, 'utf8'));
    };

    const table = await download();
    const [header, ...body] = table;

    expect(header).toEqual([
        'ticket_no',
        'conversation',
        'type',
        'status',
        'widget',
        'category',
        'agent',
        'visitor_name',
        'visitor_email',
        'visitor_verified',
        'created_at',
        'claimed_at',
        'ended_at',
        'closed_at',
        'ended_by',
        'close_reason',
        'messages',
        'rating',
    ]);

    const byUlid = Object.fromEntries(
        body.filter((row) => row.length > 1).map((row) => [row[1], row]),
    );
    const column = (name: string) => header.indexOf(name);

    expect(Object.keys(byUlid).sort()).toEqual([...everything].sort());

    // One row per conversation, with the facts of this widget's seed.
    const rated = byUlid[data.live];

    expect(rated[column('ticket_no')]).toBe(data.ticketNos[data.live]);
    expect(rated[column('type')]).toBe('live');
    expect(rated[column('status')]).toBe('closed');
    expect(rated[column('widget')]).toBe(data.world.widget.name);
    expect(rated[column('category')]).toBe(data.world.categories.main.name);
    expect(rated[column('agent')]).toBe(data.world.agents.ann.name);
    expect(rated[column('visitor_name')]).toBe('Vera Visitor');
    expect(rated[column('visitor_email')]).toBe('vera@example.test');
    expect(rated[column('close_reason')]).toBe('rated');
    expect(rated[column('ended_by')]).toBe('agent');
    expect(rated[column('rating')]).toBe('5');
    expect(Number(rated[column('messages')])).toBeGreaterThanOrEqual(2);
    expect(byUlid[data.other][column('rating')]).toBe('2');
    expect(byUlid[data.missed][column('status')]).toBe('missed');
    expect(byUlid[data.closedTicket][column('type')]).toBe('offline');

    // A visitor name that starts with `=` would run as a formula in a spreadsheet: the cell is prefixed with a quote.
    expect(byUlid[data.ticket][column('visitor_name')]).toBe(
        `'${FORMULA_NAME}`,
    );
    expect(
        Object.values(byUlid).every((row) =>
            row.every(
                (cell) => !/^[=+\-@\t\r]/.test(cell) || cell.startsWith("'"),
            ),
        ),
        'no cell starts like a formula',
    ).toBe(true);

    // The export follows the filters on the page.
    await page.getByTestId('history-filter-status').selectOption('missed');
    await expectListed(page, [data.missed]);

    const filtered = (await download())
        .slice(1)
        .filter((row) => row.length > 1);

    expect(filtered.map((row) => row[1])).toEqual([data.missed]);
});

test('the history is paged 25 at a time, with Previous and Next', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const ulids: string[] = [];

    // 27 tickets, each from a visitor of its own (own network: the per-address ticket budget is 3 a minute).
    for (let start = 0; start < 27; start += 9) {
        const batch = await Promise.all(
            Array.from({ length: 9 }, async (_, offset) => {
                const visitor = await VisitorApi.start(instance, {
                    key: world.widget.key,
                });
                const created = must<{ ulid: string }>(
                    await visitor.offlineTicket({
                        name: `Pager ${start + offset}`,
                        email: `pager${start + offset}@example.test`,
                        message: `Ticket number ${start + offset}`,
                        category: world.categories.main.slug,
                    }),
                    'a ticket',
                );

                await visitor.dispose();

                return created.ulid;
            }),
        );

        ulids.push(...batch);
    }

    const admin = await actors.staff('admin');
    const page = admin.page;

    await scopeToWidget(page, world);
    await expect(page.getByTestId('history-count')).toHaveText(
        'Showing 1 to 25 of 27',
    );
    await expect.poll(async () => (await listed(page)).length).toBe(25);
    await expect(page.getByTestId('history-prev')).toBeDisabled();
    await expect(page.getByTestId('history-pager')).toContainText(
        'Page 1 of 2',
    );

    await page.getByTestId('history-next').click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page.getByTestId('history-count')).toHaveText(
        'Showing 26 to 27 of 27',
    );
    await expect.poll(async () => (await listed(page)).length).toBe(2);
    await expect(page.getByTestId('history-next')).toBeDisabled();

    // The two on page 2 are the oldest tickets (newest first): the page 1 ones are not repeated.
    const second = await listed(page);

    await page.getByTestId('history-prev').click();
    await expect(page.getByTestId('history-count')).toHaveText(
        'Showing 1 to 25 of 27',
    );

    const first = await listed(page);

    expect(first.filter((ulid) => second.includes(ulid))).toEqual([]);
    expect([...first, ...second].sort()).toEqual([...ulids].sort());

    // A filter that leaves one page resets the pager.
    await page.getByTestId('history-search').fill('Pager 7');
    await expect(page.getByTestId('history-count')).toHaveText(
        'Showing 1 to 1 of 1',
    );
});

test('agents have no history: no navigation entry, a 403 page and a 403 export', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const ann = await actors.account(world.agents.ann, { open: '/inbox' });
    const admin = await actors.staff('admin');

    // The navigation: the agent sees Inbox and Offline tickets, the administrator also History.
    for (const [person, history] of [
        [ann, 0],
        [admin, 1],
    ] as const) {
        await person.page.goto('/inbox');

        const navigation = await openNavigation(person.page);

        await expect(
            navigation.getByRole('link', { name: 'Inbox' }).first(),
        ).toBeVisible();
        await expect(
            navigation.getByRole('link', { name: 'History', exact: true }),
        ).toHaveCount(history);

        if (isPhone(person.page)) {
            await person.page.keyboard.press('Escape');
        }
    }

    const response = await ann.page.goto('/history');

    expect(response?.status()).toBe(403);

    const refused = await ann.api.api.get(
        '/api/v1/conversations/export?format=csv',
    );

    expect(refused.status).toBe(403);
    expect(refused.error?.code).toBe('forbidden');
    expect(
        (await admin.api.api.get('/api/v1/conversations/export?format=csv'))
            .status,
    ).toBe(200);
});
