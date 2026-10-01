import { useTrans } from '@/hooks/use-trans';

/** Three pulsing dots (still dots under reduced motion) and a polite status text for assistive tech. */
export function TypingIndicator({ name }: { name: string }) {
    const { t } = useTrans();

    return (
        <div
            data-testid="typing-indicator"
            role="status"
            className="mt-3 flex items-center gap-2 px-1 text-xs text-muted-foreground"
        >
            <span
                aria-hidden
                className="inline-flex items-center gap-1 rounded-2xl bg-muted px-3 py-2.5"
            >
                {[0, 1, 2].map((index) => (
                    <span
                        key={index}
                        style={{ animationDelay: `${index * 160}ms` }}
                        className="size-1.5 animate-pulse rounded-full bg-muted-foreground/70 motion-reduce:animate-none"
                    />
                ))}
            </span>
            <span className="sr-only">{t('inbox.typing', { name })}</span>
        </div>
    );
}
