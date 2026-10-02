import { ShieldAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useTrans } from '@/hooks/use-trans';

/**
 * The ban-risk notice: WhatsApp does not allow automation, and OpenWA is an unofficial gateway. Always visible at the top of the page (it is
 * not a dismissible tip: it is the thing to know before connecting a number).
 */
export function RiskNotice() {
    const { t } = useTrans();

    return (
        <Alert
            data-testid="wa-risk-notice"
            className="border-amber-300/70 bg-amber-50 text-amber-950 *:data-[slot=alert-description]:text-amber-950/90 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-100 dark:*:data-[slot=alert-description]:text-amber-100/90"
        >
            <ShieldAlert />
            <AlertTitle>{t('whatsapp.risk.title')}</AlertTitle>
            <AlertDescription>
                <p>{t('whatsapp.risk.body')}</p>
                <ul className="mt-2 grid list-disc gap-1 ps-5">
                    <li>{t('whatsapp.risk.dedicated')}</li>
                    <li>{t('whatsapp.risk.inbound')}</li>
                    <li>{t('whatsapp.risk.limits')}</li>
                </ul>
            </AlertDescription>
        </Alert>
    );
}
