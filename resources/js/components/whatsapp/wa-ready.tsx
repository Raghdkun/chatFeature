import type { ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { useWaRealtimeOptional } from '@/lib/realtime/whatsapp/context';

/**
 * Holds a WhatsApp screen back until the live session exists. The session's code is loaded on demand (`gate.tsx`), so on a direct visit
 * of a WhatsApp page the page can be ready a moment before it; the screens read the session without a fallback, so they mount only
 * inside this.
 */
export function WaReady({ children }: { children: ReactNode }) {
    const ready = useWaRealtimeOptional() !== null;

    if (!ready) {
        return (
            <Skeleton
                data-testid="wa-loading"
                aria-busy
                className="m-4 h-64 max-w-3xl"
            />
        );
    }

    return <>{children}</>;
}
