import { describe, expect, it } from 'vite-plus/test';
import {
    addTags,
    areRolesDirty,
    canActivate,
    checkBaseUrl,
    DEFAULT_ROLES,
    DEFAULT_SERVICE_NAME,
    environmentPayload,
    environmentValuesFrom,
    hostOf,
    isEnvironmentDirty,
    isEnvironmentFilled,
    isLocalHost,
    natsTokenRequired,
    removeTag,
    rolesPayload,
    serviceTokenRequired,
    setupFormValuesFrom,
    setupPizzasysPayload,
    settingsEnvironmentPayload,
    unplacedEnvironmentErrors,
    validateEnvironment,
    validateRoles,
    validateSetupForm,
    type EnvFormValues,
    type SetupFormValues,
} from '@/lib/pizzasys-form';
import type { PizzasysEnvironmentData } from '@/types/pizzasys';

const savedEnv = (
    key: 'production' | 'testing',
    overrides: Partial<PizzasysEnvironmentData> = {},
): PizzasysEnvironmentData => ({
    key,
    label: key === 'production' ? 'Production' : 'Testing',
    configured: true,
    base_url: `https://${key}.example.com`,
    service_name: 'pne-chat',
    has_service_token: true,
    nats_url: null,
    has_nats_token: false,
    verify_tls: true,
    last_check_at: null,
    last_check_status: null,
    last_check_message: null,
    ...overrides,
});

const blankEnv = (key: 'production' | 'testing'): PizzasysEnvironmentData =>
    savedEnv(key, {
        configured: false,
        base_url: null,
        service_name: null,
        has_service_token: false,
    });

const values = (overrides: Partial<EnvFormValues> = {}): EnvFormValues => ({
    ...environmentValuesFrom(null),
    base_url: 'https://auth.example.com',
    service_name: 'pne-chat',
    service_token: 'secret-token',
    ...overrides,
});

describe('base URL rules', () => {
    it('accepts https anywhere and http only for local development hosts', () => {
        expect(checkBaseUrl('https://auth.example.com')).toBe('ok');
        expect(checkBaseUrl('http://localhost:8000')).toBe('ok');
        expect(checkBaseUrl('http://127.0.0.1:8201')).toBe('ok');
        expect(checkBaseUrl('http://pizzasys.test')).toBe('ok');
        expect(checkBaseUrl('http://auth.example.com')).toBe('https');
    });

    it('rejects things that are not web addresses', () => {
        expect(checkBaseUrl('auth.example.com')).toBe('url');
        expect(checkBaseUrl('ftp://auth.example.com')).toBe('url');
        expect(checkBaseUrl('javascript:alert(1)')).toBe('url');
        expect(checkBaseUrl('')).toBe('url');
    });

    it('recognises local hosts case-insensitively', () => {
        expect(isLocalHost('LOCALHOST')).toBe(true);
        expect(isLocalHost('app.Test')).toBe(true);
        expect(isLocalHost('testing.example.com')).toBe(false);
    });
});

describe('environment form values', () => {
    it('never prefills a secret, only the non-secret fields the server holds', () => {
        const form = environmentValuesFrom(
            savedEnv('production', {
                nats_url: 'nats://nats.example.com:4222',
            }),
        );

        expect(form.service_token).toBe('');
        expect(form.nats_token).toBe('');
        expect(form.clear_nats_token).toBe(false);
        expect(form.base_url).toBe('https://production.example.com');
        expect(form.nats_url).toBe('nats://nats.example.com:4222');
    });

    it('suggests the default service name for a fresh Production only', () => {
        const form = setupFormValuesFrom(null);

        expect(form.environments.production.service_name).toBe(
            DEFAULT_SERVICE_NAME,
        );
        expect(form.environments.testing.service_name).toBe('');
        expect(form.active_env).toBe('production');
        expect(form.roles).toEqual(DEFAULT_ROLES);
    });

    it('treats Testing as unconfigured until something is typed for it', () => {
        expect(isEnvironmentFilled(environmentValuesFrom(null))).toBe(false);
        expect(
            isEnvironmentFilled({
                ...environmentValuesFrom(null),
                verify_tls: false,
            }),
        ).toBe(false);
        expect(
            isEnvironmentFilled({
                ...environmentValuesFrom(null),
                base_url: 'https://t.example.com',
            }),
        ).toBe(true);
    });
});

