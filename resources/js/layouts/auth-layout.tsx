import type { ReactNode } from 'react';
import { DirectionProvider } from '@/components/direction-provider';
import AuthCardLayout from '@/layouts/auth/auth-card-layout';
import AuthSimpleLayout from '@/layouts/auth/auth-simple-layout';

export default function AuthLayout({
    title = '',
    description = '',
    variant = 'simple',
    wide = false,
    bare = false,
    header,
    children,
}: {
    title?: string;
    description?: string;
    /** `simple` for sign-in pages, `card` for the setup wizard. */
    variant?: 'simple' | 'card';
    wide?: boolean;
    bare?: boolean;
    header?: ReactNode;
    children: ReactNode;
}) {
    return (
        <DirectionProvider>
            {variant === 'card' ? (
                <AuthCardLayout
                    title={title}
                    description={description}
                    wide={wide}
                    bare={bare}
                    header={header}
                >
                    {children}
                </AuthCardLayout>
            ) : (
                <AuthSimpleLayout title={title} description={description}>
                    {children}
                </AuthSimpleLayout>
            )}
        </DirectionProvider>
    );
}
