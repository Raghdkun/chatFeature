import { KeyRound } from 'lucide-react';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { useTrans } from '@/hooks/use-trans';

/**
 * Mode 1 (starter kit auth): accounts live in this app, so there is no portal to configure.
 * Read-only on purpose; the sign-in method is chosen once, in the setup wizard.
 */
export function ManagedNotice() {
    const { t } = useTrans();

    return (
        <Card
            role="region"
            aria-labelledby="settings-auth-managed-title"
            data-testid="settings-auth-managed"
        >
            <CardHeader>
                <div className="flex items-center gap-3">
                    <span
                        className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground"
                        aria-hidden
                    >
                        <KeyRound className="size-4" />
                    </span>
                    <CardTitle
                        id="settings-auth-managed-title"
                        role="heading"
                        aria-level={2}
                    >
                        {t('settings.auth.managed.title')}
                    </CardTitle>
                </div>
                <CardDescription>
                    {t('settings.auth.managed.description')}
                </CardDescription>
            </CardHeader>
            <CardContent>
                <ul className="list-disc space-y-1.5 ps-5 text-sm text-muted-foreground">
                    <li>{t('settings.auth.managed.accounts')}</li>
                    <li>{t('settings.auth.managed.security')}</li>
                    <li>{t('settings.auth.managed.locked')}</li>
                </ul>
            </CardContent>
        </Card>
    );
}
