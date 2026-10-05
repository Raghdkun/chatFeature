import { Link } from '@inertiajs/react';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/widgets/form-bits';
import { useTrans } from '@/hooks/use-trans';
import { widgetsRoutes } from '@/lib/widgets-routes';

/**
 * Shown to a member of staff who takes chats but serves no category: they can be "online" and still never be offered a chat, and
 * the visitor is told that nobody is available. Nothing else on screen explains it, so say it here, with the way out.
 */
export function ServingNotice({
    serving,
    className,
}: {
    serving: App.Data.Dashboard.ServingStatusData | null | undefined;
    className?: string;
}) {
    const { t } = useTrans();

    if (!serving || !serving.takesChats || serving.categories > 0) {
        return null;
    }

    return (
        <Notice
            tone="warning"
            data-testid="serving-notice"
            className={className}
        >
            <div className="grid gap-2">
                <p className="font-medium">{t('dashboard.serving.title')}</p>
                <p>{t('dashboard.serving.body')}</p>
                <Button
                    asChild
                    size="sm"
                    variant="outline"
                    className="w-fit bg-background"
                >
                    <Link href={widgetsRoutes.pages.supportCategories()}>
                        {t('dashboard.serving.action')}
                    </Link>
                </Button>
            </div>
        </Notice>
    );
}
