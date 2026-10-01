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
    nextRangeFor,
    normaliseDraft,
    sectionAction,
    settingAction,
    settingError,
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

const own = 'https://chat.example.test';

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
        const state = run(init(), settingAction('name', 'Docs site'));

        expect(state.doc.settings).toMatchObject({ name: 'Docs site' });
        expect(dirtySlices(state)).toEqual(['settings']);
        expect(settingsPatch(state)).toEqual({ name: 'Docs site' });
    });

    it('never puts is_enabled into the settings PATCH: going live is its own confirmed action', () => {
        const edited = run(
            init(),
            settingAction('name', 'Docs site'),
            settingAction('is_enabled', false),
        );

        expect(settingsPatch(edited)).toEqual({ name: 'Docs site' });
    });

    it('the enabled action updates doc and baseline together, leaving other edits dirty', () => {
        const edited = run(init(), settingAction('name', 'Docs site'));
        const offline = run(edited, { type: 'enabled', value: false });

        expect(offline.doc.settings.is_enabled).toBe(false);
        expect(offline.saved.settings.is_enabled).toBe(false);
        // The name edit is still pending; the switch itself is not a pending change.
        expect(dirtySlices(offline)).toEqual(['settings']);
        expect(settingsPatch(offline)).toEqual({ name: 'Docs site' });
        expect(isDirty(run(init(), { type: 'enabled', value: false }))).toBe(
            false,
        );
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

    it('"Add hours" on a day that already has hours proposes a range after the last one, never a copy', () => {
        // The default schedule has 09:00-17:00 on Monday (day 1).
        const state = run(init(), { type: 'hours/add-range', day: 1 });
        const added = state.doc.config.hours.schedule.at(-1);

        expect(added).toEqual({ day: 1, start: '18:00', end: '22:00' });
        expect(validateBuilderDoc(state.doc, t, own)).not.toHaveProperty([
            'config.hours.schedule.5.start',
        ]);
    });

    it('keeps adding without overlap until the day is full, then does nothing', () => {
        let state = run(init(), { type: 'hours/set-schedule', schedule: [] });

        for (let i = 0; i < 6; i++) {
            state = run(state, { type: 'hours/add-range', day: 2 });
        }

        const ranges = state.doc.config.hours.schedule;

        expect(ranges.length).toBeGreaterThanOrEqual(2);
        expect(validateBuilderDoc(state.doc, t, own)).toEqual({});

        const full = run(state, { type: 'hours/add-range', day: 2 });

        // Either it still found room or it left the schedule alone; it never produces an overlap.
        expect(validateBuilderDoc(full.doc, t, own)).toEqual({});
    });

    it('nextRangeFor: first range is office hours, a full day has no room', () => {
        expect(nextRangeFor([], 3)).toEqual({
            day: 3,
            start: '09:00',
            end: '17:00',
        });
        expect(
            nextRangeFor([{ day: 3, start: '00:00', end: '24:00' }], 3),
        ).toBeNull();
        expect(
            nextRangeFor([{ day: 3, start: '09:00', end: '23:30' }], 3),
        ).toBeNull();
        // Other days do not matter.
        expect(
            nextRangeFor([{ day: 4, start: '09:00', end: '17:00' }], 3),
        ).toEqual({ day: 3, start: '09:00', end: '17:00' });
    });

    it('does not add a range when the day has no room left', () => {
        const state = run(init(), {
            type: 'hours/set-schedule',
            schedule: [{ day: 1, start: '00:00', end: '24:00' }],
        });

        expect(run(state, { type: 'hours/add-range', day: 1 })).toBe(state);
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

    it('a saved settings change is mirrored into the published config too (the server overlays both), so Publish has nothing to do', () => {
        const edited = run(
            init(),
            settingAction('timezone', 'Europe/Berlin'),
            settingAction('offline_mode', 'always_online'),
            settingAction('locale', 'de'),
            settingAction('queue_timeout_seconds', 45),
            settingAction('idle_timeout_minutes', 30),
        );
        const saved = run(edited, {
            type: 'saved',
            slice: 'settings',
            snapshot: edited.doc.settings,
        });

        expect(saved.published.hours).toMatchObject({
            timezone: 'Europe/Berlin',
            mode: 'always_online',
        });
        expect(saved.published.defaultLocale).toBe('de');
        expect(saved.published.routing.queueTimeoutSeconds).toBe(45);
        expect(saved.published.session.idleTimeoutMinutes).toBe(30);
        // The draft baseline got the same values, so the config slice has nothing left to send.
        expect(saved.saved.config.hours.timezone).toBe('Europe/Berlin');
        expect(dirtySlices(saved)).toEqual([]);
        expect(hasUnpublished(saved)).toBe(false);
    });

    it('only mirrors the settings that actually changed, leaving unpublished draft edits alone', () => {
        const draft = defaultWidgetConfig();

        draft.theme.primary = '#123456';

        const clean = init({
            draft_config: draft,
            widget: makeWidget({ has_unpublished_changes: true }),
        });
        const edited = run(clean, settingAction('timezone', 'Asia/Dubai'));
        const saved = run(edited, {
            type: 'saved',
            slice: 'settings',
            snapshot: edited.doc.settings,
        });

        expect(saved.published.hours.timezone).toBe('Asia/Dubai');
        expect(saved.published.theme.primary).toBe('#0f766e');
        expect(saved.saved.config.theme.primary).toBe('#123456');
        // The design draft is still unpublished.
        expect(hasUnpublished(saved)).toBe(true);
    });

    it('a settings edit without a config twin leaves both copies alone', () => {
        const edited = run(
            init(),
            settingAction('allow_non_browser_clients', true),
        );
        const saved = run(edited, {
            type: 'saved',
            slice: 'settings',
            snapshot: edited.doc.settings,
        });

        expect(saved.published).toEqual(init().published);
        expect(saved.saved.config).toEqual(init().saved.config);
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

        // Same paths as the server (`config.hours.schedule.N.start|end`, `...holidays.N.date`).
        expect(errors).not.toHaveProperty(['config.hours.schedule.0.start']);
        expect(errors).not.toHaveProperty(['config.hours.schedule.0.end']);
        expect(errors['config.hours.schedule.1.end']).toEqual([
            'builder.validation.time_order',
        ]);
        expect(errors['config.hours.schedule.2.start']).toEqual([
            'builder.validation.time',
        ]);
        expect(errors['config.hours.holidays.0.date']).toEqual([
            'builder.validation.date',
        ]);
        expect(errors).not.toHaveProperty(['config.hours.holidays.1.date']);
    });

    it('flags overlapping ranges on the same day (server: "Ranges on the same day must not overlap")', () => {
        const state = run(init(), {
            type: 'hours/set-schedule',
            schedule: [
                { day: 1, start: '09:00', end: '17:00' },
                { day: 1, start: '09:00', end: '17:00' },
                { day: 1, start: '16:00', end: '18:00' },
                // Touching is fine, other days are independent.
                { day: 1, start: '18:00', end: '20:00' },
                { day: 2, start: '09:00', end: '17:00' },
            ],
        });
        const errors = validateBuilderDoc(state.doc, t, own);

        expect(errors['config.hours.schedule.1.start']).toEqual([
            'builder.validation.time_overlap',
        ]);
        expect(errors['config.hours.schedule.2.start']).toEqual([
            'builder.validation.time_overlap',
        ]);
        expect(errors).not.toHaveProperty(['config.hours.schedule.0.start']);
        expect(errors).not.toHaveProperty(['config.hours.schedule.3.start']);
        expect(errors).not.toHaveProperty(['config.hours.schedule.4.start']);
        expect(tabForErrorPath('config.hours.schedule.1.start')).toBe('hours');
    });

    it('accepts a closing time of 24:00 (the server allows it) but not an opening time of 24:00', () => {
        const ok = run(init(), {
            type: 'hours/set-schedule',
            schedule: [{ day: 1, start: '09:00', end: '24:00' }],
        });
        const bad = run(init(), {
            type: 'hours/set-schedule',
            schedule: [{ day: 1, start: '24:00', end: '24:00' }],
        });

        expect(validateBuilderDoc(ok.doc, t, own)).toEqual({});
        expect(validateBuilderDoc(bad.doc, t, own)).toHaveProperty([
            'config.hours.schedule.0.start',
        ]);
    });

    it('flags a holiday date that is listed twice, on the later entry', () => {
        const state = run(
            init(),
            { type: 'hours/add-holiday' },
            { type: 'hours/add-holiday' },
            { type: 'hours/add-holiday' },
            ...[0, 1, 2].map((index): BuilderAction => ({
                type: 'hours/update-holiday',
                index,
                patch: { date: index === 2 ? '2026-12-26' : '2026-12-25' },
            })),
        );
        const errors = validateBuilderDoc(state.doc, t, own);

        expect(errors['config.hours.holidays.1.date']).toEqual([
            'builder.validation.date_duplicate',
        ]);
        expect(errors).not.toHaveProperty(['config.hours.holidays.0.date']);
        expect(errors).not.toHaveProperty(['config.hours.holidays.2.date']);
    });

    it('survives a holiday whose label is null (the server stores a blank name as null)', () => {
        const draft = defaultWidgetConfig();

        draft.hours.holidays = [
            { date: '2026-12-25', label: null },
            { date: '2026-12-26', label: 'x'.repeat(81) },
        ];

        // A state that skipped hydration (a stale action payload, a future caller) must not throw either.
        const doc = {
            ...init().doc,
            config: draft,
        };
        let errors: ReturnType<typeof validateBuilderDoc> = {};

        expect(() => {
            errors = validateBuilderDoc(doc, t, own);
        }).not.toThrow();
        expect(errors).not.toHaveProperty(['config.hours.holidays.0.label']);
        expect(errors['config.hours.holidays.1.label'][0]).toContain(
            'builder.validation.too_long',
        );
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

describe('hydration', () => {
    it('turns a null holiday label (stored blank) into an empty string for both the draft and the published config', () => {
        const wire = defaultWidgetConfig();

        wire.hours.holidays = [
            { date: '2026-12-25', label: null },
            { date: '2026-12-26', label: 'Boxing day' },
        ];

        const state = init({ draft_config: wire, config: wire });

        expect(state.doc.config.hours.holidays).toEqual([
            { date: '2026-12-25', label: '' },
            { date: '2026-12-26', label: 'Boxing day' },
        ]);
        expect(state.published.hours.holidays[0].label).toBe('');
        // Nothing to save or publish just because of the normalisation.
        expect(isDirty(state)).toBe(false);
        expect(hasUnpublished(state)).toBe(false);
        expect(validateBuilderDoc(state.doc, t, own)).toEqual({});
    });

    it('drops malformed holiday entries instead of crashing later', () => {
        const wire = defaultWidgetConfig();

        wire.hours.holidays = [null, 'x', { date: 5 }] as never;

        expect(init({ draft_config: wire }).doc.config.hours.holidays).toEqual([
            { date: '', label: '' },
        ]);
    });
});

describe('server error placement', () => {
    it('keeps nested server paths of the hours tab on the hours tab', () => {
        const errors = mapApiErrors('config', {
            'config.hours.schedule.2.start': ['overlap'],
            'config.hours.holidays.1.date': ['duplicate'],
        });

        expect(errors).toEqual({
            'config.hours.schedule.2.start': ['overlap'],
            'config.hours.holidays.1.date': ['duplicate'],
        });
        expect([...tabsWithErrors(errors)]).toEqual(['hours']);
        expect(errorsUnder(errors, 'config.hours.schedule.2')).toEqual([
            'overlap',
        ]);
        expect(errorsUnder(errors, 'config.hours.holidays.1')).toEqual([
            'duplicate',
        ]);
        // Another item does not pick it up.
        expect(errorsUnder(errors, 'config.hours.schedule.1')).toEqual([]);
    });

    it('replaces the dotted attribute the server embeds in its message by the field label, keeping the rule text', () => {
        const label = (path: string) =>
            path === 'config.hours.holidays.1.date'
                ? 'Holiday 2 date'
                : undefined;
        const errors = mapApiErrors(
            'config',
            {
                'config.hours.holidays.1.date': [
                    'The config.hours.holidays.1.date field has a duplicate value.',
                ],
                'config.theme.primaryText': [
                    'The config.theme.primary text field format is invalid.',
                ],
            },
            label,
        );

        expect(errors['config.hours.holidays.1.date']).toEqual([
            'The Holiday 2 date field has a duplicate value.',
        ]);
        // No label known: a readable name instead of the dotted key.
        expect(errors['config.theme.primaryText']).toEqual([
            'The theme primary text field format is invalid.',
        ]);
    });

    it('does the same for the other slices and leaves custom texts alone', () => {
        expect(
            mapApiErrors(
                'categories',
                {
                    'category_ulids.0': [
                        'The selected category ulids.0 is invalid.',
                    ],
                },
                (path) => (path === 'categories.0' ? 'Category 1' : undefined),
            ),
        ).toEqual({
            'categories.0': ['The selected Category 1 is invalid.'],
        });
        expect(
            mapApiErrors('domains', {
                'domains.0': ['"x" is not a valid domain.'],
            }),
        ).toEqual({ 'domains.0': ['"x" is not a valid domain.'] });
        expect(
            mapApiErrors(
                'settings',
                {
                    idle_timeout_minutes: [
                        'The idle timeout minutes field must be between 5 and 10080.',
                    ],
                },
                () => 'Idle timeout',
            ),
        ).toEqual({
            'settings.idle_timeout_minutes': [
                'The Idle timeout field must be between 5 and 10080.',
            ],
        });
    });

    it('maps category_ulids.N onto the categories tab and finds it under the list prefix', () => {
        const errors = mapApiErrors('categories', {
            'category_ulids.0': ['The selected category is invalid.'],
            category_ulids: ['Too many.'],
        });

        expect(errorsUnder(errors, 'categories').sort()).toEqual([
            'The selected category is invalid.',
            'Too many.',
        ]);
        expect([...tabsWithErrors(errors)]).toEqual(['categories']);
    });

    it('reports a problem of a mirrored setting under the setting, and clears it when the setting is edited', () => {
        const withError = {
            ...init(),
            errors: mapApiErrors('config', {
                'config.hours.timezone': ['Not a time zone.'],
            }),
        };

        expect(settingError(withError.errors, 'timezone')).toBe(
            'Not a time zone.',
        );
        expect(settingError(withError.errors, 'locale')).toBeUndefined();
        expect(
            run(withError, settingAction('timezone', 'Europe/Paris')).errors,
        ).toEqual({});
    });

    it('lists each message once', () => {
        expect(
            errorsUnder(
                {
                    'domains.0': ['Same.'],
                    'domains.1': ['Same.', 'Other.'],
                },
                'domains',
            ),
        ).toEqual(['Same.', 'Other.']);
    });
});

describe('draft normalisation', () => {
    it('puts a cleared launcher label back at its default, like the server does', () => {
        const config = defaultWidgetConfig();

        config.launcher.label = '  ';

        expect(normaliseDraft(config).launcher.label).toBe('Chat with us');
        expect(draftPayload(config).config.launcher.label).toBe('Chat with us');
        // The caller's object is untouched.
        expect(config.launcher.label).toBe('  ');
    });

    it('keeps a real label', () => {
        const config = defaultWidgetConfig();

        config.launcher.label = 'Ask us';

        expect(normaliseDraft(config).launcher.label).toBe('Ask us');
    });

    it('adopts the normalised draft as the baseline and shows it in the editor', () => {
        const edited = run(
            init(),
            sectionAction('launcher', { style: 'bubble', label: '' }),
        );
        const normalised = normaliseDraft(edited.doc.config);
        const saved = run(edited, {
            type: 'saved',
            slice: 'config',
            snapshot: edited.doc.config,
            normalised,
        });

        expect(saved.doc.config.launcher.label).toBe('Chat with us');
        expect(isDirty(saved)).toBe(false);
    });
});

describe('client limits match the server', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => i);

    it('rejects more schedule ranges, holidays, greetings and domains than the server accepts', () => {
        const state = run(
            init(),
            {
                type: 'hours/set-schedule',
                schedule: many(43).map((i) => ({
                    day: i % 7,
                    start: `0${i % 9}:00`,
                    end: `0${i % 9}:30`,
                })),
            },
            ...many(101).map((i): BuilderAction => ({
                type: 'greetings/add',
                clientId: `n${i}`,
            })),
            ...many(51).map((i): BuilderAction => ({
                type: 'domains/add',
                value: `d${i}.example.com`,
            })),
        );
        const errors = validateBuilderDoc(state.doc, t, own);

        expect(errors['config.hours.schedule'][0]).toContain(
            'builder.validation.too_many',
        );
        expect(errors['greetings'][0]).toContain('builder.validation.too_many');
        expect(errors['domains'][0]).toContain('builder.validation.too_many');
    });

    it('applies the server panel size ranges (280-600 x 360-900) and the font family pattern', () => {
        const ok = run(
            init(),
            sectionAction('theme', {
                panelWidth: 280,
                panelHeight: 900,
                fontFamily: "Inter, 'Noto Sans', system-ui",
            }),
        );

        expect(validateBuilderDoc(ok.doc, t, own)).toEqual({});

        const bad = run(
            init(),
            sectionAction('theme', {
                panelWidth: 601,
                panelHeight: 901,
                fontFamily: 'Inter; background:url(x)',
            }),
        );
        const errors = validateBuilderDoc(bad.doc, t, own);

        expect(errors['config.theme.panelWidth'][0]).toBe(
            'builder.validation.range {"min":280,"max":600}',
        );
        expect(errors['config.theme.panelHeight'][0]).toBe(
            'builder.validation.range {"min":360,"max":900}',
        );
        expect(errors['config.theme.fontFamily']).toEqual([
            'builder.validation.font_family',
        ]);
        expect(
            validateBuilderDoc(
                run(init(), sectionAction('theme', { panelHeight: 359 })).doc,
                t,
                own,
            ),
        ).toHaveProperty(['config.theme.panelHeight']);
    });

    it('limits the launcher label (40) and greeting agent name (120)', () => {
        const state = run(
            init(),
            sectionAction('launcher', { label: 'x'.repeat(41) }),
            {
                type: 'greetings/update',
                clientId: 'g1',
                patch: { agent_name: 'y'.repeat(121) },
            },
        );
        const errors = validateBuilderDoc(state.doc, t, own);

        expect(errors['config.launcher.label'][0]).toContain('"max":40');
        expect(errors['greetings.0.agent_name'][0]).toContain('"max":120');
    });
});
