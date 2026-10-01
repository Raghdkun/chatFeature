/**
 * Waiting without sleeping: poll something that can be read (REST, the database, the DOM) until it is what the spec expects.
 * A realtime event may arrive a few milliseconds or a few seconds after the request that caused it; a fixed `waitForTimeout` is
 * either too short (flaky) or too long (slow). For anything shown in a page prefer Playwright's own web-first assertions
 * (`await expect(locator).toBeVisible()`), which retry the same way.
 */

export type EventuallyOptions = {
    /** Give up after this many ms (default 15 s). */
    timeout?: number;
    /** What the spec was waiting for: the first line of the failure message. */
    message?: string;
    /** Pauses between two reads; the last one repeats (default 100, 250, 500, 1000 ms). */
    intervals?: number[];
};

/**
 * Reads until `until(value)` is true and returns that value. On timeout it throws with the last value read, so a failure says what the
 * state really was (`status: "queued"`) instead of just "timed out".
 */
export async function expectEventually<T>(
    read: () => Promise<T> | T,
    until: (value: T) => boolean | Promise<boolean>,
    options: EventuallyOptions = {},
): Promise<T> {
    const timeout = options.timeout ?? 15_000;
    const intervals = options.intervals ?? [100, 250, 500, 1000];
    const deadline = Date.now() + timeout;
    let attempt = 0;
    let last: T | undefined;
    let failure: unknown;

    for (;;) {
        try {
            last = await read();
            failure = undefined;

            if (await until(last)) {
                return last;
            }
        } catch (error) {
            failure = error;
        }

        if (Date.now() >= deadline) {
            break;
        }

        const pause = intervals[Math.min(attempt, intervals.length - 1)];

        attempt += 1;
        await new Promise((resolve) =>
            setTimeout(
                resolve,
                Math.min(pause, Math.max(deadline - Date.now(), 1)),
            ),
        );
    }

    throw new Error(
        `${options.message ?? 'Condition not met'} within ${timeout} ms. ${
            failure === undefined
                ? `Last value: ${JSON.stringify(last, null, 2)}`
                : `Last read failed: ${failure instanceof Error ? failure.message : JSON.stringify(failure)}`
        }`,
    );
}
