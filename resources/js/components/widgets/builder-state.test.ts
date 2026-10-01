import { describe, expect, it } from 'vite-plus/test';
import {
    builderReducer,
    createBuilderState,
    deepEqual,
    dirtySlices,
    domainsFromResponse,
    draftPayload,
    errorCount,
    errorsUnder,
    firstError,
    firstTabWithError,
    greetingsFromResponse,
    greetingsPayload,
    hasUnpublished,
    isDirty,
    mapApiErrors,
    sectionAction,
    settingAction,
    settingsPatch,
    tabForErrorPath,
    tabsWithErrors,
    validateBuilderDoc,
    type BuilderAction,
    type BuilderState,
} from '@/components/widgets/builder-state';
import { defaultWidgetConfig } from '@/lib/widget-config';
import { makeBuilderData, makeGreeting, makeWidget } from '@/tests/fixtures';

const t = (key: string, replacements?: Record<string, string | number>) =>
    replacements ? `${key} ${JSON.stringify(replacements)}` : key;

const init = (overrides = {}) => createBuilderState(makeBuilderData(overrides));

function run(state: BuilderState, ...actions: BuilderAction[]): BuilderState {
    return actions.reduce(builderReducer, state);
}

describe('createBuilderState', () => {
    it('starts clean with the draft config, sorted greetings and a baseline copy', () => {
        const state = init({
            greetings: [
                makeGreeting({ ulid: 'b', sort_order: 1 }),
                makeGreeting({ ulid: 'a', sort_order: 0 }),
            ],
        });

        expect(isDirty(state)).toBe(false);
        expect(dirtySlices(state)).toEqual([]);
        expect(state.doc.greetings.map((g) => g.ulid)).toEqual(['a', 'b']);
        expect(state.doc.greetings[0].clientId).toBe('a');
        expect(state.saved).toEqual(state.doc);
        expect(state.saved).not.toBe(state.doc);
        expect(state.meta).toMatchObject({
            ulid: 'w1',
            publicKey: 'wk_abc123',
            configVersion: 3,
        });
    });

    it('edits the draft, not the published config', () => {
        const draft = defaultWidgetConfig();

        draft.theme.primary = '#123456';

        const state = init({ draft_config: draft });

        expect(state.doc.config.theme.primary).toBe('#123456');
        expect(state.published.theme.primary).toBe('#0f766e');
        expect(hasUnpublished(state)).toBe(true);
    });

    it('fills missing config sections with defaults', () => {
        const state = init({
            draft_config: { theme: { primary: '#abcdef' } } as never,
        });

        expect(state.doc.config.features.attachments).toBe(true);
    });
});

describe('settings slice', () => {
    it('only marks the settings slice dirty for plain fields', () => {
        const state = run(
            init(),
            settingAction('name', 'Docs site'),
            settingAction('is_enabled', false),
        );

        expect(state.doc.settings).toMatchObject({
            name: 'Docs site',
            is_enabled: false,
        });
        expect(dirtySlices(state)).toEqual(['settings']);
        expect(settingsPatch(state)).toEqual({
            name: 'Docs site',
            is_enabled: false,
        });
    });

    it('mirrors the columns the config duplicates', () => {
        const state = run(
            init(),
            settingAction('idle_timeout_minutes', 30),
            settingAction('queue_timeout_seconds', 45),
            settingAction('offline_mode', 'always_online'),
            settingAction('timezone', 'Europe/Berlin'),
            settingAction('locale', 'ar'),
        );

        expect(state.doc.config.session.idleTimeoutMinutes).toBe(30);
        expect(state.doc.config.routing.queueTimeoutSeconds).toBe(45);
        expect(state.doc.config.hours).toMatchObject({
            mode: 'always_online',
            timezone: 'Europe/Berlin',
        });
        expect(state.doc.config.defaultLocale).toBe('ar');
        expect(dirtySlices(state)).toEqual(['settings', 'config']);
    });

    it('does not mirror columns that have no config twin', () => {
        const before = init();
        const state = run(
            before,
            settingAction('allow_non_browser_clients', true),
        );

        expect(state.doc.config).toEqual(before.doc.config);
    });

    it('becomes clean again when an edit is reverted', () => {
        const state = run(
            init(),
            settingAction('name', 'X'),
            settingAction('name', 'Marketing site'),
        );

        expect(isDirty(state)).toBe(false);
        expect(settingsPatch(state)).toEqual({});
    });
});

