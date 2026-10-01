import '@/tests/dom-polyfills';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vite-plus/test';
import WidgetBuilder from '@/pages/widgets/builder';
import {
    blur,
    body,
    byAriaLabel,
    byLabelText,
    byTestId,
    choose,
    fill,
    mouseDown,
    radio,
} from '@/tests/dom';
import { setViewportWidth } from '@/tests/dom-polyfills';
import { fakeApi, type FakeCall } from '@/tests/fake-api';
import {
    CATEGORIES,
    makeBuilderData,
    makeGreeting,
    makeWidget,
} from '@/tests/fixtures';
import { resetInertiaMock, routerMock } from '@/tests/inertia-mock';
import { click, flush, render, type Rendered } from '@/tests/render';
import { defaultWidgetConfig } from '@/lib/widget-config';
import type { WidgetBuilderData } from '@/types/widgets';

vi.mock('@inertiajs/react', async () =>
    (await import('@/tests/inertia-mock')).inertiaMock(),
);

type Routes = Parameters<typeof fakeApi>[0];

const DATA = () => makeBuilderData();

async function setup(
    data: WidgetBuilderData = DATA(),
    routes: Routes = {},
    { loader = 404 }: { loader?: number } = {},
) {
    const api = fakeApi({
        'HEAD /widget/v1/loader.js': { status: loader },
        ...routes,
    });
    const view = await render(<WidgetBuilder {...data} />);

    await flush();

    return { api, view };
}

async function openTab(view: Rendered, tab: string) {
    await mouseDown(byTestId(view.container, `builder-tab-${tab}`));
}

beforeEach(() => {
    resetInertiaMock();
    setViewportWidth(1440);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    setViewportWidth(1440);
});

/** `PUT .../draft` body -> the config. */
const draftOf = (api: ReturnType<typeof fakeApi>) =>
    (
        api.bodyOf('PUT', '/api/v1/widgets/w1/draft') as {
            config: ReturnType<typeof defaultWidgetConfig>;
        }
    ).config;

describe('header and state badges', () => {
    it('starts clean: nothing to save, nothing to publish', async () => {
        const { view } = await setup();

        expect(
            (view.byTestId('builder-save') as HTMLButtonElement).disabled,
        ).toBe(true);
        expect(
            (view.byTestId('builder-publish') as HTMLButtonElement).disabled,
        ).toBe(true);
        expect(view.byTestId('builder-badge-published')?.textContent).toContain(
            'Published v3',
        );
        expect(view.byTestId('builder-title')?.textContent).toBe(
            'Marketing site',
        );
    });

    it('offers Publish when the saved draft differs from what visitors get', async () => {
        const draft = defaultWidgetConfig();

        draft.theme.primary = '#123456';

        const { view } = await setup(
            makeBuilderData({
                draft_config: draft,
                widget: makeWidget({ has_unpublished_changes: true }),
            }),
        );

        expect(
            view.byTestId('builder-badge-unpublished')?.textContent,
        ).toContain('Draft not published');
        expect(
            (view.byTestId('builder-save') as HTMLButtonElement).disabled,
        ).toBe(true);
        expect(
            (view.byTestId('builder-publish') as HTMLButtonElement).disabled,
        ).toBe(false);
    });

    it('turns dirty as soon as something is edited and shows the disabled state of the widget', async () => {
        const { view } = await setup();

        await fill(byLabelText(view.container, 'Widget name'), 'Docs site');

        expect(view.byTestId('builder-badge-dirty')?.textContent).toContain(
            'Unsaved changes',
        );
        expect(view.byTestId('builder-title')?.textContent).toBe('Docs site');
        expect(
            (view.byTestId('builder-save') as HTMLButtonElement).disabled,
        ).toBe(false);

        await click(byLabelText(view.container, 'Widget enabled'));

        expect(view.byTestId('builder-badge-disabled')).not.toBeNull();

        // Reverting both edits makes it clean again.
        await fill(
            byLabelText(view.container, 'Widget name'),
            'Marketing site',
        );
        await click(byLabelText(view.container, 'Widget enabled'));

        expect(view.byTestId('builder-badge-published')).not.toBeNull();
        expect(
            (view.byTestId('builder-save') as HTMLButtonElement).disabled,
        ).toBe(true);
    });
});

describe('general tab', () => {
    it('shows the idle timeout explanation with the current value and the default', async () => {
        const { view } = await setup();

        expect(view.byTestId('builder-panel-general')?.textContent).toContain(
            'Chat closes after 120 minutes without messages. Default: 120.',
        );

        await fill(byLabelText(view.container, 'Idle timeout'), '45');

        expect(view.byTestId('builder-panel-general')?.textContent).toContain(
            'Chat closes after 45 minutes without messages. Default: 120.',
        );
    });

    it('never lets an out-of-range timeout into the model: error while typing, clamped on blur', async () => {
        const { view } = await setup();
        const input = byLabelText(
            view.container,
            'Idle timeout',
        ) as HTMLInputElement;

        await fill(input, '4');

        expect(view.byTestId('builder-panel-general')?.textContent).toContain(
            'Enter a whole number from 5 to 10080.',
        );
        expect(view.byTestId('builder-panel-general')?.textContent).toContain(
            'Chat closes after 120 minutes',
        );
        expect(view.byTestId('builder-badge-dirty')).toBeNull();

        await blur(input);

        expect(input.value).toBe('5');
        expect(view.byTestId('builder-panel-general')?.textContent).toContain(
            'Chat closes after 5 minutes',
        );

        await fill(input, '99999');
        await blur(input);

        expect(input.value).toBe('10080');

        await fill(input, '');
        await blur(input);

        expect(input.value).toBe('10080');
    });

    it('edits queue timeout, availability mode, time zone and the non-browser switch', async () => {
        const api = fakeApi({
            'HEAD /widget/v1/loader.js': { status: 404 },
            'PATCH /api/v1/widgets/w1': { json: { data: makeWidget() } },
            'PUT /api/v1/widgets/w1/draft': { json: { data: {} } },
        });
        const view = await render(<WidgetBuilder {...DATA()} />);

        await flush();
        await fill(byLabelText(view.container, 'Waiting time'), '60');
        await click(radio(view.container, 'Always online'));
        await choose(
            byLabelText(
                view.container,
                'Time zone',
            ) as unknown as HTMLSelectElement,
            'Europe/Berlin',
        );
        await click(byLabelText(view.container, 'Allow non-browser clients'));
        await click(view.byTestId('builder-save'));
        await flush();

        expect(api.bodyOf('PATCH', '/api/v1/widgets/w1')).toEqual({
            queue_timeout_seconds: 60,
            offline_mode: 'always_online',
            timezone: 'Europe/Berlin',
            allow_non_browser_clients: true,
        });

        const config = draftOf(api);

        // The mirrors in the config follow the columns.
        expect(config.routing.queueTimeoutSeconds).toBe(60);
        expect(config.hours).toMatchObject({
            mode: 'always_online',
            timezone: 'Europe/Berlin',
        });
    });
});

