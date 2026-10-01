import type { PizzasysSetupData } from '@/types/pizzasys';

/**
 * Props for `pages/setup/index.tsx`. Mirrors docs/contracts/setup-wizard.md and the mode-2
 * additions in docs/contracts/auth-pizzasys.md (`pizzasys` and `portal-admin`).
 */
export type SetupStepKey =
    | 'welcome'
    | 'mode'
    | 'admin'
    | 'pizzasys'
    | 'portal-admin'
    | 'basics'
    | 'run'
    | 'done';

export type SetupMode = 'fortify' | 'pizzasys';

export type SetupStepStatus = 'pending' | 'current' | 'done';

export type SetupStepSummary = {
    key: SetupStepKey;
    label: string;
    status: SetupStepStatus;
};

export type SetupEnvironmentCheck = {
    key: string;
    label: string;
    ok: boolean;
    message?: string;
};

export type SetupDefaults = {
    app_name: string;
    app_url: string;
    locale: string;
    timezone: string;
    idle_timeout_minutes: number;
};

export type SetupRunStatus = 'pending' | 'running' | 'done' | 'failed';

/** Why a run step failed on the client, when the server gave no message of its own. */
export type SetupRunFailureCode =
    | 'network'
    | 'conflict'
    | 'forbidden'
    | 'session_expired'
    | 'throttled'
    | 'server'
    | 'invalid_response';

export type SetupRunRow = {
    key: string;
    label: string;
    status: SetupRunStatus;
    message?: string;
    /** Client-side classification, used to pick a translated message. */
    code?: SetupRunFailureCode;
};

/**
 * Generated from `App\\Data\\Setup\\SetupData` (composer types:generate), widened for the mode-2
 * step keys and the `pizzasys` block until the regenerated type carries them. After the
 * backend merges, this collapses to `App.Data.Setup.SetupData`.
 */
export type SetupState = Omit<
    App.Data.Setup.SetupData,
    'step' | 'steps' | 'pizzasys'
> & {
    step: SetupStepKey;
    steps: SetupStepSummary[];
    /** Non-null only when `mode === 'pizzasys'` (optional here so mode-1 fixtures stay valid). */
    pizzasys?: PizzasysSetupData | null;
};

export type SetupProps = {
    setup: SetupState;
};

/** JSON answer of `POST /setup/run/{step}`. */
export type SetupRunResponse =
    | { status: 'ok'; next: string | null; redirect?: string }
    | { status: 'failed'; message: string };
