import { Check } from 'lucide-react';
import { useEffect } from 'react';
import { StepFrame } from '@/components/setup/step-frame';
import { Button } from '@/components/ui/button';
import { useTrans } from '@/hooks/use-trans';

/** How long the success message stays before we move on to sign-in on our own. */
export const DONE_REDIRECT_DELAY_MS = 2500;

/** A full page load on purpose: once the lock exists the app switches from install-time to its real drivers (sessions, cache). */
const hardNavigate = (url: string) => window.location.assign(url);

export function StepDone({
    redirect,
    portal = false,
    navigate = hardNavigate,
}: {
    redirect: string;
    /** Auth Portal mode: people sign in with their portal account. */
    portal?: boolean;
    /** Injectable for tests. */
    navigate?: (url: string) => void;
}) {
    const { t } = useTrans();

    useEffect(() => {
        const timer = window.setTimeout(
            () => navigate(redirect),
            DONE_REDIRECT_DELAY_MS,
        );

        return () => window.clearTimeout(timer);
    }, [redirect, navigate]);

    return (
        <StepFrame
            step="done"
            title={t('setup.done.title')}
            description={t(
                portal
                    ? 'setup.pizzasys.done_description'
                    : 'setup.done.description',
            )}
        >
            <div className="flex flex-col items-start gap-5">
                <span
                    className="flex size-12 items-center justify-center rounded-full bg-accent text-primary"
                    aria-hidden
                >
                    <Check className="size-6" />
                </span>

                <div className="flex flex-col gap-2 self-stretch sm:self-start">
                    <Button asChild data-testid="setup-done-login">
                        <a href={redirect}>{t('setup.done.cta')}</a>
                    </Button>
                    <p
                        className="text-sm text-muted-foreground"
                        role="status"
                        data-testid="setup-done-redirecting"
                    >
                        {t('setup.done.redirecting')}
                    </p>
                </div>
            </div>
        </StepFrame>
    );
}