describe('environment validation', () => {
    it('passes a complete environment', () => {
        expect(validateEnvironment(values(), { hasSavedToken: false })).toEqual(
            {},
        );
    });

    it('requires address, service name and (unless one is saved) a token', () => {
        const issues = validateEnvironment(
            values({ base_url: ' ', service_name: '', service_token: '' }),
            { hasSavedToken: false },
        );

        expect(issues).toEqual({
            base_url: 'required',
            service_name: 'required',
            service_token: 'token_required',
        });
    });

    it('does not ask for the token again when one is stored', () => {
        expect(
            validateEnvironment(values({ service_token: '' }), {
                hasSavedToken: true,
            }),
        ).toEqual({});
    });

    it('explains why an address or service name is wrong', () => {
        const issues = validateEnvironment(
            values({
                base_url: 'http://auth.example.com',
                service_name: 'bad name!',
                nats_url: 'nats://a b',
            }),
            { hasSavedToken: false },
        );

        expect(issues).toEqual({
            base_url: 'https',
            service_name: 'service_name',
            nats_url: 'nats_url',
        });
    });

    it('accepts the service name alphabet and rejects 65 characters', () => {
        const ok = (name: string) =>
            validateEnvironment(values({ service_name: name }), {
                hasSavedToken: false,
            }).service_name;

        expect(ok('pne-chat_2.prod')).toBeUndefined();
        expect(ok('a'.repeat(64))).toBeUndefined();
        expect(ok('a'.repeat(65))).toBe('service_name');
    });
});

describe('token re-entry (the server asks for it when the portal address changes)', () => {
    const saved = savedEnv('production');

    it('is not needed while nothing that points at the portal differs', () => {
        expect(serviceTokenRequired(values({ service_token: '' }), null)).toBe(
            false,
        );
        expect(
            serviceTokenRequired(
                values({
                    base_url: ' https://production.example.com ',
                    service_token: '',
                }),
                saved,
            ),
        ).toBe(false);
        // Label and NATS address are not part of the rule for the service token.
        expect(
            serviceTokenRequired(
                {
                    ...environmentValuesFrom(saved),
                    label: 'Other',
                    nats_url: 'nats://x:4222',
                },
                saved,
            ),
        ).toBe(false);
    });

    it('is needed for a different address, a different service name and TLS verification turned off', () => {
        const same = environmentValuesFrom(saved);

        expect(
            serviceTokenRequired(
                { ...same, base_url: 'https://x.test' },
                saved,
            ),
        ).toBe(true);
        expect(
            serviceTokenRequired({ ...same, service_name: 'other' }, saved),
        ).toBe(true);
        expect(
            serviceTokenRequired({ ...same, verify_tls: false }, saved),
        ).toBe(true);
    });

    it('is not needed when nothing is stored yet (the token is simply required) or TLS goes back on', () => {
        const same = environmentValuesFrom(saved);

        expect(
            serviceTokenRequired(
                { ...same, base_url: 'https://x.test' },
                savedEnv('production', { has_service_token: false }),
            ),
        ).toBe(false);
        expect(
            serviceTokenRequired(
                { ...same, verify_tls: true },
                savedEnv('production', { verify_tls: false }),
            ),
        ).toBe(false);
    });

    it('asks for a stored NATS token only when the NATS address changes to another one', () => {
        const withNats = savedEnv('production', {
            nats_url: 'nats://a:4222',
            has_nats_token: true,
        });
        const same = environmentValuesFrom(withNats);

        expect(natsTokenRequired(same, withNats)).toBe(false);
        expect(
            natsTokenRequired({ ...same, nats_url: 'nats://b:4222' }, withNats),
        ).toBe(true);
        expect(natsTokenRequired({ ...same, nats_url: '' }, withNats)).toBe(
            false,
        );
        expect(
            natsTokenRequired(
                { ...same, nats_url: 'nats://b:4222', clear_nats_token: true },
                withNats,
            ),
        ).toBe(false);
        // No stored token: nothing to re-enter.
        expect(
            natsTokenRequired(
                { ...same, nats_url: 'nats://b:4222' },
                savedEnv('production', {
                    nats_url: 'nats://a:4222',
                    has_nats_token: false,
                }),
            ),
        ).toBe(false);
        expect(natsTokenRequired(same, null)).toBe(false);
    });

    it('validateEnvironment reports a missing re-entered token, but not when it is typed', () => {
        const moved = {
            ...environmentValuesFrom(saved),
            base_url: 'https://moved.example.com',
        };

        expect(
            validateEnvironment(moved, { hasSavedToken: true, saved }),
        ).toEqual({ service_token: 'token_changed' });
        expect(
            validateEnvironment(
                { ...moved, service_token: 'again' },
                { hasSavedToken: true, saved },
            ),
        ).toEqual({});
        // Without a baseline (old callers) the behaviour is unchanged.
        expect(validateEnvironment(moved, { hasSavedToken: true })).toEqual({});
        expect(
            validateEnvironment(
                { ...moved, service_token: '' },
                { hasSavedToken: false, saved: blankEnv('production') },
            ),
        ).toEqual({ service_token: 'token_required' });
    });

    it('validateSetupForm uses the baselines per environment', () => {
        const form = setupFormValuesFrom({
            environments: {
                production: saved,
                testing: blankEnv('testing'),
            },
            active_env: 'production',
            roles: DEFAULT_ROLES,
            tested: { production: false, testing: false },
            portal_admin: null,
        });

        form.environments.production.base_url = 'https://moved.example.com';

        expect(
            validateSetupForm(
                form,
                { production: true, testing: false },
                { production: saved },
            ),
        ).toEqual({
            'environments.production.service_token': 'token_changed',
        });
    });
});

