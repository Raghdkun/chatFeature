import { liveWidget } from '../support/loader';
import { PASSWORD } from '../support/users';
import { expect, test } from '../support/test';

/**
 * Several administrators configuring different widgets at the same moment must never see a server error. Replacing the domains,
 * greetings or categories of a widget deletes and re-inserts rows next to each other in an index; two such transactions on
 * MySQL deadlock (error 1213) and one of them used to answer `500 server_error`. The actions retry such a transaction now.
 */
test.use({ scenario: 'p3-widgets' });

test('sixteen administrators configuring widgets in parallel never get a 500', async ({
    adminApi,
    instance,
}) => {
    test.setTimeout(120_000);

    const failures: string[] = [];
    let created = 0;

    await Promise.all(
        Array.from({ length: 16 }, async (_, client) => {
            for (let round = 0; round < 5; round += 1) {
                try {
                    // Name, domains, categories, greetings, draft, publish, enable: every write the builder makes.
                    await liveWidget(adminApi, instance, {
                        name: `Parallel ${client}-${round} ${Math.random().toString(36).slice(2, 7)}`,
                    });
                    created += 1;
                } catch (error) {
                    failures.push(String(error).slice(0, 240));
                }
            }
        }),
    );

    expect(failures).toEqual([]);
    expect(created).toBe(80);
});

test('sixteen agents having their categories assigned at the same moment never get a 500', async ({
    adminApi,
}) => {
    test.setTimeout(120_000);

    const categories = (
        (await adminApi.ok('GET', '/api/v1/categories')).data as {
            ulid: string;
        }[]
    ).map((category) => category.ulid);
    const agents: number[] = [];

    for (let index = 0; index < 16; index += 1) {
        const created = await adminApi.ok('POST', '/api/v1/agents', {
            name: `Parallel Agent ${index}`,
            email: `parallel.${index}.${Math.random().toString(36).slice(2, 8)}@example.test`,
            password: PASSWORD,
        });

        agents.push(created.data.id);
    }

    const failures: string[] = [];

    // Every round gives each agent another half of the categories: deletes and inserts in the same index, all at once.
    await Promise.all(
        agents.map(async (id, index) => {
            for (let round = 0; round < 8; round += 1) {
                const set = categories.filter(
                    (_, position) => (position + round + index) % 2 === 0,
                );
                const answer = await adminApi.patch(
                    `/api/v1/agents/${id}/categories`,
                    { category_ulids: set },
                );

                if (!answer.ok) {
                    failures.push(
                        `${answer.status} ${JSON.stringify(answer.body).slice(0, 160)}`,
                    );
                }
            }
        }),
    );

    expect(failures).toEqual([]);
});
