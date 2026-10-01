/**
 * The ONE place that knows the setup wizard URLs (docs/contracts/setup-wizard.md).
 *
 * Wayfinder cannot generate these until the backend routes (`routes/web/setup.php`)
 * are merged, so they are plain strings for now. Every route mirrors the Wayfinder
 * call shape (`route.url`, `route.form()`), which keeps the later swap to
 * `@/actions/App/Http/Controllers/Setup/SetupController` a change to this file only.
 */

export type SetupRunStepKey =
    | 'run-migrations'
    | 'seed-defaults'
    | 'create-admin'
    | 'write-lock';

type FormDefinition = { action: string; method: 'post' };

type SetupFormRoute = {
    url: string;
    method: 'post';
    /** Same shape as Wayfinder's `Controller.method.form()`; spread it onto `<Form>`. */
    form: () => FormDefinition;
};

function formRoute(url: string): SetupFormRoute {
    return {
        url,
        method: 'post',
        form: () => ({ action: url, method: 'post' }),
    };
}

export const setupRoutes = {
    /** GET /setup (name: setup.index) */
    index: { url: '/setup', method: 'get' },
    /** POST /setup/token (setup.token) */
    token: formRoute('/setup/token'),
    /** POST /setup/mode (setup.mode) */
    mode: formRoute('/setup/mode'),
    /** POST /setup/admin (setup.admin) */
    admin: formRoute('/setup/admin'),
    /** POST /setup/basics (setup.basics) */
    basics: formRoute('/setup/basics'),
    /** GET /setup/state (setup.state): JSON snapshot of SetupProps */
    state: { url: '/setup/state', method: 'get' },
    /** POST /setup/run/{step} (setup.run): JSON; `step` is one of {@link SetupRunStepKey}. */
    run: (step: string): string => `/setup/run/${encodeURIComponent(step)}`,
} as const;

/** Where the wizard sends people once the lock is written (`login` route). */
export const LOGIN_URL = '/login';
