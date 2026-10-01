/**
 * Typing indicator timing (the `client-typing` whisper of docs/contracts/realtime-events.md): a sender tells the other side it
 * is typing at most once every 3 s, and a receiver treats the indicator as gone 5 s after the last "typing" it heard
 * (typing has no server state and a lost "stopped" whisper must not leave the dots on forever).
 *
 * Everything here is pure: every function takes `now` (milliseconds) so tests and components decide where time comes from.
 * `createTypingTracker` binds the same logic to a clock for imperative callers (a hook that owns a ref).
 */
import type { TypingActor, TypingWhisper } from '@/lib/chat/types';

/** A sender repeats "typing" at most this often while keys keep coming. */
export const TYPING_DEBOUNCE_MS = 3_000;

/** A receiver drops the indicator this long after the last "typing" whisper. */
export const TYPING_EXPIRE_MS = 5_000;

export type Clock = () => number;

/* -------------------------------------------------------------------------- */
/* Sending side                                                               */
/* -------------------------------------------------------------------------- */

export type TypingSendState = {
    /** Whether the other side currently believes we are typing. */
    typing: boolean;
    /** When the last "typing: true" whisper left, in clock milliseconds. */
    sentAt: number | null;
};

export type TypingSendResult = {
    state: TypingSendState;
    /** The value to whisper (`typing: true | false`), or `null` when nothing should be sent. */
    send: boolean | null;
};

export function createTypingSendState(): TypingSendState {
    return { typing: false, sentAt: null };
}

/**
 * The input changed. `typing` is true on every keystroke and false when the draft was emptied, sent or lost focus.
 * A keystroke whispers at once the first time and then at most once per `TYPING_DEBOUNCE_MS`; "stopped" is whispered only
 * if "typing" was.
 */
export function onLocalTyping(
    state: TypingSendState,
    typing: boolean,
    now: number,
): TypingSendResult {
    if (typing) {
        const due =
            state.sentAt === null || now - state.sentAt >= TYPING_DEBOUNCE_MS;

        if (!state.typing || due) {
            return { state: { typing: true, sentAt: now }, send: true };
        }

        return { state, send: null };
    }

    if (!state.typing) {
        return { state, send: null };
    }

    return { state: { typing: false, sentAt: null }, send: false };
}

/* -------------------------------------------------------------------------- */
/* Receiving side                                                             */
/* -------------------------------------------------------------------------- */

/** Per actor, when the indicator expires (clock milliseconds); absent = not typing. */
export type TypingReceiveState = Readonly<Partial<Record<TypingActor, number>>>;

export const EMPTY_TYPING: TypingReceiveState = Object.freeze({});

/** A whisper arrived: "typing" (re)starts the 5 s countdown, "stopped" clears it. */
export function onRemoteTyping(
    state: TypingReceiveState,
    whisper: TypingWhisper,
    now: number,
): TypingReceiveState {
    if (!whisper.typing) {
        if (state[whisper.actor] === undefined) {
            return state;
        }

        const { [whisper.actor]: _removed, ...rest } = state;

        return rest;
    }

    return { ...state, [whisper.actor]: now + TYPING_EXPIRE_MS };
}

export function isRemoteTyping(
    state: TypingReceiveState,
    actor: TypingActor,
    now: number,
): boolean {
    const expiresAt = state[actor];

    return expiresAt !== undefined && now < expiresAt;
}

/** Drop expired entries (returns the same object when nothing expired). */
export function pruneTyping(
    state: TypingReceiveState,
    now: number,
): TypingReceiveState {
    const live = Object.entries(state).filter(
        ([, expiresAt]) => expiresAt !== undefined && now < expiresAt,
    );

    return live.length === Object.keys(state).length
        ? state
        : (Object.fromEntries(live) as TypingReceiveState);
}

/** Milliseconds until the next indicator expires (to schedule one re-render), or `null` when nobody is typing. */
export function msUntilTypingExpires(
    state: TypingReceiveState,
    now: number,
): number | null {
    const remaining = Object.values(state)
        .filter((expiresAt): expiresAt is number => expiresAt !== undefined)
        .map((expiresAt) => expiresAt - now)
        .filter((ms) => ms > 0);

    return remaining.length === 0 ? null : Math.min(...remaining);
}

/* -------------------------------------------------------------------------- */
/* Clock-bound convenience                                                    */
/* -------------------------------------------------------------------------- */

export type TypingTracker = {
    /** The local input changed; returns what to whisper, or `null`. */
    local(typing: boolean): boolean | null;
    /** A whisper arrived from the other side. */
    receive(whisper: TypingWhisper): void;
    /** Whether `actor` is typing right now. */
    isTyping(actor: TypingActor): boolean;
    /** Milliseconds until the next indicator expires, or `null`. */
    msUntilExpiry(): number | null;
    /** Forget everything (conversation switched, ended or closed). */
    reset(): void;
};

/** The same rules bound to a clock (default `Date.now`, so fake timers drive it in tests). */
export function createTypingTracker(clock: Clock = Date.now): TypingTracker {
    let sending = createTypingSendState();
    let receiving: TypingReceiveState = EMPTY_TYPING;

    return {
        local(typing) {
            const result = onLocalTyping(sending, typing, clock());
            sending = result.state;

            return result.send;
        },
        receive(whisper) {
            receiving = pruneTyping(
                onRemoteTyping(receiving, whisper, clock()),
                clock(),
            );
        },
        isTyping(actor) {
            return isRemoteTyping(receiving, actor, clock());
        },
        msUntilExpiry() {
            return msUntilTypingExpires(receiving, clock());
        },
        reset() {
            sending = createTypingSendState();
            receiving = EMPTY_TYPING;
        },
    };
}
