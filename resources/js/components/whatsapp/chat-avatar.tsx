import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { useInitials } from '@/hooks/use-initials';
import { cn } from '@/lib/utils';

/** The customer's initials (the last digits of the number when WhatsApp gave no name): decorative, the name sits next to it. */
export function ChatAvatar({
    title,
    className,
}: {
    title: string;
    className?: string;
}) {
    const initials = useInitials();
    const text = /^[+\d\s()-]+$/.test(title)
        ? title.replace(/\D/g, '').slice(-2)
        : initials(title);

    return (
        <Avatar aria-hidden className={cn('size-9', className)}>
            <AvatarFallback className="bg-emerald-100 text-sm font-medium text-emerald-900 dark:bg-emerald-400/15 dark:text-emerald-100">
                {text}
            </AvatarFallback>
        </Avatar>
    );
}
