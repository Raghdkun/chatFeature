/**
 * The notification sound for agent messages while the panel is open (the loader plays its own while the panel is closed).
 * Web Audio, unlocked by the first gesture inside the iframe; silent until then, and silent when audio is unavailable.
 */
let context: AudioContext | undefined;
let armed = false;

function create(): AudioContext | undefined {
    try {
        const Ctor =
            window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext })
                .webkitAudioContext;

        return Ctor === undefined ? undefined : new Ctor();
    } catch {
        return undefined;
    }
}

/** Listens for the first pointer / key gesture and resumes the audio context then. */
export function armSound(target: Window = window): void {
    if (armed) {
        return;
    }

    armed = true;

    const unlock = (): void => {
        context ??= create();
        void context?.resume().catch(() => undefined);
        target.removeEventListener('pointerdown', unlock, true);
        target.removeEventListener('keydown', unlock, true);
    };

    target.addEventListener('pointerdown', unlock, true);
    target.addEventListener('keydown', unlock, true);
}

/** A short soft two-note chime. */
export function ping(): void {
    try {
        if (context?.state !== 'running') {
            return;
        }

        const start = context.currentTime;

        for (const [index, frequency] of [740, 988].entries()) {
            const oscillator = context.createOscillator();
            const gain = context.createGain();
            const at = start + index * 0.09;

            oscillator.type = 'sine';
            oscillator.frequency.value = frequency;
            gain.gain.setValueAtTime(0.0001, at);
            gain.gain.exponentialRampToValueAtTime(0.08, at + 0.015);
            gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);
            oscillator.connect(gain).connect(context.destination);
            oscillator.start(at);
            oscillator.stop(at + 0.2);
        }
    } catch {
        // a sound is a nicety
    }
}

export const sound = { ping };