describe('save draft', () => {
    it('saves every dirty slice with its own request and body, in a fixed order', async () => {
        const api = fakeApi({
            'HEAD /widget/v1/loader.js': { status: 404 },
            'PATCH /api/v1/widgets/w1': {
                json: { data: makeWidget({ name: 'Docs' }) },
            },
            'PUT /api/v1/widgets/w1/draft': { json: { data: {} } },
            'PUT /api/v1/widgets/w1/greetings': { json: { data: [] } },
            'PUT /api/v1/widgets/w1/domains': {
                json: {
                    data: { domains: ['example.com', 'docs.example.com'] },
                },
            },
            'PUT /api/v1/widgets/w1/categories': { json: { data: {} } },
        });
        const view = await render(<WidgetBuilder {...DATA()} />);

        await flush();

        // general
        await fill(byLabelText(view.container, 'Widget name'), 'Docs');
        // branding
        await openTab(view, 'branding');
        await fill(byLabelText(view.container, 'Primary color'), '#112233');
        // greetings
        await openTab(view, 'greetings');
        await fill(
            byTestId(view.container, 'builder-greeting-0-body'),
            'Welcome to the docs!',
        );
        // domains
        await openTab(view, 'domains');
        await fill(
            byTestId(view.container, 'builder-domain-input'),
            'Docs.Example.com',
        );
        await click(byTestId(view.container, 'builder-domain-add'));
        // categories
        await openTab(view, 'categories');
        await click(byTestId(view.container, 'builder-category-add-cat2'));

        await click(view.byTestId('builder-save'));
        await flush();

        expect(api.unhandled).toEqual([]);
        expect(
            api.calls
                .filter((c) => c.method !== 'HEAD')
                .map((c) => `${c.method} ${c.path}`),
        ).toEqual([
            'PATCH /api/v1/widgets/w1',
            'PUT /api/v1/widgets/w1/draft',
            'PUT /api/v1/widgets/w1/greetings',
            'PUT /api/v1/widgets/w1/domains',
            'PUT /api/v1/widgets/w1/categories',
        ]);
        expect(api.bodyOf('PATCH', '/api/v1/widgets/w1')).toEqual({
            name: 'Docs',
        });
        expect(draftOf(api).theme.primary).toBe('#112233');
        expect(draftOf(api)).toHaveProperty('v', 1);
        expect(api.bodyOf('PUT', '/api/v1/widgets/w1/domains')).toEqual({
            domains: ['example.com', 'docs.example.com'],
        });
        expect(api.bodyOf('PUT', '/api/v1/widgets/w1/categories')).toEqual({
            category_ulids: ['cat1', 'cat2'],
        });
        expect(api.bodyOf('PUT', '/api/v1/widgets/w1/greetings')).toEqual({
            greetings: [
                {
                    ulid: 'g1',
                    body: 'Welcome to the docs!',
                    agent_name: 'Sara',
                    agent_avatar_url: null,
                    locale: null,
                    weight: 2,
                    is_active: true,
                    sort_order: 0,
                },
                {
                    ulid: 'g2',
                    body: 'Questions about billing?',
                    agent_name: 'Omar',
                    agent_avatar_url: null,
                    locale: null,
                    weight: 1,
                    is_active: true,
                    sort_order: 1,
                },
            ],
        });

        // Saved: clean, but the changed config is now an unpublished draft.
        expect(
            (view.byTestId('builder-save') as HTMLButtonElement).disabled,
        ).toBe(true);
        expect(view.byTestId('builder-badge-unpublished')).not.toBeNull();
        expect(view.byTestId('builder-status-message')?.textContent).toContain(
            'Draft saved',
        );
        expect(
            (view.byTestId('builder-publish') as HTMLButtonElement).disabled,
        ).toBe(false);
    });

    it('sends nothing for slices that did not change', async () => {
        const api = fakeApi({
            'HEAD /widget/v1/loader.js': { status: 404 },
            'PUT /api/v1/widgets/w1/draft': { json: { data: {} } },
        });
        const view = await render(<WidgetBuilder {...DATA()} />);

        await flush();
        await openTab(view, 'branding');
        await fill(byLabelText(view.container, 'Primary color'), '#abcdef');
        await click(view.byTestId('builder-save'));
        await flush();

        expect(
            api.calls
                .filter((c) => c.method !== 'HEAD')
                .map((c) => `${c.method} ${c.path}`),
        ).toEqual(['PUT /api/v1/widgets/w1/draft']);
    });

    it('sends the XSRF header and JSON like the rest of the dashboard', async () => {
        document.cookie = 'XSRF-TOKEN=abc%3D; path=/';

        const api = fakeApi({
            'HEAD /widget/v1/loader.js': { status: 404 },
            'PATCH /api/v1/widgets/w1': { json: { data: makeWidget() } },
        });
        const view = await render(<WidgetBuilder {...DATA()} />);

        await flush();
        await fill(byLabelText(view.container, 'Widget name'), 'X');
        await click(view.byTestId('builder-save'));
        await flush();

        const call = api.to('PATCH', '/api/v1/widgets/w1')[0] as FakeCall;

        expect(call.headers).toMatchObject({
            'X-XSRF-TOKEN': 'abc=',
            Accept: 'application/json',
            'Content-Type': 'application/json',
        });
        document.cookie =
            'XSRF-TOKEN=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
    });

    it('takes the server-normalised domains and greeting ids as the new baseline', async () => {
        const api = fakeApi({
            'HEAD /widget/v1/loader.js': { status: 404 },
            'PUT /api/v1/widgets/w1/greetings': {
                json: {
                    data: [
                        makeGreeting({
                            ulid: 'srv1',
                            sort_order: 0,
                            body: 'Brand new',
                        }),
                    ],
                },
            },
        });
        const view = await render(
            <WidgetBuilder {...makeBuilderData({ greetings: [] })} />,
        );

        await flush();
        await openTab(view, 'greetings');
        await click(byTestId(view.container, 'builder-greeting-add'));
        await fill(
            byTestId(view.container, 'builder-greeting-0-body'),
            'Brand new',
        );
        await click(view.byTestId('builder-save'));
        await flush();

        expect(api.bodyOf('PUT', '/api/v1/widgets/w1/greetings')).toMatchObject(
            {
                greetings: [{ body: 'Brand new', sort_order: 0 }],
            },
        );
        expect(
            (view.byTestId('builder-save') as HTMLButtonElement).disabled,
        ).toBe(true);

        // A second save without edits does nothing.
        await click(view.byTestId('builder-save'));
        expect(api.to('PUT', '/api/v1/widgets/w1/greetings')).toHaveLength(1);
    });
});

