import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { fill, choose } from '@/tests/dom';
import { click } from '@/tests/render';
import { bootConfig } from '@/tests/msw/chat-visitor';
import { useBackend } from '@/tests/msw/server';
import {
    createHarness,
    loaderBoot,
    makeInit,
    type Harness,
} from '@/tests/embed-harness';
import { renderPanel, run, text, waitFor } from '@/tests/embed-render';

const byTestId = (root: ParentNode, id: string): HTMLElement | null =>
    root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const phase = (root: ParentNode): string | undefined =>
    byTestId(root, 'chat-state')?.dataset.state;
const submitButton = (root: ParentNode, formId: string): HTMLElement | null =>
    byTestId(root, formId)?.querySelector<HTMLElement>(
        'button[type="submit"]',
    ) ?? null;

type PreChat = {
    fields: Record<string, { enabled: boolean; required: boolean }>;
    consentText: string | null;
};

const preChat = (
    patch: Partial<PreChat> & { fields?: PreChat['fields'] } = {},
): PreChat => ({
    fields: {
        name: { enabled: true, required: true },
        email: { enabled: true, required: false },
        phone: { enabled: false, required: false },
        ...patch.fields,
    },
    consentText: patch.consentText ?? null,
});

function bootWith(patch: {
    preChat?: PreChat;
    features?: Record<string, boolean>;
    texts?: unknown;
    availability?: unknown;
    categories?: unknown;
    defaultLocale?: string;
}) {
    const base = bootConfig().config as { features: object; texts: object };

    return loaderBoot({
        config: {
            ...base,
            ...(patch.defaultLocale
                ? { defaultLocale: patch.defaultLocale }
                : {}),
            features: { ...base.features, ...patch.features },
            ...(patch.preChat ? { preChat: patch.preChat } : {}),
            ...(patch.texts ? { texts: patch.texts } : {}),
        },
        ...(patch.availability ? { availability: patch.availability } : {}),
        ...(patch.categories ? { categories: patch.categories } : {}),
    });
}

async function panel(
    init: ReturnType<typeof makeInit>,
    backend = useBackend(),
    open = true,
) {
    const h: Harness = createHarness({ backend });
    const view = await renderPanel(h);

    await run(() => h.init(init));

    if (open) {
        await run(() => h.open());
    }

    return { h, backend, view, c: view.container };
}

afterEach(() => vi.useRealTimers());

