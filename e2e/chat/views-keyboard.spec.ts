import type { Locator, Page } from '@playwright/test';
import { must } from '../support/chat-api';
import {
    expect,
    png,
    sendImageAsAgent,
    sendImageAsVisitor,
    test,
} from '../support/chat-lab';
import { setTheme } from '../support/helpers';
import { widget } from '../support/host';
import { expectEventually } from '../support/wait';
import { openCustomerSite, type Panel } from '../support/panel';

/**
 * Keyboard, focus, motion and screen-reader semantics of the live chat.
 *
 * Inherently desktop-only (a phone has no Tab key): the mobile project skips the keyboard flows; the motion and semantics checks do not
 * depend on the device but need nothing the desktop project does not cover, so they run once there too.
 *
 * What is proved: a whole visitor chat and an agent's shift can be done with the keyboard alone (Tab order, Enter / Shift+Enter, Escape
 * closing the lightbox, the dialogs and the panel, focus going into the panel when it opens and back to the launcher when it closes, no
 * focus trap that does not let go), the visible focus rings in both themes, `prefers-reduced-motion`, and the accessibility tree
 * (`log` with its live region, a labelled composer, status announcements for the queue and for typing, buttons with names).
 */
test.use({ scenario: 'p4-chat-views' });

// Several workers, two projects and other suites share one machine: a screen full of axe scans needs more than the default minute.
test.describe.configure({ timeout: 120_000 });

test.skip(
    ({ isMobile }) => isMobile,
    'keyboard flows: a phone has no Tab key (the desktop project covers them)',
);

/** The accessible name or test id of the element holding focus inside the panel's iframe (`null` when focus left the panel). */
async function focusedInPanel(panel: Panel): Promise<string | null> {
    return panel.root.evaluate(() => {
        const active = document.activeElement;

        if (active === null || active === document.body) {
            return null;
        }

        return (
            active.getAttribute('data-testid') ??
            active.getAttribute('aria-label') ??
            active.tagName.toLowerCase()
        );
    });
}

/** Presses Tab `count` times and returns what had focus after each press. */
async function tabThrough(
    page: Page,
    panel: Panel,
    count: number,
): Promise<(string | null)[]> {
    const seen: (string | null)[] = [];

    for (let index = 0; index < count; index += 1) {
        await page.keyboard.press('Tab');
        seen.push(await focusedInPanel(panel));
    }

    return seen;
}

/**
 * The focus indicator of a control: its own outline / ring / border, or the one of the wrapper that draws it for a composite field
 * (a message box inside a bordered row), is different while the control has focus than while it has not.
 */
async function focusIndicator(locator: Locator): Promise<boolean> {
    return locator.evaluate((element) => {
        const snapshot = (): string[] => {
            const out: string[] = [];
            let node: Element | null = element;

            for (let depth = 0; depth < 4 && node !== null; depth += 1) {
                const style = getComputedStyle(node);

                out.push(
                    `${style.outlineStyle}|${style.outlineWidth}|${style.outlineColor}|${style.boxShadow}|${style.borderColor}`,
                );
                node = node.parentElement;
            }

            return out;
        };
        const focused = snapshot();

        (element as HTMLElement).blur();

        const blurred = snapshot();

        (element as HTMLElement).focus();

        return focused.some((value, index) => value !== blurred[index]);
    });
}

