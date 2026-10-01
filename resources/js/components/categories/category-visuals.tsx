import {
    BookOpen,
    CreditCard,
    Gift,
    Globe,
    Heart,
    Laptop,
    LifeBuoy,
    Mail,
    MessageCircle,
    Package,
    Phone,
    ShieldCheck,
    ShoppingCart,
    Star,
    Tag,
    Truck,
    Users,
    Wrench,
    Zap,
    type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/** The icon keys a category can carry (stored as the plain string in `categories.icon`). */
export const CATEGORY_ICONS: Record<string, LucideIcon> = {
    'message-circle': MessageCircle,
    'life-buoy': LifeBuoy,
    'credit-card': CreditCard,
    'shopping-cart': ShoppingCart,
    truck: Truck,
    package: Package,
    wrench: Wrench,
    'book-open': BookOpen,
    shield: ShieldCheck,
    users: Users,
    star: Star,
    zap: Zap,
    gift: Gift,
    heart: Heart,
    laptop: Laptop,
    phone: Phone,
    mail: Mail,
    globe: Globe,
    tag: Tag,
};

export const CATEGORY_ICON_KEYS = Object.keys(CATEGORY_ICONS);

/** Readable on both light and dark surfaces when used for an icon or a dot. */
export const CATEGORY_COLORS = [
    '#0f766e',
    '#2563eb',
    '#7c3aed',
    '#c026d3',
    '#e11d48',
    '#d97706',
    '#16a34a',
    '#475569',
];

export function categoryIcon(key: string | null | undefined): LucideIcon {
    return (key ? CATEGORY_ICONS[key] : undefined) ?? Tag;
}

/** A tinted rounded square with the category's icon. */
export function CategoryTile({
    icon,
    color,
    className,
}: {
    icon: string | null;
    color: string | null;
    className?: string;
}) {
    const Icon = categoryIcon(icon);

    return (
        <span
            aria-hidden
            className={cn(
                'flex size-10 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground',
                className,
            )}
            style={
                color
                    ? {
                          backgroundColor: `color-mix(in oklab, ${color} 16%, transparent)`,
                          color,
                      }
                    : undefined
            }
        >
            <Icon className="size-[1.15rem]" />
        </span>
    );
}

/** Compact chip: coloured dot + name. */
export function CategoryChip({
    name,
    color,
    muted,
    className,
}: {
    name: string;
    color: string | null;
    muted?: boolean;
    className?: string;
}) {
    return (
        <span
            className={cn(
                'inline-flex max-w-full items-center gap-1.5 rounded-full border bg-background px-2 py-0.5 text-xs font-medium',
                muted && 'text-muted-foreground',
                className,
            )}
        >
            <span
                aria-hidden
                className="size-2 shrink-0 rounded-full bg-muted-foreground/50"
                style={color ? { backgroundColor: color } : undefined}
            />
            <span className="truncate">{name}</span>
        </span>
    );
}
