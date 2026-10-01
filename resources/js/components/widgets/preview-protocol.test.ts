import { describe, expect, it } from 'vite-plus/test';
import { toGreetingDraft } from '@/components/widgets/builder-state';
import {
    buildCommandMessage,
    buildDraftMessage,
    dropsOverrides,
    parseHostStatus,
    PREVIEW_HOST_NS,
    restyleOverrides,
    withPreviewScheme,
} from '@/components/widgets/preview-protocol';
import { defaultWidgetConfig } from '@/lib/widget-config';
import { makeGreeting } from '@/tests/fixtures';

describe('draft message (docs/contracts/postmessage-protocol.md)', () => {
    it('is the contract envelope with the unsaved config and greetings', () => {
        const config = defaultWidgetConfig();

        config.theme.primary = '#123456';

        const message = buildDraftMessage(config, [
            toGreetingDraft(
                makeGreeting({
                    ulid: 'g1',
                    body: 'Hello',
                    agent_name: 'Sara',
                    weight: 3,
                }),
            ),
        ]);

        expect(message).toEqual({
            ns: 'chatfeature',
            v: 1,
            type: 'draft',
            payload: {
                config: expect.objectContaining({
                    theme: expect.objectContaining({ primary: '#123456' }),
                }),
                greetings: [
                    {
                        id: 'g1',
                        body: 'Hello',
                        agentName: 'Sara',
                        agentAvatarUrl: null,
                        locale: null,
                        weight: 3,
                    },
                ],
            },
        });
    });

    it('is structured-cloneable plain JSON and leaves server-only policy out', () => {
        const message = buildDraftMessage(defaultWidgetConfig(), []);

        expect(JSON.parse(JSON.stringify(message))).toEqual(message);
        expect(structuredClone(message)).toEqual(message);
        expect(message.payload.config).not.toHaveProperty('routing');
        expect(message.payload.config).not.toHaveProperty('session');
    });

    it('skips inactive and empty greetings and uses the client id for unsaved ones', () => {
        const unsaved = {
            ...toGreetingDraft(makeGreeting()),
            ulid: null,
            clientId: 'new-greeting-1',
            body: 'Fresh',
        };
        const inactive = toGreetingDraft(
            makeGreeting({ ulid: 'g2', is_active: false }),
        );
        const empty = toGreetingDraft(makeGreeting({ ulid: 'g3', body: '  ' }));
        const { greetings } = buildDraftMessage(defaultWidgetConfig(), [
            unsaved,
            inactive,
            empty,
        ]).payload;

        expect(greetings.map((g) => g.id)).toEqual(['new-greeting-1']);
    });
});

describe('preview scheme', () => {
    it('overrides the auto mode with the previewed scheme without touching the draft', () => {
        const config = defaultWidgetConfig();
        const dark = withPreviewScheme(config, 'dark');

        expect(config.theme.mode).toBe('auto');
        expect(dark.theme.mode).toBe('dark');
        expect(dark.theme.primary).toBe(config.theme.primary);
        expect(withPreviewScheme(dark, 'light').theme.mode).toBe('light');
    });
});

describe('restyle overrides for ChatFeature("update")', () => {
    it('only carries what overrides may restyle, never policy or feature flags', () => {
        const overrides = restyleOverrides(defaultWidgetConfig());

        expect(Object.keys(overrides).sort()).toEqual([
            'defaultLocale',
            'greetings',
            'launcher',
            'texts',
            'theme',
        ]);
    });
});