describe('config sections', () => {
    it('patches theme, launcher, features, greetings, hours and routing sections', () => {
        const state = run(
            init(),
            sectionAction('theme', {
                primary: '#ff0000',
                radius: 4,
                position: 'bottom-left',
            }),
            sectionAction('launcher', { style: 'pill', label: 'Talk to us' }),
            sectionAction('features', { rating: false, sounds: false }),
            sectionAction('greetings', {
                intervalMinutes: 10,
                dismissPolicy: 'never',
            }),
            sectionAction('hours', {
                holidays: [{ date: '2026-12-25', label: 'Xmas' }],
            }),
            sectionAction('routing', { wakeOfflineViaPush: true }),
        );
        const { config } = state.doc;

        expect(config.theme).toMatchObject({
            primary: '#ff0000',
            radius: 4,
            position: 'bottom-left',
            primaryText: '#ffffff',
        });
        expect(config.launcher).toMatchObject({
            style: 'pill',
            label: 'Talk to us',
            icon: 'chat',
        });
        expect(config.features).toMatchObject({
            rating: false,
            sounds: false,
            attachments: true,
        });
        expect(config.greetings).toMatchObject({
            intervalMinutes: 10,
            dismissPolicy: 'never',
            delaySeconds: 3,
        });
        expect(config.hours.holidays).toHaveLength(1);
        expect(config.routing.wakeOfflineViaPush).toBe(true);
        expect(dirtySlices(state)).toEqual(['config']);
    });

    it('toggles locale detection', () => {
        const state = run(init(), {
            type: 'config/root',
            patch: { localeDetect: false },
        });

        expect(state.doc.config.localeDetect).toBe(false);
    });

    it('edits pre-chat fields and the consent text', () => {
        const state = run(
            init(),
            {
                type: 'prechat/field',
                field: 'phone',
                patch: { enabled: true, required: true },
            },
            {
                type: 'prechat/field',
                field: 'name',
                patch: { required: false },
            },
            { type: 'prechat/consent', text: 'I agree' },
        );

        expect(state.doc.config.preChat.fields.phone).toEqual({
            enabled: true,
            required: true,
        });
        expect(state.doc.config.preChat.fields.name).toEqual({
            enabled: true,
            required: false,
        });
        expect(state.doc.config.preChat.consentText).toBe('I agree');

        const cleared = run(state, { type: 'prechat/consent', text: null });

        expect(cleared.doc.config.preChat.consentText).toBeNull();
    });
});

describe('texts', () => {
    it('sets a text and drops the key when it is emptied (falls back again)', () => {
        const typed = run(init(), {
            type: 'texts/set',
            locale: 'en',
            key: 'title',
            value: 'Help desk',
        });

        expect(typed.doc.config.texts.en.title).toBe('Help desk');

        const cleared = run(typed, {
            type: 'texts/set',
            locale: 'en',
            key: 'title',
            value: '',
        });

        expect(cleared.doc.config.texts.en).not.toHaveProperty('title');
    });

    it('adds a language once and edits it', () => {
        const state = run(
            init(),
            { type: 'texts/add-locale', locale: 'ar' },
            { type: 'texts/add-locale', locale: 'ar' },
            { type: 'texts/set', locale: 'ar', key: 'send', value: 'إرسال' },
        );

        expect(Object.keys(state.doc.config.texts)).toEqual(['en', 'ar']);
        expect(state.doc.config.texts.ar).toEqual({ send: 'إرسال' });
    });

    it('removes a language but never the default one', () => {
        const withArabic = run(init(), {
            type: 'texts/add-locale',
            locale: 'ar',
        });
        const removed = run(withArabic, {
            type: 'texts/remove-locale',
            locale: 'ar',
        });
        const keptDefault = run(removed, {
            type: 'texts/remove-locale',
            locale: 'en',
        });

        expect(Object.keys(removed.doc.config.texts)).toEqual(['en']);
        expect(keptDefault).toBe(removed);
    });
});

