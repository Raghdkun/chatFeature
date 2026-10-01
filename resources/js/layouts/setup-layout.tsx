import { usePage } from '@inertiajs/react';
import type { ReactNode } from 'react';
import AppLogoIcon from '@/components/app-logo-icon';
import { useTrans } from '@/hooks/use-trans';
import AuthLayout from '@/layouts/auth-layout';

function SetupBrand() {
    const { name } = usePage().props;
    const { t } = useTrans();

    return (
        <div className="flex items-center gap-3 px-1">
            <div className="flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <AppLogoIcon className="size-6 fill-current" aria-hidden />
            </div>
            <div className="grid leading-tight">
                <span className="text-base font-semibold">{name}</span>
                <span className="text-sm text-muted-foreground">
                    {t('setup.brand.subtitle')}
                </span>
            </div>
        </div>
    );
}

/** The wizard uses the `AuthLayout` card variant, with its own brand header and no padding. */
export default function SetupLayout({ children }: { children: ReactNode }) {
    return (
        <AuthLayout variant="card" wide bare header={<SetupBrand />}>
            {children}
        </AuthLayout>
    );
}