describe('validation', () => {
    it('maps a server 422 onto the field, marks the tab and jumps to it', async () => {
        const api = fakeApi({
            'HEAD /widget/v1/loader.js': { status: 404 },
            'PATCH /api/v1/widgets/w1': {
                json: { data: makeWidget({ name: 'Docs' }) },
            },
            'PUT /api/v1/widgets/w1/draft': {
                status: 422,
                json: {
                    error: {
                        code: 'validation_failed',
                        message: 'Invalid',
                        details: {
                            'config.theme.primary': [
                                'The primary color is not allowed.',
                            ],
                        },
                    },
                },
            },
        });
        const view = await render(<WidgetBuilder {...DATA()} />);

        await flush();
        await fill(byLabelText(view.container, 'Widget name'), 'Docs');
        await openTab(view, 'branding');
        await fill(byLabelText(view.container, 'Primary color'), '#010101');
        await openTab(view, 'general');
        await click(view.byTestId('builder-save'));
        await flush();

        expect(api.to('PATCH', '/api/v1/widgets/w1')).toHaveLength(1);
        // The failing slice stays dirty, the one that worked is saved.
        expect(view.byTestId('builder-badge-dirty')).not.toBeNull();
        expect(view.byTestId('builder-status-message')?.textContent).toContain(
            'Some changes could not be saved',
        );
        expect(view.byTestId('builder-tab-branding-error')).not.toBeNull();
        expect(view.byTestId('builder-tab-general-error')).toBeNull();
        // Jumped to the first tab with an error and shows the message at the field.
        expect(view.byTestId('builder-panel-branding')?.textContent).toContain(
            'The primary color is not allowed.',
        );

        // Editing the field clears its error and the tab marker.
        await fill(byLabelText(view.container, 'Primary color'), '#020202');

        expect(view.byTestId('builder-tab-branding-error')).toBeNull();
        expect(
            view.byTestId('builder-panel-branding')?.textContent,
        ).not.toContain('The primary color is not allowed.');
    });

    it('maps greeting and domain errors by position', async () => {
        fakeApi({
            'HEAD /widget/v1/loader.js': { status: 404 },
            'PUT /api/v1/widgets/w1/greetings': {
                status: 422,
                json: {
                    error: {
                        code: 'validation_failed',
                        message: 'x',
                        details: { 'greetings.1.body': ['Plain text only.'] },
                    },
                },
            },
            'PUT /api/v1/widgets/w1/domains': {
                status: 422,
                json: {
                    error: {
                        code: 'validation_failed',
                        message: 'x',
                        details: { 'domains.0': ['Not a valid host.'] },
                    },
                },
            },
        });
        const view = await render(<WidgetBuilder {...DATA()} />);

        await flush();
        await openTab(view, 'greetings');
        await fill(
            byTestId(view.container, 'builder-greeting-1-body'),
            'Edited',
        );
        await openTab(view, 'domains');
        await click(byTestId(view.container, 'builder-domain-remove-0'));
        await fill(
            byTestId(view.container, 'builder-domain-input'),
            'good.example.com',
        );
        await click(byTestId(view.container, 'builder-domain-add'));
        await click(view.byTestId('builder-save'));
        await flush();

        expect(view.byTestId('builder-tab-greetings-error')).not.toBeNull();
        expect(view.byTestId('builder-tab-domains-error')).not.toBeNull();
        // Greetings come first in the tab order: the view jumps there.
        expect(view.byTestId('builder-panel-greetings')?.textContent).toContain(
            'Plain text only.',
        );
        await openTab(view, 'domains');
        expect(view.byTestId('builder-panel-domains')?.textContent).toContain(
            'Not a valid host.',
        );
    });

    it('stops before the network when the draft has obvious mistakes', async () => {
        const api = fakeApi({ 'HEAD /widget/v1/loader.js': { status: 404 } });
        const view = await render(<WidgetBuilder {...DATA()} />);

        await flush();
        await openTab(view, 'hours');
        await click(byTestId(view.container, 'builder-hours-add-6'));
        await fill(byTestId(view.container, 'builder-hours-start-5'), '18:00');
        await fill(byTestId(view.container, 'builder-hours-end-5'), '09:00');
        await click(view.byTestId('builder-save'));
        await flush();

        expect(api.calls.filter((c) => c.method !== 'HEAD')).toHaveLength(0);
        expect(view.byTestId('builder-status-message')?.textContent).toContain(
            'Fix the highlighted fields',
        );
        expect(view.byTestId('builder-tab-hours-error')).not.toBeNull();
        expect(view.byTestId('builder-panel-hours')?.textContent).toContain(
            'Closing time must be after opening time.',
        );
    });

    it('reports a failed save with the transport reason', async () => {
        fakeApi({
            'HEAD /widget/v1/loader.js': { status: 404 },
            'PATCH /api/v1/widgets/w1': {
                status: 500,
                json: { error: { code: 'server_error', message: 'x' } },
            },
        });
        const view = await render(<WidgetBuilder {...DATA()} />);

        await flush();
        await fill(byLabelText(view.container, 'Widget name'), 'X');
        await click(view.byTestId('builder-save'));
        await flush();

        expect(view.byTestId('builder-status-message')?.textContent).toContain(
            'server hit an error',
        );
        expect(
            view.byTestId('builder-status-message')?.getAttribute('data-tone'),
        ).toBe('error');
        expect(view.byTestId('builder-badge-dirty')).not.toBeNull();
    });
});

describe('publish', () => {
    it('saves pending changes first, then publishes and shows the new version', async () => {
        const api = fakeApi({
            'HEAD /widget/v1/loader.js': { status: 404 },
            'PUT /api/v1/widgets/w1/draft': { json: { data: {} } },
            'POST /api/v1/widgets/w1/publish': {
                json: {
                    data: makeWidget({
                        config_version: 4,
                        has_unpublished_changes: false,
                    }),
                },
            },
        });
        const view = await render(<WidgetBuilder {...DATA()} />);

        await flush();
        await openTab(view, 'branding');
        await fill(byLabelText(view.container, 'Primary color'), '#445566');
        await click(view.byTestId('builder-publish'));

        // Confirmation first; it warns that unsaved changes are saved too.
        expect(body.byTestId('builder-publish-dialog')?.textContent).toContain(
            'Your unsaved changes are saved first',
        );
        expect(api.calls.filter((c) => c.method !== 'HEAD')).toHaveLength(0);

        await click(body.byTestId('builder-publish-confirm'));
        await flush();

        expect(
            api.calls
                .filter((c) => c.method !== 'HEAD')
                .map((c) => `${c.method} ${c.path}`),
        ).toEqual([
            'PUT /api/v1/widgets/w1/draft',
            'POST /api/v1/widgets/w1/publish',
        ]);
        expect(view.byTestId('builder-badge-published')?.textContent).toContain(
            'Published v4',
        );
        expect(view.byTestId('builder-status-message')?.textContent).toContain(
            'Published as version 4',
        );
        expect(
            (view.byTestId('builder-publish') as HTMLButtonElement).disabled,
        ).toBe(true);
    });

    it('does not publish when saving the draft fails', async () => {
        const api = fakeApi({
            'HEAD /widget/v1/loader.js': { status: 404 },
            'PUT /api/v1/widgets/w1/draft': {
                status: 422,
                json: {
                    error: {
                        code: 'validation_failed',
                        message: 'x',
                        details: { 'config.theme.radius': ['Too round.'] },
                    },
                },
            },
        });
        const view = await render(<WidgetBuilder {...DATA()} />);

        await flush();
        await openTab(view, 'branding');
        await fill(byLabelText(view.container, 'Primary color'), '#445566');
        await click(view.byTestId('builder-publish'));
        await click(body.byTestId('builder-publish-confirm'));
        await flush();

        expect(api.to('POST', '/api/v1/widgets/w1/publish')).toHaveLength(0);
        expect(view.byTestId('builder-badge-published')).toBeNull();
    });

    it('keeps the draft state and shows the reason when publishing itself fails', async () => {
        const draft = defaultWidgetConfig();

        draft.theme.radius = 4;

        fakeApi({
            'HEAD /widget/v1/loader.js': { status: 404 },
            'POST /api/v1/widgets/w1/publish': {
                status: 500,
                json: { error: { code: 'server_error', message: 'x' } },
            },
        });

        const view = await render(
            <WidgetBuilder
                {...makeBuilderData({
                    draft_config: draft,
                    widget: makeWidget({ has_unpublished_changes: true }),
                })}
            />,
        );

        await flush();
        await click(view.byTestId('builder-publish'));

        expect(body.byTestId('builder-publish-dialog')?.textContent).toContain(
            'Visitors get the current draft',
        );

        await click(body.byTestId('builder-publish-confirm'));
        await flush();

        expect(view.byTestId('builder-status-message')?.textContent).toContain(
            'server hit an error',
        );
        expect(view.byTestId('builder-badge-unpublished')).not.toBeNull();
        expect(
            (view.byTestId('builder-publish') as HTMLButtonElement).disabled,
        ).toBe(false);
    });
});

