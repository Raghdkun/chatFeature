import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import { useTrans } from '@/hooks/use-trans';

/**
 * The connected number: masked (`+49•••••••4567`) until an administrator asks to see it. Numbers are written left to right whatever the
 * page's direction. A session with no number yet shows a dash.
 */
export function PhoneNumber({
    phone,
    masked,
    testId,
}: {
    phone: string | null;
    masked: string | null;
    testId?: string;
}) {
    const { t } = useTrans();
    const [shown, setShown] = useState(false);

    if (phone === null && masked === null) {
        return (
            <span data-testid={testId} className="text-muted-foreground">
                {t('whatsapp.phone.none')}
            </span>
        );
    }

    const revealable = phone !== null && masked !== null;

    return (
        <span className="inline-flex items-center gap-1.5">
            <span data-testid={testId} dir="ltr" className="tabular-nums">
                {shown && phone !== null ? phone : (masked ?? phone)}
            </span>
            {revealable && (
                <button
                    type="button"
                    aria-pressed={shown}
                    aria-label={t(
                        shown ? 'whatsapp.phone.hide' : 'whatsapp.phone.show',
                    )}
                    title={t(
                        shown ? 'whatsapp.phone.hide' : 'whatsapp.phone.show',
                    )}
                    onClick={() => setShown((value) => !value)}
                    data-testid={testId ? `${testId}-toggle` : undefined}
                    className="inline-grid size-6 place-items-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                    {shown ? (
                        <EyeOff className="size-3.5" aria-hidden />
                    ) : (
                        <Eye className="size-3.5" aria-hidden />
                    )}
                </button>
            )}
        </span>
    );
}
