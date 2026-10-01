import { linkify } from '@/components/inbox/format';

/**
 * A message body as text: React escapes it, URLs are turned into links at render time with `rel="noopener noreferrer nofollow"`
 * (decision P4-D11: stored bodies are raw plain text and never executed as HTML).
 */
export function MessageBody({ text }: { text: string }) {
    return (
        <p className="text-sm/relaxed break-words whitespace-pre-wrap">
            {linkify(text).map((part, index) =>
                part.kind === 'link' ? (
                    <a
                        key={index}
                        href={part.href}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="underline underline-offset-2 hover:opacity-80"
                    >
                        {part.text}
                    </a>
                ) : (
                    <span key={index}>{part.text}</span>
                ),
            )}
        </p>
    );
}