describe('pre-chat screen', () => {
    it('shows the enabled fields, marks optional ones, and wires labels, types and autofill hints', async () => {
        const { c } = await panel(
            makeInit({
                boot: bootWith({
                    preChat: preChat({
                        fields: { phone: { enabled: true, required: false } },
                    }),
                }),
            }),
        );
        const label = (name: string) =>
            c.querySelector(
                `label[for="${c.querySelector<HTMLElement>(`input[name="${name}"]`)?.id}"]`,
            );

        expect(text(label('name'))).toBe('Your name');
        expect(text(label('email'))).toBe('Email (optional)');
        expect(text(label('phone'))).toBe('Phone (optional)');
        expect(
            c.querySelector('input[name="name"]')?.getAttribute('autocomplete'),
        ).toBe('name');
        expect(
            c.querySelector('input[name="email"]')?.getAttribute('type'),
        ).toBe('email');
        expect(
            c.querySelector('input[name="phone"]')?.getAttribute('type'),
        ).toBe('tel');
        expect(
            c.querySelector('input[name="name"]')?.hasAttribute('required'),
        ).toBe(true);
        expect(
            c.querySelector('input[name="email"]')?.hasAttribute('required'),
        ).toBe(false);
        expect(c.querySelector('input[name="consent"]')).toBeNull();
    });

    it('hides disabled fields completely', async () => {
        const { c } = await panel(
            makeInit({
                boot: bootWith({
                    preChat: preChat({
                        fields: { email: { enabled: false, required: false } },
                    }),
                }),
            }),
        );

        expect(c.querySelector('input[name="email"]')).toBeNull();
        expect(c.querySelector('input[name="phone"]')).toBeNull();
    });

    it('validates on submit, focuses the first invalid field, and clears an error as soon as it is edited', async () => {
        const { h, c } = await panel(
            makeInit({
                boot: bootWith({
                    preChat: preChat({
                        fields: { email: { enabled: true, required: true } },
                    }),
                }),
            }),
        );
        const name = c.querySelector<HTMLInputElement>(
            'input[name="name"]',
        ) as HTMLInputElement;
        const email = c.querySelector<HTMLInputElement>(
            'input[name="email"]',
        ) as HTMLInputElement;

        await click(submitButton(c, 'prechat-form'));
        await act(async () => {
            await new Promise((resolve) => requestAnimationFrame(resolve));
        });

        expect(name.getAttribute('aria-invalid')).toBe('true');
        expect(email.getAttribute('aria-invalid')).toBe('true');
        expect(document.activeElement).toBe(name);
        expect(h.state().phase).toBe('prechat');

        await fill(name, 'Vera');
        expect(name.getAttribute('aria-invalid')).toBeNull();

        await fill(email, 'not-an-email');
        await click(submitButton(c, 'prechat-form'));
        expect(
            text(
                document.getElementById(
                    email.getAttribute('aria-describedby') ?? '',
                ),
            ),
        ).toBe('Enter a valid email address.');

        await fill(email, 'vera@x.test');
        await click(submitButton(c, 'prechat-form'));
        expect(h.state().phase).toBe('category');
    });

    it('a consent checkbox gates the form until it is ticked', async () => {
        const { h, c } = await panel(
            makeInit({
                boot: bootWith({
                    preChat: preChat({
                        consentText: 'I agree to the privacy policy.',
                    }),
                }),
            }),
        );
        const consent = c.querySelector<HTMLInputElement>(
            'input[name="consent"]',
        ) as HTMLInputElement;

        expect(text(consent.closest('label'))).toBe(
            'I agree to the privacy policy.',
        );

        await fill(c.querySelector('input[name="name"]'), 'Vera');
        await click(submitButton(c, 'prechat-form'));
        expect(consent.getAttribute('aria-invalid')).toBe('true');
        expect(text(c)).toContain('Please accept to continue.');
        expect(h.state().phase).toBe('prechat');

        await click(consent);
        await click(submitButton(c, 'prechat-form'));
        expect(h.state().phase).toBe('category');
        expect(h.state().form.consent).toBe(true);
    });

    it('shows prefilled values and server-side field errors, which disappear once the field is edited', async () => {
        const backend = useBackend({ requireEmail: true });
        const { h, c } = await panel(
            makeInit({ visitor: { name: 'Prefilled' } }),
            backend,
        );

        expect(
            c.querySelector<HTMLInputElement>('input[name="name"]')?.value,
        ).toBe('Prefilled');

        await click(submitButton(c, 'prechat-form'));
        await click(byTestId(c, 'category-option-billing'));
        await waitFor(() => h.state().fieldErrors.email !== undefined);

        expect(phase(c)).toBe('prechat');
        expect(text(c)).toContain('The email field is required.');

        await fill(c.querySelector('input[name="email"]'), 'a@b.co');
        expect(text(c)).not.toContain('The email field is required.');
    });
});

