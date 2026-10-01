/**
 * Lays a conversation out for display: date separators, system lines, and runs of messages from the same sender grouped so the
 * avatar, name and time/receipt row appear once per run. Pure; the list component only renders what this returns.
 */
import { dayKey } from '@/embed/lib/format';
import type { LocalMessage } from '@/lib/chat/types';

export const GROUP_WINDOW_MS = 5 * 60_000;

export type ListItem =
    | { kind: 'separator'; key: string; at: string }
    | { kind: 'system'; key: string; message: LocalMessage }
    | {
          kind: 'message';
          key: string;
          message: LocalMessage;
          /** First of a run: the avatar / name go here. */
          groupStart: boolean;
          /** Last of a run: the time and receipt row go here. */
          groupEnd: boolean;
      };

/** Stable across the optimistic copy and the server's copy of the same message (the `client_msg_id` survives the ack). */
export const messageKey = (message: LocalMessage): string =>
    message.clientMsgId ?? message.ulid ?? `at-${message.createdAt}`;

/** The test id contract (`message-{ulid}`); a message the server has not numbered yet is `message-pending-{clientMsgId}`. */
export const messageTestId = (message: LocalMessage): string =>
    `message-${message.ulid ?? `pending-${message.clientMsgId ?? ''}`}`;

function sameRun(a: LocalMessage, b: LocalMessage): boolean {
    return (
        a.sender.type === b.sender.type &&
        a.sender.name === b.sender.name &&
        dayKey(a.createdAt) === dayKey(b.createdAt) &&
        Math.abs(Date.parse(b.createdAt) - Date.parse(a.createdAt)) <=
            GROUP_WINDOW_MS
    );
}

/** The last message item so far ends its run (a separator, a system line, another sender or the end of the list follows). */
function closeRun(items: ListItem[]): void {
    const last = items.at(-1);

    if (last?.kind === 'message') {
        last.groupEnd = true;
    }
}

export function layoutMessages(messages: readonly LocalMessage[]): ListItem[] {
    const items: ListItem[] = [];
    let previous: LocalMessage | null = null;
    let lastDay: string | null = null;

    for (const message of messages) {
        const day = dayKey(message.createdAt);

        if (day !== lastDay) {
            closeRun(items);
            items.push({
                kind: 'separator',
                key: `day-${day}-${messageKey(message)}`,
                at: message.createdAt,
            });
            lastDay = day;
            previous = null;
        }

        if (message.type === 'system' || message.sender.type === 'system') {
            closeRun(items);
            items.push({
                kind: 'system',
                key: messageKey(message),
                message,
            });
            previous = null;

            continue;
        }

        const groupStart = previous === null || !sameRun(previous, message);

        if (groupStart) {
            closeRun(items);
        }

        items.push({
            kind: 'message',
            key: messageKey(message),
            message,
            groupStart,
            groupEnd: false,
        });
        previous = message;
    }

    closeRun(items);

    return items;
}
