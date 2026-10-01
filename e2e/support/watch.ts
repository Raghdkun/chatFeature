/**
 * Fails a spec on what a user would call "broken" even when every assertion passed: an uncaught exception in a page, a console
 * error, a failed request, or an HTTP 5xx from the app. It follows every page of a browser context (the visitor panel is an iframe of
 * the customer-site page and reports through that page), and the pattern is that of `collectConsole()` in `loader.ts`.
 *
 * Known product issues that would fail every spec that finishes a chat are listed in `KNOWN_ISSUES` (none today): they are collected in
 * `watch.known` (so a spec can still look at them) but are not problems. Delete an entry when the product is fixed.
 *
 * Not counted, on purpose: Chrome's own "Failed to load resource: the server responded with a status of 409" console line (the
 * product answers expected conflicts with 4xx; `watch.statuses` lists every status seen, so a spec that wants to forbid a 4xx can say
 * so), aborted requests (navigations, closed pages), and anything matching `allow`.
 */
import type { BrowserContext, Page } from '@playwright/test';

export type Allowed = (RegExp | string)[];

/**
 * Open product bugs the e2e infrastructure found (docs/testing.md, "Known issues the watch tolerates"). Each entry names where the bug is,
 * so the fix can remove it.
 */
export const KNOWN_ISSUES: { pattern: RegExp; issue: string }[] = [];

export type Watch = {
    /** Problems found so far, one line each. */
    problems: string[];
    /** Matches of `KNOWN_ISSUES` (message, the issue's description). Not problems. */
    known: string[];
    /** Every API response seen as `METHOD path -> status` (`/api/` paths only). */
    statuses: string[];
    /** Ignore matching problems from now on (a spec that provokes an error on purpose). */
    allow(...patterns: Allowed): void;
};

const matches = (text: string, patterns: Allowed): boolean =>
    patterns.some((pattern) =>
        typeof pattern === 'string'
            ? text.includes(pattern)
            : pattern.test(text),
    );

/** Starts watching every page of `context` (existing and future). `label` names the actor in the messages. */
export function watchContext(
    context: BrowserContext,
    label: string,
    allowed: Allowed = [],
): Watch {
    const allow = [...allowed];
    const watch: Watch = {
        problems: [],
        known: [],
        statuses: [],
        allow: (...patterns) => {
            allow.push(...patterns);
        },
    };
    const report = (problem: string): void => {
        if (matches(problem, allow)) {
            return;
        }

        const known = KNOWN_ISSUES.find((entry) => entry.pattern.test(problem));

        if (known) {
            watch.known.push(`[${label}] ${problem} -- known: ${known.issue}`);
        } else {
            watch.problems.push(`[${label}] ${problem}`);
        }
    };
    const follow = (page: Page): void => {
        page.on('pageerror', (error) =>
            report(`uncaught exception: ${error.message}`),
        );
        page.on('console', (message) => {
            if (
                message.type() === 'error' &&
                !message.text().startsWith('Failed to load resource')
            ) {
                const where = message.location();

                report(
                    `console error: ${message.text()}${where.url ? ` (${where.url}:${where.lineNumber})` : ''}`,
                );
            }
        });
        page.on('requestfailed', (request) => {
            const failure = request.failure()?.errorText ?? '';

            // Navigations away, closed pages and cancelled fetches are not failures.
            if (
                !/ERR_ABORTED|aborted|cancelled|NS_BINDING_ABORTED/i.test(
                    failure,
                )
            ) {
                report(
                    `request failed: ${request.method()} ${request.url()} (${failure})`,
                );
            }
        });
        page.on('response', (response) => {
            const url = new URL(response.url());

            if (
                url.pathname.startsWith('/api/') ||
                url.pathname === '/broadcasting/auth'
            ) {
                watch.statuses.push(
                    `${response.request().method()} ${url.pathname} -> ${response.status()}`,
                );
            }

            if (response.status() >= 500) {
                report(
                    `HTTP ${response.status()}: ${response.request().method()} ${response.url()}`,
                );
            }
        });
    };

    context.pages().forEach(follow);
    context.on('page', follow);

    return watch;
}
