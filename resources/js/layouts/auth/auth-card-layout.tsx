import { Link } from '@inertiajs/react';
import type { PropsWithChildren, ReactNode } from 'react';
import AppLogoIcon from '@/components/app-logo-icon';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { dashboard } from '@/routes';

type Props = PropsWithChildren<{
    name?: string;
    title?: string;
    description?: string;
    /** Wider column (the setup wizard needs room for its stepper rail). */
    wide?: boolean;
    /** No title block and no inner padding: the page lays out its own card content. */
    bare?: boolean;
    /** Replaces the default logo link above the card. */
    header?: ReactNode;
}>;

export default function AuthCardLayout({
    children,
    title,
    description,
    wide = false,
    bare = false,
    header,
}: Props) {
    return (
        <div
            className={cn(
                'flex min-h-svh flex-col items-center gap-6 bg-muted p-4 sm:p-6 md:p-10',
                // The wizard changes height per step: anchor it to the top so the header stays put.
                bare ? 'justify-start md:pt-16' : 'justify-center',
            )}
        >
            <div
                className={cn(
                    'flex w-full flex-col gap-6',
                    wide ? 'max-w-3xl' : 'max-w-md',
                )}
            >
                {header ?? (
                    <Link
                        href={dashboard()}
                        className="flex items-center gap-2 self-center font-medium"
                    >
                        <div className="flex h-9 w-9 items-center justify-center">
                            <AppLogoIcon className="size-9 fill-current text-foreground" />
                        </div>
                    </Link>
                )}

                <div className="flex flex-col gap-6">
                    <Card
                        className={cn(
                            'rounded-xl',
                            bare && 'gap-0 overflow-hidden py-0 shadow-xs',
                        )}
                    >
                        {!bare && (
                            <CardHeader className="px-10 pt-8 pb-0 text-center">
                                <CardTitle className="text-xl">
                                    {title}
                                </CardTitle>
                                <CardDescription>{description}</CardDescription>
                            </CardHeader>
                        )}
                        <CardContent className={bare ? 'p-0' : 'px-10 py-8'}>
                            {children}
                        </CardContent>
                    </Card>
                </div>
            </div>
        </div>
    );
}
