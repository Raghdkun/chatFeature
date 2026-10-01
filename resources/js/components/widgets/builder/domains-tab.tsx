import { Globe, Plus, X } from 'lucide-react';
import { useId, useState } from 'react';
import { describedBy } from '@/components/setup/field';
import {
    errorsUnder,
    firstError,
    DOMAIN_PROBLEM_KEYS,
} from '@/components/widgets/builder-state';
import type { TabProps } from '@/components/widgets/builder/tab-props';
import { Notice, SectionCard } from '@/components/widgets/form-bits';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTrans } from '@/hooks/use-trans';
import { normaliseDomainEntry } from '@/lib/widget-config';
import { cn } from '@/lib/utils';

/** The sites the widget may run on (CSP `frame-ancestors` + Origin checks use this list). */
export function DomainsTab({ state, dispatch }: TabProps) {
    const { t } = useTrans();
    const uid = useId();
    const [draft, setDraft] = useState('');
    const [problem, setProblem] = useState<string | undefined>();
    const { domains } = state.doc;

    function add() {
        const entries = draft.split(/[\s,;]+/).filter(Boolean);

        if (entries.length === 0) {
            return;
        }

        const rejected: string[] = [];
        let message: string | undefined;

        for (const entry of entries) {
            const result = normaliseDomainEntry(entry);

            if (result.ok) {
                dispatch({ type: 'domains/add', value: result.value });
            } else {
                rejected.push(entry);
                message ??= `${entry}: ${t(DOMAIN_PROBLEM_KEYS[result.reason])}`;
            }
        }

        setDraft(rejected.join(' '));
        setProblem(message);
    }

    return (
        <div className="grid gap-5" data-testid="builder-panel-domains">
            <SectionCard
                title={t('builder.domains.title')}
                description={t('builder.domains.description')}
            >
                {domains.length === 0 && (
                    <Notice tone="warning" data-testid="builder-domains-empty">
                        {t('builder.domains.empty')}
                    </Notice>
                )}

                <div className="grid gap-2">
                    <Label htmlFor={`${uid}-input`}>
                        {t('builder.domains.add_label')}
                    </Label>
                    <div className="flex flex-wrap items-start gap-2">
                        <Input
                            id={`${uid}-input`}
                            value={draft}
                            onChange={(event) => {
                                setDraft(event.target.value);
                                setProblem(undefined);
                            }}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                    event.preventDefault();
                                    add();
                                }
                            }}
                            placeholder="example.com, *.example.com, localhost:5173"
                            dir="ltr"
                            spellCheck={false}
                            autoCapitalize="none"
                            autoComplete="off"
                            inputMode="url"
                            aria-invalid={problem ? true : undefined}
                            aria-describedby={describedBy(`${uid}-input`, {
                                hint: true,
                                error: problem,
                            })}
                            data-testid="builder-domain-input"
                            className="min-w-56 flex-1 font-mono text-sm"
                        />
                        <Button
                            type="button"
                            variant="outline"
                            onClick={add}
                            data-testid="builder-domain-add"
                        >
                            <Plus aria-hidden />
                            {t('builder.domains.add')}
                        </Button>
                    </div>
                    <p
                        id={`${uid}-input-hint`}
                        className="text-sm text-muted-foreground"
                    >
                        {t('builder.domains.add_hint')}
                    </p>
                    {problem && (
                        <p
                            id={`${uid}-input-error`}
                            role="alert"
                            data-testid="builder-domain-problem"
                            className="text-sm text-red-600 dark:text-red-400"
                        >
                            {problem}
                        </p>
                    )}
                </div>

                {domains.length > 0 && (
                    <ul
                        className="flex flex-wrap gap-2"
                        aria-label={t('builder.domains.list_label')}
                        data-testid="builder-domains-list"
                    >
                        {domains.map((domain, index) => {
                            const error = firstError(
                                state.errors,
                                `domains.${index}`,
                            );

                            return (
                                <li key={domain} className="grid gap-1">
                                    <span
                                        className={cn(
                                            'inline-flex items-center gap-1.5 rounded-full border bg-background py-1 ps-3 pe-1 text-sm',
                                            error && 'border-red-400',
                                        )}
                                    >
                                        <Globe
                                            className="size-3.5 text-muted-foreground"
                                            aria-hidden
                                        />
                                        <code
                                            dir="ltr"
                                            className="font-mono text-xs"
                                        >
                                            {domain}
                                        </code>
                                        <button
                                            type="button"
                                            aria-label={t(
                                                'builder.domains.remove',
                                                { domain },
                                            )}
                                            data-testid={`builder-domain-remove-${index}`}
                                            onClick={() =>
                                                dispatch({
                                                    type: 'domains/remove',
                                                    value: domain,
                                                })
                                            }
                                            className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                                        >
                                            <X
                                                className="size-3.5"
                                                aria-hidden
                                            />
                                        </button>
                                    </span>
                                    {error && (
                                        <span className="text-xs text-red-600 dark:text-red-400">
                                            {error}
                                        </span>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}

                {errorsUnder(state.errors, 'domains')
                    .filter(
                        (message) =>
                            !domains.some(
                                (_, i) =>
                                    firstError(state.errors, `domains.${i}`) ===
                                    message,
                            ),
                    )
                    .map((message) => (
                        <p
                            key={message}
                            className="text-sm text-red-600 dark:text-red-400"
                        >
                            {message}
                        </p>
                    ))}
            </SectionCard>

            <SectionCard title={t('builder.domains.help_title')}>
                <ul className="grid gap-2.5 text-sm text-muted-foreground">
                    <li>{t('builder.domains.help_hosts')}</li>
                    <li>{t('builder.domains.help_wildcard')}</li>
                    <li>{t('builder.domains.help_port')}</li>
                    <li>{t('builder.domains.help_scheme')}</li>
                </ul>
            </SectionCard>
        </div>
    );
}
