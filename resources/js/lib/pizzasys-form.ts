/**
 * Pure form model for the Auth Portal (pizzasys) environments and role mapping, shared by the
 * setup wizard (`components/setup/step-pizzasys.tsx`) and Settings > Auth. No React, no network.
 *
 * Contract: docs/contracts/auth-pizzasys.md. Rules enforced here are the UX mirror of the server
 * rules (the server stays authoritative): https URLs (http only for localhost, 127.0.0.1 and
 * *.test), service name `[A-Za-z0-9._-]{1,64}`, secrets write-only and omitted when unchanged.
 */
import { LIMITS } from '@/lib/limits';
import type {
    PizzasysEnvironmentData,
    PizzasysEnvKey,
    PizzasysRoles,
    PizzasysSetupData,
} from '@/types/pizzasys';

export const PIZZASYS_ENV_KEYS: readonly PizzasysEnvKey[] = [
    'production',
    'testing',
];

/** The service name pizzasys admins register this app under (see docs/pizzasys-findings.md). */
export const DEFAULT_SERVICE_NAME = 'pne-chat';

export const DEFAULT_ROLES: PizzasysRoles = {
    admin_permission: 'chat.admin',
    agent_permission: 'chat.agent',
    super_roles: ['super-admin'],
};

/** Mirrors `app/Http/Requests/Auth/UpdateAuthEnvironmentRequest.php`: `[A-Za-z0-9._-]{1,64}`. */
const SERVICE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/* -------------------------------------------------------------------------- */
/* Form values                                                                */
/* -------------------------------------------------------------------------- */

/** What the inputs hold. Secrets start empty and are never filled from the server. */
export type EnvFormValues = {
    /** Display name (Settings only; the wizard keeps the server's default labels). */
    label: string;
    base_url: string;
    service_name: string;
    service_token: string;
    nats_url: string;
    nats_token: string;
    /** Settings only: send `nats_token: null` to forget the stored NATS token. */
    clear_nats_token: boolean;
    verify_tls: boolean;
};

export type SetupFormValues = {
    environments: Record<PizzasysEnvKey, EnvFormValues>;
    active_env: PizzasysEnvKey;
    roles: PizzasysRoles;
};

export function environmentValuesFrom(
    data: PizzasysEnvironmentData | null | undefined,
    { suggestServiceName = false }: { suggestServiceName?: boolean } = {},
): EnvFormValues {
    return {
        label: data?.label ?? '',
        base_url: data?.base_url ?? '',
        service_name:
            data?.service_name ??
            (suggestServiceName ? DEFAULT_SERVICE_NAME : ''),
        service_token: '',
        nats_url: data?.nats_url ?? '',
        nats_token: '',
        clear_nats_token: false,
        verify_tls: data?.verify_tls ?? true,
    };
}

export function rolesValuesFrom(
    roles: PizzasysRoles | null | undefined,
): PizzasysRoles {
    return {
        admin_permission:
            roles?.admin_permission ?? DEFAULT_ROLES.admin_permission,
        agent_permission:
            roles?.agent_permission ?? DEFAULT_ROLES.agent_permission,
        super_roles: [...(roles?.super_roles ?? DEFAULT_ROLES.super_roles)],
    };
}

/** Initial wizard form: whatever the install state already holds, never a token. */
export function setupFormValuesFrom(
    pizzasys: PizzasysSetupData | null | undefined,
): SetupFormValues {
    return {
        environments: {
            production: environmentValuesFrom(
                pizzasys?.environments.production,
                {
                    suggestServiceName: true,
                },
            ),
            testing: environmentValuesFrom(pizzasys?.environments.testing),
        },
        active_env: pizzasys?.active_env ?? 'production',
        roles: rolesValuesFrom(pizzasys?.roles),
    };
}

