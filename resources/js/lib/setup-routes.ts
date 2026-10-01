/**
 * The ONE place that knows the setup wizard URLs (docs/contracts/setup-wizard.md).
 *
 * Thin adapter over the generated Wayfinder actions so call sites keep a stable shape
 * (`route.url` string, `route.form()` for `<Form>`, `run(step)`), and Wayfinder owns the URLs.
 */
import SetupController from '@/actions/App/Http/Controllers/Setup/SetupController';
import { login } from '@/routes';

export type SetupRunStepKey =
    | 'run-migrations'
    | 'seed-defaults'
    | 'create-admin'
    | 'write-lock';

/** "/setup" (Wayfinder knows any base path); the mode-2 URLs hang off it. */
const SETUP_BASE = SetupController.index.url().replace(/\/$/, '');

export const setupRoutes = {
    /** GET /setup (name: setup.index) */
    index: { url: SetupController.index.url(), method: 'get' },
    /** POST /setup/token (setup.token) */
    token: {
        url: SetupController.token.url(),
        method: 'post',
        form: () => SetupController.token.form(),
    },
    /** POST /setup/mode (setup.mode) */
    mode: {
        url: SetupController.mode.url(),
        method: 'post',
        form: () => SetupController.mode.form(),
    },
    /** POST /setup/admin (setup.admin) */
    admin: {
        url: SetupController.admin.url(),
        method: 'post',
        form: () => SetupController.admin.form(),
    },
    /** POST /setup/basics (setup.basics) */
    basics: {
        url: SetupController.basics.url(),
        method: 'post',
        form: () => SetupController.basics.form(),
    },
    /**
     * Mode 2 (docs/contracts/auth-pizzasys.md). Plain strings on purpose: the controller does not
     * exist until track 2A merges. After that, swap these three for `SetupController.<action>.url()`
     * (this object is the only place that changes).
     */
    /** POST /setup/pizzasys: environments + roles + active environment (Inertia post, redirects). */
    pizzasys: { url: `${SETUP_BASE}/pizzasys`, method: 'post' },
    /** POST /setup/pizzasys/test: JSON `PortalTestResult` for the SAVED environment `{ env }`. */
    pizzasysTest: { url: `${SETUP_BASE}/pizzasys/test`, method: 'post' },
    /** POST /setup/portal-admin: JSON, `{ email, password }`. */
    portalAdmin: { url: `${SETUP_BASE}/portal-admin`, method: 'post' },
    /** GET /setup/state (setup.state): JSON snapshot of SetupProps */
    state: { url: SetupController.state.url(), method: 'get' },
    /** POST /setup/run/{step} (setup.run): JSON; `step` is one of {@link SetupRunStepKey}. */
    run: (step: string): string => SetupController.run.url({ step }),
} as const;

/** Where the wizard sends people once the lock is written (`login` route). */
export const LOGIN_URL = login.url();
