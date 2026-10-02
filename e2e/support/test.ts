/**
 * The `test` every spec imports. It adds two options on top of Playwright's own:
 *
 *   test.use({ scenario: 'installed' })  -> baseURL of that scenario's server (per project where the
 *                                          scenario is stateful, see scenarios.ts)
 *   test.use({ role: 'admin' })          -> start with the saved session of that role (installed scenarios;
 *                                          `admin-only` = an administrator who does not take chats, P3 scenarios;
 *                                          `alice` / `bob` = the agents of the P4 `chat` scenarios)
 *
 * P4 (scenarios with a Reverb): the dashboard of a staff `role` connects to the instance's Reverb (the `realtime` shared prop),
 * `actors` builds several people in separate browser contexts for one test (`e2e/support/actors.ts`), `seed` is what the `chat`
 * seed created (`e2e/support/chat-seed.ts`).
 *
 * P6 (`p6-wa`): `openWa` drives the scenario's OpenWA mock (`e2e/support/openwa.ts`).
 */
import { test as base, expect } from '@playwright/test';
import {
    ALL_INSTANCES,
    instanceFor,
    type Instance,
    type ScenarioName,
} from './scenarios';
import { Actors } from './actors';
import { Api } from './api';
import { readSeed, type ChatSeed } from './chat-seed';
import { OpenWaMock } from './openwa';
import { authStatePath, type Role } from './users';

type Options = {
    scenario: ScenarioName | undefined;
    role: Role | undefined;
};

type Fixtures = {
    /** The instance (port, database, state directory) this test talks to. */
    instance: Instance;
    /** The management API with the session of `page` (cookies are shared with the browser context). */
    api: Api;
    /**
     * The management API as the saved administrator, in a context of its own: for specs whose `page` plays an anonymous
     * visitor on a customer's site (no cookies of the dashboard in that browser).
     */
    adminApi: Api;
    /** Several isolated people (visitor, Alice, Bob, admin) for one test; closed, and checked for page errors / 5xx, when it ends. */
    actors: Actors;
    /** `chat` scenarios: the widget key / ulid, category ulids and the staff user ids. */
    seed: ChatSeed;
    /** `p6-wa`: the control client of the scenario's OpenWA mock (call `openWa.reset()` in `beforeEach` for a clean slate). */
    openWa: OpenWaMock;
};

export const test = base.extend<Options & Fixtures>({
    scenario: [undefined, { option: true }],
    role: [undefined, { option: true }],

    instance: async ({ scenario }, use, testInfo) => {
        if (!scenario) {
            throw new Error(
                'Pick a scenario first: test.use({ scenario: "..." }).',
            );
        }

        await use(instanceFor(scenario, testInfo.project.name));
    },

    api: async ({ page, instance }, use) => {
        await use(new Api(page.request, instance.url));
    },

    adminApi: async ({ playwright, instance }, use) => {
        const context = await playwright.request.newContext({
            baseURL: instance.url,
            storageState: authStatePath(instance, 'admin'),
        });

        await use(new Api(context, instance.url));
        await context.dispose();
    },

    actors: async ({ browser, instance }, use, testInfo) => {
        const actors = new Actors(browser, instance, testInfo);

        await use(actors);

        const problems = actors.problems();

        await actors.closeAll();

        // A failing test already says why; a passing one must not hide a crash or a 5xx behind its assertions.
        if (
            testInfo.status === testInfo.expectedStatus &&
            problems.length > 0
        ) {
            throw new Error(
                `Unexpected errors while the test ran:\n${problems.join('\n')}`,
            );
        }
    },

    seed: async ({ instance }, use) => {
        await use(readSeed(instance));
    },

    openWa: async ({ instance }, use) => {
        await use(OpenWaMock.for(instance));
    },

    baseURL: async ({ scenario }, use, testInfo) => {
        await use(
            scenario
                ? instanceFor(scenario, testInfo.project.name).url
                : undefined,
        );
    },

    storageState: async ({ scenario, role }, use, testInfo) => {
        await use(
            scenario && role
                ? authStatePath(
                      instanceFor(scenario, testInfo.project.name),
                      role,
                  )
                : undefined,
        );
    },
});

export { expect, ALL_INSTANCES };
