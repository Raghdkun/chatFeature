import { expect, test } from '../support/test';
import { must, VisitorApi } from '../support/chat-api';
import {
    ageConversation,
    readConversationRow,
    runSweep,
} from '../support/chat-db';
import { openCustomerSite } from '../support/panel';
import { agePresenceRecord, widgetAvailability } from '../support/presence';
import { createWorld } from '../support/world';

/**
 * What presence does to routing and to the visitor (database store): an agent who turned Away by themselves (their tab sat in the
 * background) is offered a chat from the second wave on while an Online colleague is offered it at once; the widget's public availability
 * follows who is reachable (cached for a few seconds, dropped when presence changes); the visitor's panel shows the offline form when nobody
 * is. Time moves by hand: stored timestamps are aged, the second wave is made by `chat:offer-waves`.
 */
test.use({ scenario: 'p5-chat' });

test('an agent who turned Away by themselves is offered the chat in the second wave, an Online colleague at once', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'], ben: ['main'] },
    });
    const ann = await actors.account(world.agents.ann, { open: '/inbox' });
    const ben = await actors.account(world.agents.ben, { open: '/inbox' });

    // Both choose Online in the selector (the automatic status); Ann's tab then sits in the background for six minutes.
    await ann.inbox.tid('presence-go-online').click();
    await ben.inbox.tid('presence-go-online').click();
    await expect(ann.inbox.tid('presence-select')).toHaveValue('online');
    await expect(ben.inbox.tid('presence-select')).toHaveValue('online');
    await agePresenceRecord(instance, world.agents.ann.id, {
        heartbeat: 5,
        visible: 6 * 60,
    });
    await runSweep(instance, 'chat:presence-sweep');
    await expect(ann.inbox.tid('presence-select')).toHaveValue('away');

    const visitor = await VisitorApi.start(instance, { key: world.widget.key });
    const { ulid } = must<{ ulid: string }>(
        await visitor.startChat({
            category: world.categories.main.slug,
            name: 'Wave Wendy',
        }),
        'the visitor starts a chat',
    );

    // Wave one is the Online agents: Ben is offered the chat, Ann (Away) is not.
    await ben.inbox.expectOffer(ulid);
    await ann.inbox.expectNoOffer(ulid);

    // Twenty-five seconds pass: the second wave makes Away agents reachable and Ann is offered it too.
    await ageConversation(instance, ulid, { by: 25 });
    await runSweep(instance, 'chat:offer-waves');
    await ann.inbox.expectOffer(ulid);
    await ben.inbox.expectOffer(ulid);

    const row = await readConversationRow(instance, ulid);

    expect(
        Object.fromEntries(
            row.offers.map((offer) => [offer.user_id, offer.wave]),
        ),
    ).toEqual({
        [world.agents.ben.id]: 1,
        [world.agents.ann.id]: 2,
    });

    // The Away agent can take it, and the chat is hers.
    await ann.inbox.accept(ulid);
    await ben.inbox.expectNoOffer(ulid);

    await visitor.dispose();
});

test('the widget is available while somebody can be offered a chat (Away counts), and the visitor gets the offline form when nobody is reachable', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const key = world.widget.key;
    const ann = await actors.account(world.agents.ann, { open: '/inbox' });
    const select = ann.inbox.tid('presence-select');
    const available = async (): Promise<boolean> =>
        (await widgetAvailability(instance, key)).online;

    // Nobody online yet: the public answer says so, and a visitor who opens the panel is sent to the offline form.
    expect(await available()).toBe(false);

    const early = await actors.visitor();
    const earlyPanel = await openCustomerSite(early.page, instance, {
        key,
        open: true,
    });

    await earlyPanel.expectState('offline');
    await expect(earlyPanel.tid('offline-form')).toBeVisible();

    // Ann goes online: the cached "nobody" is dropped by the status change and the widget opens for chats.
    await ann.inbox.tid('presence-go-online').click();
    await expect(select).toHaveValue('online');
    await expect.poll(available).toBe(true);

    const later = await actors.visitor();
    const laterPanel = await openCustomerSite(later.page, instance, {
        key,
        open: true,
    });

    await laterPanel.expectState(['idle', 'prechat', 'category']);

    // She turns Away by herself: the widget stays available (an Away agent is offered chats from the second wave on)...
    await agePresenceRecord(instance, world.agents.ann.id, {
        heartbeat: 5,
        visible: 6 * 60,
    });
    await runSweep(instance, 'chat:presence-sweep');
    await expect(select).toHaveValue('away');
    expect(await available()).toBe(true);

    // ...and goes dark when she is gone for good: the beats stopped, the sweep announces it, the next visitor meets the offline form.
    await agePresenceRecord(instance, world.agents.ann.id, {
        heartbeat: 100,
        visible: 100,
    });
    await runSweep(instance, 'chat:presence-sweep');
    await expect.poll(available).toBe(false);

    const last = await actors.visitor();
    const lastPanel = await openCustomerSite(last.page, instance, {
        key,
        open: true,
    });

    await lastPanel.expectState('offline');
});
