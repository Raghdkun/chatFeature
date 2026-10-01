/**
 * What the P4 `chat` seed (`SEED_P4` in e2e/global-setup.ts) created in a scenario instance, written to `<instance dir>/seed.json`
 * by `globalSetup` and read by the specs: the widget (public key, ulid), the category ulids and the user ids of the seeded staff.
 *
 * The people are `ADMIN`, `ALICE` (Billing + General) and `BOB` (Sales + General) of `users.ts`; the widget "Acme Storefront" is
 * published and enabled, may run on the instance's customer site (`localhost:<hostPort>`), offers General, Billing and Sales, is open
 * around the clock (`hours.mode = always_online`) and has the routing below. Nothing runs on a timer in this suite (no worker, no
 * scheduler): the deadlines are moved by `ageConversation()` and the sweeps are run by hand (`runSweep()`), see e2e/support/chat-db.ts.
 */
import { readFileSync } from 'node:fs';
import type { Instance } from './scenarios';

export const SEED_WIDGET_NAME = 'Acme Storefront';

/** The routing of the seeded widget: `online` agents at once, `away` agents 20 s after the chat was queued; the queue gives up after 45 s. */
export const SEED_ROUTING = {
    waves: [
        { afterSeconds: 0, statuses: ['online'] },
        { afterSeconds: 20, statuses: ['away'] },
    ],
    wakeOfflineViaPush: false,
    queueTimeoutSeconds: 45,
} as const;

export type SeedCategory = { ulid: string; name: string };

export type ChatSeed = {
    widget: { ulid: string; key: string; name: string };
    categories: {
        general: SeedCategory;
        billing: SeedCategory;
        sales: SeedCategory;
    };
    /** Integer user ids (staff see them as `assignedAgent.id`, `staff.{id}` channels, `agent_id` of a transfer). */
    users: { admin: number; alice: number; bob: number };
};

export const seedPath = (instance: Instance): string =>
    `${instance.dir}/seed.json`;

const cache = new Map<string, ChatSeed>();

/** The seed of a `chat` instance (cached per process: it never changes during a run). */
export function readSeed(instance: Instance): ChatSeed {
    const known = cache.get(instance.key);

    if (known) {
        return known;
    }

    if (instance.seed !== 'chat') {
        throw new Error(`Scenario ${instance.key} has no chat seed.`);
    }

    const seed = JSON.parse(
        readFileSync(seedPath(instance), 'utf8'),
    ) as ChatSeed;

    cache.set(instance.key, seed);

    return seed;
}