describe('unsaved changes guard', () => {
    const beforeHandler = () =>
        routerMock.on.mock.calls.find(([event]) => event === 'before')?.[1] as
            | ((event: unknown) => void)
            | undefined;

    it('only guards once something is dirty', async () => {
        const { view } = await setup();

        expect(beforeHandler()).toBeUndefined();

        const add = vi.spyOn(window, 'addEventListener');

        await fill(byLabelText(view.container, 'Widget name'), 'X');

        expect(add.mock.calls.some(([type]) => type === 'beforeunload')).toBe(
            true,
        );
        expect(beforeHandler()).toBeDefined();
    });

    it('cancels in-app navigation unless the user confirms leaving', async () => {
        const { view } = await setup();

        await fill(byLabelText(view.container, 'Widget name'), 'X');

        const confirm = vi.spyOn(window, 'confirm');
        const stay = { preventDefault: vi.fn(), detail: {} };
        const leave = { preventDefault: vi.fn(), detail: {} };

        confirm.mockReturnValueOnce(false);
        beforeHandler()?.(stay);
        confirm.mockReturnValueOnce(true);
        beforeHandler()?.(leave);

        expect(stay.preventDefault).toHaveBeenCalledTimes(1);
        expect(leave.preventDefault).not.toHaveBeenCalled();
    });

    it('asks the browser before closing the tab and stops guarding after saving', async () => {
        const api = fakeApi({
            'HEAD /widget/v1/loader.js': { status: 404 },
            'PATCH /api/v1/widgets/w1': { json: { data: makeWidget() } },
        });
        const view = await render(<WidgetBuilder {...DATA()} />);

        await flush();
        await fill(byLabelText(view.container, 'Widget name'), 'X');

        const event = new Event('beforeunload', { cancelable: true });

        window.dispatchEvent(event);

        expect(event.defaultPrevented).toBe(true);

        await click(view.byTestId('builder-save'));
        await flush();

        const after = new Event('beforeunload', { cancelable: true });

        window.dispatchEvent(after);

        expect(api.to('PATCH', '/api/v1/widgets/w1')).toHaveLength(1);
        expect(after.defaultPrevented).toBe(false);
    });
});

describe('branding tab', () => {
    it('grades text contrast with a number and a verdict, and fixes the text color on request', async () => {
        const { view } = await setup();

        await openTab(view, 'branding');

        expect(
            view
                .byTestId('builder-contrast-button')
                ?.getAttribute('data-grade'),
        ).toBe('aa');
        expect(view.byTestId('builder-contrast-button')?.textContent).toContain(
            '5.4:1',
        );
        expect(
            view.byTestId('builder-contrast-body')?.getAttribute('data-grade'),
        ).toBe('aaa');

        await fill(byLabelText(view.container, 'Primary color'), '#facc15');

        expect(
            view
                .byTestId('builder-contrast-button')
                ?.getAttribute('data-grade'),
        ).toBe('fail');
        expect(view.byTestId('builder-contrast-button')?.textContent).toContain(
            'Too low',
        );

        await click(view.byTestId('builder-auto-primary-text'));

        expect(
            (byLabelText(view.container, 'Text on primary') as HTMLInputElement)
                .value,
        ).toBe('#0f172a');
        expect(
            view
                .byTestId('builder-contrast-button')
                ?.getAttribute('data-grade'),
        ).toBe('aaa');
    });

    it('does not accept an invalid color but says why and keeps the last good one', async () => {
        const { view } = await setup();

        await openTab(view, 'branding');

        const input = byLabelText(
            view.container,
            'Primary color',
        ) as HTMLInputElement;

        await fill(input, 'teal');

        expect(view.byTestId('builder-panel-branding')?.textContent).toContain(
            'Use a hex color such as #0f766e.',
        );
        expect(view.byTestId('builder-badge-dirty')).toBeNull();

        await blur(input);

        expect(input.value).toBe('#0f766e');
    });

    it('accepts 3-digit hex and the native color picker', async () => {
        const { view } = await setup();

        await openTab(view, 'branding');
        await fill(byLabelText(view.container, 'Accent color'), '#f0a');

        expect(view.byTestId('builder-badge-dirty')).not.toBeNull();

        const picker = byAriaLabel(view.container, 'Pick Primary color');

        await fill(picker, '#336699');

        expect(
            (byLabelText(view.container, 'Primary color') as HTMLInputElement)
                .value,
        ).toBe('#336699');
    });

    it('moves and restyles the launcher in the preview as the draft changes', async () => {
        const { view } = await setup();
        const launcher = () => view.byTestId('preview-launcher');

        expect(launcher()?.getAttribute('data-position')).toBe('bottom-right');
        expect(launcher()?.getAttribute('data-style')).toBe('bubble');

        await openTab(view, 'branding');
        await click(radio(view.container, 'Bottom left'));
        await click(radio(view.container, 'Pill with label'));
        await click(radio(view.container, 'Large · 72px'));
        await fill(byLabelText(view.container, 'Label'), 'Ask us anything');

        expect(launcher()?.getAttribute('data-position')).toBe('bottom-left');
        expect(launcher()?.getAttribute('data-style')).toBe('pill');
        expect(launcher()?.getAttribute('data-size')).toBe('lg');
        expect(launcher()?.textContent).toContain('Ask us anything');
        expect(launcher()?.style.left).toBe('20px');
        expect(launcher()?.style.right).toBe('');
    });

    it('asks for the icon image only when the icon is custom', async () => {
        const { view } = await setup();

        await openTab(view, 'branding');

        expect(byLabelText(view.container, 'Icon image URL')).toBeNull();

        await click(radio(view.container, 'Custom image'));

        expect(byLabelText(view.container, 'Icon image URL')).not.toBeNull();
    });

    it('edits radius, font, panel size and stacking order into the draft', async () => {
        const api = fakeApi({
            'HEAD /widget/v1/loader.js': { status: 404 },
            'PUT /api/v1/widgets/w1/draft': { json: { data: {} } },
        });
        const view = await render(<WidgetBuilder {...DATA()} />);

        await flush();
        await openTab(view, 'branding');
        await fill(byLabelText(view.container, 'Corner radius'), '6');
        await fill(
            byLabelText(view.container, 'Font family'),
            'Georgia, serif',
        );
        await fill(
            byLabelText(view.container, 'Font stylesheet URL'),
            'https://fonts.googleapis.com/css2?family=Inter',
        );
        await fill(byLabelText(view.container, 'Panel width'), '420');
        await fill(byLabelText(view.container, 'Horizontal offset'), '32');
        await click(radio(view.container, 'Strong'));
        await click(view.byTestId('builder-save'));
        await flush();

        expect(draftOf(api).theme).toMatchObject({
            radius: 6,
            fontFamily: 'Georgia, serif',
            fontUrl: 'https://fonts.googleapis.com/css2?family=Inter',
            panelWidth: 420,
            offsetX: 32,
            shadow: 'strong',
        });
    });

    it('rejects a font stylesheet from an unknown host before saving', async () => {
        const api = fakeApi({ 'HEAD /widget/v1/loader.js': { status: 404 } });
        const view = await render(<WidgetBuilder {...DATA()} />);

        await flush();
        await openTab(view, 'branding');
        await fill(
            byLabelText(view.container, 'Font stylesheet URL'),
            'https://evil.example/x.css',
        );
        await click(view.byTestId('builder-save'));
        await flush();

        expect(api.calls.filter((c) => c.method !== 'HEAD')).toHaveLength(0);
        expect(view.byTestId('builder-panel-branding')?.textContent).toContain(
            'fonts.googleapis.com',
        );
    });
});

