import { linkify } from '@/lib/chat/linkify';

/**
 * A message body as text: React escapes it, URLs are turned into links at render time with `rel="noopener noreferrer nofollow"`
 * (decision P4-D11: stored bodies are raw plain text and never executed as HTML). The same safe linkifier as the visitor's panel:
 * no credentialed URLs, balanced parentheses, a length cap. Long unbroken words and URLs wrap instead of widening the bubble.
 * `dir="auto"`: a message takes the direction of what it says (an English sentence in an Arabic dashboard, an Arabic one in an English
 * dashboard), not of the page around it, so its punctuation and its alignment land on the right side.
 */
export function MessageBody({ text }: { text: string }) {
    return (
        <p
            dir="auto"
            className="min-w-0 text-sm/relaxed [overflow-wrap:anywhere] whitespace-pre-wrap"
        >
            {linkify(text).map((part, index) =>
                part.type === 'link' ? (
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
