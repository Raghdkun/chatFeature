import '@/tests/dom-polyfills';
import { act } from 'react';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vite-plus/test';
import { toGreetingDraft } from '@/components/widgets/builder-state';
import {
    BuilderPreview,
    type BuilderPreviewProps,
} from '@/components/widgets/builder-preview';
import { PREVIEW_HOST_NS } from '@/components/widgets/preview-protocol';
import { defaultWidgetConfig } from '@/lib/widget-config';
import WidgetBuilder from '@/pages/widgets/builder';
import { byLabelText, byTestId, fill, mouseDown, radio } from '@/tests/dom';
import { setViewportWidth } from '@/tests/dom-polyfills';
import { fakeApi } from '@/tests/fake-api';
import {
    BUILT_LOADER,
    makeBuilderData,
    makeGreeting,
    STUB_LOADER,
} from '@/tests/fixtures';
import { resetInertiaMock } from '@/tests/inertia-mock';
import { click, flush, render } from '@/tests/render';

vi.mock('@inertiajs/react', async () =>
    (await import('@/tests/inertia-mock')).inertiaMock(),
);

const ORIGIN = window.location.origin;
const LOADER_PATH = '/widget/v1/loader.js';

const props = (
    overrides: Partial<BuilderPreviewProps> = {},
): BuilderPreviewProps => ({
    widgetKey: 'wk_abc123',
    configVersion: 3,
    config: defaultWidgetConfig(),
    greetings: [toGreetingDraft(makeGreeting())],
    categories: [{ slug: 'sales', label: 'Sales' }],
    preview: {
        embed_url: 'https://chat.example.test/embed/wk_abc123?preview=1',
        app_origin: 'https://chat.example.test',
    },
    greetingFocus: { id: null, nonce: 0 },
    ...overrides,
});

beforeEach(() => {
    resetInertiaMock();
    setViewportWidth(1440);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.restoreAllMocks();
});

const iframeOf = (container: HTMLElement) =>
    container.querySelector<HTMLIFrameElement>(
        '[data-testid="builder-preview-iframe"]',
    );

/** Lets the frame "load" and the host relay report a status, the way the real document would. */
async function loadFrame(frame: HTMLIFrameElement | null) {
    await act(async () => {
        frame?.dispatchEvent(new Event('load'));
    });
}

async function hostStatus(
    frame: HTMLIFrameElement | null,
    loader: 'loading' | 'ready' | 'error',
    origin = ORIGIN,
) {
    await act(async () => {
        window.dispatchEvent(
            new MessageEvent('message', {
                data: {
                    ns: PREVIEW_HOST_NS,
                    v: 1,
                    type: 'status',
                    loader,
                    frame: true,
                },
                origin,
                source: frame?.contentWindow ?? null,
            }),
        );
    });
}

