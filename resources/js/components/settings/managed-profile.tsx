import { ExternalLink, UserRound } from 'lucide-react';
import Heading from '@/components/heading';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTrans } from '@/hooks/use-trans';
import { safeExternalUrl } from '@/lib/urls';

/**
 * Auth Portal mode: the account (name, email, password) is owned by the portal, so the profile is shown as
 * read-only with a pointer to where it can be changed. The editing endpoints answer 404 in this mode.
 */
export function ManagedProfile({
    name,
    email,
    portalUrl,
}: {
    name: string;
    email: string;
    portalUrl: string | null;
}) {
    const { t } = useTrans();
    const link = safeExternalUrl(portalUrl);

    return (
        <div className="space-y-6" data-testid="profile-managed">
            <Heading
                variant="small"
                title={t('settings.profile.title')}
                description={t('settings.profile.managed.description')}
            />

            <Alert>
                <UserRound />
                <AlertTitle>{t('settings.profile.managed.title')}</AlertTitle>
                <AlertDescription>
                    <p>{t('settings.profile.managed.body')}</p>
                    {link && (
                        <a
                            href={link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-1 inline-flex w-fit items-center gap-1 underline underline-offset-4"
                        >
                            {t('settings.profile.managed.portal_link')}
                            <ExternalLink
                                className="size-3.5 rtl:-scale-x-100"
                                aria-hidden
                            />
                        </a>
                    )}
                </AlertDescription>
            </Alert>

            <div className="grid gap-2">
                <Label htmlFor="name">{t('settings.profile.name')}</Label>
                <Input
                    id="name"
                    className="mt-1 block w-full"
                    value={name}
                    readOnly
                    autoComplete="name"
                />
            </div>

            <div className="grid gap-2">
                <Label htmlFor="email">{t('settings.profile.email')}</Label>
                <Input
                    id="email"
                    type="email"
                    dir="ltr"
                    className="mt-1 block w-full"
                    value={email}
                    readOnly
                    autoComplete="username"
                />
            </div>
        </div>
    );
}
