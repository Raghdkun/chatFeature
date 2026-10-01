import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import {
    GreetingScheduler,
    PausableTimer,
    pickGreeting,
} from '../src/greeting';
import { makeStore } from '../src/storage';
import type { Greeting, GreetingsConfig } from '../src/types';
import { resetGlobals, setHidden } from './helpers';

const g = (id: string, over: Partial<Greeting> = {}): Greeting => ({
    id,
    body: `body ${id}`,
    agentName: null,
    agentAvatarUrl: null,
    locale: null,
    weight: 1,
    ...over,
});

/** Small deterministic PRNG (mulberry32) so the distribution test is reproducible. */
function seeded(seed: number): () => number {
    let a = seed;

    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe('pickGreeting', () => {
    it('follows the weights (seeded RNG)', () => {
        const pool = [
            g('a', { weight: 1 }),
            g('b', { weight: 2 }),
            g('c', { weight: 7 }),
        ];
        const rng = seeded(42);
        const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
        const n = 20000;

        for (let i = 0; i < n; i++) {
            // lastId = null: measures the raw weighted distribution
            counts[pickGreeting(pool, 'en', null, rng)?.id ?? 'x']++;
        }

        expect(counts.a / n).toBeCloseTo(0.1, 1);
        expect(counts.b / n).toBeCloseTo(0.2, 1);
        expect(counts.c / n).toBeCloseTo(0.7, 1);
    });

    it('never returns the previous greeting twice in a row when there is an alternative', () => {
        const pool = [g('a', { weight: 100 }), g('b'), g('c')];
        const rng = seeded(7);
        let last: string | null = null;

        for (let i = 0; i < 2000; i++) {
            const picked = pickGreeting(pool, 'en', last, rng);
            expect(picked?.id).not.toBe(last);
            last = picked?.id ?? null;
        }
    });

    it('still returns the only candidate when it was the last one', () => {
        expect(pickGreeting([g('a')], 'en', 'a', Math.random)?.id).toBe('a');
    });

    it('prefers greetings of the visitor locale and falls back to locale-less ones', () => {
        const pool = [
            g('any'),
            g('en', { locale: 'en' }),
            g('ar1', { locale: 'ar' }),
            g('ar2', { locale: 'ar-sa' }),
        ];
        const rng = seeded(3);
        const ids = (loc: string) =>
            new Set(
                Array.from(
                    { length: 200 },
                    () => pickGreeting(pool, loc, null, rng)?.id,
                ),
            );

        expect(ids('ar-SA')).toEqual(new Set(['ar1', 'ar2']));
        expect(ids('en-US')).toEqual(new Set(['en']));
        expect(ids('fr')).toEqual(new Set(['any']));
    });

    it('falls back to greetings of the widget default locale before giving up', () => {
        const pool = [
            g('en1', { locale: 'en' }),
            g('en2', { locale: 'en-GB' }),
        ];
        const rng = seeded(5);
        const ids = (loc: string, fallback?: string) =>
            new Set(
                Array.from(
                    { length: 100 },
                    () => pickGreeting(pool, loc, null, rng, fallback)?.id,
                ),
            );

        // a French visitor on a widget whose greetings are all tagged `en` still gets one...
        expect(ids('fr-FR', 'en')).toEqual(new Set(['en1', 'en2']));
        // ...but the visitor's own language, then locale-less ones, still come first
        const mixed = [...pool, g('fr', { locale: 'fr' }), g('any')];
        expect(
            new Set(
                Array.from(
                    { length: 100 },
                    () => pickGreeting(mixed, 'fr', null, rng, 'en')?.id,
                ),
            ),
        ).toEqual(new Set(['fr']));
        expect(
            new Set(
                Array.from(
                    { length: 100 },
                    () => pickGreeting(mixed, 'de', null, rng, 'en')?.id,
                ),
            ),
        ).toEqual(new Set(['any']));
        // no fallback locale given: nothing matches
        expect(ids('fr-FR')).toEqual(new Set([undefined]));
    });

    it('returns null for an empty or fully mismatched pool', () => {
        expect(pickGreeting([], 'en', null, Math.random)).toBeNull();
        expect(
            pickGreeting([g('x', { locale: 'ar' })], 'en', null, Math.random),
        ).toBeNull();
    });

    it('treats weights below 1 as 1', () => {
        const rng = seeded(11);
        const seen = new Set(
            Array.from(
                { length: 200 },
                () =>
                    pickGreeting(
                        [g('a', { weight: 0 }), g('b', { weight: -5 })],
                        'en',
                        null,
                        rng,
                    )?.id,
            ),
        );
        expect(seen).toEqual(new Set(['a', 'b']));
    });
});

describe('PausableTimer', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('keeps the time left across pause/resume', () => {
        const cb = vi.fn();
        const t = new PausableTimer(cb, 1000, false);
        vi.advanceTimersByTime(400);
        t.pause();
        vi.advanceTimersByTime(5000);
        expect(cb).not.toHaveBeenCalled();
        t.resume();
        vi.advanceTimersByTime(599);
        expect(cb).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(cb).toHaveBeenCalledTimes(1);
    });

    it('starts paused when asked to and never fires after clear', () => {
        const cb = vi.fn();
        const t = new PausableTimer(cb, 100, true);
        vi.advanceTimersByTime(1000);
        expect(cb).not.toHaveBeenCalled();
        t.clear();
        t.resume();
        vi.advanceTimersByTime(1000);
        expect(cb).not.toHaveBeenCalled();
    });
});

