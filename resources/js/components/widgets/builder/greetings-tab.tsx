import {
    ChevronDown,
    ChevronUp,
    Eye,
    MessageSquarePlus,
    Trash2,
} from 'lucide-react';
import { useId } from 'react';
import { describedBy, Field } from '@/components/setup/field';
import {
    errorsUnder,
    firstError,
    sectionAction,
    type GreetingDraft,
} from '@/components/widgets/builder-state';
import { LocaleSelect } from '@/components/widgets/builder/selects';
import type { TabProps } from '@/components/widgets/builder/tab-props';
import {
    NumberField,
    SectionCard,
    SegmentedChoice,
    SwitchRow,
    TextField,
} from '@/components/widgets/form-bits';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useInitials } from '@/hooks/use-initials';
import { useTrans } from '@/hooks/use-trans';
import { isSecureUrl, LIMITS } from '@/lib/widget-config';
import { cn } from '@/lib/utils';
import type { DismissPolicy, GreetingsSettings } from '@/types/widgets';

let greetingCounter = 0;

export function newGreetingClientId(): string {
    greetingCounter += 1;

    return `new-greeting-${greetingCounter}`;
}

export function GreetingsTab({
    state,
    dispatch,
    onPreviewGreeting,
    previewingId,
}: TabProps & {
    /** Shows this greeting's popup in the (static) preview. */
    onPreviewGreeting: (clientId: string) => void;
    previewingId: string | null;
}) {
    const { t } = useTrans();
    const uid = useId();
    const { greetings: settings } = state.doc.config;
    const pool = state.doc.greetings;
    const err = (path: string) => firstError(state.errors, path);
    const patch = (value: Partial<GreetingsSettings>) =>
        dispatch(sectionAction('greetings', value));

    return (
        <div className="grid gap-5" data-testid="builder-panel-greetings">
            <SectionCard
                title={t('builder.greetings.settings_title')}
                description={t('builder.greetings.settings_description')}
            >
                <div className="grid gap-x-8 gap-y-5 lg:grid-cols-2">
                    <SwitchRow
                        id={`${uid}-enabled`}
                        label={t('builder.greetings.enabled')}
                        description={t('builder.greetings.enabled_hint')}
                        checked={settings.enabled}
                        onCheckedChange={(enabled) => patch({ enabled })}
                        testId="builder-greetings-enabled"
                    />
                    <SwitchRow
                        id={`${uid}-on-page-load`}
                        label={t('builder.greetings.on_page_load')}
                        description={t('builder.greetings.on_page_load_hint')}
                        checked={settings.onPageLoad}
                        onCheckedChange={(onPageLoad) => patch({ onPageLoad })}
                        testId="builder-greetings-on-page-load"
                    />
                    <SwitchRow
                        id={`${uid}-show-agent`}
                        label={t('builder.greetings.show_agent')}
                        description={t('builder.greetings.show_agent_hint')}
                        checked={settings.showAgent}
                        onCheckedChange={(showAgent) => patch({ showAgent })}
                        testId="builder-greetings-show-agent"
                    />
                </div>

                <div className="grid gap-5 sm:grid-cols-3">
                    <NumberField
                        id={`${uid}-delay`}
                        label={t('builder.greetings.delay')}
                        hint={t('builder.greetings.delay_hint')}
                        value={settings.delaySeconds}
                        onValueChange={(delaySeconds) =>
                            patch({ delaySeconds })
                        }
                        min={LIMITS.delaySeconds.min}
                        max={LIMITS.delaySeconds.max}
                        suffix={t('builder.unit.seconds')}
                        error={err('config.greetings.delaySeconds')}
                    />
                    <NumberField
                        id={`${uid}-interval`}
                        label={t('builder.greetings.interval')}
                        hint={t('builder.greetings.interval_hint')}
                        value={settings.intervalMinutes}
                        onValueChange={(intervalMinutes) =>
                            patch({ intervalMinutes })
                        }
                        min={LIMITS.intervalMinutes.min}
                        max={LIMITS.intervalMinutes.max}
                        suffix={t('builder.unit.minutes')}
                        error={err('config.greetings.intervalMinutes')}
                    />
                    <NumberField
                        id={`${uid}-auto-hide`}
                        label={t('builder.greetings.auto_hide')}
                        hint={t('builder.greetings.auto_hide_hint')}
                        value={settings.autoHideSeconds}
                        onValueChange={(autoHideSeconds) =>
                            patch({ autoHideSeconds })
                        }
                        min={LIMITS.autoHideSeconds.min}
                        max={LIMITS.autoHideSeconds.max}
                        suffix={t('builder.unit.seconds')}
                        error={err('config.greetings.autoHideSeconds')}
                    />
                </div>

                <SegmentedChoice<DismissPolicy>
                    legend={t('builder.greetings.dismiss')}
                    name={`${uid}-dismiss`}
                    value={settings.dismissPolicy}
                    onChange={(dismissPolicy) => patch({ dismissPolicy })}
                    hint={t(
                        `builder.greetings.dismiss_${settings.dismissPolicy}_hint`,
                    )}
                    options={[
                        {
                            value: 'session',
                            label: t('builder.greetings.dismiss_session'),
                        },
                        {
                            value: 'interval',
                            label: t('builder.greetings.dismiss_interval'),
                        },
                        {
                            value: 'never',
                            label: t('builder.greetings.dismiss_never'),
                        },
                    ]}
                    testId="builder-greetings-dismiss"
                />
            </SectionCard>

            <SectionCard
                title={t('builder.greetings.pool_title')}
                description={t('builder.greetings.pool_description')}
                actions={
                    <Button
                        type="button"
                        size="sm"
                        data-testid="builder-greeting-add"
                        onClick={() =>
                            dispatch({
                                type: 'greetings/add',
                                clientId: newGreetingClientId(),
                            })
                        }
                    >
                        <MessageSquarePlus aria-hidden />
                        {t('builder.greetings.add')}
                    </Button>
                }
                testId="builder-greetings-pool"
            >
                {pool.length === 0 ? (
                    <p
                        className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground"
                        data-testid="builder-greetings-empty"
                    >
                        {t('builder.greetings.empty')}
                    </p>
                ) : (
                    <ol className="grid gap-4">
                        {pool.map((greeting, index) => (
                            <GreetingCard
                                key={greeting.clientId}
                                greeting={greeting}
                                index={index}
                                count={pool.length}
                                state={state}
                                dispatch={dispatch}
                                previewing={previewingId === greeting.clientId}
                                onPreview={() =>
                                    onPreviewGreeting(greeting.clientId)
                                }
                            />
                        ))}
                    </ol>
                )}
            </SectionCard>
        </div>
    );
}