describe('texts tab', () => {
    it('shows every text of the default language with the built-in English as placeholder', async () => {
        const { view } = await setup();

        await openTab(view, 'texts');

        expect(view.byTestId('builder-texts-en')).not.toBeNull();
        expect(
            view
                .byTestId('builder-panel-texts')
                ?.querySelectorAll('[data-testid^="builder-text-"]'),
        ).toHaveLength(17);
        expect(
            (view.byTestId('builder-text-title') as HTMLInputElement).value,
        ).toBe('Support');
        expect(
            (view.byTestId('builder-text-welcome') as HTMLTextAreaElement)
                .value,
        ).toBe('Hi! How can we help you today?');
    });

    it('adds a language, translates a text and falls back for the rest', async () => {
        const api = fakeApi({
            'HEAD /widget/v1/loader.js': { status: 404 },
            'PUT /api/v1/widgets/w1/draft': { json: { data: {} } },
        });
        const view = await render(<WidgetBuilder {...DATA()} />);

        await flush();
        await openTab(view, 'texts');
        await fill(
            view.byTestId('builder-texts-add-input') as HTMLInputElement,
            'ar',
        );
        await click(view.byTestId('builder-texts-add'));

        expect(view.byTestId('builder-texts-ar')?.textContent).toContain(
            '0 of 17 texts translated',
        );
        // Empty fields show the default-language text as placeholder (the fallback).
        expect(
            (view.byTestId('builder-text-title') as HTMLInputElement)
                .placeholder,
        ).toBe('Support');

        await fill(
            view.byTestId('builder-text-title') as HTMLInputElement,
            'الدعم',
        );

        expect(view.byTestId('builder-texts-ar')?.textContent).toContain(
            '1 of 17 texts translated',
        );
        expect(
            (
                view.byTestId('builder-text-title') as HTMLInputElement
            ).getAttribute('dir'),
        ).toBe('rtl');

        await click(view.byTestId('builder-save'));
        await flush();

        expect(draftOf(api).texts).toEqual({
            en: expect.objectContaining({ title: 'Support' }),
            ar: { title: 'الدعم' },
        });
    });

    it('refuses duplicate and malformed language codes', async () => {
        const { view } = await setup();

        await openTab(view, 'texts');
        await fill(
            view.byTestId('builder-texts-add-input') as HTMLInputElement,
            'en',
        );
        await click(view.byTestId('builder-texts-add'));

        expect(view.byTestId('builder-panel-texts')?.textContent).toContain(
            'That language is already added.',
        );

        await fill(
            view.byTestId('builder-texts-add-input') as HTMLInputElement,
            'English',
        );
        await click(view.byTestId('builder-texts-add'));

        expect(view.byTestId('builder-panel-texts')?.textContent).toContain(
            'Use a language code',
        );
        expect(view.byTestId('builder-badge-dirty')).toBeNull();
    });

    it('removes a non-default language and clears emptied texts', async () => {
        const { view } = await setup();

        await openTab(view, 'texts');
        await fill(
            view.byTestId('builder-texts-add-input') as HTMLInputElement,
            'fr',
        );
        await click(view.byTestId('builder-texts-add'));
        await click(view.byTestId('builder-texts-remove'));

        expect(view.byTestId('builder-texts-fr')).toBeNull();
        expect(view.byTestId('builder-texts-en')).not.toBeNull();
        expect(view.byTestId('builder-texts-remove')).toBeNull();

        // Emptying a default text means "use the built-in English" again.
        await fill(view.byTestId('builder-text-title') as HTMLInputElement, '');

        expect(view.byTestId('builder-badge-dirty')).not.toBeNull();
        expect(
            (view.byTestId('builder-text-title') as HTMLInputElement)
                .placeholder,
        ).toBe('Support');
    });
});

describe('features and pre-chat tab', () => {
    it('toggles features and warns when WhatsApp is on without a connected session', async () => {
        const api = fakeApi({
            'HEAD /widget/v1/loader.js': { status: 404 },
            'PUT /api/v1/widgets/w1/draft': { json: { data: {} } },
        });
        const view = await render(<WidgetBuilder {...DATA()} />);

        await flush();
        await openTab(view, 'features');

        expect(view.byTestId('builder-whatsapp-notice')).toBeNull();

        await click(view.byTestId('builder-feature-whatsapp'));
        await click(view.byTestId('builder-feature-attachments'));
        await click(view.byTestId('builder-feature-poweredBy'));

        expect(view.byTestId('builder-whatsapp-notice')).not.toBeNull();

        await click(view.byTestId('builder-save'));
        await flush();

        expect(draftOf(api).features).toMatchObject({
            whatsapp: true,
            attachments: false,
            poweredBy: false,
            rating: true,
        });
    });

    it('does not warn about WhatsApp when a session is connected', async () => {
        const { view } = await setup(
            makeBuilderData({
                widget: makeWidget({ whatsapp_connected: true }),
            }),
        );

        await openTab(view, 'features');
        await click(view.byTestId('builder-feature-whatsapp'));

        expect(view.byTestId('builder-whatsapp-notice')).toBeNull();
    });

    it('edits which pre-chat fields are shown and required, and the consent text', async () => {
        const api = fakeApi({
            'HEAD /widget/v1/loader.js': { status: 404 },
            'PUT /api/v1/widgets/w1/draft': { json: { data: {} } },
        });
        const view = await render(<WidgetBuilder {...DATA()} />);

        await flush();
        await openTab(view, 'features');

        // Phone is off: it cannot be required.
        expect(
            (
                view.byTestId(
                    'builder-prechat-phone-required',
                ) as HTMLButtonElement
            ).disabled,
        ).toBe(true);

        await click(view.byTestId('builder-prechat-phone-enabled'));
        await click(view.byTestId('builder-prechat-phone-required'));
        // Hiding a field also drops "required".
        await click(view.byTestId('builder-prechat-name-enabled'));
        await fill(
            view.byTestId('builder-prechat-consent') as HTMLTextAreaElement,
            'I agree to the privacy policy.',
        );
        await click(view.byTestId('builder-save'));
        await flush();

        expect(draftOf(api).preChat).toEqual({
            fields: {
                name: { enabled: false, required: false },
                email: { enabled: true, required: false },
                phone: { enabled: true, required: true },
            },
            consentText: 'I agree to the privacy policy.',
        });
    });

    it('dims the form when the pre-chat feature is off', async () => {
        const { view } = await setup();

        await openTab(view, 'features');
        await click(view.byTestId('builder-feature-preChat'));

        expect(view.byTestId('builder-prechat-off')).not.toBeNull();
        expect(
            (
                view.byTestId(
                    'builder-prechat-email-enabled',
                ) as HTMLButtonElement
            ).disabled,
        ).toBe(true);
        expect(
            (view.byTestId('builder-prechat-consent') as HTMLTextAreaElement)
                .disabled,
        ).toBe(true);
    });
});