describe('errors no input shows', () => {
    it('keeps what is not a field of the environment (a failed check, a form message)', () => {
        expect(
            unplacedEnvironmentErrors({
                base_url: 'x',
                service_token: 'y',
                reachable: 'Could not connect.',
                connection: 'Timed out.',
                nats_token: 'z',
            }),
        ).toEqual([
            { key: 'reachable', message: 'Could not connect.' },
            { key: 'connection', message: 'Timed out.' },
        ]);
    });

    it("reads the wizard's nested paths per environment", () => {
        const errors = {
            'environments.production.base_url': 'x',
            'environments.production.service_credential': 'Rejected.',
            'environments.testing.reachable': 'Down.',
            active_env: 'x',
        };

        expect(
            unplacedEnvironmentErrors(errors, 'environments.production.'),
        ).toEqual([{ key: 'service_credential', message: 'Rejected.' }]);
        expect(
            unplacedEnvironmentErrors(errors, 'environments.testing.'),
        ).toEqual([{ key: 'reachable', message: 'Down.' }]);
    });

    it('ignores empty messages', () => {
        expect(unplacedEnvironmentErrors({ reachable: '' })).toEqual([]);
    });
});

describe('role validation', () => {
    it('accepts the defaults', () => {
        expect(validateRoles(DEFAULT_ROLES)).toEqual({});
    });

    it('requires both permission names', () => {
        expect(
            validateRoles({
                admin_permission: ' ',
                agent_permission: '',
                super_roles: [],
            }),
        ).toEqual({
            admin_permission: 'required',
            agent_permission: 'required',
        });
    });

    it('refuses one name for both roles, which would make every agent an admin', () => {
        expect(
            validateRoles({
                admin_permission: 'chat.admin',
                agent_permission: 'chat.admin ',
                super_roles: [],
            }),
        ).toEqual({ agent_permission: 'same_permission' });
    });

    it('allows no super roles but caps name length (64, like the server) and count (20)', () => {
        expect(validateRoles({ ...DEFAULT_ROLES, super_roles: [] })).toEqual(
            {},
        );
        expect(
            validateRoles({ ...DEFAULT_ROLES, super_roles: ['x'.repeat(64)] }),
        ).toEqual({});
        expect(
            validateRoles({ ...DEFAULT_ROLES, super_roles: ['x'.repeat(65)] }),
        ).toEqual({ super_roles: 'role_name' });
        expect(
            validateRoles({
                ...DEFAULT_ROLES,
                super_roles: Array.from({ length: 21 }, (_, i) => `r${i}`),
            }),
        ).toEqual({ super_roles: 'role_count' });
    });

    it('caps permission names at 128 characters like the server', () => {
        expect(
            validateRoles({
                ...DEFAULT_ROLES,
                admin_permission: 'a'.repeat(128),
            }),
        ).toEqual({});
        expect(
            validateRoles({
                ...DEFAULT_ROLES,
                admin_permission: 'a'.repeat(129),
            }),
        ).toEqual({ admin_permission: 'permission' });
    });
});

