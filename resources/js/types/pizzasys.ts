/**
 * Auth mode 2 (pizzasys) payload shapes. Hand-written to match docs/contracts/auth-pizzasys.md
 * until the generated `App.Data.Auth.*` types exist (PHP classes `PizzasysEnvironmentData`,
 * `PizzasysSetupData`, `AuthSettingsData`, `PortalCheckData`, `PortalTestResultData`).
 *
 * After the backend merges: delete this file's duplicates and alias them to the generated types
 * (e.g. `export type AuthSettingsData = App.Data.Auth.AuthSettingsData`). See the report for the
 * exact places.
 */
export type PizzasysEnvKey = 'production' | 'testing';

/** Never carries a secret: only `has_*` flags tell whether one is stored. */
export type PizzasysEnvironmentData = {
    key: PizzasysEnvKey;
    label: string;
    configured: boolean;
    base_url: string | null;
    service_name: string | null;
    has_service_token: boolean;
    nats_url: string | null;
    has_nats_token: boolean;
    verify_tls: boolean;
    last_check_at: string | null;
    last_check_status: 'ok' | 'failed' | null;
    last_check_message: string | null;
};

export type PortalCheckKey =
    | 'reachable'
    | 'service_credential'
    | 'latency'
    | 'nats';

export type PortalCheck = {
    key: PortalCheckKey;
    label: string;
    ok: boolean;
    message?: string;
};

export type PortalTestResult = {
    ok: boolean;
    checks: PortalCheck[];
};

export type PizzasysRoles = {
    admin_permission: string;
    agent_permission: string;
    super_roles: string[];
};

/** `SetupData.pizzasys`: non-null only when the wizard mode is `pizzasys`. */
export type PizzasysSetupData = {
    environments: Record<PizzasysEnvKey, PizzasysEnvironmentData>;
    active_env: PizzasysEnvKey;
    roles: PizzasysRoles;
    /** Last `PortalTestResult.ok` per environment. */
    tested: Record<PizzasysEnvKey, boolean>;
    /** Verified in this wizard run. */
    portal_admin: { name: string; email: string } | null;
};

export type PortalHealthStatus = 'ok' | 'degraded' | 'down' | 'unknown';

export type AuthSettingsData = {
    mode: 'fortify' | 'pizzasys';
    active_env: PizzasysEnvKey;
    /** Both keys, production first. */
    environments: PizzasysEnvironmentData[];
    roles: PizzasysRoles;
    health: {
        portal: PortalHealthStatus;
        circuit_open: boolean;
        last_verify_at: string | null;
        nats: {
            enabled: boolean;
            connected: boolean | null;
            last_event_at: string | null;
        };
    };
};

/** Why `POST /setup/portal-admin` said no. */
export type PortalAdminCode =
    | 'invalid'
    | 'unavailable'
    | 'no_chat_access'
    | 'not_admin';

export type SettingsAuthProps = {
    authSettings: AuthSettingsData;
};