/** Has the user typed anything into this environment (used to treat Testing as optional)? */
export function isEnvironmentFilled(values: EnvFormValues): boolean {
    return [
        values.base_url,
        values.service_name,
        values.service_token,
        values.nats_url,
        values.nats_token,
    ].some((value) => value.trim() !== '');
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

/** Suffix of the translation key `setup.pizzasys.error.<code>`. */
export type ValidationCode =
    | 'required'
    | 'url'
    | 'https'
    | 'service_name'
    | 'token_required'
    | 'token_changed'
    | 'nats_token_changed'
    | 'nats_url'
    | 'permission'
    | 'same_permission'
    | 'role_name'
    | 'role_count'
    | 'active_unconfigured';

export const VALIDATION_CODES: readonly ValidationCode[] = [
    'required',
    'url',
    'https',
    'service_name',
    'token_required',
    'token_changed',
    'nats_token_changed',
    'nats_url',
    'permission',
    'same_permission',
    'role_name',
    'role_count',
    'active_unconfigured',
];

export type EnvFieldName =
    | 'base_url'
    | 'service_name'
    | 'service_token'
    | 'nats_url'
    | 'nats_token';

export type FieldIssues = Record<string, ValidationCode>;

/** http is only acceptable for local development hosts. */
export function isLocalHost(hostname: string): boolean {
    const host = hostname.toLowerCase();

    return (
        host === 'localhost' || host === '127.0.0.1' || host.endsWith('.test')
    );
}

export function checkBaseUrl(raw: string): 'ok' | 'url' | 'https' {
    let url: URL;

    try {
        url = new URL(raw.trim());
    } catch {
        return 'url';
    }

    if (url.protocol === 'https:') {
        return 'ok';
    }

    if (url.protocol === 'http:') {
        return isLocalHost(url.hostname) ? 'ok' : 'https';
    }

    return 'url';
}

/**
 * What the server holds for an environment, as far as the token rules are concerned. (The
 * server hands out flags, never the tokens.)
 */
export type EnvBaseline = Pick<
    PizzasysEnvironmentData,
    | 'base_url'
    | 'service_name'
    | 'nats_url'
    | 'verify_tls'
    | 'has_service_token'
    | 'has_nats_token'
>;

/**
 * Changing where the portal is (address, service name) or turning TLS verification off could point a
 * stored credential at a different party, so the server asks for the service token again
 * ("Re-enter the service token to change the portal address", 422 on `service_token`). Mirrors that
 * so the field is marked required as soon as one of them differs from what is saved. Nothing saved
 * yet: the token is required anyway.
 */
export function serviceTokenRequired(
    values: EnvFormValues,
    saved: EnvBaseline | null | undefined,
): boolean {
    if (!saved?.has_service_token) {
        return false;
    }

    return (
        values.base_url.trim() !== (saved.base_url ?? '').trim() ||
        values.service_name.trim() !== (saved.service_name ?? '').trim() ||
        (!values.verify_tls && saved.verify_tls)
    );
}

/** The same for a stored NATS token when the NATS address is changed to another one (not when it is cleared). */
export function natsTokenRequired(
    values: EnvFormValues,
    saved: EnvBaseline | null | undefined,
): boolean {
    if (!saved?.has_nats_token || values.clear_nats_token) {
        return false;
    }

    const url = values.nats_url.trim();

    return url !== '' && url !== (saved.nats_url ?? '').trim();
}

export function validateEnvironment(
    values: EnvFormValues,
    {
        hasSavedToken,
        saved,
    }: { hasSavedToken: boolean; saved?: EnvBaseline | null },
): Partial<Record<EnvFieldName, ValidationCode>> {
    const issues: Partial<Record<EnvFieldName, ValidationCode>> = {};
    const baseUrl = values.base_url.trim();
    const serviceName = values.service_name.trim();
    const natsUrl = values.nats_url.trim();

    if (baseUrl === '') {
        issues.base_url = 'required';
    } else {
        const verdict = checkBaseUrl(baseUrl);

        if (verdict !== 'ok') {
            issues.base_url = verdict;
        }
    }

    if (serviceName === '') {
        issues.service_name = 'required';
    } else if (
        serviceName.length > LIMITS.serviceNameLength ||
        !SERVICE_NAME_PATTERN.test(serviceName)
    ) {
        issues.service_name = 'service_name';
    }

    if (values.service_token.trim() === '' && !hasSavedToken) {
        issues.service_token = 'token_required';
    } else if (
        values.service_token.trim() === '' &&
        serviceTokenRequired(values, saved)
    ) {
        issues.service_token = 'token_changed';
    }

    if (values.nats_token.trim() === '' && natsTokenRequired(values, saved)) {
        issues.nats_token = 'nats_token_changed';
    }

    if (natsUrl !== '' && /\s/.test(natsUrl)) {
        issues.nats_url = 'nats_url';
    }

    return issues;
}

export function validateRoles(roles: PizzasysRoles): FieldIssues {
    const issues: FieldIssues = {};
    const admin = roles.admin_permission.trim();
    const agent = roles.agent_permission.trim();

    if (admin === '') {
        issues.admin_permission = 'required';
    } else if (admin.length > LIMITS.permissionLength) {
        issues.admin_permission = 'permission';
    }

    if (agent === '') {
        issues.agent_permission = 'required';
    } else if (agent.length > LIMITS.permissionLength) {
        issues.agent_permission = 'permission';
    } else if (admin !== '' && admin === agent) {
        // Admin wins over agent, so one shared name would make every agent an admin.
        issues.agent_permission = 'same_permission';
    }

    if (roles.super_roles.length > LIMITS.maxSuperRoles) {
        issues.super_roles = 'role_count';
    } else if (
        roles.super_roles.some((role) => role.length > LIMITS.superRoleLength)
    ) {
        issues.super_roles = 'role_name';
    }

    return issues;
}

/** Keys an environment form shows next to an input. */
export const ENV_FIELD_KEYS: readonly string[] = [
    'label',
    'base_url',
    'api_prefix',
    'service_name',
    'service_token',
    'nats_url',
    'nats_token',
    'verify_tls',
];

export type EnvProblem = { key: string; message: string };

/**
 * Server errors of one environment that no input shows (a failed connection test, a message about
 * the form as a whole). `prefix` is the path the server puts them under (`environments.production.`
 * in the wizard, nothing in Settings); errors for a known field are left to that field.
 */
export function unplacedEnvironmentErrors(
    errors: Record<string, string>,
    prefix = '',
): EnvProblem[] {
    return Object.entries(errors)
        .filter(
            ([key, message]) =>
                message !== '' &&
                key.startsWith(prefix) &&
                !ENV_FIELD_KEYS.includes(key.slice(prefix.length)),
        )
        .map(([key, message]) => ({ key: key.slice(prefix.length), message }));
}

/** Which environments already have a stored service token (the server's `has_service_token`). */
export type SavedTokens = Record<PizzasysEnvKey, boolean>;

export const NO_SAVED_TOKENS: SavedTokens = {
    production: false,
    testing: false,
};

/** Wizard validation. Keys follow the server's dotted error paths (`environments.testing.base_url`). */
export function validateSetupForm(
    values: SetupFormValues,
    savedTokens: SavedTokens = NO_SAVED_TOKENS,
    baselines: Partial<Record<PizzasysEnvKey, EnvBaseline | null>> = {},
): FieldIssues {
    const issues: FieldIssues = {};

    for (const key of PIZZASYS_ENV_KEYS) {
        const env = values.environments[key];

        // Testing is optional: leave it entirely blank and it is simply not configured.
        if (key === 'testing' && !isEnvironmentFilled(env)) {
            continue;
        }

        const found = validateEnvironment(env, {
            hasSavedToken: savedTokens[key],
            saved: baselines[key],
        });

        for (const [field, code] of Object.entries(found)) {
            issues[`environments.${key}.${field}`] = code;
        }
    }

    Object.assign(issues, validateRoles(values.roles));

    if (
        values.active_env === 'testing' &&
        !isEnvironmentFilled(values.environments.testing)
    ) {
        issues.active_env = 'active_unconfigured';
    }

    return issues;
}

/* -------------------------------------------------------------------------- */
/* Payloads (what goes over the wire)                                         */
/* -------------------------------------------------------------------------- */

export type EnvPayload = {
    base_url: string;
    service_name: string;
    verify_tls: boolean;
    /** Present only when typed: omitting it keeps the stored token. */
    service_token?: string;
    /** `null` clears it. */
    nats_url: string | null;
    nats_token?: string;
};

export type SetupPizzasysPayload = {
    environments: { production: EnvPayload; testing?: EnvPayload };
    active_env: PizzasysEnvKey;
    admin_permission: string;
    agent_permission: string;
    super_roles: string[];
};

export type SettingsEnvironmentPayload = Omit<EnvPayload, 'nats_token'> & {
    label?: string;
    /** `null` forgets the stored token; omitted keeps it. */
    nats_token?: string | null;
};

export type RolesPayload = PizzasysRoles;

export function environmentPayload(values: EnvFormValues): EnvPayload {
    const payload: EnvPayload = {
        base_url: values.base_url.trim(),
        service_name: values.service_name.trim(),
        verify_tls: values.verify_tls,
        nats_url: values.nats_url.trim() === '' ? null : values.nats_url.trim(),
    };
    const token = values.service_token.trim();
    const natsToken = values.nats_token.trim();

    if (token !== '') {
        payload.service_token = token;
    }

    if (natsToken !== '') {
        payload.nats_token = natsToken;
    }

    return payload;
}

export function rolesPayload(roles: PizzasysRoles): RolesPayload {
    return {
        admin_permission: roles.admin_permission.trim(),
        agent_permission: roles.agent_permission.trim(),
        super_roles: addTags([], roles.super_roles.join(',')),
    };
}

/** Body of `POST /setup/pizzasys`: Testing is only sent when something was entered for it. */
export function setupPizzasysPayload(
    values: SetupFormValues,
): SetupPizzasysPayload {
    const environments: SetupPizzasysPayload['environments'] = {
        production: environmentPayload(values.environments.production),
    };

    if (isEnvironmentFilled(values.environments.testing)) {
        environments.testing = environmentPayload(values.environments.testing);
    }

    return {
        environments,
        active_env: values.active_env,
        ...rolesPayload(values.roles),
    };
}

/** Body of `PUT /settings/auth/environments/{key}`. */
export function settingsEnvironmentPayload(
    values: EnvFormValues,
): SettingsEnvironmentPayload {
    const { nats_token: typedNatsToken, ...rest } = environmentPayload(values);
    const payload: SettingsEnvironmentPayload = { ...rest };
    const label = values.label.trim();

    if (label !== '') {
        payload.label = label;
    }

    if (values.clear_nats_token) {
        payload.nats_token = null;
    } else if (typedNatsToken !== undefined) {
        payload.nats_token = typedNatsToken;
    }

    return payload;
}

/** Has the Settings form changed from what the server holds (a typed secret counts)? */
export function isEnvironmentDirty(
    values: EnvFormValues,
    saved: PizzasysEnvironmentData,
): boolean {
    const baseline = environmentValuesFrom(saved);

    return (
        values.service_token.trim() !== '' ||
        values.nats_token.trim() !== '' ||
        values.clear_nats_token ||
        values.label.trim() !== baseline.label.trim() ||
        values.base_url.trim() !== baseline.base_url.trim() ||
        values.service_name.trim() !== baseline.service_name.trim() ||
        values.nats_url.trim() !== baseline.nats_url.trim() ||
        values.verify_tls !== baseline.verify_tls
    );
}

export function areRolesDirty(
    values: PizzasysRoles,
    saved: PizzasysRoles,
): boolean {
    return (
        values.admin_permission.trim() !== saved.admin_permission ||
        values.agent_permission.trim() !== saved.agent_permission ||
        rolesPayload(values).super_roles.join('\n') !==
            saved.super_roles.join('\n')
    );
}

/* -------------------------------------------------------------------------- */
/* Tags (super roles)                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Adds the names in `raw` (comma or newline separated; names may contain spaces) to `list`:
 * trimmed, empty ones dropped, duplicates ignored, order kept.
 */
export function addTags(list: readonly string[], raw: string): string[] {
    const next = [...list];

    for (const part of raw.split(/[,\n]/)) {
        const tag = part.trim();

        if (tag !== '' && !next.includes(tag)) {
            next.push(tag);
        }
    }

    return next;
}

export function removeTag(list: readonly string[], tag: string): string[] {
    return list.filter((entry) => entry !== tag);
}

/* -------------------------------------------------------------------------- */
/* Misc                                                                       */
/* -------------------------------------------------------------------------- */

/** "portal.example.com" for "https://portal.example.com/app"; `null` when not a web URL. */
export function hostOf(value: string | null | undefined): string | null {
    if (!value) {
        return null;
    }

    try {
        const url = new URL(value);

        return url.protocol === 'https:' || url.protocol === 'http:'
            ? url.host
            : null;
    } catch {
        return null;
    }
}

/** Is Testing set up well enough to be chosen as the active environment? */
export function canActivate(env: PizzasysEnvironmentData | undefined): boolean {
    return Boolean(env?.configured && env.has_service_token);
}