describe('host status messages', () => {
    const frame = {} as Window;
    const own = 'https://chat.example.test';
    const status = {
        ns: PREVIEW_HOST_NS,
        v: 1,
        type: 'status',
        loader: 'ready',
        frame: true,
    };

    it('accepts a status from our frame, same origin, our namespace', () => {
        expect(
            parseHostStatus(
                { data: status, origin: own, source: frame },
                frame,
                own,
            ),
        ).toEqual({
            ns: PREVIEW_HOST_NS,
            v: 1,
            type: 'status',
            loader: 'ready',
            frame: true,
        });
    });

    it('rejects other windows, other origins, other namespaces and junk', () => {
        const other = {} as Window;

        expect(
            parseHostStatus(
                { data: status, origin: own, source: other },
                frame,
                own,
            ),
        ).toBeNull();
        expect(
            parseHostStatus(
                { data: status, origin: 'https://evil.example', source: frame },
                frame,
                own,
            ),
        ).toBeNull();
        expect(
            parseHostStatus(
                { data: status, origin: own, source: frame },
                null,
                own,
            ),
        ).toBeNull();
        expect(
            parseHostStatus(
                {
                    data: { ...status, ns: 'chatfeature' },
                    origin: own,
                    source: frame,
                },
                frame,
                own,
            ),
        ).toBeNull();
        expect(
            parseHostStatus(
                { data: { ...status, v: 2 }, origin: own, source: frame },
                frame,
                own,
            ),
        ).toBeNull();
        expect(
            parseHostStatus(
                {
                    data: { ...status, loader: 'weird' },
                    origin: own,
                    source: frame,
                },
                frame,
                own,
            ),
        ).toBeNull();
        expect(
            parseHostStatus(
                { data: null, origin: own, source: frame },
                frame,
                own,
            ),
        ).toBeNull();
        expect(
            parseHostStatus(
                { data: 'text', origin: own, source: frame },
                frame,
                own,
            ),
        ).toBeNull();
    });

    it('treats a missing frame flag as false', () => {
        const parsed = parseHostStatus(
            {
                data: { ...status, frame: undefined },
                origin: own,
                source: frame,
            },
            frame,
            own,
        );

        expect(parsed?.frame).toBe(false);
    });
});

describe('command message', () => {
    it('asks the relay to open or close the panel', () => {
        expect(buildCommandMessage('open')).toEqual({
            ns: PREVIEW_HOST_NS,
            v: 1,
            type: 'command',
            name: 'open',
        });
        expect(buildCommandMessage('close').name).toBe('close');
    });
});

describe('dropsOverrides', () => {
    it('is false while values are only added or changed', () => {
        expect(dropsOverrides({ a: 1 }, { a: 2 })).toBe(false);
        expect(dropsOverrides({ a: 1 }, { a: 1, b: 2 })).toBe(false);
        expect(dropsOverrides({}, { texts: { fr: {} } })).toBe(false);
        expect(dropsOverrides({ a: null }, { a: 'x' })).toBe(false);
        expect(dropsOverrides({ a: null }, {})).toBe(false);
        expect(dropsOverrides({ list: [1, 2] }, { list: [3] })).toBe(false);
    });

    it('is true when a key disappears or a set value becomes null', () => {
        expect(dropsOverrides({ a: 1, b: 2 }, { a: 1 })).toBe(true);
        expect(dropsOverrides({ a: 'x' }, { a: null })).toBe(true);
        expect(dropsOverrides({ a: 'x' }, { a: undefined })).toBe(true);
        expect(dropsOverrides({ o: { a: 1 } }, { o: null })).toBe(true);
    });

    it('looks inside nested objects (a text of one language, a font url)', () => {
        expect(
            dropsOverrides(
                { texts: { en: { title: 'A', send: 'B' } } },
                { texts: { en: { title: 'A' } } },
            ),
        ).toBe(true);
        expect(
            dropsOverrides(
                { texts: { en: { title: 'A' }, fr: { title: 'B' } } },
                { texts: { en: { title: 'A' } } },
            ),
        ).toBe(true);
        expect(
            dropsOverrides(
                { theme: { fontUrl: 'https://fonts.googleapis.com/css' } },
                { theme: { fontUrl: null } },
            ),
        ).toBe(true);
    });

    it('sees a cleared text override in a real draft', () => {
        const before = defaultWidgetConfig();
        const after = structuredClone(before);

        delete after.texts.en.title;

        expect(
            dropsOverrides(restyleOverrides(before), restyleOverrides(after)),
        ).toBe(true);

        const changed = structuredClone(before);

        changed.texts.en.title = 'Other';
        changed.launcher.iconUrl = 'https://cdn.example.com/i.svg';

        expect(
            dropsOverrides(restyleOverrides(before), restyleOverrides(changed)),
        ).toBe(false);
    });
});