describe('category screen', () => {
    const noForm = () =>
        bootWith({
            preChat: preChat({
                fields: {
                    name: { enabled: false, required: false },
                    email: { enabled: false, required: false },
                },
            }),
        });

    it('lists the topics as cards with their name, description and icon, and starts the chat on a click', async () => {
        const { h, c } = await panel(makeInit({ boot: noForm() }));

        expect(phase(c)).toBe('category');
        expect(text(c.querySelector('h2'))).toBe('What do you need help with?');

        const billing = byTestId(c, 'category-option-billing') as HTMLElement;

        expect(text(billing)).toContain('Billing');
        expect(text(billing)).toContain('Invoices and payments');
        expect(billing.querySelector('svg')).not.toBeNull();
        expect(byTestId(c, 'category-option-tech')).not.toBeNull();

        await click(byTestId(c, 'category-option-tech'));
        await waitFor(() => phase(c) === 'queued');
        expect(h.state().conversation?.category?.slug).toBe('tech');
    });

    it('marks topics nobody is serving and sends the visitor to the leave-a-message form for them', async () => {
        const availability = {
            online: true,
            openNow: true,
            nextOpenAt: null,
            categories: [
                { slug: 'billing', online: false },
                { slug: 'tech', online: true },
            ],
            whatsapp: { enabled: false },
        };
        const { c, h } = await panel(
            makeInit({ boot: noForm() }),
            useBackend({ availability }),
        );

        expect(text(byTestId(c, 'category-option-billing'))).toContain(
            'Offline: leave a message',
        );
        expect(text(byTestId(c, 'category-option-tech'))).toContain('Online');

        await click(byTestId(c, 'category-option-billing'));
        expect(phase(c)).toBe('offline');
        expect(h.state().category).toBe('billing');
        expect(
            (c.querySelector('select[name="category"]') as HTMLSelectElement)
                .value,
        ).toBe('billing');
    });

    it('has a Back button after the form, and a rate limit shows a banner without leaving the screen', async () => {
        const backend = useBackend();

        backend.fail(
            'POST',
            '/conversations$',
            429,
            { error: { code: 'rate_limited', message: 'x' } },
            1,
            { 'Retry-After': '7' },
        );

        const { c } = await panel(makeInit(), backend);

        await fill(c.querySelector('input[name="name"]'), 'Vera');
        await click(submitButton(c, 'prechat-form'));
        await click(byTestId(c, 'category-option-billing'));
        await waitFor(() => c.querySelector('[role="alert"]') !== null);

        expect(text(c.querySelector('[role="alert"]'))).toBe(
            'Too many attempts. Try again in 7 seconds.',
        );
        expect(phase(c)).toBe('category');

        await click(
            Array.from(c.querySelectorAll('button')).find(
                (b) => b.textContent === 'Back',
            ) ?? null,
        );
        expect(phase(c)).toBe('prechat');
    });
});

