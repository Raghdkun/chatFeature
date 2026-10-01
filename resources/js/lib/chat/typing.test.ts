import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vite-plus/test';
import {
    TYPING_DEBOUNCE_MS,
    TYPING_EXPIRE_MS,
    createTypingSendState,
    createTypingTracker,
    isRemoteTyping,
    msUntilTypingExpires,
    onLocalTyping,
    onRemoteTyping,
    pruneTyping,
    type TypingReceiveState,
} from '@/lib/chat/typing';

describe('contract constants', () => {
    it('debounce 3 s, expire 5 s', () => {
        expect(TYPING_DEBOUNCE_MS).toBe(3000);
        expect(TYPING_EXPIRE_MS).toBe(5000);
    });
});

describe('onLocalTyping (sending side)', () => {
    it('whispers on the first keystroke and then at most once per 3 s', () => {
        let state = createTypingSendState();
        const sent: Array<[number, boolean | null]> = [];

        for (const at of [0, 400, 1200, 2900, 3000, 3500, 5000, 6100]) {
            const result = onLocalTyping(state, true, at);
            state = result.state;
            sent.push([at, result.send]);
        }

        expect(
            sent.filter(([, send]) => send === true).map(([at]) => at),
        ).toEqual([0, 3000, 6100]);
        expect(sent.filter(([, send]) => send === null)).toHaveLength(5);
    });

    it('whispers "stopped" only when "typing" was whispered', () => {
        const idle = createTypingSendState();
        expect(onLocalTyping(idle, false, 10)).toEqual({
            state: idle,
            send: null,
        });

        const typing = onLocalTyping(idle, true, 10).state;
        const stopped = onLocalTyping(typing, false, 20);

        expect(stopped.send).toBe(false);
        expect(stopped.state).toEqual({ typing: false, sentAt: null });
        expect(onLocalTyping(stopped.state, false, 30).send).toBeNull();
    });

    it('whispers immediately when typing resumes after a stop, inside the debounce window', () => {
        let state = onLocalTyping(createTypingSendState(), true, 0).state;
        state = onLocalTyping(state, false, 500).state;

        expect(onLocalTyping(state, true, 800).send).toBe(true);
    });

    it('does not mutate the previous state', () => {
        const state = Object.freeze(createTypingSendState());

        expect(() => onLocalTyping(state, true, 5)).not.toThrow();
        expect(state).toEqual({ typing: false, sentAt: null });
    });
});

describe('remote typing (receiving side)', () => {
    const empty: TypingReceiveState = {};

    it('shows the indicator for 5 s after the last "typing"', () => {
        const state = onRemoteTyping(
            empty,
            { actor: 'agent', typing: true },
            1000,
        );

        expect(isRemoteTyping(state, 'agent', 1000)).toBe(true);
        expect(isRemoteTyping(state, 'agent', 5999)).toBe(true);
        expect(isRemoteTyping(state, 'agent', 6000)).toBe(false);
        expect(isRemoteTyping(state, 'visitor', 1000)).toBe(false);
    });

    it('extends the countdown when "typing" repeats', () => {
        let state = onRemoteTyping(
            empty,
            { actor: 'visitor', typing: true },
            0,
        );
        state = onRemoteTyping(state, { actor: 'visitor', typing: true }, 3000);

        expect(isRemoteTyping(state, 'visitor', 7999)).toBe(true);
        expect(isRemoteTyping(state, 'visitor', 8000)).toBe(false);
    });

    it('clears at once on "stopped"', () => {
        const typing = onRemoteTyping(
            empty,
            { actor: 'agent', typing: true },
            0,
        );
        const stopped = onRemoteTyping(
            typing,
            { actor: 'agent', typing: false },
            100,
        );

        expect(isRemoteTyping(stopped, 'agent', 100)).toBe(false);
        expect(stopped).toEqual({});
    });

    it('ignores "stopped" for somebody who was not typing (same state back)', () => {
        expect(
            onRemoteTyping(empty, { actor: 'agent', typing: false }, 0),
        ).toBe(empty);
    });

    it('tracks both actors independently', () => {
        let state = onRemoteTyping(empty, { actor: 'agent', typing: true }, 0);
        state = onRemoteTyping(state, { actor: 'visitor', typing: true }, 2000);

        expect(isRemoteTyping(state, 'agent', 5500)).toBe(false);
        expect(isRemoteTyping(state, 'visitor', 5500)).toBe(true);
    });

    it('prunes expired entries and keeps live ones (same object when nothing expired)', () => {
        let state = onRemoteTyping(empty, { actor: 'agent', typing: true }, 0);
        state = onRemoteTyping(state, { actor: 'visitor', typing: true }, 4000);

        expect(pruneTyping(state, 1000)).toBe(state);
        expect(pruneTyping(state, 6000)).toEqual({ visitor: 9000 });
        expect(pruneTyping(state, 20000)).toEqual({});
    });

    it('says when to look again', () => {
        let state = onRemoteTyping(empty, { actor: 'agent', typing: true }, 0);
        state = onRemoteTyping(state, { actor: 'visitor', typing: true }, 2000);

        expect(msUntilTypingExpires(empty, 0)).toBeNull();
        expect(msUntilTypingExpires(state, 1000)).toBe(4000);
        expect(msUntilTypingExpires(state, 5500)).toBe(1500);
        expect(msUntilTypingExpires(state, 7000)).toBeNull();
    });
});

