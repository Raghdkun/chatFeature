import { useEffect } from 'react';

const PREFIX = /^\(\d+\+?\)\s/;

/** `"(3) Inbox - App"` for a count of 3; the bare title for 0. Never stacks prefixes. */
export function withAttentionCount(title: string, count: number): string {
    const base = title.replace(PREFIX, '');

    if (count <= 0) {
        return base;
    }

    return `(${count > 99 ? '99+' : count}) ${base}`;
}

/**
 * Keep `(n)` in front of the document title while `count` > 0, whatever page sets the title (Inertia's `<Head>` rewrites it on every
 * visit, so a one-off assignment would be lost): a MutationObserver on the head re-applies the prefix when the title changes.
 */
export function useAttentionTitle(count: number): void {
    useEffect(() => {
        const apply = (): void => {
            const next = withAttentionCount(document.title, count);

            if (document.title !== next) {
                document.title = next;
            }
        };

        apply();

        const observer = new MutationObserver(apply);

        observer.observe(document.head, {
            childList: true,
            subtree: true,
            characterData: true,
        });

        return () => {
            observer.disconnect();
            document.title = withAttentionCount(document.title, 0);
        };
    }, [count]);
}
