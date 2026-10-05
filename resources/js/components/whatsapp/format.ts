/**
 * Pure helpers of the WhatsApp screens (no React, no clock): names, sizes and the grouping of a transcript into day dividers and runs of
 * bubbles. The time formats (`clockTime`, `dayLabel`, `shortAge`, `fullDateTime`) are the inbox's own, shared on purpose.
 */
import { GROUP_GAP_MS } from '@/components/inbox/format';
import type { DisplayMessage } from '@/lib/whatsapp/transcript';
import type { WaChat } from '@/lib/whatsapp/types';

/** Who this chat is with: the name WhatsApp shows, else the number, else `unknown` (a chat with neither is rare, never blank). */
export function chatTitle(
    chat: Pick<WaChat, 'pushName' | 'phone'>,
    unknown: string,
): string {
    const name = chat.pushName?.trim();

    if (name) {
        return name;
    }

    return chat.phone?.trim() || unknown;
}

/** "117 KB", "4.8 MB" in the locale's style; `null` for an unknown size. */
export function formatBytes(
    bytes: number | null | undefined,
    locale: string,
): string | null {
    if (bytes === null || bytes === undefined || bytes < 0) {
        return null;
    }

    const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const;
    let value = bytes;
    let index = 0;

    while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
    }

    try {
        return new Intl.NumberFormat(locale, {
            style: 'unit',
            unit: units[index],
            unitDisplay: 'short',
            maximumFractionDigits: index === 0 ? 0 : value < 10 ? 1 : 0,
        }).format(value);
    } catch {
        return `${Math.round(value)} ${units[index]}`;
    }
}

function parse(iso: string): number {
    const ms = Date.parse(iso);

    return Number.isNaN(ms) ? 0 : ms;
}

function startOfDay(ms: number): number {
    const date = new Date(ms);

    date.setHours(0, 0, 0, 0);

    return date.getTime();
}

export type WaListEntry =
    | { kind: 'day'; key: string; iso: string }
    | {
          kind: 'message';
          key: string;
          message: DisplayMessage;
          /** First of a run by the same side (shows who wrote it). */
          startsGroup: boolean;
          /** Last of the run (shows the time and the ticks). */
          endsGroup: boolean;
      };

export function waMessageKey(message: DisplayMessage): string {
    return message.local?.clientMsgId ?? message.ulid;
}

/**
 * Interleave day dividers and group consecutive messages of one side: the customer, or the same administrator. The day and the time of a
 * message are WhatsApp's own (`waTimestamp`), not the moment this app recorded it: a delayed or replayed delivery keeps its real day.
 */
export function buildWaEntries(
    messages: readonly DisplayMessage[],
): WaListEntry[] {
    const entries: WaListEntry[] = [];
    // A run is one side; a reply with another delivery status starts its own, so every distinct status shows its ticks.
    const side = (message: DisplayMessage): string =>
        message.direction === 'in'
            ? 'in'
            : `out:${message.sentBy?.id ?? ''}:${message.status}`;
    const continues = (a: DisplayMessage, b: DisplayMessage): boolean => {
        const aAt = parse(a.waTimestamp);
        const bAt = parse(b.waTimestamp);

        return (
            side(a) === side(b) &&
            startOfDay(aAt) === startOfDay(bAt) &&
            bAt - aAt <= GROUP_GAP_MS
        );
    };

    messages.forEach((message, index) => {
        const previous = messages[index - 1];
        const next = messages[index + 1];
        const at = parse(message.waTimestamp);

        if (
            previous === undefined ||
            startOfDay(parse(previous.waTimestamp)) !== startOfDay(at)
        ) {
            entries.push({
                kind: 'day',
                key: `day-${startOfDay(at)}`,
                iso: message.waTimestamp,
            });
        }

        entries.push({
            kind: 'message',
            key: waMessageKey(message),
            message,
            startsGroup:
                previous === undefined || !continues(previous, message),
            endsGroup: next === undefined || !continues(message, next),
        });
    });

    return entries;
}