describe('queued screen', () => {
    async function queued() {
        const backend = useBackend();
        const stored = backend.issueToken();

        backend.seedConversation(stored.token, 'queued');

        return panel(makeInit({ visitorSession: stored }), backend);
    }

    it('shows the waiting message, a ticking timer and a cancel button that closes the chat', async () => {
        const { c, h, backend } = await queued();

        expect(phase(c)).toBe('queued');
        expect(text(c)).toContain('Connecting you to an agent…');
        expect(byTestId(c, 'queued-timer')?.textContent).toMatch(
            /^Waiting [0-3]:\d\d$/,
        );
        expect(text(c)).toContain('Keep this window open');

        await click(byTestId(c, 'queued-cancel'));
        await waitFor(() => phase(c) === 'closed');

        expect(h.state().closedReason).toBe('cancelled');
        expect(backend.callsTo('POST', '/cancel')).toHaveLength(1);
        expect(backend.callsTo('POST', '/end')).toHaveLength(0);
        expect(text(c)).toContain('You cancelled the chat.');
    });

    it('counts up each second', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

        try {
            const { c } = await queued();
            const before = byTestId(c, 'queued-timer')?.textContent;

            await act(async () => {
                await vi.advanceTimersByTimeAsync(5000);
            });
            expect(byTestId(c, 'queued-timer')?.textContent).not.toBe(before);
            expect(byTestId(c, 'queued-timer')?.textContent).toMatch(
                /Waiting \d:\d\d/,
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('says it is connecting to another agent after a transfer', async () => {
        const { c, h } = await queued();

        await waitFor(() => h.socket()?.status() === 'connected');
        h.backend.claim('Sam');
        await run(() =>
            h.socket()?.emit('chat.claimed', {
                v: 1,
                agent: { name: 'Sam', avatarUrl: null },
                claimedAt: 'x',
            }),
        );
        await waitFor(() => phase(c) === 'active');
        // the server re-queues the chat (and the watchdog poll must agree with the event)
        h.backend.state.conversation = {
            ...(h.backend.state.conversation as object),
            status: 'queued',
            agent: null,
        } as never;
        await run(() => h.socket()?.emit('conversation.transferred', { v: 1 }));

        expect(phase(c)).toBe('queued');
        expect(text(c)).toContain('Connecting you to another agent…');
    });
});

describe('offline screen', () => {
    const closed = {
        online: false,
        openNow: false,
        nextOpenAt: '2026-11-23T09:00:00.000Z',
        categories: [],
        whatsapp: { enabled: false },
    };
    const offline = (extra: Record<string, unknown> = {}) =>
        bootWith({ availability: closed, ...extra });
    const closedBackend = () => useBackend({ availability: closed });

    it('explains why (reopening time) and offers the form with every required field', async () => {
        const { c } = await panel(
            makeInit({ boot: offline() }),
            closedBackend(),
        );

        expect(phase(c)).toBe('offline');
        expect(text(c.querySelector('h2'))).toBe('Leave us a message');
        expect(text(c)).toContain("We're back");
        expect(text(c)).toContain("We'll get back to you by email.");
        expect(c.querySelector('select[name="category"]')).not.toBeNull();
        expect(byTestId(c, 'offline-form')).not.toBeNull();
    });

    it('validates, then sends the ticket and confirms with the ticket number and the email', async () => {
        const { c, backend } = await panel(
            makeInit({ boot: offline() }),
            closedBackend(),
        );

        await click(submitButton(c, 'offline-form'));
        expect(c.querySelectorAll('[aria-invalid="true"]').length).toBe(4);
        expect(backend.callsTo('POST', '/offline-tickets')).toHaveLength(0);

        await fill(c.querySelector('input[name="name"]'), 'Vera');
        await fill(c.querySelector('input[name="email"]'), 'vera@x.test');
        await choose(c.querySelector('select[name="category"]'), 'billing');
        await fill(
            c.querySelector('textarea[name="message"]'),
            'Please call me back',
        );
        await click(submitButton(c, 'offline-form'));
        await waitFor(() => phase(c) === 'closed');

        expect(backend.callsTo('POST', '/offline-tickets')[0].body).toEqual({
            name: 'Vera',
            email: 'vera@x.test',
            message: 'Please call me back',
            category: 'billing',
        });
        expect(text(c)).toContain('Message sent');
        expect(text(c)).toContain(
            "We'll reply to vera@x.test. Your ticket number is T1CKET.",
        );
    });

    it('a missed queue says nobody was free', async () => {
        const backend = useBackend();
        const stored = backend.issueToken();

        backend.seedConversation(stored.token, 'queued');

        const { c } = await panel(
            makeInit({ visitorSession: stored }),
            backend,
        );

        backend.miss();
        await waitFor(() => phase(c) === 'offline', 5000);

        expect(text(c)).toContain('Nobody was free to take your chat.');
    });

    it('with the offline form switched off it only says nobody is available', async () => {
        const { c } = await panel(
            makeInit({ boot: offline({ features: { offlineForm: false } }) }),
            closedBackend(),
        );

        expect(phase(c)).toBe('offline');
        expect(text(c.querySelector('h2'))).toBe(
            'No agent is available right now.',
        );
        expect(byTestId(c, 'offline-form')).toBeNull();
    });
});

describe('closed screen and boot screen', () => {
    it.each([
        ['idle', 'This chat was closed because it had been quiet for a while.'],
        ['expired', 'Your session expired. Start a new chat to continue.'],
        ['ended', 'This chat has ended.'],
    ] as const)('explains a chat closed as %s', async (reason, copy) => {
        const backend = useBackend();
        const stored = backend.issueToken();

        backend.seedConversation(stored.token, 'active');

        const { c, h } = await panel(
            makeInit({ visitorSession: stored }),
            backend,
        );

        await waitFor(() => h.socket()?.status() === 'connected');
        await run(() => {
            if (reason === 'idle') {
                h.socket()?.emit('conversation.closed', {
                    v: 1,
                    reason: 'idle',
                });
            } else if (reason === 'ended') {
                h.socket()?.emit('conversation.ended', {
                    v: 1,
                    endedBy: 'agent',
                    ratingRequested: false,
                });
            } else {
                h.socket()?.failSubscription(401);
            }
        });

        expect(phase(c)).toBe('closed');
        expect(text(c)).toContain(copy);
        expect(byTestId(c, 'new-chat')).not.toBeNull();
    });

    it('shows a skeleton while booting and an unavailable message for a widget that cannot be loaded', async () => {
        const h = createHarness({ backend: useBackend() });
        const view = await renderPanel(h);

        expect(phase(view.container)).toBe('booting');
        expect(
            view.container.querySelector('[aria-busy="true"]'),
        ).not.toBeNull();
        expect(text(view.container)).toContain('Loading chat…');

        await run(() => h.init(makeInit({ boot: { key: '', api: {} } })));
        expect(text(view.container)).toContain(
            'Chat is not available right now.',
        );
    });
});
