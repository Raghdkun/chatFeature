/**
 * Building blocks of the visitor and lifecycle specs (`e2e/chat/visitor-*.spec.ts`, `lifecycle-*.spec.ts`):
 *
 *  - `test` / `expect`: the suite's `test` plus a `chats` janitor fixture: every conversation a spec tracks is closed by the
 *    administrator when the test ends, so a failed test never leaves an active chat that eats an agent's capacity (max 5) for the
 *    files that run next to it in the same scenario.
 *  - `startQueuedChat()` / `acceptAs()` / `startActiveChat()`: the visitor on the customer site asks for a topic, an agent accepts.
 *  - `createTeam()`: an ISOLATED team for a test (an own category, own agents with own logins, an own widget), so a spec that changes
 *    presence, capacity or routing never touches the seeded Alice / Bob that other files use at the same time. `actors.staffLogin()`
 *    (actors.ts) turns a team member into a browser.
 *
 * Time and the database come from `chat-db.ts` (`ageConversation`, `runSweep`, `readConversationRow`).
 */
import { createWidget, type Api } from './api';
import { test as base, expect } from './test';
import type { Actors, StaffActor, VisitorActor } from './actors';
import { unique } from './helpers';
import { must } from './chat-api';
import { PASSWORD, type TestUser } from './users';
import {
    openCustomerSite,
    type Panel,
    type SiteOptions,
    type StartChatOptions,
} from './panel';
import type { Instance } from './scenarios';

/** Closes whatever a spec left open (an admin may close any unfinished conversation). */
export class Chats {
    private readonly ulids = new Set<string>();

    constructor(private readonly adminApi: Api) {}

    /** Remembers a conversation to clean up; returns its ulid. */
    track(ulid: string | null | undefined): string {
        if (ulid) {
            this.ulids.add(ulid);
        }

        return ulid ?? '';
    }

    async cleanup(): Promise<void> {
        for (const ulid of this.ulids) {
            const found = await this.adminApi.get(
                `/api/v1/conversations/${ulid}`,
            );

            if (
                found.ok &&
                ['queued', 'active', 'ended'].includes(found.data.status)
            ) {
                await this.adminApi.post(`/api/v1/conversations/${ulid}/close`);
            }
        }

        this.ulids.clear();
    }
}

export const test = base.extend<{ chats: Chats }>({
    chats: async ({ adminApi }, use) => {
        const chats = new Chats(adminApi);

        await use(chats);
        await chats.cleanup().catch(() => undefined);
    },
});

export { expect };

export type Flow = {
    visitor: VisitorActor;
    panel: Panel;
    /** The conversation the panel created (`null` when the widget answered `no_agents`). */
    ulid: string;
    ticketNo: string | null;
    status: number;
};

export type QueuedChatOptions = Partial<StartChatOptions> &
    Pick<SiteOptions, 'visitor' | 'identityToken' | 'key'> & {
        /** Another site option (hostile CSS, rtl, ...). */
        site?: Partial<SiteOptions>;
        /** The visitor's browser language and device. */
        locale?: string;
        device?: 'project' | 'desktop';
        /** Reuse a visitor (browser) that already exists. */
        actor?: VisitorActor;
    };

/**
 * A visitor on the customer site opens the widget, walks the pre-chat / topic screens and ends up `queued` (or `offline` when the
 * widget says nobody is there). The conversation is tracked for cleanup.
 */
export async function startQueuedChat(
    actors: Actors,
    instance: Instance,
    chats: Chats,
    options: QueuedChatOptions = {},
): Promise<Flow> {
    const visitor =
        options.actor ??
        (await actors.visitor({
            locale: options.locale,
            device: options.device,
        }));
    const panel = await openCustomerSite(visitor.page, instance, {
        ...options.site,
        key: options.key,
        visitor: options.visitor,
        identityToken: options.identityToken,
        open: true,
    });
    const started = await panel.startChat({
        category: options.category ?? 'billing',
        name: options.name ?? 'Vera Visitor',
        email: options.email,
        phone: options.phone,
        consent: options.consent,
    });

    return {
        visitor,
        panel,
        ulid: chats.track(started.ulid),
        ticketNo: started.ticketNo,
        status: started.status,
    };
}

/** An agent (browser with the inbox open) sees the offer for the chat and accepts it; the visitor's panel turns `active`. */
export async function acceptAs(agent: StaffActor, flow: Flow): Promise<void> {
    await agent.inbox.expectOffer(flow.ulid);
    await agent.inbox.accept(flow.ulid);
    await flow.panel.expectState('active');
}