describe('hours', () => {
    it('adds, edits and removes ranges', () => {
        const state = run(
            init(),
            { type: 'hours/set-schedule', schedule: [] },
            { type: 'hours/add-range', day: 6 },
            { type: 'hours/add-range', day: 0 },
            {
                type: 'hours/update-range',
                index: 0,
                patch: { start: '10:00', end: '14:00' },
            },
        );

        expect(state.doc.config.hours.schedule).toEqual([
            { day: 6, start: '10:00', end: '14:00' },
            { day: 0, start: '09:00', end: '17:00' },
        ]);

        const removed = run(state, { type: 'hours/remove-range', index: 0 });

        expect(removed.doc.config.hours.schedule).toEqual([
            { day: 0, start: '09:00', end: '17:00' },
        ]);
    });

    it('adds, edits and removes holidays', () => {
        const state = run(
            init(),
            { type: 'hours/add-holiday' },
            {
                type: 'hours/update-holiday',
                index: 0,
                patch: { date: '2026-12-25', label: 'Christmas' },
            },
        );

        expect(state.doc.config.hours.holidays).toEqual([
            { date: '2026-12-25', label: 'Christmas' },
        ]);
        expect(
            run(state, { type: 'hours/remove-holiday', index: 0 }).doc.config
                .hours.holidays,
        ).toEqual([]);
    });
});

describe('greetings pool', () => {
    it('adds a blank greeting with the defaults', () => {
        const state = run(init(), { type: 'greetings/add', clientId: 'new-1' });
        const added = state.doc.greetings.at(-1)!;

        expect(added).toMatchObject({
            clientId: 'new-1',
            ulid: null,
            body: '',
            agent_name: null,
            locale: null,
            weight: 1,
            is_active: true,
        });
        expect(dirtySlices(state)).toEqual(['greetings']);
    });

    it('updates, reorders and removes by clientId', () => {
        const state = run(
            init(),
            {
                type: 'greetings/update',
                clientId: 'g1',
                patch: { body: 'Changed', weight: 9 },
            },
            { type: 'greetings/move', clientId: 'g1', direction: 1 },
        );

        expect(state.doc.greetings.map((g) => g.clientId)).toEqual([
            'g2',
            'g1',
        ]);
        expect(state.doc.greetings[1]).toMatchObject({
            body: 'Changed',
            weight: 9,
        });

        const removed = run(state, {
            type: 'greetings/remove',
            clientId: 'g2',
        });

        expect(removed.doc.greetings.map((g) => g.clientId)).toEqual(['g1']);
    });

    it('ignores moves past either end', () => {
        const state = init();

        expect(
            run(state, {
                type: 'greetings/move',
                clientId: 'g1',
                direction: -1,
            }).doc.greetings,
        ).toEqual(state.doc.greetings);
        expect(
            run(state, { type: 'greetings/move', clientId: 'g2', direction: 1 })
                .doc.greetings,
        ).toEqual(state.doc.greetings);
    });
});

describe('domains and categories', () => {
    it('adds a domain once and removes it', () => {
        const state = run(
            init(),
            { type: 'domains/add', value: 'shop.example.com' },
            { type: 'domains/add', value: 'shop.example.com' },
        );

        expect(state.doc.domains).toEqual(['example.com', 'shop.example.com']);
        expect(
            run(state, { type: 'domains/remove', value: 'example.com' }).doc
                .domains,
        ).toEqual(['shop.example.com']);
        expect(dirtySlices(state)).toEqual(['domains']);
    });

    it('toggles and reorders categories (order is display order)', () => {
        const state = run(
            init(),
            { type: 'categories/toggle', ulid: 'cat2' },
            { type: 'categories/toggle', ulid: 'cat3' },
            { type: 'categories/move', ulid: 'cat3', direction: -1 },
        );

        expect(state.doc.categoryUlids).toEqual(['cat1', 'cat3', 'cat2']);
        expect(
            run(state, { type: 'categories/toggle', ulid: 'cat1' }).doc
                .categoryUlids,
        ).toEqual(['cat3', 'cat2']);
        expect(dirtySlices(state)).toEqual(['categories']);
    });

    it('does not move an item past either end', () => {
        const state = init();

        expect(
            run(state, { type: 'categories/move', ulid: 'cat1', direction: -1 })
                .doc.categoryUlids,
        ).toEqual(['cat1']);
    });
});