describe('wizard validation', () => {
    const form = (): SetupFormValues => ({
        environments: {
            production: values(),
            testing: environmentValuesFrom(null),
        },
        active_env: 'production',
        roles: { ...DEFAULT_ROLES },
    });

    it('is valid with Production only', () => {
        expect(validateSetupForm(form())).toEqual({});
    });

    it('keys problems by the server paths', () => {
        const broken = form();

        broken.environments.production.base_url = '';

        expect(validateSetupForm(broken)).toEqual({
            'environments.production.base_url': 'required',
        });
    });

    it('validates Testing only once something is typed for it', () => {
        const typed = form();

        typed.environments.testing.base_url = 'https://testing.example.com';

        expect(validateSetupForm(typed)).toEqual({
            'environments.testing.service_name': 'required',
            'environments.testing.service_token': 'token_required',
        });
    });

    it('accepts a saved token in place of a typed one', () => {
        const resumed = form();

        resumed.environments.production.service_token = '';

        expect(
            validateSetupForm(resumed, { production: true, testing: false }),
        ).toEqual({});
        expect(validateSetupForm(resumed)).toEqual({
            'environments.production.service_token': 'token_required',
        });
    });

    it('does not let Testing be active while it is empty', () => {
        const wrong = form();

        wrong.active_env = 'testing';

        expect(validateSetupForm(wrong)).toEqual({
            active_env: 'active_unconfigured',
        });
    });
});

describe('wizard payload', () => {
    it('sends only Production when Testing is empty, with the roles flattened', () => {
        const payload = setupPizzasysPayload({
            environments: {
                production: values({ base_url: ' https://auth.example.com ' }),
                testing: environmentValuesFrom(null),
            },
            active_env: 'production',
            roles: {
                admin_permission: ' chat.admin ',
                agent_permission: 'chat.agent',
                super_roles: ['super-admin', 'super-admin', ' ops '],
            },
        });

        expect(payload).toEqual({
            environments: {
                production: {
                    base_url: 'https://auth.example.com',
                    service_name: 'pne-chat',
                    verify_tls: true,
                    service_token: 'secret-token',
                    nats_url: null,
                },
            },
            active_env: 'production',
            admin_permission: 'chat.admin',
            agent_permission: 'chat.agent',
            super_roles: ['super-admin', 'ops'],
        });
        expect(Object.keys(payload.environments)).toEqual(['production']);
    });

    it('omits a blank token (the stored one is kept) but sends a typed one', () => {
        expect(
            'service_token' in
                environmentPayload(values({ service_token: ' ' })),
        ).toBe(false);
        expect(
            environmentPayload(values({ service_token: ' fresh ' }))
                .service_token,
        ).toBe('fresh');
        expect('nats_token' in environmentPayload(values())).toBe(false);
        expect(
            environmentPayload(values({ nats_token: 'n-token' })).nats_token,
        ).toBe('n-token');
    });

    it('includes Testing once it is filled in, and its TLS choice', () => {
        const payload = setupPizzasysPayload({
            environments: {
                production: values(),
                testing: values({
                    base_url: 'https://testing.example.com',
                    verify_tls: false,
                    nats_url: 'nats://t:4222',
                }),
            },
            active_env: 'testing',
            roles: { ...DEFAULT_ROLES },
        });

        expect(payload.environments.testing).toEqual({
            base_url: 'https://testing.example.com',
            service_name: 'pne-chat',
            verify_tls: false,
            service_token: 'secret-token',
            nats_url: 'nats://t:4222',
        });
        expect(payload.active_env).toBe('testing');
    });
});

