/**
 * The `test` every spec imports. It adds two options on top of Playwright's own:
 *
 *   test.use({ scenario: 'installed' })  -> baseURL of that scenario's server (per project where the
 *                                          scenario is stateful, see scenarios.ts)
 *   test.use({ role: 'admin' })          -> start with the saved session of that role (installed scenarios;
 *                                          `admin-only` = an administrator who does not take chats, P3 scenarios)
 */
import { test as base, expect } from '@playwright/test';
import {
    ALL_INSTANCES,
    instanceFor,
    type Instance,
    type ScenarioName,
} from './scenarios';
import { Api } from './api';
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