test.describe('visitor, keyboard only', () => {
    test('opens the panel from the launcher, fills the form, picks a topic, chats, ends and rates, never needing a pointer', async ({
        lab,
        instance,
    }) => {
        const tenant = await lab.tenant({
            categories: 2,
            config: {
                preChat: {
                    fields: {
                        name: { enabled: true, required: true },
                        email: { enabled: false, required: false },
                        phone: { enabled: false, required: false },
                    },
                },
            },
        });
        const agent = await lab.agent(tenant, 0, {
            presence: 'online',
            keepAlive: true,
        });
        const visitor = await lab.visitor();
        const { page } = visitor;
        const panel = await openCustomerSite(page, instance, {
            key: tenant.widget.key,
        });

        // The launcher takes focus (the host page's own tab order up to it is the customer's business) and Enter opens the panel.
        await panel.launcher.focus();
        await expect(panel.launcher).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(panel.root).toBeVisible();

        // Focus moved INTO the panel, onto the first field of the form.
        await panel.expectState('prechat');
        await expect(
            panel.tid('prechat-form').locator('input[name="name"]'),
        ).toBeFocused();
        await page.keyboard.type('Maya Thompson');
        await page.keyboard.press('Enter');

        // The topic cards: the first has focus, Tab / Shift+Tab move between them, Enter picks.
        await panel.expectState('category');

        const [first, second] = tenant.categories.map((category) =>
            panel.tid(`category-option-${category.slug}`),
        );

        await expect(first).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(second).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(first).toBeFocused();
        await page.keyboard.press('Enter');

        // Queued: focus is on the one thing to do here (cancel), and the waiting is announced by the heading.
        await panel.expectState('queued');
        await expect(panel.tid('queued-cancel')).toBeFocused();

        const queued = must<{ ulid: string }[]>(
            await agent.api.queue(),
            'the queue',
        ).at(-1)!;

        await lab.accept(agent, queued);
        await panel.expectState('active');
        await expect(panel.composerInput).toBeFocused();

        // Shift+Enter breaks the line, Enter sends; the box empties and keeps focus.
        await page.keyboard.type('first line');
        await page.keyboard.press('Shift+Enter');
        await page.keyboard.type('second line');
        await expect(panel.composerInput).toHaveValue(
            'first line\nsecond line',
        );
        await expect(panel.message('second line', 'visitor')).toHaveCount(0);
        await page.keyboard.press('Enter');
        await panel.expectMessage('second line', 'visitor');
        await expect(panel.composerInput).toHaveValue('');
        await expect(panel.composerInput).toBeFocused();

        // The tab order of the active panel follows the visual order: header actions, the transcript, the composer.
        await panel.tid('end-chat').focus();
        expect(await tabThrough(page, panel, 4)).toEqual([
            'Close chat',
            'message-list',
            'composer-attach',
            'composer-input',
        ]);

        // An image: Enter opens the lightbox, focus is held inside it, Escape closes only the lightbox and returns to the thumbnail.
        await sendImageAsAgent(agent, instance, queued, png(), 'The receipt');
        await panel.expectMessage('The receipt', 'agent');

        const thumbnail = panel.tid('message-image').first();

        await thumbnail.focus();
        await page.keyboard.press('Enter');
        await expect(panel.tid('lightbox')).toBeVisible();
        await expect(panel.tid('lightbox-close')).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(panel.tid('lightbox-close')).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(panel.tid('lightbox')).toHaveCount(0);
        await expect(panel.root).toBeVisible();
        await expect(thumbnail).toBeFocused();

        // The end-chat confirmation: the safe answer has focus, Tab stays inside, Escape returns to the button.
        await panel.tid('end-chat').focus();
        await page.keyboard.press('Enter');
        await expect(panel.tid('end-chat-dialog')).toBeVisible();
        await expect(panel.tid('end-chat-keep')).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(panel.tid('end-chat-confirm')).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(panel.tid('end-chat-keep')).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(panel.tid('end-chat-confirm')).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(panel.tid('end-chat-dialog')).toHaveCount(0);
        await expect(panel.tid('end-chat')).toBeFocused();

        // Escape with nothing open closes the panel and hands focus back to the launcher; Enter on the launcher opens it again.
        await page.keyboard.press('Escape');
        await expect(widget(page).panel).toHaveAttribute('data-open', 'false');
        await expect(panel.launcher).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(widget(page).panel).toHaveAttribute('data-open', 'true');
        await expect(panel.root).toBeVisible();

        // Ending the chat shows the rating: arrow keys choose the stars, Tab moves on to the comment and the buttons.
        must(await agent.api.end(queued.ulid), 'end');
        await panel.expectState('ended');
        await expect(panel.tid('rating-star-1')).toBeFocused();
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        await expect(panel.tid('rating-star-3')).toBeFocused();
        await expect(panel.tid('rating-star-3')).toHaveAttribute(
            'aria-checked',
            'true',
        );
        await page.keyboard.press('Tab');
        await expect(panel.tid('rating-comment')).toBeFocused();
        await page.keyboard.type('Helpful, thanks.');
        await page.keyboard.press('Tab');
        await expect(panel.tid('rating-submit')).toBeFocused();
        await page.keyboard.press('Enter');

        await panel.expectState('closed');
        await expect(panel.tid('new-chat')).toBeFocused();
    });
});

