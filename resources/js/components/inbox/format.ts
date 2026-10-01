/**
 * Pure formatting and grouping helpers of the agent inbox (no React, no clock: `nowMs` is always passed in), so they can be tested
 * exactly and so the components stay free of date maths. Everything locale-aware goes through `Intl`.
 */
import type { LocalMessage } from '@/lib/chat/types';

type Translate = (
    key: string,
    replacements?: Record<string, string | number>,
) => string;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A group of consecutive messages by one sender closer together than this share one name / avatar. */
export const GROUP_GAP_MS = 5 * MINUTE;

function parse(iso: string | null | undefined): number | null {
    if (!iso) {
        return null;
    }

    const ms = Date.parse(iso);

    return Number.isNaN(ms) ? null : ms;
}

function unit(
    locale: string,
    value: number,
    unitName: 'minute' | 'hour' | 'day',
): string {
    try {
        return new Intl.NumberFormat(locale, {
            style: 'unit',
            unit: unitName,
            unitDisplay: 'narrow',
            maximumFractionDigits: 0,
        }).format(value);
    } catch {
        return `${value}${unitName[0]}`;
    }
}

/** "now", "5m", "3h", "2d" (narrow units of the locale), then a short date. `null` for a missing / invalid time. */
export function shortAge(
    iso: string | null | undefined,
    nowMs: number,
    locale: string,
    t: Translate,
): string | null {
    const then = parse(iso);

    if (then === null) {
        return null;
    }

    const age = Math.max(0, nowMs - then);

    if (age < MINUTE) {
        return t('inbox.time.now');
    }

    if (age < HOUR) {
        return unit(locale, Math.floor(age / MINUTE), 'minute');
    }

    if (age < DAY) {
        return unit(locale, Math.floor(age / HOUR), 'hour');
    }

    if (age < 7 * DAY) {
        return unit(locale, Math.floor(age / DAY), 'day');
    }

    try {
        return new Intl.DateTimeFormat(locale, {
            day: 'numeric',
            month: 'short',
        }).format(then);
    } catch {
        return new Date(then).toDateString();
    }
}

/** The time of day, in the locale's style ("10:42 AM" / "10:42"). */
export function clockTime(iso: string, locale: string): string {
    const ms = parse(iso);

    if (ms === null) {
        return '';
    }

    try {
        return new Intl.DateTimeFormat(locale, {
            hour: 'numeric',
            minute: '2-digit',
        }).format(ms);
    } catch {
        return new Date(ms).toLocaleTimeString();
    }
}

/** A full date and time, for tooltips and the details sheet. */
export function fullDateTime(
    iso: string | null,
    locale: string,
): string | null {
    const ms = parse(iso);

    if (ms === null) {
        return null;
    }

    try {
        return new Intl.DateTimeFormat(locale, {
            dateStyle: 'medium',
            timeStyle: 'short',
        }).format(ms);
    } catch {
        return new Date(ms).toLocaleString();
    }
}

function startOfDay(ms: number): number {
    const date = new Date(ms);

    date.setHours(0, 0, 0, 0);

    return date.getTime();
}

/** "Today", "Yesterday" or a weekday + date: the divider above the first message of a day. */
export function dayLabel(
    iso: string,
    nowMs: number,
    locale: string,
    t: Translate,
): string {
    const ms = parse(iso);

    if (ms === null) {
        return '';
    }

    const days = Math.round((startOfDay(nowMs) - startOfDay(ms)) / DAY);

    if (days === 0) {
        return t('inbox.day.today');
    }

    if (days === 1) {
        return t('inbox.day.yesterday');
    }

    try {
        return new Intl.DateTimeFormat(locale, {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            ...(days > 300 ? { year: 'numeric' } : {}),
        }).format(ms);
    } catch {
        return new Date(ms).toDateString();
    }
}

