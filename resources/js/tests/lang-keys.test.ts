import { describe, expect, it } from 'vite-plus/test';
import { CHECK_ORDER } from '@/lib/pizzasys-checks';
import { VALIDATION_CODES } from '@/lib/pizzasys-form';
import type { PortalRequestError } from '@/lib/pizzasys-http';
import type { PortalAdminCode } from '@/types/pizzasys';

const en = Object.values(
    import.meta.glob<Record<string, string>>('/lang/en.json', {
        eager: true,
        import: 'default',
    }),
)[0];

/** Every source file of the Auth Portal UI (wizard steps, Settings > Auth, login, layout). */
const sources = import.meta.glob<string>(
    [
        '/resources/js/components/setup/*.tsx',
        '/resources/js/components/settings/auth/*.tsx',
        '/resources/js/pages/setup/index.tsx',
        '/resources/js/pages/settings/auth.tsx',
        '/resources/js/pages/auth/login.tsx',
        '/resources/js/layouts/settings/layout.tsx',
    ],
    { query: '?raw', import: 'default', eager: true },
);

const staticKeys = (source: string): string[] =>
    [...source.matchAll(/\b(?:t|has)\(\s*'([A-Za-z0-9_.-]+)'/g)].map(
        (match) => match[1],
    );

// Compile-time exhaustiveness: adding a code to the type without listing it here fails tsc.
const REQUEST_ERRORS = {
    network: true,
    forbidden: true,
    session_expired: true,
    throttled: true,
    not_found: true,
    validation: true,
    server: true,
    invalid_response: true,
} satisfies Record<PortalRequestError, true>;

const ADMIN_CODES = {
    invalid: true,
    unavailable: true,
    no_chat_access: true,
    not_admin: true,
} satisfies Record<PortalAdminCode, true>;

/** Keys built from a value at runtime (`t(\`setup.pizzasys.error.${code}\`)`), enumerated. */
const dynamicKeys = (): string[] => {
    const requestErrors = Object.keys(REQUEST_ERRORS);
    const adminCodes = [...Object.keys(ADMIN_CODES), 'unknown'];
    const keys: string[] = [];

    keys.push(...VALIDATION_CODES.map((c) => `setup.pizzasys.error.${c}`));
    keys.push(...CHECK_ORDER.map((c) => `setup.pizzasys.hint.${c}`));
    keys.push(...CHECK_ORDER.map((c) => `setup.pizzasys.check.${c}`));
    keys.push(...requestErrors.map((c) => `setup.pizzasys.test_error.${c}`));
    keys.push(...requestErrors.map((c) => `setup.pizzasys.portal.error.${c}`));
    keys.push(
        ...[...requestErrors, 'rejected'].map(
            (c) => `settings.auth.switch.error.${c}`,
        ),
    );
    keys.push(
        ...adminCodes.flatMap((c) => [
            `setup.pizzasys.portal.problem.${c}.title`,
            `setup.pizzasys.portal.problem.${c}.body`,
        ]),
    );
    keys.push(
        ...['passed', 'warning', 'failed'].map(
            (c) => `setup.pizzasys.test.summary.${c}`,
        ),
        ...['ok', 'warning', 'failed'].map(
            (c) => `setup.pizzasys.test.tone.${c}`,
        ),
        ...['production', 'testing'].flatMap((c) => [
            `setup.pizzasys.env.${c}`,
            `setup.pizzasys.active.${c}_hint`,
        ]),
        ...['pizzasys', 'portal-admin'].map((c) => `setup.pizzasys.steps.${c}`),
        ...['fortify', 'pizzasys'].map((c) => `settings.auth.mode.${c}`),
        ...['ok', 'degraded', 'down', 'unknown'].flatMap((c) => [
            `settings.auth.health.status.${c}`,
            `settings.auth.health.status_hint.${c}`,
        ]),
        ...['disabled', 'connected', 'disconnected', 'unknown'].map(
            (c) => `settings.auth.health.nats_state.${c}`,
        ),
    );

    return keys;
};

describe('Auth Portal translations', () => {
    it('finds the UI sources it scans', () => {
        expect(Object.keys(sources).length).toBeGreaterThan(10);
    });

    it('has English text for every literal key the UI uses', () => {
        const missing: string[] = [];

        for (const [path, source] of Object.entries(sources)) {
            for (const key of staticKeys(source)) {
                if (!(key in en)) {
                    missing.push(`${path.split('/').pop()}: ${key}`);
                }
            }
        }

        expect(missing).toEqual([]);
    });

    it('has English text for every key built at runtime', () => {
        expect(dynamicKeys().filter((key) => !(key in en))).toEqual([]);
    });

    it('keeps the new copy under the Auth Portal prefixes', () => {
        const prefixes = ['setup.pizzasys.', 'auth.portal.', 'settings.auth.'];
        const scanned = new Set<string>([
            ...Object.values(sources).flatMap(staticKeys),
            ...dynamicKeys(),
        ]);
        const portalKeys = [...scanned].filter((key) =>
            prefixes.some((prefix) => key.startsWith(prefix)),
        );

        // A sanity floor: the UI really does use a lot of them.
        expect(portalKeys.length).toBeGreaterThan(80);
    });

    it('never leaves an empty English string', () => {
        expect(
            Object.entries(en)
                .filter(
                    ([key, value]) =>
                        (key.startsWith('setup.pizzasys.') ||
                            key.startsWith('auth.portal.') ||
                            key.startsWith('settings.auth.')) &&
                        value.trim() === '',
                )
                .map(([key]) => key),
        ).toEqual([]);
    });
});
