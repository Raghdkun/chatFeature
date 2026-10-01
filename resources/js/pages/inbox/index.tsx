import { Head } from '@inertiajs/react';
import { InboxLayout } from '@/components/inbox/inbox-layout';
import { InboxShell } from '@/components/inbox/inbox-shell';
import { useTrans } from '@/hooks/use-trans';
import type { InboxPageProps } from '@/types/chat-staff';

export default function InboxIndex(props: InboxPageProps) {
    const { t } = useTrans();

    return (
        <>
            <Head title={t('inbox.title')} />
            <InboxShell {...props} selectedUlid={null} />
        </>
    );
}

InboxIndex.layout = InboxLayout;