describe('greetings tab', () => {
    it('lists the pool in order and edits behavior settings', async () => {
        const api = fakeApi({
            'HEAD /widget/v1/loader.js': { status: 404 },
            'PUT /api/v1/widgets/w1/draft': { json: { data: {} } },
        });
        const view = await render(<WidgetBuilder {...DATA()} />);

        await flush();
        await openTab(view, 'greetings');

        expect(
            (
                byTestId(
                    view.container,
                    'builder-greeting-0-body',
                ) as HTMLTextAreaElement
            ).value,
        ).toContain('choosing a plan');
        expect(byLabelText(view.container, 'Repeat every')).toHaveProperty(
            'value',
            '30',
        );
        expect(view.byTestId('builder-panel-greetings')?.textContent).toContain(
            'Minutes between greetings. Default: 30.',
        );

        await fill(byLabelText(view.container, 'Repeat every'), '10');
        await fill(byLabelText(view.container, 'Delay'), '5');
        await fill(byLabelText(view.container, 'Hide after'), '60');
        await click(radio(view.container, 'Keep greeting'));
        await click(byLabelText(view.container, 'Greet on page load'));
        await click(view.byTestId('builder-save'));
        await flush();

        expect(draftOf(api).greetings).toMatchObject({
            intervalMinutes: 10,
            delaySeconds: 5,
            autoHideSeconds: 60,
            dismissPolicy: 'never',
            onPageLoad: false,
            enabled: true,
        });
    });

    it('adds, edits, reorders and removes greeting messages', async () => {
        const api = fakeApi({
            'HEAD /widget/v1/loader.js': { status: 404 },
            'PUT /api/v1/widgets/w1/greetings': { json: { data: {} } },
        });
        const view = await render(<WidgetBuilder {...DATA()} />);

        await flush();
        await openTab(view, 'greetings');
        await click(byTestId(view.container, 'builder-greeting-add'));

        const body2 = byTestId(
            view.container,
            'builder-greeting-2-body',
        ) as HTMLTextAreaElement;

        await fill(body2, 'We are here until 5pm.');
        await fill(
            byLabelText(view.container, 'Agent name') ?? null,
            'ignored',
        );
        await click(byTestId(view.container, 'builder-greeting-2-up'));
        await click(byTestId(view.container, 'builder-greeting-0-remove'));
        await click(view.byTestId('builder-save'));
        await flush();

        const sent = (
            api.bodyOf('PUT', '/api/v1/widgets/w1/greetings') as {
                greetings: {
                    body: string;
                    sort_order: number;
                    ulid?: string;
                }[];
            }
        ).greetings;

        expect(sent.map((g) => [g.body, g.sort_order])).toEqual([
            ['We are here until 5pm.', 0],
            ['Questions about billing?', 1],
        ]);
        expect(sent[0]).not.toHaveProperty('ulid');
        expect(sent[1].ulid).toBe('g2');
    });

    it('shows an empty hint without messages and disables the move buttons at the ends', async () => {
        const { view } = await setup(makeBuilderData({ greetings: [] }));

        await openTab(view, 'greetings');

        expect(view.byTestId('builder-greetings-empty')).not.toBeNull();

        await click(byTestId(view.container, 'builder-greeting-add'));

        expect(
            (
                byTestId(
                    view.container,
                    'builder-greeting-0-up',
                ) as HTMLButtonElement
            ).disabled,
        ).toBe(true);
        expect(
            (
                byTestId(
                    view.container,
                    'builder-greeting-0-down',
                ) as HTMLButtonElement
            ).disabled,
        ).toBe(true);
    });

    it('previews a chosen greeting in the approximation (flip + popup)', async () => {
        const { view } = await setup();

        await openTab(view, 'greetings');
        await click(byTestId(view.container, 'builder-greeting-1-preview'));

        expect(view.byTestId('preview-greeting-body')?.textContent).toBe(
            'Questions about billing?',
        );
        expect(
            view
                .byTestId('preview-launcher')
                ?.querySelector('[data-flipped="true"]'),
        ).not.toBeNull();
        expect(view.byTestId('preview-greeting')?.textContent).toContain(
            'Omar',
        );

        await click(byTestId(view.container, 'builder-greeting-0-preview'));

        expect(view.byTestId('preview-greeting-body')?.textContent).toContain(
            'choosing a plan',
        );
    });

    it('lets the popup be dismissed and replayed', async () => {
        const { view } = await setup();

        await click(
            view.byTestId('preview-greeting')?.querySelector('button') ?? null,
        );

        expect(view.byTestId('preview-greeting')).toBeNull();
        expect(
            view
                .byTestId('preview-launcher')
                ?.querySelector('[data-flipped="true"]'),
        ).toBeNull();

        await click(view.byTestId('builder-preview-replay'));

        expect(view.byTestId('preview-greeting')).not.toBeNull();
    });
});

describe('hours tab', () => {
    it('shows the weekly schedule, adds ranges and holidays', async () => {
        const api = fakeApi({
            'HEAD /widget/v1/loader.js': { status: 404 },
            'PUT /api/v1/widgets/w1/draft': { json: { data: {} } },
        });
        const view = await render(<WidgetBuilder {...DATA()} />);

        await flush();
        await openTab(view, 'hours');

        expect(view.byTestId('builder-hours-day-1')?.textContent).toContain(
            'Monday',
        );
        expect(
            (
                byTestId(
                    view.container,
                    'builder-hours-start-0',
                ) as HTMLInputElement
            ).value,
        ).toBe('09:00');
        expect(view.byTestId('builder-hours-day-6')?.textContent).toContain(
            'Closed',
        );
        expect(view.byTestId('builder-hours-day-0')?.textContent).toContain(
            'Closed',
        );

        await click(byTestId(view.container, 'builder-hours-add-6'));
        await fill(byTestId(view.container, 'builder-hours-start-5'), '10:00');
        await fill(byTestId(view.container, 'builder-hours-end-5'), '14:00');
        // A second range on the same day.
        await click(byTestId(view.container, 'builder-hours-add-1'));
        await click(byTestId(view.container, 'builder-holiday-add'));
        await fill(
            byTestId(view.container, 'builder-holiday-date-0'),
            '2026-12-25',
        );
        await fill(
            byTestId(view.container, 'builder-holiday-label-0'),
            'Christmas',
        );
        await click(view.byTestId('builder-save'));
        await flush();

        const { hours } = draftOf(api);

        expect(hours.schedule).toContainEqual({
            day: 6,
            start: '10:00',
            end: '14:00',
        });
        expect(hours.schedule.filter((range) => range.day === 1)).toHaveLength(
            2,
        );
        expect(hours.holidays).toEqual([
            { date: '2026-12-25', label: 'Christmas' },
        ]);
    });

    it('applies the weekday preset, clears, and removes single ranges', async () => {
        const { view } = await setup();

        await openTab(view, 'hours');
        await click(byTestId(view.container, 'builder-hours-clear'));

        expect(view.byTestId('builder-hours-day-1')?.textContent).toContain(
            'Closed',
        );
        expect(
            (
                byTestId(
                    view.container,
                    'builder-hours-clear',
                ) as HTMLButtonElement
            ).disabled,
        ).toBe(true);

        await click(byTestId(view.container, 'builder-hours-preset'));

        expect(
            byTestId(view.container, 'builder-hours-start-4'),
        ).not.toBeNull();

        await click(byTestId(view.container, 'builder-hours-remove-0'));

        expect(view.byTestId('builder-hours-day-1')?.textContent).toContain(
            'Closed',
        );
    });

    it('explains that the schedule is ignored unless availability follows business hours', async () => {
        const { view } = await setup();

        await openTab(view, 'hours');

        expect(view.byTestId('builder-hours-inactive')).toBeNull();

        await click(radio(view.container, 'Always offline'));

        expect(view.byTestId('builder-hours-inactive')?.textContent).toContain(
            'Always offline',
        );
    });
});