test.describe('agent, keyboard only', () => {
    test('accepts an offer, replies, and opens and leaves every dialog with focus returning to its button', async ({
        lab,
    }) => {
        const tenant = await lab.tenant({ agents: 2, categories: 2 });
        const agent = await lab.agent(tenant, 0, {
            presence: 'online',
            open: '/inbox',
        });

        await lab.agent(tenant, 1, { presence: 'online', keepAlive: true });

        const chat = await lab.chat(tenant, {
            name: 'Maya Thompson',
            email: 'maya.thompson@example.org',
            message: 'I was charged twice.',
        });
        const { inbox, page } = agent;

        await inbox.expectOffer(chat.ulid);

        // Accept with Enter on the focused button.
        await inbox.tid(`offer-accept-${chat.ulid}`).focus();
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(new RegExp(`/inbox/${chat.ulid}$`));
        await expect(inbox.conversation).toBeVisible();

        // Reply from the keyboard: type, Enter sends, Shift+Enter does not.
        await inbox.composerInput.focus();
        await page.keyboard.type('Let me look.');
        await page.keyboard.press('Shift+Enter');
        await page.keyboard.type('One moment please.');
        await page.keyboard.press('Enter');
        await inbox.expectMessage('One moment please.');
        await expect(inbox.composerInput).toHaveValue('');

        // The message is stored once the server has answered (the bubble shows at once, as "sending"): wait for the transcript, not for the DOM.
        await expectEventually(
            async () =>
                must<{ body: string | null }[]>(
                    await agent.api.messages(chat.ulid),
                    'the transcript',
                ),
            (stored) =>
                stored.some(
                    (message) =>
                        message.body === 'Let me look.\nOne moment please.',
                ),
            { message: 'the two-line reply was stored with its line break' },
        );

        // Every surface opens with Enter, closes with Escape and gives focus back to the control that opened it.
        await sendImageAsVisitor(chat, png(), 'The statement');
        await inbox.expectMessage('The statement');

        for (const [opener, surface] of [
            ['conversation-info', 'conversation-details'],
            ['transfer-chat', 'transfer-dialog'],
            ['end-chat', 'end-chat-dialog'],
        ] as const) {
            await inbox.tid(opener).focus();
            await page.keyboard.press('Enter');
            await expect(inbox.tid(surface)).toBeVisible();
            await page.keyboard.press('Escape');
            await expect(inbox.tid(surface)).toHaveCount(0);
            await expect(inbox.tid(opener)).toBeFocused();
        }

        const thumbnail = inbox.conversation
            .locator('[data-testid^="attachment-"]')
            .first();

        await thumbnail.focus();
        await page.keyboard.press('Enter');
        await expect(inbox.tid('lightbox')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(inbox.tid('lightbox')).toHaveCount(0);
        await expect(thumbnail).toBeFocused();

        must(await agent.api.end(chat.ulid), 'end');
    });
});

test.describe('focus rings', () => {
    for (const theme of ['light', 'dark'] as const) {
        test(`every control shows where focus is, in the ${theme} theme (dashboard and panel)`, async ({
            lab,
            instance,
        }) => {
            const tenant = await lab.tenant();
            const agent = await lab.agent(tenant, 0, {
                presence: 'online',
                keepAlive: true,
                open: '/inbox',
            });
            const chat = await lab.chat(tenant, {
                name: 'Maya Thompson',
                message: 'Hello',
            });

            await agent.inbox.expectOffer(chat.ulid);
            await setTheme(agent.page, theme);
            await agent.page.keyboard.press('Tab');

            const accept = agent.inbox.tid(`offer-accept-${chat.ulid}`);

            await accept.focus();
            await agent.page.keyboard.press('Shift+Tab');
            await agent.page.keyboard.press('Tab');
            expect(
                await focusIndicator(accept),
                'Accept shows a focus ring',
            ).toBe(true);

            await agent.inbox.accept(chat.ulid);

            for (const control of [
                'conversation-info',
                'copy-transcript',
                'composer-input',
            ]) {
                await agent.inbox.tid(control).focus();
                await agent.page.keyboard.press('Shift+Tab');
                await agent.page.keyboard.press('Tab');
                expect(
                    await focusIndicator(agent.inbox.tid(control)),
                    `${control} shows a focus ring`,
                ).toBe(true);
            }

            // The panel of a visitor chatting with this agent.
            const visitor = await lab.visitor();
            const panel = await openCustomerSite(visitor.page, instance, {
                key: tenant.widget.key,
                open: true,
            });

            await visitor.page.emulateMedia({ colorScheme: theme });
            must(await agent.api.end(chat.ulid), 'end the first chat');

            const second = await panel.startChat({
                category: tenant.categories[0].slug,
                name: 'Daniel Okafor',
            });

            await agent.inbox.expectOffer(second.ulid!);
            await lab.accept(agent, { ulid: second.ulid! });
            await panel.expectState('active');
            await expect(panel.root).toHaveAttribute('data-scheme', theme);

            await panel.composerInput.fill('Hello there');

            for (const id of [
                'end-chat',
                'composer-attach',
                'composer-input',
                'composer-send',
            ]) {
                const control = panel.tid(id);

                await control.focus();
                await visitor.page.keyboard.press('Shift+Tab');
                await visitor.page.keyboard.press('Tab');
                expect(
                    await focusIndicator(control),
                    `${id} shows a focus ring in the panel`,
                ).toBe(true);
            }

            must(await agent.api.end(second.ulid!), 'end');
        });
    }
});

test.describe('reduced motion', () => {
    test('the inbox does not animate offers or the countdown ring when motion is reduced, and does when it is not', async ({
        lab,
    }) => {
        const tenant = await lab.tenant();
        const calm = await lab.agent(tenant, 0, {
            presence: 'online',
            open: '/inbox',
            reducedMotion: 'reduce',
        });
        const lively = await lab.agent(tenant, 0, {
            reducedMotion: 'no-preference',
            open: '/inbox',
        });
        const chat = await lab.chat(tenant, {
            name: 'Maya Thompson',
            message: 'Hello',
        });

        await calm.inbox.expectOffer(chat.ulid);
        await lively.inbox.expectOffer(chat.ulid);

        const animationOf = (agentPage: Page) =>
            agentPage.getByTestId(`offer-${chat.ulid}`).evaluate((card) => ({
                name: getComputedStyle(card).animationName,
                running: card
                    .getAnimations({ subtree: true })
                    .filter(
                        (animation) =>
                            animation.effect?.getComputedTiming().iterations ===
                            Infinity,
                    ).length,
            }));

        expect(
            (await animationOf(calm.page)).name,
            'no entrance animation under reduced motion',
        ).toBe('none');
        expect(
            (await animationOf(lively.page)).name,
            'the control browser does animate the entrance',
        ).not.toBe('none');
        expect((await animationOf(calm.page)).running).toBe(0);
        const ring = (agentPage: Page) =>
            agentPage
                .getByTestId(`offer-${chat.ulid}`)
                .getByTestId('offer-countdown')
                .locator('circle')
                .last()
                .evaluate(
                    (circle) => getComputedStyle(circle).transitionProperty,
                );

        expect(
            await ring(calm.page),
            'the countdown ring does not tween under reduced motion',
        ).toBe('none');
        expect(
            await ring(lively.page),
            'the control browser tweens it',
        ).not.toBe('none');

        must(await chat.visitor.cancel(chat.ulid), 'cancel');
    });

    test('the panel fades instead of moving, and nothing loops on the waiting screen, when motion is reduced', async ({
        lab,
        instance,
    }) => {
        const tenant = await lab.tenant();
        const agent = await lab.agent(tenant, 0, {
            presence: 'online',
            keepAlive: true,
        });
        const probe = async (reducedMotion: 'reduce' | 'no-preference') => {
            const visitor = await lab.visitor();

            await visitor.page.emulateMedia({ reducedMotion });

            const panel = await openCustomerSite(visitor.page, instance, {
                key: tenant.widget.key,
                open: true,
            });
            const started = await panel.startChat({
                category: tenant.categories[0].slug,
                name: 'Maya Thompson',
            });

            await panel.expectState('queued');

            const looping = await panel.root.evaluate(() =>
                document
                    .getAnimations()
                    .filter(
                        (animation) =>
                            animation.effect?.getComputedTiming().iterations ===
                            Infinity,
                    )
                    .map(
                        (animation) =>
                            (animation as CSSAnimation).animationName,
                    ),
            );

            await lab.accept(agent, { ulid: started.ulid! });
            await panel.expectState('active');
            // The conversation screen is a lazily loaded chunk: a message that arrives before it has mounted is part of the transcript
            // it starts with and is not "new" (no entrance); wait for the list, then say something.
            await expect(panel.messageList).toBeVisible();
            must(
                await agent.api.send(started.ulid!, 'Hello Maya'),
                'agent message',
            );
            await panel.expectMessage('Hello Maya', 'agent');

            const bubble = panel.message('Hello Maya', 'agent').first();
            const entrance = await bubble.evaluate(
                (element) => getComputedStyle(element).animationName,
            );

            must(await agent.api.end(started.ulid!), 'end');

            return { looping, entrance };
        };
        const calm = await probe('reduce');
        const lively = await probe('no-preference');

        expect(calm.looping, 'nothing loops on the waiting screen').toEqual([]);
        expect(calm.entrance, 'a new message only fades').toBe('pne-fade');
        expect(
            lively.looping.length,
            'the control browser animates the waiting screen',
        ).toBeGreaterThan(0);
        expect(lively.entrance).toBe('pne-msg');
    });
});

test.describe('screen reader semantics', () => {
    test('the panel exposes a labelled log, a labelled composer, named buttons and a typing status', async ({
        lab,
        instance,
    }) => {
        const tenant = await lab.tenant();
        const agent = await lab.agent(tenant, 0, {
            presence: 'online',
            keepAlive: true,
        });
        const { panel, ulid } = await lab.activePanel(tenant, agent);

        must(await agent.api.send(ulid, 'Hello Maya'), 'agent message');
        await panel.expectMessage('Hello Maya', 'agent');
        await sendImageAsAgent(agent, instance, { ulid }, png(), 'The receipt');
        await panel.expectMessage('The receipt', 'agent');

        // The transcript is a log (announced politely, additions only), with a name.
        const log = panel.frame.getByRole('log');

        await expect(log).toHaveCount(1);
        await expect(log).toHaveAttribute('aria-live', 'polite');
        await expect(log).toHaveAttribute('aria-relevant', 'additions');
        await expect(log).not.toHaveAccessibleName('');

        // The composer and its buttons are named; the image thumbnails say what they are.
        await expect(
            panel.frame.getByRole('textbox', { name: 'Message' }),
        ).toBeVisible();
        await expect(
            panel.frame.getByRole('button', { name: 'Send' }),
        ).toBeVisible();
        await expect(
            panel.frame.getByRole('button', { name: 'Attach image' }),
        ).toBeVisible();
        await expect(
            panel.frame.getByRole('button', { name: 'Close chat' }),
        ).toBeVisible();
        await expect(
            panel.frame.getByRole('button', { name: 'End chat' }),
        ).toBeVisible();
        await expect(
            panel.frame.getByRole('img', { name: /./ }).first(),
        ).toBeVisible();

        // Typing is announced through a status region that is NOT part of the log.
        const status = panel.frame
            .getByRole('status')
            .filter({ hasText: /typing/i });

        must(await agent.api.typing(ulid, true), 'typing');
        await expect(status).toHaveCount(1);
        await expect(status).toContainText('is typing');
        expect(
            await status.evaluate(
                (element) => element.closest('[role="log"]') === null,
            ),
        ).toBe(true);
        must(await agent.api.typing(ulid, false), 'stopped typing');
        await expect(
            panel.frame.getByRole('status').filter({ hasText: /typing/i }),
        ).toHaveCount(0);

        // Every button of the screen has an accessible name.
        for (const button of await panel.frame.getByRole('button').all()) {
            await expect(button).not.toHaveAccessibleName('');
        }

        // The screen is one `main` landmark with the state on it, and the page language / direction are set.
        await expect(panel.frame.getByRole('main')).toHaveCount(1);
        await expect(panel.frame.locator('html')).toHaveAttribute(
            'lang',
            /^en/,
        );
        await expect(panel.frame.locator('html')).toHaveAttribute('dir', 'ltr');

        must(await agent.api.end(ulid), 'end');
    });

    test('the inbox exposes the waiting count as a status, a labelled transcript log and an Accept button named for the visitor', async ({
        lab,
    }) => {
        const tenant = await lab.tenant();
        const agent = await lab.agent(tenant, 0, {
            presence: 'online',
            open: '/inbox',
        });
        const { inbox, page } = agent;
        const chat = await lab.chat(tenant, {
            name: 'Maya Thompson',
            message: 'I was charged twice.',
        });

        await inbox.expectOffer(chat.ulid);

        // "1 chat waiting": announced (polite status), the countdown is hidden from assistive technology (it would chatter).
        await expect(
            inbox.queue.getByRole('status').filter({ hasText: /waiting/i }),
        ).toHaveText(/1 chat waiting/i);
        await expect(
            inbox.offer(chat.ulid).getByTestId('offer-countdown'),
        ).toHaveAttribute('aria-hidden', 'true');
        await expect(
            inbox
                .offer(chat.ulid)
                .getByRole('button', { name: /Accept.*Maya Thompson/ }),
        ).toBeVisible();
        await expect(
            page
                .getByRole('combobox', {
                    name: /status|availability|presence/i,
                })
                .or(inbox.tid('presence-select')),
        ).toBeVisible();

        await inbox.accept(chat.ulid);
        must(await chat.visitor.typing(chat.ulid, true), 'typing');

        const log = inbox.conversation.getByRole('log');

        await expect(log).toHaveAttribute('aria-live', 'polite');
        await expect(log).toHaveAccessibleName(/Maya Thompson/);
        await expect(inbox.conversation).toHaveAccessibleName(/Maya Thompson/);
        await expect(inbox.composerInput).toHaveAccessibleName(/./);

        for (const control of [
            'conversation-info',
            'copy-transcript',
            'transfer-chat',
            'end-chat',
            'composer-send',
        ]) {
            await expect(inbox.tid(control)).not.toHaveAccessibleName('');
        }

        must(await agent.api.end(chat.ulid), 'end');
    });
});