describe('createTypingTracker with fake timers', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-11-20T10:00:00.000Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('debounces the local whisper against the real clock', () => {
        const tracker = createTypingTracker();

        expect(tracker.local(true)).toBe(true);
        vi.advanceTimersByTime(1000);
        expect(tracker.local(true)).toBeNull();
        vi.advanceTimersByTime(1999);
        expect(tracker.local(true)).toBeNull();
        vi.advanceTimersByTime(1);
        expect(tracker.local(true)).toBe(true);
        expect(tracker.local(false)).toBe(false);
        expect(tracker.local(false)).toBeNull();
    });

    it('expires the remote indicator after 5 s of silence', () => {
        const tracker = createTypingTracker();

        tracker.receive({ actor: 'agent', typing: true });
        expect(tracker.isTyping('agent')).toBe(true);
        expect(tracker.msUntilExpiry()).toBe(5000);

        vi.advanceTimersByTime(4999);
        expect(tracker.isTyping('agent')).toBe(true);
        expect(tracker.msUntilExpiry()).toBe(1);

        vi.advanceTimersByTime(1);
        expect(tracker.isTyping('agent')).toBe(false);
        expect(tracker.msUntilExpiry()).toBeNull();
    });

    it('lets a repeated whisper keep the indicator alive', () => {
        const tracker = createTypingTracker();

        tracker.receive({ actor: 'visitor', typing: true });
        vi.advanceTimersByTime(3000);
        tracker.receive({ actor: 'visitor', typing: true });
        vi.advanceTimersByTime(3000);

        expect(tracker.isTyping('visitor')).toBe(true);

        vi.advanceTimersByTime(2000);
        expect(tracker.isTyping('visitor')).toBe(false);
    });

    it('clears on "stopped" and on reset', () => {
        const tracker = createTypingTracker();

        tracker.receive({ actor: 'agent', typing: true });
        tracker.receive({ actor: 'agent', typing: false });
        expect(tracker.isTyping('agent')).toBe(false);

        tracker.receive({ actor: 'visitor', typing: true });
        tracker.local(true);
        tracker.reset();
        expect(tracker.isTyping('visitor')).toBe(false);
        expect(tracker.local(true)).toBe(true);
    });

    it('takes its time from an injected clock', () => {
        let now = 1_000_000;
        const tracker = createTypingTracker(() => now);

        tracker.receive({ actor: 'agent', typing: true });
        now += 4999;
        expect(tracker.isTyping('agent')).toBe(true);
        now += 1;
        expect(tracker.isTyping('agent')).toBe(false);
    });
});
