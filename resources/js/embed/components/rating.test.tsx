import { describe, expect, it } from 'vite-plus/test';
import { fill } from '@/tests/dom';
import { click } from '@/tests/render';
import { useBackend } from '@/tests/msw/server';
import { createHarness, makeInit } from '@/tests/embed-harness';
import {
    press,
    renderPanel,
    run,
    settleFrame,
    text,
    waitFor,
} from '@/tests/embed-render';

const byTestId = (root: ParentNode, id: string): HTMLElement | null =>
    root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const phase = (root: ParentNode): string | undefined =>
    byTestId(root, 'chat-state')?.dataset.state;

async function ended() {
    const backend = useBackend();
    const stored = backend.issueToken();

    backend.seedConversation(stored.token, 'active');
    backend.agentSays('Anything else?');
    backend.agentEnds(true);

    const h = createHarness({ backend });
    const view = await renderPanel(h);

    await run(() => h.init(makeInit({ visitorSession: stored })));
    await run(() => h.open());
    await settleFrame();

    return { backend, h, c: view.container };
}

describe('rating screen', () => {
    it('keeps the transcript readable above the card, and the submit disabled until a star is chosen', async () => {
        const { c } = await ended();

        expect(phase(c)).toBe('ended');
        expect(text(byTestId(c, 'message-list'))).toContain('Anything else?');
        expect(text(c)).toContain('How was this chat?');
        expect(
            (byTestId(c, 'rating-submit') as HTMLButtonElement).disabled,
        ).toBe(true);
        expect(byTestId(c, 'composer-input')).toBeNull();
        expect(byTestId(c, 'end-chat')).toBeNull();

        await click(byTestId(c, 'rating-star-5'));
        expect(
            (byTestId(c, 'rating-submit') as HTMLButtonElement).disabled,
        ).toBe(false);
    });

    it('stars are a radio group: labelled, roving tabindex, arrow keys move and select', async () => {
        const { c } = await ended();
        const group = byTestId(c, 'rating-stars') as HTMLElement;
        const stars = Array.from(
            group.querySelectorAll<HTMLElement>('[role="radio"]'),
        );

        expect(group.getAttribute('role')).toBe('radiogroup');
        expect(group.getAttribute('aria-label')).toBe('How was this chat?');
        expect(stars.map((s) => s.getAttribute('aria-label'))).toEqual([
            'Rate 1 out of 5',
            'Rate 2 out of 5',
            'Rate 3 out of 5',
            'Rate 4 out of 5',
            'Rate 5 out of 5',
        ]);
        expect(stars.map((s) => s.tabIndex)).toEqual([0, -1, -1, -1, -1]);

        await press(stars[0], 'ArrowRight');
        expect(stars[1].getAttribute('aria-checked')).toBe('true');
        expect(document.activeElement).toBe(stars[1]);
        expect(stars.map((s) => s.tabIndex)).toEqual([-1, 0, -1, -1, -1]);

        await press(stars[1], 'ArrowRight');
        await press(stars[2], 'ArrowUp');
        expect(stars[3].getAttribute('aria-checked')).toBe('true');

        await press(stars[3], 'ArrowLeft');
        await press(stars[2], 'ArrowDown');
        expect(stars[1].getAttribute('aria-checked')).toBe('true');
        // never below 1 or above 5
        await press(stars[1], 'ArrowLeft');
        await press(stars[0], 'ArrowLeft');
        expect(stars[0].getAttribute('aria-checked')).toBe('true');
    });

    it('submits the score and the trimmed comment, then thanks the visitor', async () => {
        const { backend, c } = await ended();

        await click(byTestId(c, 'rating-star-3'));
        await fill(
            byTestId(c, 'rating-comment') as HTMLTextAreaElement,
            '  OK  ',
        );
        await click(byTestId(c, 'rating-submit'));
        await waitFor(() => phase(c) === 'closed');

        expect(backend.state.ratings).toEqual([{ score: 3, comment: 'OK' }]);
        expect(text(c)).toContain('Thanks for your feedback!');
    });

    it('a rating without a comment sends just the score; the comment is capped at 2000 characters', async () => {
        const { backend, c } = await ended();

        expect(
            (byTestId(c, 'rating-comment') as HTMLTextAreaElement).maxLength,
        ).toBe(2000);
        await click(byTestId(c, 'rating-star-1'));
        await click(byTestId(c, 'rating-submit'));
        await waitFor(() => phase(c) === 'closed');

        expect(backend.state.ratings).toEqual([{ score: 1 }]);
    });

    it('can be skipped without calling the server', async () => {
        const { backend, c } = await ended();

        await click(byTestId(c, 'rating-skip'));

        expect(phase(c)).toBe('closed');
        expect(backend.callsTo('POST', '/rating')).toHaveLength(0);
        expect(text(c)).toContain('Thanks for your feedback!');
    });

    it('shows a failure and lets the visitor try again', async () => {
        const { backend, c } = await ended();

        backend.fail('POST', '/rating$', 500, undefined, 1);
        await click(byTestId(c, 'rating-star-4'));
        await click(byTestId(c, 'rating-submit'));
        await waitFor(() => c.querySelector('[role="alert"]') !== null);

        expect(phase(c)).toBe('ended');

        await click(byTestId(c, 'rating-submit'));
        await waitFor(() => phase(c) === 'closed');
    });
});
