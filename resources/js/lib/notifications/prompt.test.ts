import { describe, expect, it } from 'vite-plus/test';
import { shouldPrompt, type PromptInput } from '@/lib/notifications/prompt';

const NOW = Date.parse('2026-11-20T12:00:00Z');

const input = (overrides: Partial<PromptInput> = {}): PromptInput => ({
    support: { supported: true },
    pushConfigured: true,
    permission: 'default',
    settings: { promptState: 'never', snoozedUntil: null, pushAvailable: true },
    nowMs: NOW,
    ...overrides,
});

const settings = (
    promptState: 'never' | 'granted' | 'denied' | 'snoozed',
    snoozedUntil: string | null = null,
    pushAvailable = true,
) => ({ promptState, snoozedUntil, pushAvailable });

describe('shouldPrompt', () => {
    it('asks a member of staff who was never asked', () => {
        expect(shouldPrompt(input())).toBe(true);
    });

    it('stays quiet until a snooze has run out, then asks again', () => {
        expect(
            shouldPrompt(
                input({
                    settings: settings('snoozed', '2026-11-27T12:00:00Z'),
                }),
            ),
        ).toBe(false);
        expect(
            shouldPrompt(
                input({
                    settings: settings('snoozed', '2026-11-20T12:00:00Z'),
                }),
            ),
        ).toBe(true);
        expect(
            shouldPrompt(
                input({
                    settings: settings('snoozed', '2026-11-13T12:00:00Z'),
                }),
            ),
        ).toBe(true);
        // A snooze without a readable deadline has nothing to wait for.
        expect(
            shouldPrompt(input({ settings: settings('snoozed', null) })),
        ).toBe(true);
    });

    it('never asks again after a yes or a no, or when the browser already decided', () => {
        expect(shouldPrompt(input({ settings: settings('granted') }))).toBe(
            false,
        );
        expect(shouldPrompt(input({ settings: settings('denied') }))).toBe(
            false,
        );
        expect(shouldPrompt(input({ permission: 'granted' }))).toBe(false);
        expect(shouldPrompt(input({ permission: 'denied' }))).toBe(false);
        expect(shouldPrompt(input({ permission: 'unsupported' }))).toBe(false);
    });

    it('never asks when push cannot work here or the server has no keys', () => {
        expect(
            shouldPrompt(
                input({ support: { supported: false, reason: 'no-push' } }),
            ),
        ).toBe(false);
        expect(shouldPrompt(input({ pushConfigured: false }))).toBe(false);
        expect(
            shouldPrompt(input({ settings: settings('never', null, false) })),
        ).toBe(false);
    });

    it('never asks when the settings are unknown or the person turned it off here', () => {
        expect(shouldPrompt(input({ settings: null }))).toBe(false);
        expect(shouldPrompt(input({ offHere: true }))).toBe(false);
    });

    it('only asks agents: an account that does not take chats is never pushed, so never asked', () => {
        expect(shouldPrompt(input({ isAgent: false }))).toBe(false);
        expect(shouldPrompt(input({ isAgent: true }))).toBe(true);
        // Unspecified = an agent (the controller always says).
        expect(shouldPrompt(input())).toBe(true);
    });
});
