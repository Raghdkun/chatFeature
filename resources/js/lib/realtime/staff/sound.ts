/**
 * The inbox's notification sounds, synthesised with Web Audio (no files to ship or cache). Browsers keep an `AudioContext`
 * suspended until the user has interacted with the page, so nothing sounds before the first gesture: `bindSoundUnlock()` listens
 * for it once and `play()` is a silent no-op until then (and while the agent has muted sounds).
 */

export type SoundKind = 'offer' | 'message';

/** `locked`: not muted, but the browser has not let the page make sound yet (no gesture so far). */
export type SoundState = 'on' | 'muted' | 'locked';

export type SoundPlayer = {
    /** Create / resume the audio context. Safe to call repeatedly; must run inside a user gesture the first time. */
    unlock: () => void;
    play: (kind: SoundKind) => void;
    isMuted: () => boolean;
    setMuted: (muted: boolean) => void;
    /** What the toggle should show; a stable string, so it can feed `useSyncExternalStore`. */
    state: () => SoundState;
    subscribe: (listener: () => void) => () => void;
};

type AudioContextFactory = () => AudioContext | null;

const STORAGE_KEY = 'pne.chat.staff.sound-muted';

/** [frequency Hz, start offset s, length s]: an ascending arpeggio for a new request, one soft tick for a message. */
const NOTES: Record<SoundKind, [number, number, number][]> = {
    offer: [
        [659.25, 0, 0.16],
        [783.99, 0.14, 0.16],
        [1046.5, 0.28, 0.32],
    ],
    message: [[880, 0, 0.14]],
};

const VOLUME: Record<SoundKind, number> = { offer: 0.18, message: 0.1 };

function defaultContext(): AudioContext | null {
    const Ctor =
        typeof window === 'undefined'
            ? undefined
            : (window.AudioContext ??
              (
                  window as unknown as {
                      webkitAudioContext?: typeof AudioContext;
                  }
              ).webkitAudioContext);

    return Ctor ? new Ctor() : null;
}

function readMuted(storage: Pick<Storage, 'getItem'> | null): boolean {
    try {
        return storage?.getItem(STORAGE_KEY) === '1';
    } catch {
        return false;
    }
}

export function createSoundPlayer(
    createContext: AudioContextFactory = defaultContext,
    storage: Pick<Storage, 'getItem' | 'setItem'> | null = typeof window ===
    'undefined'
        ? null
        : window.localStorage,
): SoundPlayer {
    let context: AudioContext | null = null;
    // A browser without Web Audio is not "locked" (no click would help): it just never makes a sound.
    let unsupported = false;
    let muted = readMuted(storage);
    const listeners = new Set<() => void>();

    function notify(): void {
        listeners.forEach((listener) => listener());
    }

    function unlock(): void {
        try {
            context ??= createContext();
            unsupported = context === null;

            if (context && context.state === 'suspended') {
                // The state flips to `running` once the browser agrees: tell the toggle then.
                void context.resume().then(notify, () => undefined);
            }
        } catch {
            context = null;
        }
    }

    function play(kind: SoundKind): void {
        if (muted || !context || context.state !== 'running') {
            return;
        }

        const ctx = context;
        const start = ctx.currentTime;

        for (const [frequency, offset, length] of NOTES[kind]) {
            const oscillator = ctx.createOscillator();
            const gain = ctx.createGain();
            const at = start + offset;

            oscillator.type = 'sine';
            oscillator.frequency.value = frequency;
            // A short attack and a decay to silence: no click at the start or the end.
            gain.gain.setValueAtTime(0.0001, at);
            gain.gain.linearRampToValueAtTime(VOLUME[kind], at + 0.015);
            gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
            oscillator.connect(gain).connect(ctx.destination);
            oscillator.start(at);
            oscillator.stop(at + length + 0.02);
        }
    }

    return {
        unlock,
        play,
        isMuted: () => muted,
        setMuted(next) {
            muted = next;

            try {
                storage?.setItem(STORAGE_KEY, next ? '1' : '0');
            } catch {
                // Private mode: the choice lasts for this page only.
            }

            notify();
        },
        state: () =>
            muted
                ? 'muted'
                : context?.state === 'running' || unsupported
                  ? 'on'
                  : 'locked',
        subscribe(listener) {
            listeners.add(listener);

            return () => {
                listeners.delete(listener);
            };
        },
    };
}

/** Unlock the player on the first pointer / key press anywhere on the page. Returns the cleanup. */
export function bindSoundUnlock(
    player: Pick<SoundPlayer, 'unlock'>,
    target: Pick<
        Document,
        'addEventListener' | 'removeEventListener'
    > = document,
): () => void {
    const events = ['pointerdown', 'keydown', 'touchstart'] as const;
    const handler = (): void => {
        player.unlock();
        remove();
    };
    const remove = (): void => {
        events.forEach((name) =>
            target.removeEventListener(name, handler, { capture: true }),
        );
    };

    events.forEach((name) =>
        target.addEventListener(name, handler, { capture: true }),
    );

    return remove;
}
