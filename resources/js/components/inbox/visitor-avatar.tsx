import { User } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { useInitials } from '@/hooks/use-initials';
import { cn } from '@/lib/utils';

/** The visitor's initials (an icon while they are anonymous): decorative, the name sits next to it. */
export function VisitorAvatar({
    name,
    className,
}: {
    name: string | null;
    className?: string;
}) {
    const initials = useInitials();
    const text = name ? initials(name) : '';

    return (
        <Avatar aria-hidden className={cn('size-9', className)}>
            <AvatarFallback className="bg-accent text-sm font-medium text-accent-foreground">
                {text !== '' ? text : <User className="size-4" />}
            </AvatarFallback>
        </Avatar>
    );
}