describe('dirty tracking and saving', () => {
    it('reports every dirty slice in save order', () => {
        const state = run(
            init(),
            { type: 'categories/toggle', ulid: 'cat2' },
            { type: 'domains/add', value: 'a.example.com' },
            sectionAction('theme', { radius: 2 }),
            settingAction('name', 'Renamed'),
            { type: 'greetings/remove', clientId: 'g2' },
        );

        expect(dirtySlices(state)).toEqual([
            'settings',
            'config',
            'greetings',
            'domains',
            'categories',
        ]);
    });

    it('adopts what was saved as the new baseline', () => {
        const edited = run(init(), sectionAction('theme', { radius: 2 }));
        const saved = run(edited, {
            type: 'saved',
            slice: 'config',
            snapshot: edited.doc.config,
        });

        expect(isDirty(saved)).toBe(false);
        expect(saved.saved.config.theme.radius).toBe(2);
    });

    it('keeps edits made while the save was in flight', () => {
        const edited = run(init(), sectionAction('theme', { radius: 2 }));
        const snapshot = edited.doc.config;
        const typedMore = run(edited, sectionAction('theme', { radius: 3 }));
        const saved = run(typedMore, {
            type: 'saved',
            slice: 'config',
            snapshot,
        });

        expect(saved.doc.config.theme.radius).toBe(3);
        expect(saved.saved.config.theme.radius).toBe(2);
        expect(dirtySlices(saved)).toEqual(['config']);
    });

    it('takes the server-normalised value (domains, greeting ulids) into doc and baseline', () => {
        const edited = run(init(), {
            type: 'domains/add',
            value: 'WWW.Example.com',
        });
        const saved = run(edited, {
            type: 'saved',
            slice: 'domains',
            snapshot: edited.doc.domains,
            normalised: ['example.com', 'www.example.com'],
        });

        expect(saved.doc.domains).toEqual(['example.com', 'www.example.com']);
        expect(isDirty(saved)).toBe(false);
    });

    it('tracks unpublished changes: saving a changed draft sets the flag, publishing clears it', () => {
        const clean = init();

        expect(hasUnpublished(clean)).toBe(false);

        const edited = run(clean, sectionAction('theme', { radius: 2 }));
        const saved = run(edited, {
            type: 'saved',
            slice: 'config',
            snapshot: edited.doc.config,
        });

        expect(saved.meta.hasUnpublishedChanges).toBe(true);
        expect(hasUnpublished(saved)).toBe(true);

        const published = run(saved, {
            type: 'published',
            widget: makeWidget({
                config_version: 4,
                has_unpublished_changes: false,
            }),
        });

        expect(published.meta.configVersion).toBe(4);
        expect(hasUnpublished(published)).toBe(false);
        expect(published.published.theme.radius).toBe(2);
    });

    it('settings saved are not "unpublished" (they are live columns)', () => {
        const edited = run(
            init(),
            settingAction('allow_non_browser_clients', true),
        );
        const saved = run(edited, {
            type: 'saved',
            slice: 'settings',
            snapshot: edited.doc.settings,
        });

        expect(hasUnpublished(saved)).toBe(false);
    });

    it('patches meta (secret status, ...)', () => {
        expect(
            run(init(), { type: 'meta', patch: { hasIdentitySecret: true } })
                .meta.hasIdentitySecret,
        ).toBe(true);
    });
});

