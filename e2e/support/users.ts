/**
 * Test-only accounts. Everything here exists only in the throwaway `chatfeature_e2e*` databases.
 *
 * The login form is throttled to 5 attempts a minute per email (Fortify's `login` limiter), so
 * the specs that really type credentials use their own account per project; everything else
 * reuses a saved session (see `authStatePath`).
 */
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
