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
import type { PanelCategory } from '@/embed/config/panel-config';

/** The icon keys a category can carry (`categories.icon`), the same set the dashboard offers. */
const ICONS: Record<string, LucideIcon> = {
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

/** A tinted rounded square with the category's icon (a tag when the key is unknown). */
export function CategoryIcon({ category }: { category: PanelCategory }) {
    const Icon = (category.icon ? ICONS[category.icon] : undefined) ?? Tag;

    return (
        <span
            aria-hidden="true"
            className="bg-brand-soft text-brand grid size-10 shrink-0 place-items-center rounded-md"
            style={
                category.color
                    ? {
                          backgroundColor: `color-mix(in oklab, ${category.color} 16%, transparent)`,
                          color: category.color,
                      }
                    : undefined
            }
        >
            <Icon className="size-5" strokeWidth={2} />
        </span>
    );
}
