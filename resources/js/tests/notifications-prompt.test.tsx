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
import { toast } from 'sonner';
import {
    announceEnableResult,
    NotificationPrompt,
} from '@/components/notifications/notification-prompt';
import { createNotificationsController } from '@/lib/notifications/controller';
import { keyDown } from '@/tests/dom';
import { en } from '@/tests/lang';
import {
    fakeEnv,
    fakeNotificationsApi,
    fakeStorage,
    VAPID_KEY,
    type FakeEnv,
    type FakeNotificationsApi,
} from '@/tests/notifications-kit';
import { click, render } from '@/tests/render';

vi.mock('sonner', () => ({
    toast: Object.assign(vi.fn(), {
        success: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        dismiss: vi.fn(),
    }),
}));

const t = (key: string, replacements?: Record<string, string | number>) =>
    Object.entries(replacements ?? {}).reduce(
        (text, [name, value]) => text.replace(`:${name}`, String(value)),
        en[key] ?? key,
    );

type Scene = {
    env: FakeEnv;
    api: FakeNotificationsApi;
    controller: ReturnType<typeof createNotificationsController>;
};

async function scene(
    options: {
        env?: Parameters<typeof fakeEnv>[0];
        settings?: Parameters<typeof fakeNotificationsApi>[0];
    } = {},
): Promise<Scene> {
    const env = fakeEnv(options.env);
    const api = fakeNotificationsApi(options.settings);
    const controller = createNotificationsController({
        userId: 7,
        vapidPublicKey: VAPID_KEY,
        api,
        env,
        storage: fakeStorage(),
        promptDelayMs: 0,
    });

    await act(async () => {
        await controller.start();
        await new Promise((resolve) => setTimeout(resolve, 5));
    });

    return { env, api, controller };
}

const dialog = () =>
    document.body.querySelector<HTMLElement>('[role="dialog"]');
const button = (id: string) =>
    document.body.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.clearAllMocks());

describe('the first-login dialog', () => {
    it('opens for a member who was never asked, with a title, a description and a way out', async () => {
        const { controller } = await scene();

        await render(<NotificationPrompt controller={controller} t={t} />);

        const box = dialog();
        expect(box).not.toBeNull();
        expect(box?.getAttribute('aria-labelledby')).toBeTruthy();
        expect(box?.getAttribute('aria-describedby')).toBeTruthy();
        expect(box?.textContent).toContain(en['notifications.prompt.title']);
        expect(box?.textContent).toContain(
            en['notifications.prompt.benefit_offers'],
        );
        expect(box?.textContent).toContain('7 days');
        expect(button('notification-prompt-enable')?.textContent).toContain(
            en['notifications.prompt.enable'],
        );
        expect(button('notification-prompt-later')?.textContent).toContain(
            en['notifications.prompt.later'],
        );
    });

    it('moves keyboard focus into the dialog', async () => {
        const { controller } = await scene();

        await render(<NotificationPrompt controller={controller} t={t} />);

        expect(dialog()?.contains(document.activeElement)).toBe(true);
    });

    it('uses the snooze length the server reports in its note', async () => {
        const { controller } = await scene({
            settings: { settings: { snoozeDays: 3 } },
        });

        await render(<NotificationPrompt controller={controller} t={t} />);

        expect(dialog()?.textContent).toContain('3 days');
    });

    it('stays closed when there is nothing to ask (already decided, or push cannot work)', async () => {
        for (const options of [
            { settings: { settings: { promptState: 'denied' as const } } },
            {
                env: {
                    support: { supported: false, reason: 'no-push' } as const,
                },
            },
            { env: { permission: 'granted' as const } },
        ]) {
            const { controller } = await scene(options);
            const view = await render(
                <NotificationPrompt controller={controller} t={t} />,
            );

            expect(dialog()).toBeNull();
            await view.unmount();
        }
    });

    it('is not shown where the page has the same controls (suppressed)', async () => {
        const { controller } = await scene();

        await render(
            <NotificationPrompt controller={controller} t={t} suppressed />,
        );

        expect(dialog()).toBeNull();
    });

    it('never asks the browser until the primary button is pressed', async () => {
        const { controller, env } = await scene();

        await render(<NotificationPrompt controller={controller} t={t} />);

        expect(env.requestPermission).not.toHaveBeenCalled();
    });
});