describe('GreetingScheduler', () => {
    let present: Mock<(g: Greeting) => void>;
    let retire: Mock<(g: Greeting, reason: string) => void>;
    let cfg: GreetingsConfig;
    let pool: Greeting[];
    let canShow: boolean;
    let sched: GreetingScheduler;

    const make = (over: Partial<GreetingsConfig> = {}): GreetingScheduler => {
        cfg = {
            enabled: true,
            onPageLoad: true,
            delaySeconds: 3,
            intervalMinutes: 30,
            autoHideSeconds: 20,
            dismissPolicy: 'session',
            showAgent: true,
            ...over,
        };
        sched = new GreetingScheduler({
            cfg: () => cfg,
            pool: () => pool,
            locale: () => 'en',
            canShow: () => canShow,
            present: (x) => present(x),
            retire: (x, r) => retire(x, r),
            local: makeStore(window, 'local'),
            session: makeStore(window, 'session'),
            storageKey: 'chatfeature:wk_T',
        });

        return sched;
    };

    beforeEach(() => {
        vi.useFakeTimers();
        present = vi.fn();
        retire = vi.fn();
        pool = [g('a'), g('b'), g('c')];
        canShow = true;
        vi.spyOn(Math, 'random').mockReturnValue(0);
    });

    afterEach(() => {
        sched?.stop();
        vi.restoreAllMocks();
        vi.useRealTimers();
        resetGlobals();
    });

    it('shows the first greeting after delaySeconds on page load', () => {
        make().start();
        vi.advanceTimersByTime(2999);
        expect(present).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(present).toHaveBeenCalledTimes(1);
        expect(sched.active?.id).toBe('a');
    });

    it('repeats every intervalMinutes (after the previous one was hidden) and never repeats back-to-back', () => {
        make({ autoHideSeconds: 10 }).start();
        const shown: string[] = [];
        present.mockImplementation((x: Greeting) => void shown.push(x.id));

        vi.advanceTimersByTime(3000); // load
        vi.advanceTimersByTime(10_000); // auto-hide
        vi.advanceTimersByTime(30 * 60_000); // +30 min
        vi.advanceTimersByTime(10_000);
        vi.advanceTimersByTime(30 * 60_000);

        expect(shown).toHaveLength(3);
        shown.forEach((id, i) => i > 0 && expect(id).not.toBe(shown[i - 1]));
    });

    it('remembers the last greeting across page loads (localStorage)', () => {
        make().start();
        vi.advanceTimersByTime(3000);
        expect(sched.active?.id).toBe('a');
        sched.stop();

        // "next page load": new scheduler, Math.random still 0 -> would pick "a" again without memory
        make().start();
        vi.advanceTimersByTime(3000);
        expect(sched.active?.id).toBe('b');
    });

    it('onPageLoad=false waits for the first interval; intervalMinutes=0 means page load only', () => {
        make({ onPageLoad: false, intervalMinutes: 1 }).start();
        vi.advanceTimersByTime(59_999);
        expect(present).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(present).toHaveBeenCalledTimes(1);
        sched.stop();

        present.mockClear();
        make({ intervalMinutes: 0, autoHideSeconds: 1 }).start();
        vi.advanceTimersByTime(3000 + 1000 + 24 * 3600_000);
        expect(present).toHaveBeenCalledTimes(1);
    });

    it('does nothing when disabled', () => {
        make({ enabled: false }).start();
        vi.advanceTimersByTime(24 * 3600_000);
        expect(present).not.toHaveBeenCalled();
    });

    it('auto-hides after autoHideSeconds with reason "timeout" (0 = never)', () => {
        make().start();
        vi.advanceTimersByTime(3000);
        vi.advanceTimersByTime(19_999);
        expect(retire).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(retire).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'a' }),
            'timeout',
        );
        expect(sched.active).toBeNull();
        sched.stop();

        retire.mockClear();
        make({ autoHideSeconds: 0 }).start();
        vi.advanceTimersByTime(3000 + 3600_000);
        expect(retire).not.toHaveBeenCalled();
        expect(sched.active).not.toBeNull();
    });

    describe('hidden tab', () => {
        it('pauses the delay while the tab is hidden and resumes with the time left', () => {
            make().start();
            vi.advanceTimersByTime(1000);
            setHidden(true);
            vi.advanceTimersByTime(60_000);
            expect(present).not.toHaveBeenCalled();
            setHidden(false);
            vi.advanceTimersByTime(1999);
            expect(present).not.toHaveBeenCalled();
            vi.advanceTimersByTime(1);
            expect(present).toHaveBeenCalledTimes(1);
        });

        it('a page opened in a background tab only starts counting once it becomes visible', () => {
            setHidden(true);
            make().start();
            vi.advanceTimersByTime(60_000);
            expect(present).not.toHaveBeenCalled();
            setHidden(false);
            vi.advanceTimersByTime(3000);
            expect(present).toHaveBeenCalledTimes(1);
        });

        it('pauses the auto-hide timer too, so the popup stays for its full time once seen', () => {
            make().start();
            vi.advanceTimersByTime(3000);
            vi.advanceTimersByTime(15_000);
            setHidden(true);
            vi.advanceTimersByTime(10 * 60_000);
            expect(retire).not.toHaveBeenCalled();
            setHidden(false);
            vi.advanceTimersByTime(4999);
            expect(retire).not.toHaveBeenCalled();
            vi.advanceTimersByTime(1);
            expect(retire).toHaveBeenCalledTimes(1);
        });
    });

    describe('suppression', () => {
        it('skips a tick while the panel is open or a chat is active, then shows at the next one', () => {
            make({ autoHideSeconds: 5 }).start();
            canShow = false;
            vi.advanceTimersByTime(3000);
            expect(present).not.toHaveBeenCalled();
            canShow = true;
            vi.advanceTimersByTime(30 * 60_000);
            expect(present).toHaveBeenCalledTimes(1);
        });

        it('hide("opened") removes the popup without counting as a dismissal', () => {
            make({ dismissPolicy: 'session', intervalMinutes: 1 }).start();
            vi.advanceTimersByTime(3000);
            sched.hide('opened');
            expect(retire).toHaveBeenCalledWith(
                expect.objectContaining({ id: 'a' }),
                'opened',
            );
            vi.advanceTimersByTime(60_000);
            expect(present).toHaveBeenCalledTimes(2);
        });

        it('does not show a second greeting while one is visible', () => {
            make({ intervalMinutes: 1, autoHideSeconds: 0 }).start();
            vi.advanceTimersByTime(3000 + 5 * 60_000);
            expect(present).toHaveBeenCalledTimes(1);
        });
    });

    describe('dismiss policy', () => {
        it('session: a visitor dismissal silences greetings for the rest of the session, including later page loads', () => {
            make({ dismissPolicy: 'session', intervalMinutes: 1 }).start();
            vi.advanceTimersByTime(3000);
            sched.dismiss();
            expect(retire).toHaveBeenCalledWith(expect.anything(), 'dismissed');
            vi.advanceTimersByTime(10 * 60_000);
            expect(present).toHaveBeenCalledTimes(1);
            sched.stop();

            make({ dismissPolicy: 'session' }).start(); // next page of the same session
            vi.advanceTimersByTime(3000);
            expect(present).toHaveBeenCalledTimes(1);

            sessionStorage.clear(); // new session
            sched.stop();
            make({ dismissPolicy: 'session' }).start();
            vi.advanceTimersByTime(3000);
            expect(present).toHaveBeenCalledTimes(2);
        });

        it('interval: silent until a full interval has passed since the dismissal', () => {
            make({
                dismissPolicy: 'interval',
                intervalMinutes: 10,
                autoHideSeconds: 0,
            }).start();
            vi.advanceTimersByTime(3000);
            sched.dismiss();
            vi.advanceTimersByTime(7 * 60_000 - 3000 + 3000); // the 10-minute tick of this page: only 7 min after dismissal
            expect(present).toHaveBeenCalledTimes(1);
            vi.advanceTimersByTime(10 * 60_000);
            expect(present).toHaveBeenCalledTimes(2);
        });

        it('interval: shown at 0:03 and dismissed at 0:11, the next greeting comes at 10:11, one full interval after the dismissal (not a whole cycle later)', () => {
            make({
                dismissPolicy: 'interval',
                intervalMinutes: 10,
                autoHideSeconds: 0,
            }).start();
            vi.advanceTimersByTime(3000);
            expect(present).toHaveBeenCalledTimes(1);
            vi.advanceTimersByTime(8000);
            sched.dismiss(); // 0:11, not at a tick instant

            vi.advanceTimersByTime(10 * 60_000 + 3000 - 11_000); // 10:03, where the old timeline ticked
            expect(present).toHaveBeenCalledTimes(1);
            vi.advanceTimersByTime(7999); // 10:10.999
            expect(present).toHaveBeenCalledTimes(1);
            vi.advanceTimersByTime(1); // 10:11
            expect(present).toHaveBeenCalledTimes(2);

            // the timeline carries on from the new anchor
            sched.dismiss();
            vi.advanceTimersByTime(10 * 60_000);
            expect(present).toHaveBeenCalledTimes(3);
        });

        it('interval: only a visitor dismissal moves the timeline (auto-hide and opening do not)', () => {
            make({
                dismissPolicy: 'interval',
                intervalMinutes: 10,
                autoHideSeconds: 5,
            }).start();
            vi.advanceTimersByTime(3000 + 5000); // shown, auto-hidden at 0:08
            vi.advanceTimersByTime(10 * 60_000 - 8000 + 3000); // old tick at 10:03
            expect(present).toHaveBeenCalledTimes(2);
        });

        it('interval: a page load within the window stays silent', () => {
            make({ dismissPolicy: 'interval', intervalMinutes: 10 }).start();
            vi.advanceTimersByTime(3000);
            sched.dismiss();
            sched.stop();
            vi.advanceTimersByTime(5 * 60_000);

            make({ dismissPolicy: 'interval', intervalMinutes: 10 }).start();
            vi.advanceTimersByTime(3000);
            expect(present).toHaveBeenCalledTimes(1);
        });

        it('never: dismissal is not remembered', () => {
            make({
                dismissPolicy: 'never',
                intervalMinutes: 1,
                autoHideSeconds: 0,
            }).start();
            vi.advanceTimersByTime(3000);
            sched.dismiss();
            vi.advanceTimersByTime(60_000);
            expect(present).toHaveBeenCalledTimes(2);
            sched.stop();

            make({ dismissPolicy: 'never' }).start();
            vi.advanceTimersByTime(3000);
            expect(present).toHaveBeenCalledTimes(3);
        });

        it('an auto-hide timeout is not a dismissal', () => {
            make({
                dismissPolicy: 'session',
                intervalMinutes: 1,
                autoHideSeconds: 5,
            }).start();
            vi.advanceTimersByTime(3000 + 5000);
            expect(retire).toHaveBeenCalledWith(expect.anything(), 'timeout');
            vi.advanceTimersByTime(60_000);
            expect(present).toHaveBeenCalledTimes(2);
        });
    });

    it('stop() cancels pending timers, retires the active greeting and ignores later visibility changes', () => {
        make().start();
        vi.advanceTimersByTime(3000);
        sched.stop();
        expect(retire).toHaveBeenCalledWith(expect.anything(), 'suppressed');
        present.mockClear();
        setHidden(true);
        setHidden(false);
        vi.advanceTimersByTime(24 * 3600_000);
        expect(present).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('start() again re-arms from scratch (config change at runtime)', () => {
        make({ delaySeconds: 60 }).start();
        vi.advanceTimersByTime(10_000);
        cfg = { ...cfg, delaySeconds: 2 };
        sched.start();
        vi.advanceTimersByTime(2000);
        expect(present).toHaveBeenCalledTimes(1);
    });
});
