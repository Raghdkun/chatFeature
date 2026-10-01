/**
 * The set-up most staff specs begin with, in one call: a world (`world.ts`), an agent online in the inbox, a visitor on the customer
 * site who has started a chat in the world's category, and, with `accept`, the agent's Accept. Returns everything the test then drives.
 */
import type { Actors, StaffActor, VisitorActor } from './actors';
import type { Api } from './api';
import { openCustomerSite, type Panel } from './panel';
import type { Instance } from './scenarios';
import type { Allowed } from './watch';
import { createWorld, type World, type WorldPlan } from './world';

export type Rig = {
    actors: Actors;
    adminApi: Api;
    instance: Instance;
};

export type ChatRig = {
    world: World;
    /** The agent (`world.agents.ann` unless `agent` says otherwise). */
    agent: StaffActor;
    visitor: VisitorActor;
    panel: Panel;
    ulid: string;
    visitorName: string;
};

export type ChatRigOptions = {
    plan?: WorldPlan;
    /** Use an existing world instead of creating one. */
    world?: World;
    /** Which of the world's agents takes the chat. Default `ann`. */
    agent?: string;
    visitorName?: string;
    /** Accept the offer in the agent's inbox (default true); false leaves the chat queued with the offer showing. */
    accept?: boolean;
    /** The category label of the world to chat about. Default `main`. */
    category?: string;
    email?: string;
    /** Runs on the agent's browser BEFORE the inbox is opened (install a clock, a socket gate, listeners). */
    prepareAgent?: (agent: StaffActor) => Promise<void>;
    /** Runs on the visitor's browser BEFORE the customer site is opened. */
    prepareVisitor?: (visitor: VisitorActor) => Promise<void>;
    /** Console / request problems the actors may have (see `watch.ts`). */
    allowAgent?: Allowed;
    allowVisitor?: Allowed;
};

/** A visitor chat started from the real panel, offered to the agent, and (default) accepted by them. */
export async function startChat(
    rig: Rig,
    options: ChatRigOptions = {},
): Promise<ChatRig> {
    const world =
        options.world ??
        (await createWorld(rig.adminApi, rig.instance, options.plan));
    const label = options.agent ?? 'ann';
    const account = world.agents[label];

    if (!account) {
        throw new Error(`The world has no agent "${label}".`);
    }

    const agent = await rig.actors.account(account, {
        presence: 'online',
        allow: options.allowAgent,
    });

    await options.prepareAgent?.(agent);
    await agent.inbox.goto();

    const visitor = await rig.actors.visitor({ allow: options.allowVisitor });

    await options.prepareVisitor?.(visitor);
    const panel = await openCustomerSite(visitor.page, rig.instance, {
        key: world.widget.key,
        open: true,
    });
    const visitorName = options.visitorName ?? 'Vera Visitor';
    const chat = await panel.startChat({
        category: world.categories[options.category ?? 'main'].slug,
        name: visitorName,
        email: options.email,
    });
    const ulid = chat.ulid;

    if (ulid === null) {
        throw new Error(
            `The panel did not create a conversation (HTTP ${chat.status}).`,
        );
    }

    await agent.inbox.expectOffer(ulid);

    if (options.accept !== false) {
        await agent.inbox.accept(ulid);
        await panel.expectState('active');
    }

    return { world, agent, visitor, panel, ulid, visitorName };
}