/** `m:ss` for a countdown or a waiting timer. */
export function clockLabel(totalSeconds: number): string {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const minutes = Math.floor(seconds / 60);

    return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Seconds left until `iso` (never negative); `null` when there is no deadline. */
export function secondsUntil(iso: string | null, nowMs: number): number | null {
    const at = parse(iso);

    return at === null ? null : Math.max(0, Math.ceil((at - nowMs) / 1000));
}

/** Seconds since `iso` (never negative). */
export function secondsSince(iso: string | null, nowMs: number): number {
    const at = parse(iso);

    return at === null ? 0 : Math.max(0, Math.floor((nowMs - at) / 1000));
}

/* -------------------------------------------------------------------------- */
/* Message list                                                               */
/* -------------------------------------------------------------------------- */

export type ListEntry =
    | { kind: 'day'; key: string; iso: string }
    | {
          kind: 'message';
          key: string;
          message: LocalMessage;
          /** First of a run by the same sender (shows the sender's name). */
          startsGroup: boolean;
          /** Last of the run (shows the time and the delivery ticks). */
          endsGroup: boolean;
      };

export function messageKey(message: LocalMessage): string {
    return message.ulid ?? message.clientMsgId ?? `seq-${message.seq}`;
}

function sameDay(a: number, b: number): boolean {
    return startOfDay(a) === startOfDay(b);
}

/** Interleave day dividers and group consecutive messages of one sender (system lines always stand alone). */
export function buildListEntries(
    messages: readonly LocalMessage[],
): ListEntry[] {
    const entries: ListEntry[] = [];
    let previous: LocalMessage | null = null;

    messages.forEach((message, index) => {
        const at = parse(message.createdAt) ?? 0;
        const before = previous ? (parse(previous.createdAt) ?? 0) : null;

        if (before === null || !sameDay(before, at)) {
            entries.push({
                kind: 'day',
                key: `day-${startOfDay(at)}`,
                iso: message.createdAt,
            });
        }

        const next = messages[index + 1];
        const nextAt = next ? (parse(next.createdAt) ?? 0) : null;
        const continues = (
            a: LocalMessage,
            aAt: number,
            b: LocalMessage,
            bAt: number,
        ) =>
            a.sender.type === b.sender.type &&
            a.sender.type !== 'system' &&
            a.sender.name === b.sender.name &&
            sameDay(aAt, bAt) &&
            bAt - aAt <= GROUP_GAP_MS;

        const startsGroup =
            previous === null ||
            before === null ||
            !continues(previous, before, message, at);
        const endsGroup =
            next === undefined ||
            nextAt === null ||
            !continues(message, at, next, nextAt);

        entries.push({
            kind: 'message',
            key: messageKey(message),
            message,
            startsGroup,
            endsGroup,
        });
        previous = message;
    });

    return entries;
}

/* -------------------------------------------------------------------------- */
/* Text                                                                       */
/* -------------------------------------------------------------------------- */

/** Plain-text transcript of a conversation for "Copy transcript". */
export function buildTranscript(
    messages: readonly LocalMessage[],
    options: {
        locale: string;
        visitorName: string;
        agentName: string;
        attachmentLabel: string;
    },
): string {
    return messages
        .filter(
            (message) => message.seq !== null && message.status !== 'failed',
        )
        .map((message) => {
            const at = parse(message.createdAt);
            const stamp =
                at === null
                    ? ''
                    : new Intl.DateTimeFormat(options.locale, {
                          dateStyle: 'short',
                          timeStyle: 'short',
                      }).format(at);
            const who =
                message.sender.type === 'system'
                    ? '*'
                    : (message.sender.name ??
                      (message.sender.type === 'visitor'
                          ? options.visitorName
                          : options.agentName));
            const lines = [
                message.body ?? '',
                ...message.attachments.map(
                    (attachment) =>
                        `[${options.attachmentLabel}: ${attachment.mime}]`,
                ),
            ].filter((line) => line !== '');

            return `[${stamp}] ${who}: ${lines.join(' ')}`;
        })
        .join('\n');
}
