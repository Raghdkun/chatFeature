let ctx: AudioContext | undefined;

/** First user gesture inside the widget: browsers only allow audio after one. */
export function unlockSound(win: Window): void {
    try {
        const w = win as unknown as { AudioContext?: typeof AudioContext };
        ctx ??= w.AudioContext === undefined ? undefined : new w.AudioContext();
        void ctx?.resume();
    } catch {
        // audio is a nicety
    }
}

/** One soft 880 Hz note (about 200 ms). Silent when audio was never unlocked. */
export function ping(): void {
    try {
        if (ctx?.state !== 'running') {
            return;
        }

        const t = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.1, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.22);
    } catch {
        // ignore
    }
}