describe('approximation (no loader needed)', () => {
    it('is the default when the loader cannot be reached, and says so', async () => {
        fakeApi({ 'GET /widget/v1/loader.js': { status: 404 } });

        const view = await render(<BuilderPreview {...props()} />);

        await flush();

        expect(
            view.byTestId('builder-preview-unavailable')?.textContent,
        ).toContain('Live preview is not available yet');
        expect(view.byTestId('preview-static')).not.toBeNull();
        expect(iframeOf(view.container)).toBeNull();
        // Nothing to choose between: just a label for the approximation.
        expect(view.byTestId('builder-preview-view')).toBeNull();
        expect(
            view.byTestId('builder-preview-view-static-only')?.textContent,
        ).toBe('Approximation');
    });

    it('draws the WhatsApp option in the panel exactly when the draft turns the feature on', async () => {
        fakeApi({ 'GET /widget/v1/loader.js': { status: 404 } });

        const off = await render(<BuilderPreview {...props()} />);

        await flush();
        await click(off.byTestId('builder-preview-panel'));
        expect(off.byTestId('preview-panel')).not.toBeNull();
        expect(off.byTestId('preview-whatsapp')).toBeNull();
        await off.unmount();

        const base = props();
        const on = await render(
            <BuilderPreview
                {...base}
                config={{
                    ...base.config,
                    features: { ...base.config.features, whatsapp: true },
                }}
            />,
        );

        await flush();
        await click(on.byTestId('builder-preview-panel'));
        expect(on.byTestId('preview-whatsapp')?.textContent).toBe(
            'Continue on WhatsApp',
        );
    });

    it('treats HTTP 200 with the "bundle not built" stub like a missing loader', async () => {
        fakeApi({ 'GET /widget/v1/loader.js': STUB_LOADER });

        const view = await render(<BuilderPreview {...props()} />);

        await flush();

        expect(view.byTestId('builder-preview-unavailable')).not.toBeNull();
        expect(view.byTestId('preview-static')).not.toBeNull();
        expect(iframeOf(view.container)).toBeNull();
    });

    it('treats an HTML error page with status 200 as unavailable too', async () => {
        fakeApi({
            'GET /widget/v1/loader.js': {
                status: 200,
                text: '<!doctype html><title>Welcome</title>',
            },
        });

        const view = await render(<BuilderPreview {...props()} />);

        await flush();

        expect(view.byTestId('preview-static')).not.toBeNull();
    });

    it('treats a network failure like a missing loader', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockRejectedValue(new TypeError('offline')),
        );

        const view = await render(<BuilderPreview {...props()} />);

        await flush();

        expect(view.byTestId('builder-preview-unavailable')).not.toBeNull();
        expect(view.byTestId('preview-static')).not.toBeNull();
    });

    it('draws launcher and greeting from the draft', async () => {
        fakeApi({ 'GET /widget/v1/loader.js': { status: 404 } });

        const config = defaultWidgetConfig();

        config.theme.primary = '#7c3aed';
        config.theme.launcherSize = 'lg';
        config.theme.offsetX = 36;
        config.theme.position = 'bottom-left';
        config.launcher.style = 'pill';
        config.launcher.label = 'Ask us';

        const view = await render(<BuilderPreview {...props({ config })} />);

        await flush();

        const launcher = view.byTestId('preview-launcher') as HTMLElement;
        const face = launcher.querySelector('.front') as HTMLElement;

        expect(launcher.style.left).toBe('36px');
        expect(launcher.style.bottom).toBe('20px');
        expect(face.style.background).toBe('rgb(124, 58, 237)');
        expect(face.style.height).toBe('72px');
        expect(launcher.textContent).toContain('Ask us');
        expect(view.byTestId('preview-greeting-body')?.textContent).toContain(
            'choosing a plan',
        );
        // A pill is wide, so the popup stacks above it on the launcher's own side.
        const popup = view.byTestId('preview-greeting') as HTMLElement;

        expect(popup.style.left).toBe('36px');
        expect(popup.style.bottom).toBe('104px');
    });

    it('labels the greeting\'s dismiss button with the draft\'s own "dismiss" text, like the real widget', async () => {
        fakeApi({ 'GET /widget/v1/loader.js': { status: 404 } });

        const config = defaultWidgetConfig();

        config.texts.en.dismiss = 'Got it';

        const custom = await render(<BuilderPreview {...props({ config })} />);

        await flush();

        expect(
            custom
                .byTestId('preview-greeting')
                ?.querySelector('button')
                ?.getAttribute('aria-label'),
        ).toBe('Got it');

        // Without an override the built-in English applies.
        const plain = await render(<BuilderPreview {...props()} />);

        await flush();

        expect(
            plain
                .byTestId('preview-greeting')
                ?.querySelector('button')
                ?.getAttribute('aria-label'),
        ).toBe('Dismiss');
    });

    it('puts the greeting beside a round launcher, on the side facing into the page', async () => {
        fakeApi({ 'GET /widget/v1/loader.js': { status: 404 } });

        const view = await render(<BuilderPreview {...props()} />);

        await flush();

        const popup = view.byTestId('preview-greeting') as HTMLElement;

        // bottom-right bubble: offset 20 + launcher 60 + a 12px gap from the right edge.
        expect(popup.style.right).toBe('92px');
        expect(popup.style.left).toBe('');
    });

    it('hides the greeting when greetings are off or the pool is empty', async () => {
        fakeApi({ 'GET /widget/v1/loader.js': { status: 404 } });

        const off = defaultWidgetConfig();

        off.greetings.enabled = false;

        const withoutGreetings = await render(
            <BuilderPreview {...props({ config: off })} />,
        );

        await flush();
        expect(withoutGreetings.byTestId('preview-greeting')).toBeNull();

        const empty = await render(
            <BuilderPreview {...props({ greetings: [] })} />,
        );

        await flush();
        expect(empty.byTestId('preview-greeting')).toBeNull();
    });

    it('shows only the active greeting for the language and honors "show agent"', async () => {
        fakeApi({ 'GET /widget/v1/loader.js': { status: 404 } });

        const config = defaultWidgetConfig();

        config.greetings.showAgent = false;

        const greetings = [
            toGreetingDraft(
                makeGreeting({ ulid: 'a', body: 'Inactive', is_active: false }),
            ),
            toGreetingDraft(
                makeGreeting({ ulid: 'b', body: 'Hola', locale: 'es' }),
            ),
            toGreetingDraft(
                makeGreeting({
                    ulid: 'c',
                    body: 'Hello there',
                    locale: null,
                    agent_name: 'Sara',
                }),
            ),
        ];
        const view = await render(
            <BuilderPreview {...props({ config, greetings })} />,
        );

        await flush();

        expect(view.byTestId('preview-greeting-body')?.textContent).toBe(
            'Hello there',
        );
        expect(view.byTestId('preview-greeting')?.textContent).not.toContain(
            'Sara',
        );
        expect(
            view
                .byTestId('preview-launcher')
                ?.querySelector('[data-flipped="true"]'),
        ).toBeNull();
    });

    it('draws the chat panel from the draft texts, categories and features', async () => {
        fakeApi({ 'GET /widget/v1/loader.js': { status: 404 } });

        const config = defaultWidgetConfig();

        config.texts.en.title = 'Help desk';
        config.texts.en.categoryPrompt = 'Pick a topic';
        config.features.poweredBy = false;

        const view = await render(<BuilderPreview {...props({ config })} />);

        await flush();
        await click(view.byTestId('builder-preview-panel'));

        const panel = view.byTestId('preview-panel')?.textContent ?? '';

        expect(panel).toContain('Help desk');
        expect(panel).toContain('Pick a topic');
        expect(panel).toContain('Sales');
        expect(panel).toContain('Type your message…');
        expect(panel).not.toContain('Powered by');
        // While the panel is open the greeting steps aside.
        expect(view.byTestId('preview-greeting')).toBeNull();
    });

    it('switches device, direction and scheme', async () => {
        fakeApi({ 'GET /widget/v1/loader.js': { status: 404 } });

        const view = await render(<BuilderPreview {...props()} />);

        await flush();

        const stage = () => view.byTestId('preview-static') as HTMLElement;

        expect(stage().getAttribute('data-device')).toBe('desktop');
        expect(stage().getAttribute('dir')).toBe('ltr');
        expect(stage().getAttribute('data-scheme')).toBe('light');

        await click(radio(view.container, 'Phone'));
        await click(radio(view.container, 'RTL'));
        await click(radio(view.container, 'Dark'));

        expect(stage().getAttribute('data-device')).toBe('phone');
        expect(stage().getAttribute('dir')).toBe('rtl');
        expect(stage().getAttribute('data-scheme')).toBe('dark');
        // On a phone the greeting becomes a bottom sheet across the viewport.
        expect(
            (view.byTestId('preview-greeting') as HTMLElement).style.left,
        ).toBe('12px');
        expect(
            (view.byTestId('preview-greeting') as HTMLElement).style.right,
        ).toBe('12px');
    });

    it('goes full screen on a phone when the chat panel is open', async () => {
        fakeApi({ 'GET /widget/v1/loader.js': { status: 404 } });

        const view = await render(<BuilderPreview {...props()} />);

        await flush();
        await click(radio(view.container, 'Phone'));
        await click(view.byTestId('builder-preview-panel'));

        expect(
            (view.byTestId('preview-panel') as HTMLElement).style.inset,
        ).toBe('0px');
        expect(view.byTestId('preview-launcher')).toBeNull();
    });

    it('follows the configured color scheme as the starting point', async () => {
        fakeApi({ 'GET /widget/v1/loader.js': { status: 404 } });

        const config = defaultWidgetConfig();

        config.theme.mode = 'dark';

        const view = await render(<BuilderPreview {...props({ config })} />);

        await flush();

        expect(
            view.byTestId('preview-static')?.getAttribute('data-scheme'),
        ).toBe('dark');
    });
});