describe('settings payload and dirtiness', () => {
    it('is clean straight after loading and never counts the empty secret inputs', () => {
        const env = savedEnv('production');

        expect(isEnvironmentDirty(environmentValuesFrom(env), env)).toBe(false);
    });

    it('is dirty after an edit, a typed secret or a cleared token', () => {
        const env = savedEnv('production', { has_nats_token: true });
        const start = environmentValuesFrom(env);

        expect(
            isEnvironmentDirty(
                { ...start, base_url: 'https://other.example.com' },
                env,
            ),
        ).toBe(true);
        expect(
            isEnvironmentDirty({ ...start, service_token: 'new' }, env),
        ).toBe(true);
        expect(
            isEnvironmentDirty({ ...start, clear_nats_token: true }, env),
        ).toBe(true);
        expect(isEnvironmentDirty({ ...start, verify_tls: false }, env)).toBe(
            true,
        );
        expect(
            isEnvironmentDirty(
                { ...start, base_url: `${start.base_url} ` },
                env,
            ),
        ).toBe(false);
    });

    it('omits unchanged secrets from the save payload', () => {
        const env = savedEnv('production');
        const payload = settingsEnvironmentPayload({
            ...environmentValuesFrom(env),
            label: ' Prod ',
        });

        expect(payload).toEqual({
            label: 'Prod',
            base_url: 'https://production.example.com',
            service_name: 'pne-chat',
            verify_tls: true,
            nats_url: null,
        });
        expect('service_token' in payload).toBe(false);
        expect('nats_token' in payload).toBe(false);
    });

    it('sends typed secrets, and null to forget the NATS token', () => {
        const env = savedEnv('production', { has_nats_token: true });
        const start = environmentValuesFrom(env);

        expect(
            settingsEnvironmentPayload({
                ...start,
                service_token: 'rotated',
                nats_token: 'n2',
            }),
        ).toMatchObject({ service_token: 'rotated', nats_token: 'n2' });
        expect(
            settingsEnvironmentPayload({
                ...start,
                clear_nats_token: true,
                nats_token: 'ignored',
            }).nats_token,
        ).toBeNull();
    });

    it('detects a changed role mapping regardless of tag order whitespace', () => {
        expect(areRolesDirty(DEFAULT_ROLES, DEFAULT_ROLES)).toBe(false);
        expect(
            areRolesDirty(
                { ...DEFAULT_ROLES, super_roles: ['super-admin', 'ops'] },
                DEFAULT_ROLES,
            ),
        ).toBe(true);
        expect(
            areRolesDirty(
                { ...DEFAULT_ROLES, admin_permission: ' chat.admin ' },
                DEFAULT_ROLES,
            ),
        ).toBe(false);
        expect(
            rolesPayload({ ...DEFAULT_ROLES, super_roles: [' a ', 'a', 'b'] })
                .super_roles,
        ).toEqual(['a', 'b']);
    });
});

describe('tags', () => {
    it('adds trimmed, unique names split on commas and new lines, keeping spaces inside names', () => {
        expect(addTags(['a'], ' b , a\nc d ,, ')).toEqual(['a', 'b', 'c d']);
        expect(addTags([], '   ')).toEqual([]);
    });

    it('removes by name', () => {
        expect(removeTag(['a', 'b'], 'a')).toEqual(['b']);
    });
});

describe('misc helpers', () => {
    it('extracts the host of a web address only', () => {
        expect(hostOf('https://portal.example.com/app')).toBe(
            'portal.example.com',
        );
        expect(hostOf('http://localhost:8201')).toBe('localhost:8201');
        expect(hostOf('javascript:alert(1)')).toBeNull();
        expect(hostOf(null)).toBeNull();
    });

    it('only lets a configured environment with a token become active', () => {
        expect(canActivate(savedEnv('testing'))).toBe(true);
        expect(canActivate(blankEnv('testing'))).toBe(false);
        expect(
            canActivate(savedEnv('testing', { has_service_token: false })),
        ).toBe(false);
        expect(canActivate(undefined)).toBe(false);
    });
});
