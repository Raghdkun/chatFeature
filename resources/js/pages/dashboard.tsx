import { Head, usePage } from '@inertiajs/react';
import type { ReactNode } from 'react';
import { AdminDashboard } from '@/components/dashboard/admin-dashboard';
import { AgentDashboard } from '@/components/dashboard/agent-dashboard';
import { useTrans } from '@/hooks/use-trans';
import AppLayout from '@/layouts/app-layout';
import { dashboard } from '@/routes';

/** Role-aware landing page: admins get a setup checklist, agents an empty inbox. */
export default function Dashboard() {
    const { auth } = usePage().props;
    const { t } = useTrans();
    const firstName = auth.user?.name.trim().split(/\s+/)[0] ?? '';

    return (
        <>
            <Head title={t('dashboard.title')} />

            <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 p-4 md:p-6">
                <h1 className="text-2xl font-semibold tracking-tight text-balance">
                    {t('dashboard.greeting', { name: firstName })}
                </h1>

                {auth.user?.is_admin ? <AdminDashboard /> : <AgentDashboard />}
            </div>
        </>
    );
}

function DashboardLayout({ children }: { children: ReactNode }) {
    const { t } = useTrans();

    return (
        <AppLayout
            breadcrumbs={[{ title: t('nav.dashboard'), href: dashboard() }]}
        >
            {children}
        </AppLayout>
    );
}

Dashboard.layout = DashboardLayout;