describe('live view (real loader)', () => {
    async function liveView(overrides: Partial<BuilderPreviewProps> = {}) {
        const api = fakeApi({ 'GET /widget/v1/loader.js': BUILT_LOADER });
        const view = await render(<BuilderPreview {...props(overrides)} />);

        await flush();

        return { api, view };
    }

    it('becomes the default when the loader answers, and checks for it without cookies', async () => {
        const { api, view } = await liveView();

        expect(api.to('GET', LOADER_PATH)).toHaveLength(1);
        expect(api.fetchMock.mock.calls[0][1]).toMatchObject({
            method: 'GET',
            credentials: 'omit',
        });
        expect(iframeOf(view.container)).not.toBeNull();
        expect(view.byTestId('preview-static')).toBeNull();
        expect(view.byTestId('builder-preview-unavailable')).toBeNull();
    });

    it('loads the real loader with the draft boot config inside a same-origin srcdoc frame', async () => {
        const config = defaultWidgetConfig();

        config.theme.primary = '#abcdef';

        const { view } = await liveView({ config });
        const frame = iframeOf(view.container) as HTMLIFrameElement;
        const html = frame.getAttribute('srcdoc') ?? '';

        expect(html).toContain(
            `<script src="${ORIGIN}/widget/v1/loader.js" data-widget-key="wk_abc123"`,
        );
        expect(html).toContain('window.__PNE_CHAT_BOOT__["wk_abc123"]');
        expect(html).toContain('"primary":"#abcdef"');
        expect(html).toContain(
            '"embed":"https://chat.example.test/embed/wk_abc123?preview=1"',
        );
        expect(html).toContain('choosing a plan');
        expect(frame.getAttribute('sandbox')).toBe(
            'allow-scripts allow-same-origin allow-forms allow-popups',
        );
        expect(frame.getAttribute('title')).toBe('Widget preview');
    });

    it('sends the unsaved draft as a postMessage to the host relay, restricted to the dashboard origin', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });

        const { view } = await liveView();
        const frame = iframeOf(view.container) as HTMLIFrameElement;
        const post = vi.spyOn(frame.contentWindow as Window, 'postMessage');

        await loadFrame(frame);
        await act(async () => {
            vi.advanceTimersByTime(200);
        });

        expect(post).toHaveBeenCalledTimes(1);

        const [message, target] = post.mock.calls[0] as unknown as [
            Record<string, unknown>,
            string,
        ];

        expect(target).toBe(ORIGIN);
        expect(message).toMatchObject({
            ns: 'chatfeature',
            v: 1,
            type: 'draft',
            payload: {
                config: { v: 1, theme: { primary: '#0f766e', mode: 'light' } },
                greetings: [
                    {
                        id: 'g1',
                        body: expect.stringContaining('choosing a plan'),
                        agentName: 'Sara',
                    },
                ],
            },
        });
        // Policy stays server-side.
        expect(
            (message.payload as { config: object }).config,
        ).not.toHaveProperty('routing');
    });

    it('pushes every edit (debounced) without rebuilding the frame', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });

        fakeApi({ 'GET /widget/v1/loader.js': BUILT_LOADER });

        const data = makeBuilderData();
        const view = await render(<WidgetBuilder {...data} />);

        await flush();

        const frame = iframeOf(view.container) as HTMLIFrameElement;
        const post = vi.spyOn(frame.contentWindow as Window, 'postMessage');

        await loadFrame(frame);
        await act(async () => {
            vi.advanceTimersByTime(200);
        });
        post.mockClear();

        await mouseDown(byTestId(view.container, 'builder-tab-branding'));
        await fill(byLabelText(view.container, 'Primary color'), '#123456');
        await fill(byLabelText(view.container, 'Accent color'), '#654321');
        await act(async () => {
            vi.advanceTimersByTime(200);
        });

        // Two quick edits collapse into one message carrying both.
        expect(post).toHaveBeenCalledTimes(1);
        expect(post.mock.calls[0][0]).toMatchObject({
            payload: {
                config: { theme: { primary: '#123456', accent: '#654321' } },
            },
        });
        // Same frame, not a reload.
        expect(iframeOf(view.container)).toBe(frame);
    });

    it('previews the chosen scheme by overriding theme.mode, and rebuilds the host in that scheme', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });

        const { view } = await liveView();
        const before = iframeOf(view.container) as HTMLIFrameElement;

        expect(before.getAttribute('srcdoc')).toContain('data-scheme="light"');

        await click(radio(view.container, 'Dark'));

        const after = iframeOf(view.container) as HTMLIFrameElement;

        expect(after.getAttribute('srcdoc')).toContain('data-scheme="dark"');
        expect(after.getAttribute('srcdoc')).toContain('"mode":"dark"');

        const post = vi.spyOn(after.contentWindow as Window, 'postMessage');

        await loadFrame(after);
        await act(async () => {
            vi.advanceTimersByTime(200);
        });

        expect(
            (
                post.mock.calls[0][0] as {
                    payload: { config: { theme: { mode: string } } };
                }
            ).payload.config.theme.mode,
        ).toBe('dark');
    });

    it('applies direction to the host page', async () => {
        const { view } = await liveView();

        await click(radio(view.container, 'RTL'));

        expect(iframeOf(view.container)?.getAttribute('srcdoc')).toContain(
            'dir="rtl"',
        );
    });

    it('rebuilds the host when the greeting pool changes (boot-time data), after a short pause', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });

        fakeApi({ 'GET /widget/v1/loader.js': BUILT_LOADER });

        const view = await render(<WidgetBuilder {...makeBuilderData()} />);

        await flush();
        await mouseDown(byTestId(view.container, 'builder-tab-greetings'));
        await fill(
            byTestId(view.container, 'builder-greeting-0-body'),
            'A completely new greeting',
        );

        expect(iframeOf(view.container)?.getAttribute('srcdoc')).not.toContain(
            'A completely new greeting',
        );

        await act(async () => {
            vi.advanceTimersByTime(1000);
        });

        expect(iframeOf(view.container)?.getAttribute('srcdoc')).toContain(
            'A completely new greeting',
        );
    });

    describe('removals', () => {
        // `ChatFeature('update')` can restyle but never un-set, so an edit that removes something must reboot the host.
        async function openWith(draft = defaultWidgetConfig()) {
            vi.useFakeTimers({ shouldAdvanceTime: true });

            fakeApi({ 'GET /widget/v1/loader.js': BUILT_LOADER });

            const view = await render(
                <WidgetBuilder
                    {...makeBuilderData({ draft_config: draft, config: draft })}
                />,
            );

            await flush();

            return {
                view,
                html: () =>
                    iframeOf(view.container)?.getAttribute('srcdoc') ?? '',
                settle: () =>
                    act(async () => {
                        vi.advanceTimersByTime(1000);
                    }),
            };
        }

        it('reboots when a text override is cleared, but not when it is merely changed', async () => {
            const draft = defaultWidgetConfig();

            draft.texts.en.title = 'Custom help';

            const { view, html, settle } = await openWith(draft);

            expect(html()).toContain('Custom help');

            await mouseDown(byTestId(view.container, 'builder-tab-texts'));
            await fill(byTestId(view.container, 'builder-text-title'), 'Other');
            await settle();

            // A change is pushed live: the host document is untouched.
            expect(html()).toContain('Custom help');
            expect(html()).not.toContain('"title":"Other"');

            await fill(byTestId(view.container, 'builder-text-title'), '');
            await settle();

            // The host was rebuilt from the draft: neither the old nor the intermediate text is left.
            expect(html()).not.toContain('Custom help');
            expect(html()).not.toContain('"title":"Other"');
        });

        it('reboots when an agent photo / icon / font URL is emptied', async () => {
            const draft = defaultWidgetConfig();

            draft.launcher.avatarUrl = 'https://cdn.example.com/agent.png';

            const { view, html, settle } = await openWith(draft);

            expect(html()).toContain('https://cdn.example.com/agent.png');

            await mouseDown(byTestId(view.container, 'builder-tab-branding'));
            await fill(
                byLabelText(view.container, 'Default agent photo URL'),
                '',
            );
            await settle();

            expect(html()).not.toContain('https://cdn.example.com/agent.png');
        });

        it('reboots when a language is removed', async () => {
            const draft = defaultWidgetConfig();

            draft.texts.fr = { title: 'Aide en ligne' };

            const { view, html, settle } = await openWith(draft);

            expect(html()).toContain('Aide en ligne');

            await mouseDown(byTestId(view.container, 'builder-tab-texts'));
            await click(
                view.container.querySelector<HTMLElement>(
                    '[data-testid="builder-texts-locales"] input[value="fr"]',
                ),
            );
            await click(byTestId(view.container, 'builder-texts-remove'));
            await settle();

            expect(html()).not.toContain('Aide en ligne');
        });

        it('leaves the frame alone while only adding or changing things', async () => {
            const { view, html, settle } = await openWith();
            const frame = iframeOf(view.container);
            const before = html();

            await mouseDown(byTestId(view.container, 'builder-tab-branding'));
            await fill(byLabelText(view.container, 'Primary color'), '#123456');
            await fill(
                byLabelText(view.container, 'Default agent photo URL'),
                'https://cdn.example.com/new.png',
            );
            await settle();

            expect(iframeOf(view.container)).toBe(frame);
            expect(html()).toBe(before);
        });
    });

    it('reloads the frame on request', async () => {
        const { view } = await liveView();
        const before = iframeOf(view.container);

        await click(view.byTestId('builder-preview-reload'));

        expect(iframeOf(view.container)).not.toBeNull();
        expect(iframeOf(view.container)).not.toBe(before);
    });

    it('shows what the host reports and ignores messages that are not from its own frame', async () => {
        const { view } = await liveView();
        const frame = iframeOf(view.container) as HTMLIFrameElement;

        expect(
            view
                .byTestId('builder-preview-status')
                ?.getAttribute('data-loader'),
        ).toBe('loading');
        expect(view.byTestId('builder-preview-open-chat')).toBeNull();

        // Wrong origin, then wrong window: both ignored.
        await hostStatus(frame, 'ready', 'https://evil.example');
        await act(async () => {
            window.dispatchEvent(
                new MessageEvent('message', {
                    data: {
                        ns: PREVIEW_HOST_NS,
                        v: 1,
                        type: 'status',
                        loader: 'ready',
                        frame: true,
                    },
                    origin: ORIGIN,
                    source: window,
                }),
            );
        });

        expect(
            view
                .byTestId('builder-preview-status')
                ?.getAttribute('data-loader'),
        ).toBe('loading');

        await hostStatus(frame, 'ready');

        expect(
            view
                .byTestId('builder-preview-status')
                ?.getAttribute('data-loader'),
        ).toBe('ready');
        expect(view.byTestId('builder-preview-status')?.textContent).toBe(
            'Live widget running',
        );
        expect(view.byTestId('builder-preview-open-chat')).not.toBeNull();
    });

    it('asks the relay to open the chat panel', async () => {
        const { view } = await liveView();
        const frame = iframeOf(view.container) as HTMLIFrameElement;
        const post = vi.spyOn(frame.contentWindow as Window, 'postMessage');

        await hostStatus(frame, 'ready');
        await click(view.byTestId('builder-preview-open-chat'));

        expect(post).toHaveBeenCalledWith(
            { ns: PREVIEW_HOST_NS, v: 1, type: 'command', name: 'open' },
            ORIGIN,
        );
    });

    it('flags a loader that failed to start', async () => {
        const { view } = await liveView();

        await hostStatus(iframeOf(view.container), 'error');

        expect(view.byTestId('builder-preview-status')?.textContent).toBe(
            'Widget failed to start',
        );
        expect(view.byTestId('builder-preview-open-chat')).toBeNull();
    });

    it('can be switched to the approximation and back', async () => {
        const { view } = await liveView();

        await click(radio(view.container, 'Approximation'));

        expect(view.byTestId('preview-static')).not.toBeNull();
        expect(iframeOf(view.container)).toBeNull();

        await click(radio(view.container, 'Live widget'));

        expect(iframeOf(view.container)).not.toBeNull();
    });

    it('jumps to the approximation when a greeting is previewed', async () => {
        fakeApi({ 'GET /widget/v1/loader.js': BUILT_LOADER });

        const view = await render(<WidgetBuilder {...makeBuilderData()} />);

        await flush();

        expect(iframeOf(view.container)).not.toBeNull();

        await mouseDown(byTestId(view.container, 'builder-tab-greetings'));
        await click(byTestId(view.container, 'builder-greeting-1-preview'));

        expect(iframeOf(view.container)).toBeNull();
        expect(view.byTestId('preview-greeting-body')?.textContent).toBe(
            'Questions about billing?',
        );
    });
});

describe('device frame', () => {
    it('keeps the natural viewport size and reports the scale it renders at', async () => {
        fakeApi({ 'GET /widget/v1/loader.js': { status: 404 } });

        const view = await render(<BuilderPreview {...props()} />);

        await flush();

        // jsdom has no layout: nothing to shrink to, so the preview stays at 1:1.
        expect(
            view.byTestId('builder-preview-frame')?.getAttribute('data-scale'),
        ).toBe('1.000');
        expect(
            view.byTestId('builder-preview')?.getAttribute('aria-label'),
        ).toBe('Live preview');
    });
});