describe('domains tab', () => {
    it('adds normalised domains (also several at once) and removes them', async () => {
        const { view } = await setup();

        await openTab(view, 'domains');

        const input = view.byTestId('builder-domain-input') as HTMLInputElement;

        await fill(input, 'Shop.Example.com, *.Cdn.Example.com localhost:5173');
        await click(view.byTestId('builder-domain-add'));

        const list = view.byTestId('builder-domains-list')?.textContent ?? '';

        expect(list).toContain('example.com');
        expect(list).toContain('shop.example.com');
        expect(list).toContain('*.cdn.example.com');
        expect(list).toContain('localhost:5173');
        expect(input.value).toBe('');

        await click(byTestId(view.container, 'builder-domain-remove-1'));

        expect(
            view.byTestId('builder-domains-list')?.textContent,
        ).not.toContain('shop.example.com');
    });

    it('rejects invalid entries with a specific hint and keeps them in the field', async () => {
        const { view } = await setup();

        await openTab(view, 'domains');

        const input = view.byTestId('builder-domain-input') as HTMLInputElement;

        await fill(input, 'https://example.org/path');
        await click(view.byTestId('builder-domain-add'));

        expect(view.byTestId('builder-domain-problem')?.textContent).toContain(
            'Remove the https:// part',
        );
        expect(input.value).toBe('https://example.org/path');
        expect(view.byTestId('builder-badge-dirty')).toBeNull();

        await fill(input, 'a.example.org *.com');
        await click(view.byTestId('builder-domain-add'));

        // The valid one went in, the bad one stays for correction.
        expect(view.byTestId('builder-domains-list')?.textContent).toContain(
            'a.example.org',
        );
        expect(input.value).toBe('*.com');
        expect(view.byTestId('builder-domain-problem')?.textContent).toContain(
            'wildcard',
        );
    });

    it('adds on Enter and warns when no site is allowed yet', async () => {
        const { view } = await setup(makeBuilderData({ domains: [] }));

        await openTab(view, 'domains');

        expect(view.byTestId('builder-domains-empty')).not.toBeNull();

        const input = view.byTestId('builder-domain-input') as HTMLInputElement;

        await fill(input, 'example.com');
        await act_enter(input);

        expect(view.byTestId('builder-domains-empty')).toBeNull();
        expect(view.byTestId('builder-domains-list')?.textContent).toContain(
            'example.com',
        );
    });
});

async function act_enter(element: HTMLElement) {
    const { keyDown } = await import('@/tests/dom');

    await keyDown(element, 'Enter');
}

describe('categories tab', () => {
    it('shows enabled categories in order and the rest as addable', async () => {
        const { view } = await setup();

        await openTab(view, 'categories');

        expect(
            view.byTestId('builder-categories-enabled')?.textContent,
        ).toContain('Sales');
        expect(
            view.byTestId('builder-categories-enabled')?.textContent,
        ).not.toContain('Billing');
        expect(
            view.byTestId('builder-categories-available')?.textContent,
        ).toContain('Billing');
        expect(
            view.byTestId('builder-categories-available')?.textContent,
        ).toContain('Technical support');
    });

    it('adds, reorders and removes categories', async () => {
        const api = fakeApi({
            'HEAD /widget/v1/loader.js': { status: 404 },
            'PUT /api/v1/widgets/w1/categories': { json: { data: {} } },
        });
        const view = await render(<WidgetBuilder {...DATA()} />);

        await flush();
        await openTab(view, 'categories');
        await click(byTestId(view.container, 'builder-category-add-cat2'));
        await click(byTestId(view.container, 'builder-category-add-cat3'));
        await click(byTestId(view.container, 'builder-category-up-cat3'));
        await click(byTestId(view.container, 'builder-category-remove-cat1'));
        await click(view.byTestId('builder-save'));
        await flush();

        expect(api.bodyOf('PUT', '/api/v1/widgets/w1/categories')).toEqual({
            category_ulids: ['cat3', 'cat2'],
        });
        // Inactive categories are flagged.
        expect(
            view.byTestId('builder-category-enabled-cat3')?.textContent,
        ).toContain('Inactive');
        expect(
            (
                byTestId(
                    view.container,
                    'builder-category-up-cat3',
                ) as HTMLButtonElement
            ).disabled,
        ).toBe(true);
    });

    it('reflects the enabled categories in the preview panel', async () => {
        const { view } = await setup();

        await click(view.byTestId('builder-preview-panel'));

        expect(view.byTestId('preview-panel')?.textContent).toContain('Sales');
        expect(view.byTestId('preview-panel')?.textContent).not.toContain(
            'Billing',
        );

        await openTab(view, 'categories');
        await click(byTestId(view.container, 'builder-category-add-cat2'));

        expect(view.byTestId('preview-panel')?.textContent).toContain(
            'Billing',
        );
    });

    it('points to the catalog when no category exists', async () => {
        const { view } = await setup(
            makeBuilderData({ all_categories: [], category_ulids: [] }),
        );

        await openTab(view, 'categories');

        expect(view.byTestId('builder-categories-none')?.textContent).toContain(
            'No categories exist yet',
        );
        expect(
            view
                .byTestId('builder-categories-none')
                ?.querySelector('a')
                ?.getAttribute('href'),
        ).toBe('/categories');
    });

    it('maps a server error on the category list', async () => {
        fakeApi({
            'HEAD /widget/v1/loader.js': { status: 404 },
            'PUT /api/v1/widgets/w1/categories': {
                status: 422,
                json: {
                    error: {
                        code: 'validation_failed',
                        message: 'x',
                        details: { category_ulids: ['Pick at least one.'] },
                    },
                },
            },
        });
        const view = await render(<WidgetBuilder {...DATA()} />);

        await flush();
        await openTab(view, 'categories');
        await click(byTestId(view.container, 'builder-category-remove-cat1'));
        await click(view.byTestId('builder-save'));
        await flush();

        expect(
            view.byTestId('builder-categories-enabled')?.textContent,
        ).toContain('Pick at least one.');
        expect(view.byTestId('builder-tab-categories-error')).not.toBeNull();
    });
});