describe('field errors', () => {
    it('namespaces server details per slice', () => {
        expect(
            mapApiErrors('settings', { idle_timeout_minutes: ['Too small'] }),
        ).toEqual({
            'settings.idle_timeout_minutes': ['Too small'],
        });
        expect(
            mapApiErrors('config', {
                'config.theme.primary': ['Bad'],
                'theme.accent': ['Bad too'],
            }),
        ).toEqual({
            'config.theme.primary': ['Bad'],
            'config.theme.accent': ['Bad too'],
        });
        expect(
            mapApiErrors('greetings', {
                'greetings.0.body': ['Required'],
                '1.weight': ['Max 100'],
            }),
        ).toEqual({
            'greetings.0.body': ['Required'],
            'greetings.1.weight': ['Max 100'],
        });
        expect(
            mapApiErrors('domains', {
                'domains.2': ['Invalid host'],
                domains: ['Too many'],
            }),
        ).toEqual({
            'domains.2': ['Invalid host'],
            domains: ['Too many'],
        });
        expect(
            mapApiErrors('categories', {
                category_ulids: ['Unknown'],
                'category_ulids.1': ['Inactive'],
            }),
        ).toEqual({
            categories: ['Unknown'],
            'categories.1': ['Inactive'],
        });
    });

    it('merges several messages for one field', () => {
        expect(mapApiErrors('settings', { name: ['A', 'B'] })).toEqual({
            'settings.name': ['A', 'B'],
        });
    });

    it('stores errors and clears the ones of a field once it is edited again', () => {
        const errors = {
            'config.theme.primary': ['Bad'],
            'config.theme.accent': ['Bad'],
            'settings.name': ['Required'],
            'greetings.0.body': ['Required'],
        };
        const withErrors = run(init(), { type: 'errors/set', errors });

        expect(errorCount(withErrors.errors)).toBe(4);

        const edited = run(
            withErrors,
            sectionAction('theme', { primary: '#ffffff' }),
        );

        expect(Object.keys(edited.errors).sort()).toEqual([
            'config.theme.accent',
            'greetings.0.body',
            'settings.name',
        ]);

        const renamed = run(edited, settingAction('name', 'x'), {
            type: 'greetings/update',
            clientId: 'g1',
            patch: { body: 'x' },
        });

        expect(Object.keys(renamed.errors)).toEqual(['config.theme.accent']);
        expect(run(renamed, { type: 'errors/clear' }).errors).toEqual({});
        expect(
            run(renamed, { type: 'errors/clear', prefix: 'config.theme' })
                .errors,
        ).toEqual({});
    });

    it('reads the first message and everything under a prefix', () => {
        const errors = {
            'greetings.0.body': ['A'],
            'greetings.0.weight': ['B'],
            'greetings.1.body': ['C'],
        };

        expect(firstError(errors, 'greetings.0.body')).toBe('A');
        expect(firstError(errors, 'nope')).toBeUndefined();
        expect(errorsUnder(errors, 'greetings.0')).toEqual(['A', 'B']);
    });

    it('sends each error path to the tab that shows it', () => {
        const cases: [string, string][] = [
            ['settings.name', 'general'],
            ['settings.idle_timeout_minutes', 'general'],
            ['config.defaultLocale', 'general'],
            ['config.theme.primary', 'branding'],
            ['config.launcher.label', 'branding'],
            ['config.texts.ar.title', 'texts'],
            ['config.features.rating', 'features'],
            ['config.preChat.consentText', 'features'],
            ['config.greetings.delaySeconds', 'greetings'],
            ['greetings.0.body', 'greetings'],
            ['config.hours.schedule.1', 'hours'],
            ['domains.0', 'domains'],
            ['categories', 'categories'],
        ];

        for (const [path, tab] of cases) {
            expect(tabForErrorPath(path)).toBe(tab);
        }
    });

    it('finds the tabs with errors and the first one in display order', () => {
        const errors = {
            'domains.0': ['x'],
            'config.theme.primary': ['x'],
            'settings.name': ['x'],
        };

        expect([...tabsWithErrors(errors)].sort()).toEqual([
            'branding',
            'domains',
            'general',
        ]);
        expect(firstTabWithError(errors)).toBe('general');
        expect(firstTabWithError({})).toBeNull();
    });
});

