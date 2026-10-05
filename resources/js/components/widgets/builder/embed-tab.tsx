import { KeyRound, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useId, useState } from 'react';
import type { TabProps } from '@/components/widgets/builder/tab-props';
import type { BuilderTab } from '@/components/widgets/builder-state';
import {
    Busy,
    CodeBlock,
    CopyButton,
    Notice,
    SectionCard,
    SegmentedChoice,
} from '@/components/widgets/form-bits';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { OpenNow } from '@/components/widgets/builder/open-now';
import { useTrans } from '@/hooks/use-trans';
import { describeApiError } from '@/lib/api-client';
import type { WidgetSnippetsData } from '@/types/widgets';

type Language = keyof WidgetSnippetsData['identity_example'];

const LANGUAGES: Language[] = ['php', 'node', 'python'];

export function EmbedTab({
    state,
    snippets,
    onRotateSecret,
    hasUnpublished,
    onTabChange,
}: Pick<TabProps, 'state'> & {
    snippets: WidgetSnippetsData;
    /** Jumps to the tab where the missing step is done. */
    onTabChange: (tab: BuilderTab) => void;
    /** Resolves with the plaintext secret; it is shown once and never kept. */
    onRotateSecret: () => Promise<string>;
    hasUnpublished: boolean;
}) {
    const { t } = useTrans();
    const uid = useId();
    const [language, setLanguage] = useState<Language>('php');
    const [confirming, setConfirming] = useState(false);
    const [rotating, setRotating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [secret, setSecret] = useState<string | null>(null);
    const hasSecret = state.meta.hasIdentitySecret;

    async function rotate() {
        setRotating(true);
        setError(null);

        try {
            setSecret(await onRotateSecret());
            setConfirming(false);
        } catch (failure) {
            setError(describeApiError(failure, t));
        } finally {
            setRotating(false);
        }
    }

    return (
        <div className="grid gap-5" data-testid="builder-panel-embed">
            <SectionCard
                title={t('builder.embed.snippets_title')}
                description={t('builder.embed.snippets_description')}
            >
                {!state.doc.settings.is_enabled ? (
                    <Notice tone="warning" data-testid="builder-embed-offline">
                        <div className="grid gap-2">
                            <p>{t('builder.embed.not_live')}</p>
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="w-fit bg-background"
                                onClick={() => onTabChange('general')}
                            >
                                {t('builder.embed.not_live_action')}
                            </Button>
                        </div>
                    </Notice>
                ) : (
                    state.doc.domains.length === 0 && (
                        <Notice
                            tone="warning"
                            data-testid="builder-embed-no-domains"
                        >
                            <div className="grid gap-2">
                                <p>{t('builder.embed.no_domains')}</p>
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    className="w-fit bg-background"
                                    onClick={() => onTabChange('domains')}
                                >
                                    {t('builder.embed.no_domains_action')}
                                </Button>
                            </div>
                        </Notice>
                    )
                )}
                {state.doc.settings.is_enabled && (
                    <OpenNow
                        onlyWhenClosed
                        mode={state.doc.settings.offline_mode}
                        timeZone={state.doc.settings.timezone}
                        schedule={state.doc.config.hours.schedule}
                        holidays={state.doc.config.hours.holidays}
                        testId="builder-embed-closed-now"
                    />
                )}
                {hasUnpublished && (
                    <Notice
                        tone="warning"
                        data-testid="builder-embed-unpublished"
                    >
                        {t('builder.embed.unpublished_notice')}
                    </Notice>
                )}
                <CodeBlock
                    title={t('builder.embed.script')}
                    code={snippets.script}
                    copyLabel={t('builder.embed.copy_script')}
                    testId="builder-snippet-script"
                />
                <CodeBlock
                    title={t('builder.embed.iframe')}
                    code={snippets.iframe}
                    copyLabel={t('builder.embed.copy_iframe')}
                    testId="builder-snippet-iframe"
                />
                <div className="grid gap-2">
                    <CodeBlock
                        title={t('builder.embed.hosted')}
                        code={snippets.hosted}
                        copyLabel={t('builder.embed.copy_hosted')}
                        testId="builder-snippet-hosted"
                    />
                    <p className="text-sm text-muted-foreground">
                        {t('builder.embed.hosted_hint')}
                    </p>
                </div>
            </SectionCard>

            <SectionCard
                title={t('builder.embed.identity_title')}
                description={t('builder.embed.identity_description')}
                actions={
                    <Badge
                        variant={hasSecret ? 'secondary' : 'outline'}
                        className="gap-1.5"
                        data-testid="builder-secret-status"
                    >
                        {hasSecret ? (
                            <ShieldCheck aria-hidden />
                        ) : (
                            <ShieldAlert aria-hidden />
                        )}
                        {hasSecret
                            ? t('builder.embed.secret_set')
                            : t('builder.embed.secret_unset')}
                    </Badge>
                }
            >
                <div className="flex flex-wrap items-center gap-3">
                    <Button
                        type="button"
                        variant={hasSecret ? 'outline' : 'default'}
                        onClick={() =>
                            hasSecret ? setConfirming(true) : void rotate()
                        }
                        disabled={rotating}
                        data-testid="builder-rotate-secret"
                    >
                        {rotating ? <Busy /> : <KeyRound aria-hidden />}
                        {hasSecret
                            ? t('builder.embed.rotate')
                            : t('builder.embed.generate')}
                    </Button>
                    <p className="text-sm text-muted-foreground">
                        {t('builder.embed.secret_once')}
                    </p>
                </div>

                {error && (
                    <Notice tone="danger" data-testid="builder-rotate-error">
                        {error}
                    </Notice>
                )}

                <SegmentedChoice<Language>
                    legend={t('builder.embed.example_language')}
                    name={`${uid}-language`}
                    value={language}
                    onChange={setLanguage}
                    options={LANGUAGES.map((code) => ({
                        value: code,
                        label: t(`builder.embed.lang_${code}`),
                    }))}
                    variant="segmented"
                    testId="builder-identity-language"
                />
                <CodeBlock
                    title={t('builder.embed.example_title', {
                        language: t(`builder.embed.lang_${language}`),
                    })}
                    code={snippets.identity_example[language]}
                    copyLabel={t('builder.embed.copy_example')}
                    testId="builder-identity-example"
                />
                <p className="text-sm text-muted-foreground">
                    {t('builder.embed.identity_hint')}
                </p>
            </SectionCard>

            <AlertDialog open={confirming} onOpenChange={setConfirming}>
                <AlertDialogContent data-testid="builder-rotate-dialog">
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {t('builder.embed.rotate_title')}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {t('builder.embed.rotate_body')}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>
                            {t('builder.embed.rotate_cancel')}
                        </AlertDialogCancel>
                        <AlertDialogAction
                            variant="destructive"
                            disabled={rotating}
                            data-testid="builder-rotate-confirm"
                            onClick={(event) => {
                                event.preventDefault();
                                void rotate();
                            }}
                        >
                            {rotating && <Busy />}
                            {t('builder.embed.rotate_confirm')}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            <SecretDialog secret={secret} onClose={() => setSecret(null)} />
        </div>
    );
}

/** The one and only time the plaintext secret is on screen. Closing it drops it from memory. */
function SecretDialog({
    secret,
    onClose,
}: {
    secret: string | null;
    onClose: () => void;
}) {
    const { t } = useTrans();

    return (
        <Dialog
            open={secret !== null}
            onOpenChange={(open) => !open && onClose()}
        >
            <DialogContent
                data-testid="builder-secret-dialog"
                className="sm:max-w-lg"
                // Esc / an outside click must not throw the only copy away by accident.
                onEscapeKeyDown={(event) => event.preventDefault()}
                onInteractOutside={(event) => event.preventDefault()}
            >
                <DialogHeader className="text-start sm:text-start">
                    <DialogTitle>{t('builder.embed.secret_title')}</DialogTitle>
                    <DialogDescription>
                        {t('builder.embed.secret_description')}
                    </DialogDescription>
                </DialogHeader>
                <div className="grid gap-3">
                    <code
                        dir="ltr"
                        data-testid="builder-secret-value"
                        className="block rounded-lg border bg-muted/50 p-3 font-mono text-sm break-all select-all"
                    >
                        {secret}
                    </code>
                    <div>
                        <CopyButton
                            value={secret ?? ''}
                            label={t('builder.embed.copy_secret')}
                            testId="builder-secret-copy"
                        />
                    </div>
                    <Notice tone="warning">
                        {t('builder.embed.secret_warning')}
                    </Notice>
                </div>
                <DialogFooter>
                    <Button
                        type="button"
                        onClick={onClose}
                        data-testid="builder-secret-done"
                    >
                        {t('builder.embed.secret_done')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