describe('embed tab', () => {
    const SECRET = 'whsec_NEVER-STORED-0123456789';

    it('shows the three embed codes and the signed-identity examples', async () => {
        const { view } = await setup();

        await openTab(view, 'embed');

        expect(view.byTestId('builder-snippet-script')?.textContent).toContain(
            '/w/wk_abc123.js',
        );
        expect(view.byTestId('builder-snippet-iframe')?.textContent).toContain(
            '/embed/wk_abc123',
        );
        expect(view.byTestId('builder-snippet-hosted')?.textContent).toBe(
            'https://chat.example.test/c/wk_abc123',
        );
        expect(
            view.byTestId('builder-identity-example')?.textContent,
        ).toContain('<?php');

        await click(radio(view.container, 'Node.js'));

        expect(
            view.byTestId('builder-identity-example')?.textContent,
        ).toContain('node');

        await click(radio(view.container, 'Python'));

        expect(
            view.byTestId('builder-identity-example')?.textContent,
        ).toContain('python');
    });

    it('copies a snippet to the clipboard', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);

        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText },
            configurable: true,
        });

        const { view } = await setup();

        await openTab(view, 'embed');
        await click(view.byTestId('builder-snippet-script-copy'));
        await flush();

        expect(writeText).toHaveBeenCalledWith(DATA().snippets.script);
        expect(
            view.byTestId('builder-snippet-script-copy')?.textContent,
        ).toContain('Copied');
        Reflect.deleteProperty(navigator, 'clipboard');
    });

    it('warns that the snippets load the published version while there are unpublished changes', async () => {
        const { view } = await setup(
            makeBuilderData({
                widget: makeWidget({ has_unpublished_changes: true }),
            }),
        );

        await openTab(view, 'embed');

        expect(view.byTestId('builder-embed-unpublished')).not.toBeNull();
    });

    it('rotates the secret after confirmation and shows it exactly once', async () => {
        const api = fakeApi({
            'HEAD /widget/v1/loader.js': { status: 404 },
            'POST /api/v1/widgets/w1/rotate-secret': {
                json: { data: { identity_secret: SECRET } },
            },
        });
        const view = await render(
            <WidgetBuilder
                {...makeBuilderData({
                    widget: makeWidget({ has_identity_secret: true }),
                })}
            />,
        );

        await flush();
        await openTab(view, 'embed');

        expect(view.byTestId('builder-secret-status')?.textContent).toContain(
            'Secret configured',
        );
        expect(document.body.textContent).not.toContain(SECRET);

        await click(view.byTestId('builder-rotate-secret'));

        // Nothing happens before the user confirms.
        expect(api.to('POST', '/api/v1/widgets/w1/rotate-secret')).toHaveLength(
            0,
        );
        expect(body.byTestId('builder-rotate-dialog')?.textContent).toContain(
            'stop being accepted immediately',
        );

        await click(body.byTestId('builder-rotate-confirm'));
        await flush();

        expect(api.to('POST', '/api/v1/widgets/w1/rotate-secret')).toHaveLength(
            1,
        );
        expect(body.byTestId('builder-secret-value')?.textContent).toBe(SECRET);
        expect(body.byTestId('builder-secret-dialog')?.textContent).toContain(
            'You will not be able to see this secret again',
        );

        // Escape does not throw the only copy away...
        await act_key(body.byTestId('builder-secret-dialog'), 'Escape');
        expect(body.byTestId('builder-secret-value')?.textContent).toBe(SECRET);

        // ...the explicit button does, and nothing keeps it around.
        await click(body.byTestId('builder-secret-done'));

        expect(body.byTestId('builder-secret-dialog')).toBeNull();
        expect(document.body.textContent).not.toContain(SECRET);
        expect(view.byTestId('builder-secret-status')?.textContent).toContain(
            'Secret configured',
        );
    });

    it('generates the first secret without a confirmation step', async () => {
        const api = fakeApi({
            'HEAD /widget/v1/loader.js': { status: 404 },
            'POST /api/v1/widgets/w1/rotate-secret': {
                json: { data: { identity_secret: SECRET } },
            },
        });
        const view = await render(<WidgetBuilder {...DATA()} />);

        await flush();
        await openTab(view, 'embed');

        expect(view.byTestId('builder-secret-status')?.textContent).toContain(
            'No secret yet',
        );

        await click(view.byTestId('builder-rotate-secret'));
        await flush();

        expect(api.to('POST', '/api/v1/widgets/w1/rotate-secret')).toHaveLength(
            1,
        );
        expect(body.byTestId('builder-secret-value')?.textContent).toBe(SECRET);

        await click(body.byTestId('builder-secret-done'));

        expect(view.byTestId('builder-secret-status')?.textContent).toContain(
            'Secret configured',
        );
        expect(document.body.textContent).not.toContain(SECRET);
    });

    it('reports a failed rotation without showing a secret', async () => {
        fakeApi({
            'HEAD /widget/v1/loader.js': { status: 404 },
            'POST /api/v1/widgets/w1/rotate-secret': {
                status: 500,
                json: { error: { code: 'server_error', message: 'x' } },
            },
        });
        const view = await render(<WidgetBuilder {...DATA()} />);

        await flush();
        await openTab(view, 'embed');
        await click(view.byTestId('builder-rotate-secret'));
        await flush();

        expect(view.byTestId('builder-rotate-error')?.textContent).toContain(
            'server hit an error',
        );
        expect(body.byTestId('builder-secret-dialog')).toBeNull();
        expect(view.byTestId('builder-secret-status')?.textContent).toContain(
            'No secret yet',
        );
    });
});

async function act_key(element: HTMLElement | null, key: string) {
    const { keyDown } = await import('@/tests/dom');

    await keyDown(element, key);
}

describe('responsive layout', () => {
    it('shows editor and preview side by side on wide screens', async () => {
        const { view } = await setup();

        expect(view.byTestId('builder-panel-general')).not.toBeNull();
        expect(view.byTestId('builder-preview')).not.toBeNull();
        expect(view.byTestId('builder-view-switch')).toBeNull();
    });

    it('stacks them behind an Edit / Preview switch on narrow screens', async () => {
        setViewportWidth(700);

        const { view } = await setup();

        expect(view.byTestId('builder-panel-general')).not.toBeNull();
        expect(view.byTestId('builder-preview')).toBeNull();

        await click(radio(view.container, 'Preview'));

        expect(view.byTestId('builder-preview')).not.toBeNull();
        expect(view.byTestId('builder-panel-general')).toBeNull();

        await click(radio(view.container, 'Edit'));

        expect(view.byTestId('builder-panel-general')).not.toBeNull();
    });

    it('jumps to the preview when a greeting is previewed on a narrow screen', async () => {
        setViewportWidth(700);

        const { view } = await setup();

        await openTab(view, 'greetings');
        await click(byTestId(view.container, 'builder-greeting-1-preview'));

        expect(view.byTestId('builder-preview')).not.toBeNull();
        expect(view.byTestId('preview-greeting-body')?.textContent).toBe(
            'Questions about billing?',
        );
    });
});

describe('tab list', () => {
    it('has one tab per area of the spec and keeps the state while switching', async () => {
        const { view } = await setup();
        const tabs = Array.from(
            view.container.querySelectorAll('[role="tab"]'),
        ).map((tab) => tab.textContent);

        expect(tabs).toEqual([
            'General',
            'Branding',
            'Texts',
            'Features',
            'Greetings',
            'Hours',
            'Domains',
            'Categories',
            'Embed',
        ]);

        await fill(byLabelText(view.container, 'Widget name'), 'Kept');
        await openTab(view, 'branding');
        await openTab(view, 'general');

        expect(
            (byLabelText(view.container, 'Widget name') as HTMLInputElement)
                .value,
        ).toBe('Kept');
        expect(CATEGORIES).toHaveLength(3);
    });
});