describe('what the buttons do', () => {
    it('"Not now" snoozes through the server and closes without touching the browser permission', async () => {
        const { controller, env, api } = await scene();
        await render(<NotificationPrompt controller={controller} t={t} />);

        await click(button('notification-prompt-later'));

        expect(dialog()).toBeNull();
        expect(api.updateSettings).toHaveBeenCalledWith({
            promptState: 'snoozed',
        });
        expect(env.requestPermission).not.toHaveBeenCalled();
    });

    it('Escape counts as "Not now"', async () => {
        const { controller, api } = await scene();
        await render(<NotificationPrompt controller={controller} t={t} />);

        await keyDown(dialog(), 'Escape');

        expect(dialog()).toBeNull();
        expect(api.updateSettings).toHaveBeenCalledWith({
            promptState: 'snoozed',
        });
    });

    it('the primary button asks the browser exactly once, subscribes and says so', async () => {
        const { controller, env, api } = await scene();
        await render(<NotificationPrompt controller={controller} t={t} />);

        await click(button('notification-prompt-enable'));

        expect(env.requestPermission).toHaveBeenCalledTimes(1);
        expect(env.subscribe).toHaveBeenCalledTimes(1);
        expect(api.register).toHaveBeenCalledTimes(1);
        expect(toast.success).toHaveBeenCalledWith(
            en['notifications.prompt.enabled'],
        );
        expect(dialog()).toBeNull();
    });

    it('explains a refusal in a toast and records it', async () => {
        const { controller, api } = await scene({
            env: { promptAnswer: 'denied' },
        });
        await render(<NotificationPrompt controller={controller} t={t} />);

        await click(button('notification-prompt-enable'));

        expect(toast.info).toHaveBeenCalledWith(
            en['notifications.prompt.denied'],
            expect.anything(),
        );
        expect(api.updateSettings).toHaveBeenLastCalledWith({
            promptState: 'denied',
        });
        expect(dialog()).toBeNull();
    });

    it('reports a subscription that could not be made', async () => {
        const { controller, env } = await scene();
        env.subscribe.mockRejectedValue(new Error('boom'));
        await render(<NotificationPrompt controller={controller} t={t} />);

        await click(button('notification-prompt-enable'));

        expect(toast.error).toHaveBeenCalledWith(
            en['notifications.prompt.failed'],
        );
    });

    it('disables the buttons while the browser asks, and Escape does not snooze an answer that is still coming', async () => {
        const { controller, env, api } = await scene();
        let answer: (value: NotificationPermission) => void = () => undefined;
        env.requestPermission.mockImplementation(
            () =>
                new Promise((resolve) => {
                    answer = resolve;
                }),
        );
        await render(<NotificationPrompt controller={controller} t={t} />);

        await click(button('notification-prompt-enable'));

        expect(button('notification-prompt-enable')?.disabled).toBe(true);
        expect(button('notification-prompt-later')?.disabled).toBe(true);
        expect(button('notification-prompt-enable')?.textContent).toContain(
            en['notifications.prompt.enabling'],
        );
        await keyDown(dialog(), 'Escape');
        expect(api.updateSettings).not.toHaveBeenCalled();

        await act(async () => {
            answer('granted');
            await new Promise((resolve) => setTimeout(resolve, 5));
        });
        expect(dialog()).toBeNull();
    });

    it('gives focus back to what had it before the dialog opened', async () => {
        const opener = document.createElement('button');
        document.body.append(opener);
        opener.focus();
        const { controller } = await scene();
        const view = await render(
            <NotificationPrompt controller={controller} t={t} />,
        );

        expect(document.activeElement).not.toBe(opener);
        await click(button('notification-prompt-later'));
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
        });

        expect(document.activeElement).toBe(opener);
        opener.remove();
        await view.unmount();
    });
});

describe('announceEnableResult', () => {
    it('says nothing when the browser prompt was closed without an answer', () => {
        const show = { success: vi.fn(), error: vi.fn(), info: vi.fn() };

        announceEnableResult('dismissed', t, show);
        announceEnableResult('unsupported', t, show);

        expect(show.success).not.toHaveBeenCalled();
        expect(show.error).not.toHaveBeenCalled();
        expect(show.info).not.toHaveBeenCalled();
    });
});