/** Queued chat + Alice (or whoever) accepts: the common starting point of a conversation spec. */
export async function startActiveChat(
    actors: Actors,
    instance: Instance,
    chats: Chats,
    agent: StaffActor,
    options: QueuedChatOptions = {},
): Promise<Flow> {
    const flow = await startQueuedChat(actors, instance, chats, options);

    await acceptAs(agent, flow);

    return flow;
}

export type TeamMember = TestUser & { id: number };

export type Team = {
    category: { ulid: string; slug: string; name: string };
    agents: TeamMember[];
    widget: { ulid: string; key: string };
};

export type TeamOptions = {
    /** Display names of the agents to create (all serve the team's category). */
    agents: string[];
    /** `max_concurrent_chats` of every agent (default: the product's 5). */
    maxConcurrentChats?: number;
    /** Merged into the team widget's config (`createWidget`'s `config`). */
    config?: Record<string, unknown>;
    /** The widget's settings (`queue_timeout_seconds`, `locale`, ...). */
    settings?: Record<string, unknown>;
    /** Extra categories (names) of the widget next to the team's own: they have no agents. */
    emptyCategories?: string[];
};

/**
 * An isolated team: one category, `agents` (own logins, categories assigned, offline until they set their presence), and a widget
 * that offers the category on the instance's customer site (open around the clock, routing `online` at 0 s + `away` at 20 s,
 * queue timeout 45 s like the seeded widget). Nothing else in the scenario is affected by what this team's agents do.
 */
export async function createTeam(
    adminApi: Api,
    instance: Instance,
    options: TeamOptions,
): Promise<Team> {
    const tag = Math.random().toString(36).slice(2, 8);
    const names = [`Team ${tag}`, ...(options.emptyCategories ?? [])];
    const categories: { ulid: string; slug: string; name: string }[] = [];

    for (const [index, name] of names.entries()) {
        const created = must<{ ulid: string; slug: string; name: string }>(
            await adminApi.post('/api/v1/categories', {
                name: index === 0 ? name : `${name} ${tag}`,
            }),
            `creating category ${name}`,
        );

        categories.push(created);
    }

    const agents: TeamMember[] = [];

    for (const name of options.agents) {
        const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}.${tag}@example.test`;
        const created = must<{ id: number }>(
            await adminApi.post('/api/v1/agents', {
                name: `${name} ${tag}`,
                email,
                password: PASSWORD,
                category_ulids: [categories[0].ulid],
            }),
            `creating agent ${name}`,
        );

        if (options.maxConcurrentChats !== undefined) {
            must(
                await adminApi.patch(`/api/v1/agents/${created.id}`, {
                    max_concurrent_chats: options.maxConcurrentChats,
                }),
                `limiting agent ${name}`,
            );
        }

        agents.push({
            id: created.id,
            name: `${name} ${tag}`,
            email,
            password: PASSWORD,
            kind: 'agent',
        });
    }

    const widget = await createWidget(adminApi, {
        name: unique('Team widget'),
        domains: [`localhost:${instance.hostPort}`],
        categories: categories.map((category) => category.slug),
        settings: {
            offline_mode: 'always_online',
            queue_timeout_seconds: 45,
            ...options.settings,
        },
        config: {
            hours: { mode: 'always_online' },
            routing: {
                waves: [
                    { afterSeconds: 0, statuses: ['online'] },
                    { afterSeconds: 20, statuses: ['away'] },
                ],
                wakeOfflineViaPush: false,
                queueTimeoutSeconds: 45,
            },
            greetings: { enabled: false },
            ...options.config,
        },
    });

    return {
        category: categories[0],
        agents,
        widget: { ulid: widget.ulid, key: widget.key },
    };
}

export type SoloChat = Flow & { agent: StaffActor; team: Team };

/**
 * The common starting point of a conversation spec: an isolated team with one agent (online, inbox open), a visitor who asks for
 * the team's category and the agent who accepts. Nothing else in the scenario can interfere (capacity, presence, offers).
 */
export async function soloChat(
    actors: Actors,
    adminApi: Api,
    instance: Instance,
    chats: Chats,
    options: {
        team?: Partial<TeamOptions>;
        visitor?: QueuedChatOptions;
        agentDevice?: 'project' | 'desktop';
    } = {},
): Promise<SoloChat> {
    const team = await createTeam(adminApi, instance, {
        agents: ['Agent'],
        ...options.team,
    });
    const agent = await actors.staffLogin(team.agents[0], {
        presence: 'online',
        open: '/inbox',
        device: options.agentDevice,
    });
    const flow = await startActiveChat(actors, instance, chats, agent, {
        key: team.widget.key,
        category: team.category.slug,
        name: 'Vera Visitor',
        ...options.visitor,
    });

    return { ...flow, agent, team };
}