describe('validateBuilderDoc', () => {
    const own = 'https://chat.example.test';

    it('accepts the untouched defaults', () => {
        expect(validateBuilderDoc(init().doc, t, own)).toEqual({});
    });

    it('flags every kind of bad value on the config', () => {
        const state = run(
            init(),
            settingAction('name', '   '),
            settingAction('idle_timeout_minutes', 4),
            settingAction('queue_timeout_seconds', 9999),
            settingAction('locale', 'English'),
            sectionAction('theme', {
                primary: 'teal',
                text: '#12',
                radius: 40,
                fontUrl: 'https://evil.example/x.css',
                offsetX: -1,
                zIndex: 0,
                fontFamily: ' ',
            }),
            sectionAction('launcher', {
                icon: 'custom',
                iconUrl: null,
                avatarUrl: 'http://x.test/a.png',
            }),
            sectionAction('greetings', {
                delaySeconds: -1,
                intervalMinutes: 0,
                autoHideSeconds: 1,
            }),
            { type: 'prechat/consent', text: 'x'.repeat(501) },
            { type: 'texts/add-locale', locale: 'English' },
        );
        const errors = validateBuilderDoc(state.doc, t, own);

        for (const path of [
            'settings.name',
            'settings.idle_timeout_minutes',
            'settings.queue_timeout_seconds',
            'settings.locale',
            'config.theme.primary',
            'config.theme.text',
            'config.theme.radius',
            'config.theme.fontUrl',
            'config.theme.offsetX',
            'config.theme.zIndex',
            'config.theme.fontFamily',
            'config.launcher.iconUrl',
            'config.launcher.avatarUrl',
            'config.greetings.delaySeconds',
            'config.greetings.intervalMinutes',
            'config.greetings.autoHideSeconds',
            'config.preChat.consentText',
            'config.texts.English',
        ]) {
            expect(errors, path).toHaveProperty([path]);
        }

        expect(errors['settings.idle_timeout_minutes'][0]).toBe(
            'builder.validation.range {"min":5,"max":10080}',
        );
        expect(errors['config.theme.radius'][0]).toBe(
            'builder.validation.range {"min":0,"max":28}',
        );
        expect(errors).not.toHaveProperty(['config.theme.accent']);
    });

    it('requires a label for the pill launcher', () => {
        const state = run(
            init(),
            sectionAction('launcher', { style: 'pill', label: ' ' }),
        );

        expect(validateBuilderDoc(state.doc, t, own)).toHaveProperty([
            'config.launcher.label',
        ]);
    });

    it('validates schedule ranges and holidays by index', () => {
        const state = run(
            init(),
            {
                type: 'hours/set-schedule',
                schedule: [
                    { day: 1, start: '09:00', end: '17:00' },
                    { day: 2, start: '17:00', end: '09:00' },
                    { day: 3, start: '9am', end: '17:00' },
                ],
            },
            { type: 'hours/add-holiday' },
            { type: 'hours/add-holiday' },
            {
                type: 'hours/update-holiday',
                index: 1,
                patch: { date: '2026-12-25' },
            },
        );
        const errors = validateBuilderDoc(state.doc, t, own);

        expect(errors).not.toHaveProperty(['config.hours.schedule.0']);
        expect(errors['config.hours.schedule.1']).toEqual([
            'builder.validation.time_order',
        ]);
        expect(errors['config.hours.schedule.2']).toEqual([
            'builder.validation.time',
        ]);
        expect(errors['config.hours.holidays.0']).toEqual([
            'builder.validation.date',
        ]);
        expect(errors).not.toHaveProperty(['config.hours.holidays.1']);
    });

    it('validates greetings (body, weight, avatar, locale) and domains by index', () => {
        const state = run(
            init(),
            {
                type: 'greetings/update',
                clientId: 'g1',
                patch: {
                    body: '',
                    weight: 500,
                    agent_avatar_url: 'http://x.test/a.png',
                    locale: 'Arabic',
                },
            },
            {
                type: 'greetings/update',
                clientId: 'g2',
                patch: { body: 'y'.repeat(2001) },
            },
            { type: 'domains/add', value: 'https://bad.example.com' },
        );
        const errors = validateBuilderDoc(state.doc, t, own);

        expect(errors['greetings.0.body']).toEqual([
            'builder.validation.required',
        ]);
        expect(errors).toHaveProperty(['greetings.0.weight']);
        expect(errors).toHaveProperty(['greetings.0.agent_avatar_url']);
        expect(errors).toHaveProperty(['greetings.0.locale']);
        expect(errors['greetings.1.body'][0]).toContain(
            'builder.validation.too_long',
        );
        expect(errors['domains.1']).toEqual(['builder.domains.problem.scheme']);
    });
});

