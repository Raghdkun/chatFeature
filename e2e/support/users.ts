/**
 * Test-only accounts. Everything here exists only in the throwaway `chatfeature_e2e*` databases.
 *
 * The login form is throttled to 5 attempts a minute per email (Fortify's `login` limiter), so
 * the specs that really type credentials use their own account per project; everything else
 * reuses a saved session (see `authStatePath`).
 */
import { harnessSecrets, roleChangeEmail } from './harness';
import type { Instance } from './scenarios';

/** Shared by every test account. */
export const PASSWORD = 'Correct-Horse-Battery-93';

export type TestUser = {
    name: string;
    email: string;
    password: string;
    kind: 'admin' | 'agent' | 'no-access';
    unverified?: boolean;
};

const account = (
    name: string,
    email: string,
    kind: TestUser['kind'],
    extra: Partial<TestUser> = {},
): TestUser => ({ name, email, password: PASSWORD, kind, ...extra });

/** Created by `chat:install` itself (INSTALL_ADMIN_*), and the admin the wizard specs create. */
export const ADMIN = account(
    'Amira Hassan',
    'amira.hassan@example.test',
    'admin',
);

/** Extra accounts created right after the install. */
export const AGENT = account(
    'Omar Nasser',
    'omar.nasser@example.test',
    'agent',
    { unverified: true },
);

export const NO_ACCESS = account(
    'Lina Karim',
    'lina.karim@example.test',
    'no-access',
);

/** Accounts the login spec types credentials for: one set per project (rate limiting). */
export function loginAccounts(project: 'desktop' | 'mobile') {
    return {
        admin: account(
            `Login Admin ${project}`,
            `login.admin.${project}@example.test`,
            'admin',
        ),
        agent: account(
            `Login Agent ${project}`,
            `login.agent.${project}@example.test`,
            'agent',
            { unverified: true },
        ),
        noAccess: account(
            `Login Guest ${project}`,
            `login.guest.${project}@example.test`,
            'no-access',
        ),
    };
}

/** Everything `globalSetup` creates besides the installer's admin. */
export const EXTRA_USERS: TestUser[] = [
    AGENT,
    NO_ACCESS,
    ...(['desktop', 'mobile'] as const).flatMap((project) =>
        Object.values(loginAccounts(project)),
    ),
];

/** Where the saved session (Playwright storageState) of a role lives for an instance. */
export function authStatePath(
    instance: Instance,
    role: 'admin' | 'agent',
): string {
    return `${instance.authDir}/${role}.json`;
}

/**
 * Mode 2: the accounts of the local pizzasys harness (docs/pizzasys-findings.md). Emails are fixed by the harness,
 * the shared password is read from its `secrets.local.env` at runtime and never written down here.
 */
export type PortalUser = {
    name: string;
    email: string;
    password: string;
    /** What the app should make of this account. */
    expect: 'admin' | 'agent' | 'none';
};

export function portalUsers() {
    const password = harnessSecrets().password;
    const user = (
        name: string,
        email: string,
        expected: PortalUser['expect'],
    ): PortalUser => ({ name, email, password, expect: expected });

    return {
        /** Role `super-admin`, no `chat.*` permission: admin through the "super roles" mapping. */
        admin: user('Test Admin', 'admin@test.local', 'admin'),
        /** Direct permission `chat.admin`. */
        chatAdmin: user('Test Chat Admin', 'chatadmin@test.local', 'admin'),
        /** Direct permission `chat.agent`. */
        agent: user('Test Agent', 'agent@test.local', 'agent'),
        /** `chat.agent` through the role `chat-agent-role`. */
        roleAgent: user('Test Role Agent', 'roleagent@test.local', 'agent'),
        /** No role, no permission. */
        noRole: user('Test NoRole', 'norole@test.local', 'none'),
        /** Only a store-scoped role (invisible to `token-verify`). */
        storeUser: user('Test Store User', 'storeuser@test.local', 'none'),
    };
}

/** Saved sessions of mode-2 scenarios: the portal's `admin@` and `agent@` accounts. */
export function portalSessionUser(role: 'admin' | 'agent'): PortalUser {
    return role === 'admin' ? portalUsers().admin : portalUsers().agent;
}

/** The portal account whose permissions the role-change spec edits (one per project, never shared). */
export function roleChangeAccount(project: 'desktop' | 'mobile') {
    return {
        email: roleChangeEmail(project),
        password: harnessSecrets().password,
    };
}
