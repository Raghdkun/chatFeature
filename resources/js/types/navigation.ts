import type { InertiaLinkProps } from '@inertiajs/react';
import type { LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';

export type BreadcrumbItem = {
    title: string;
    href: NonNullable<InertiaLinkProps['href']>;
};

export type NavItem = {
    title: string;
    /** Translation key for `title`; when absent (or missing from lang files) `title` is shown as is. */
    titleKey?: string;
    href: NonNullable<InertiaLinkProps['href']>;
    icon?: LucideIcon | null;
    isActive?: boolean;
    /** Stay highlighted on the pages below the entry (`/inbox` while `/inbox/{ulid}` is open). */
    activeOnChildren?: boolean;
    /** A small live count shown at the end of the entry (the inbox's unread / queue badge); renders nothing when there is none. */
    badge?: ComponentType;
};