describe('payloads', () => {
    it('only sends settings that changed', () => {
        const state = run(init(), settingAction('timezone', 'Asia/Dubai'));

        expect(settingsPatch(state)).toEqual({ timezone: 'Asia/Dubai' });
    });

    it('strips blank text overrides from the draft but keeps everything else', () => {
        const state = run(
            init(),
            { type: 'texts/add-locale', locale: 'fr' },
            { type: 'texts/set', locale: 'fr', key: 'title', value: 'Aide' },
        );
        const { config } = draftPayload({
            ...state.doc.config,
            texts: {
                ...state.doc.config.texts,
                fr: { title: 'Aide', send: '' },
            },
        });

        expect(config.texts.fr).toEqual({ title: 'Aide' });
        expect(config.texts.en).toEqual(state.doc.config.texts.en);
        expect(config.theme).toEqual(state.doc.config.theme);
    });

    it('serialises the greeting pool with sort order, null blanks and clamped weight', () => {
        const state = run(
            init(),
            { type: 'greetings/add', clientId: 'n1' },
            {
                type: 'greetings/update',
                clientId: 'n1',
                patch: {
                    body: 'New',
                    weight: 500,
                    agent_name: '  ',
                    locale: '',
                    agent_avatar_url: ' https://a.test/p.png ',
                },
            },
        );
        const { greetings } = greetingsPayload(state.doc.greetings);

        expect(greetings).toHaveLength(3);
        expect(greetings[0]).toMatchObject({
            ulid: 'g1',
            body: 'Hi! Need a hand choosing a plan?',
            agent_name: 'Sara',
            sort_order: 0,
            weight: 2,
        });
        expect(greetings[2]).toEqual({
            body: 'New',
            agent_name: null,
            agent_avatar_url: 'https://a.test/p.png',
            locale: null,
            weight: 100,
            is_active: true,
            sort_order: 2,
        });
        expect(greetings[2]).not.toHaveProperty('ulid');
    });

    it('reads the saved pool from a server answer', () => {
        const rows = [
            makeGreeting({ ulid: 'x2', sort_order: 1 }),
            makeGreeting({ ulid: 'x1', sort_order: 0 }),
        ];

        expect(greetingsFromResponse(rows)?.map((g) => g.ulid)).toEqual([
            'x1',
            'x2',
        ]);
        expect(greetingsFromResponse(rows)?.[0].clientId).toBe('x1');
        expect(greetingsFromResponse({ nope: true })).toBeNull();
        expect(greetingsFromResponse([{ id: 1 }])).toBeNull();
    });

    it('reads normalised domains from a list or an object', () => {
        expect(domainsFromResponse(['a.test'])).toEqual(['a.test']);
        expect(domainsFromResponse({ domains: ['b.test'] })).toEqual([
            'b.test',
        ]);
        expect(domainsFromResponse({ domains: [1] })).toBeNull();
        expect(domainsFromResponse(null)).toBeNull();
    });
});

describe('deepEqual', () => {
    it('compares structure, not identity', () => {
        expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(
            true,
        );
        expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
        expect(deepEqual([1, 2], [2, 1])).toBe(false);
        expect(deepEqual([], {})).toBe(false);
        expect(deepEqual(null, {})).toBe(false);
        expect(deepEqual(NaN, NaN)).toBe(true);
    });
});