function GreetingCard({
    greeting,
    index,
    count,
    state,
    dispatch,
    previewing,
    onPreview,
}: TabProps & {
    greeting: GreetingDraft;
    index: number;
    count: number;
    previewing: boolean;
    onPreview: () => void;
}) {
    const { t } = useTrans();
    const uid = useId();
    const getInitials = useInitials();
    const path = `greetings.${index}`;
    const err = (field: string) => firstError(state.errors, `${path}.${field}`);
    const bodyError = err('body');
    const patch = (value: Partial<Omit<GreetingDraft, 'clientId' | 'ulid'>>) =>
        dispatch({
            type: 'greetings/update',
            clientId: greeting.clientId,
            patch: value,
        });
    const avatarOk =
        greeting.agent_avatar_url !== null &&
        isSecureUrl(greeting.agent_avatar_url);
    const general = errorsUnder(state.errors, path).filter(
        (message) =>
            !['body', 'weight', 'agent_avatar_url', 'locale'].some(
                (f) => err(f) === message,
            ),
    );

    return (
        <li
            data-testid={`builder-greeting-${index}`}
            className={cn(
                'grid gap-4 rounded-lg border p-4',
                !greeting.is_active && 'bg-muted/30',
                previewing && 'ring-2 ring-primary/40',
            )}
        >
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">
                    {t('builder.greetings.item', { n: index + 1 })}
                </p>
                <div className="flex items-center gap-1">
                    <SwitchRow
                        id={`${uid}-active`}
                        label={t('builder.greetings.item_active')}
                        checked={greeting.is_active}
                        onCheckedChange={(is_active) => patch({ is_active })}
                        className="me-2 items-center gap-2"
                        testId={`builder-greeting-${index}-active`}
                    />
                    <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="size-8"
                        disabled={index === 0}
                        aria-label={t('builder.greetings.move_up', {
                            n: index + 1,
                        })}
                        data-testid={`builder-greeting-${index}-up`}
                        onClick={() =>
                            dispatch({
                                type: 'greetings/move',
                                clientId: greeting.clientId,
                                direction: -1,
                            })
                        }
                    >
                        <ChevronUp aria-hidden />
                    </Button>
                    <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="size-8"
                        disabled={index === count - 1}
                        aria-label={t('builder.greetings.move_down', {
                            n: index + 1,
                        })}
                        data-testid={`builder-greeting-${index}-down`}
                        onClick={() =>
                            dispatch({
                                type: 'greetings/move',
                                clientId: greeting.clientId,
                                direction: 1,
                            })
                        }
                    >
                        <ChevronDown aria-hidden />
                    </Button>
                    <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="size-8 text-destructive-foreground hover:text-destructive-foreground"
                        aria-label={t('builder.greetings.remove', {
                            n: index + 1,
                        })}
                        data-testid={`builder-greeting-${index}-remove`}
                        onClick={() =>
                            dispatch({
                                type: 'greetings/remove',
                                clientId: greeting.clientId,
                            })
                        }
                    >
                        <Trash2 aria-hidden />
                    </Button>
                </div>
            </div>

            <Field
                id={`${uid}-body`}
                label={t('builder.greetings.body')}
                hint={t('builder.greetings.body_hint', {
                    count: greeting.body.length,
                    max: LIMITS.greetingBodyLength,
                })}
                error={bodyError}
            >
                <Textarea
                    id={`${uid}-body`}
                    value={greeting.body}
                    rows={3}
                    maxLength={LIMITS.greetingBodyLength}
                    dir="auto"
                    onChange={(event) => patch({ body: event.target.value })}
                    aria-invalid={bodyError ? true : undefined}
                    aria-describedby={describedBy(`${uid}-body`, {
                        hint: true,
                        error: bodyError,
                    })}
                    data-testid={`builder-greeting-${index}-body`}
                />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                    id={`${uid}-agent`}
                    label={t('builder.greetings.agent_name')}
                    hint={t('builder.greetings.agent_name_hint')}
                    value={greeting.agent_name ?? ''}
                    onValueChange={(value) =>
                        patch({ agent_name: value === '' ? null : value })
                    }
                    maxLength={60}
                    error={err('agent_name')}
                />
                <div className="grid content-start gap-2">
                    <TextField
                        id={`${uid}-avatar`}
                        type="url"
                        label={t('builder.greetings.agent_avatar')}
                        value={greeting.agent_avatar_url ?? ''}
                        onValueChange={(value) =>
                            patch({
                                agent_avatar_url:
                                    value.trim() === '' ? null : value.trim(),
                            })
                        }
                        placeholder="https://"
                        error={err('agent_avatar_url')}
                        dir="ltr"
                        spellCheck={false}
                    />
                    <div className="flex items-center gap-2">
                        <Avatar className="size-8">
                            {avatarOk && (
                                <AvatarImage
                                    src={greeting.agent_avatar_url ?? undefined}
                                    alt=""
                                />
                            )}
                            <AvatarFallback className="text-xs">
                                {getInitials(greeting.agent_name ?? '') || '·'}
                            </AvatarFallback>
                        </Avatar>
                        <span className="text-xs text-muted-foreground">
                            {t('builder.greetings.avatar_preview')}
                        </span>
                    </div>
                </div>
                <LocaleSelect
                    id={`${uid}-locale`}
                    label={t('builder.greetings.locale')}
                    hint={t('builder.greetings.locale_hint')}
                    value={greeting.locale ?? ''}
                    allowAny
                    anyLabel={t('builder.greetings.any_locale')}
                    extra={Object.keys(state.doc.config.texts)}
                    onValueChange={(value) =>
                        patch({ locale: value === '' ? null : value })
                    }
                    error={err('locale')}
                />
                <NumberField
                    id={`${uid}-weight`}
                    label={t('builder.greetings.weight')}
                    hint={t('builder.greetings.weight_hint')}
                    value={greeting.weight}
                    onValueChange={(weight) => patch({ weight })}
                    min={LIMITS.greetingWeight.min}
                    max={LIMITS.greetingWeight.max}
                    error={err('weight')}
                />
            </div>

            {general.map((message) => (
                <p
                    key={message}
                    className="text-sm text-red-600 dark:text-red-400"
                >
                    {message}
                </p>
            ))}

            <div>
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={onPreview}
                    aria-pressed={previewing}
                    data-testid={`builder-greeting-${index}-preview`}
                >
                    <Eye aria-hidden />
                    {t('builder.greetings.preview')}
                </Button>
            </div>
        </li>
    );
}
