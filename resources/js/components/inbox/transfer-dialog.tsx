import { useEffect, useId, useMemo, useState } from 'react';
import { PresenceDot } from '@/components/inbox/presence-select';
import { useReturnFocus } from '@/components/inbox/use-return-focus';
import { NativeSelect } from '@/components/setup/native-select';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Busy } from '@/components/widgets/form-bits';
import { useTrans } from '@/hooks/use-trans';
import {
    staffApi,
    type TransferTarget,
    type TransferTargetAgent,
    type TransferTargets,
} from '@/lib/chat-api/staff';
import type { ConversationStaff, PresenceMemberData } from '@/lib/chat/types';
import type { CategoryData } from '@/types/widgets';

const STATUS_ORDER = { online: 0, away: 1, offline: 2 } as const;

/** Colleagues to hand the chat to: everybody on the roster but the viewer, the ones who are around first. */
export function transferCandidates(
    roster: PresenceMemberData[],
    viewerId: number,
): PresenceMemberData[] {
    return roster
        .filter((member) => member.id !== viewerId)
        .sort(
            (a, b) =>
                STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
                a.name.localeCompare(b.name),
        );
}

/** Reachable colleagues first, then the ones who are around but full, then the rest; by name inside each group. */
export function sortTargetAgents(
    agents: TransferTargetAgent[],
): TransferTargetAgent[] {
    return [...agents].sort(
        (a, b) =>
            Number(b.reachable) - Number(a.reachable) ||
            STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
            a.name.localeCompare(b.name),
    );
}

/** `unreachable` colleagues say why: offline, full, or simply not available. */
function unreachableReason(agent: TransferTargetAgent): string {
    if (agent.status === 'offline') {
        return 'inbox.transfer.reason.offline';
    }

    return agent.maxConcurrentChats > 0 &&
        agent.activeChats >= agent.maxConcurrentChats
        ? 'inbox.transfer.reason.capacity'
        : 'inbox.transfer.reason.unavailable';
}

/**
 * Hand a chat to a colleague or to a category (it returns to the queue for that category's agents). The visitor sees "connecting you
 * to another agent".
 *
 * The list comes from `GET .../transfer-targets`: only agents who serve this chat's category (the ones who cannot take it right now are
 * greyed out with the reason and their load) and only topics of this widget that have someone reachable. Where that endpoint does
 * not exist (404) the dialog falls back to the `presence-staff` roster and the active categories, and the server's `409 no_agents` is
 * the final word, shown right here.
 */
export function TransferDialog({
    open,
    onOpenChange,
    conversation,
    roster,
    categories,
    viewerId,
    onTransfer,
    error = null,
    loadTargets = (ulid) => staffApi.transferTargets(ulid),
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    conversation: ConversationStaff;
    roster: PresenceMemberData[];
    categories: CategoryData[];
    viewerId: number;
    onTransfer: (target: TransferTarget) => Promise<boolean>;
    /** Why the last transfer failed (shown inside the dialog, where the agent is looking). */
    error?: string | null;
    loadTargets?: (ulid: string) => Promise<TransferTargets>;
}) {
    const { t } = useTrans();
    const categoryId = useId();
    const [tab, setTab] = useState<'agent' | 'category'>('agent');
    const [agent, setAgent] = useState('');
    const [category, setCategory] = useState('');
    const [pending, setPending] = useState(false);
    // `undefined`: still loading; `null`: the endpoint is not there (or failed): the roster is the source.
    const [loaded, setLoaded] = useState<TransferTargets | null | undefined>(
        undefined,
    );
    const returnFocus = useReturnFocus(open);
    const ulid = conversation.ulid;

    useEffect(() => {
        if (!open) {
            return;
        }

        let current = true;

        // eslint-disable-next-line react-hooks/set-state-in-effect -- each opening asks again: availability changes by the minute
        setLoaded(undefined);
        loadTargets(ulid).then(
            (targets) => current && setLoaded(targets),
            () => current && setLoaded(null),
        );

        return () => {
            current = false;
        };
        // `loadTargets` is an injection point: its identity must not restart the request.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, ulid]);

    const fromServer = loaded !== undefined && loaded !== null;
    const agents = useMemo(
        () => transferCandidates(roster, viewerId),
        [roster, viewerId],
    );
    const serverAgents = useMemo(
        () =>
            loaded
                ? sortTargetAgents(
                      loaded.agents.filter((member) => member.id !== viewerId),
                  )
                : [],
        [loaded, viewerId],
    );
    const targets: { slug: string; label: string }[] = loaded
        ? loaded.categories.filter(
              (item) => item.slug !== conversation.category?.slug,
          )
        : categories
              .filter(
                  (item) =>
                      item.is_active &&
                      item.slug !== conversation.category?.slug,
              )
              .map((item) => ({ slug: item.slug, label: item.name }));
    const target: TransferTarget | null =
        tab === 'agent' && agent !== ''
            ? { agentId: Number(agent) }
            : tab === 'category' && category !== ''
              ? { category }
              : null;

    const submit = async (): Promise<void> => {
        if (!target) {
            return;
        }

        setPending(true);

        try {
            if (await onTransfer(target)) {
                onOpenChange(false);
            }
        } finally {
            setPending(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent data-testid="transfer-dialog" {...returnFocus}>
                <DialogHeader>
                    <DialogTitle>{t('inbox.transfer.title')}</DialogTitle>
                    <DialogDescription>
                        {t('inbox.transfer.description')}
                    </DialogDescription>
                </DialogHeader>

                <Tabs
                    value={tab}
                    onValueChange={(value) =>
                        setTab(value as 'agent' | 'category')
                    }
                >
                    {/* The kit's inactive tab (60% foreground on the muted track) measures 4.46:1; 75% clears WCAG AA's 4.5:1 with room. */}
                    <TabsList className="w-full">
                        <TabsTrigger
                            value="agent"
                            data-testid="transfer-tab-agent"
                            className="text-foreground/75"
                        >
                            {t('inbox.transfer.to_agent')}
                        </TabsTrigger>
                        <TabsTrigger
                            value="category"
                            data-testid="transfer-tab-category"
                            className="text-foreground/75"
                        >
                            {t('inbox.transfer.to_category')}
                        </TabsTrigger>
                    </TabsList>

                    <TabsContent value="agent" className="mt-3">
                        {loaded === undefined ? (
                            <p
                                data-testid="transfer-loading"
                                role="status"
                                className="rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground"
                            >
                                {t('inbox.transfer.loading')}
                            </p>
                        ) : fromServer ? (
                            serverAgents.length === 0 ? (
                                <p
                                    data-testid="transfer-no-agents"
                                    className="rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground"
                                >
                                    {t('inbox.transfer.no_agents_for_topic')}
                                </p>
                            ) : (
                                <RadioGroup
                                    value={agent}
                                    onValueChange={setAgent}
                                    aria-label={t('inbox.transfer.to_agent')}
                                    className="max-h-64 gap-1 overflow-y-auto"
                                >
                                    {serverAgents.map((member) => (
                                        <Label
                                            key={member.id}
                                            htmlFor={`transfer-agent-${member.id}`}
                                            data-unreachable={
                                                member.reachable
                                                    ? undefined
                                                    : 'true'
                                            }
                                            className="flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 font-normal has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-accent data-[unreachable=true]:cursor-not-allowed data-[unreachable=true]:opacity-60"
                                        >
                                            <RadioGroupItem
                                                id={`transfer-agent-${member.id}`}
                                                value={String(member.id)}
                                                disabled={!member.reachable}
                                                data-testid={`transfer-agent-${member.id}`}
                                            />
                                            <PresenceDot
                                                status={member.status}
                                            />
                                            <span className="min-w-0 flex-1">
                                                <span className="block truncate text-sm">
                                                    {member.name}
                                                </span>
                                                <span className="block text-xs text-muted-foreground">
                                                    {member.reachable
                                                        ? t(
                                                              `inbox.presence.${member.status}`,
                                                          )
                                                        : t(
                                                              unreachableReason(
                                                                  member,
                                                              ),
                                                          )}
                                                </span>
                                            </span>
                                            <span
                                                data-testid={`transfer-load-${member.id}`}
                                                className="text-xs text-muted-foreground tabular-nums"
                                            >
                                                {t('inbox.transfer.load', {
                                                    active: member.activeChats,
                                                    max: member.maxConcurrentChats,
                                                })}
                                            </span>
                                        </Label>
                                    ))}
                                </RadioGroup>
                            )
                        ) : agents.length === 0 ? (
                            <p
                                data-testid="transfer-no-agents"
                                className="rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground"
                            >
                                {t('inbox.transfer.no_agents')}
                            </p>
                        ) : (
                            <RadioGroup
                                value={agent}
                                onValueChange={setAgent}
                                aria-label={t('inbox.transfer.to_agent')}
                                className="max-h-64 gap-1 overflow-y-auto"
                            >
                                {agents.map((member) => (
                                    <Label
                                        key={member.id}
                                        htmlFor={`transfer-agent-${member.id}`}
                                        className="flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 font-normal has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-accent"
                                    >
                                        <RadioGroupItem
                                            id={`transfer-agent-${member.id}`}
                                            value={String(member.id)}
                                            data-testid={`transfer-agent-${member.id}`}
                                        />
                                        <PresenceDot status={member.status} />
                                        <span className="min-w-0 flex-1 truncate text-sm">
                                            {member.name}
                                        </span>
                                        <span className="text-xs text-muted-foreground">
                                            {t(
                                                `inbox.presence.${member.status}`,
                                            )}
                                        </span>
                                    </Label>
                                ))}
                            </RadioGroup>
                        )}
                    </TabsContent>

                    <TabsContent value="category" className="mt-3 grid gap-2">
                        <Label htmlFor={categoryId}>
                            {t('inbox.transfer.category_label')}
                        </Label>
                        <NativeSelect
                            id={categoryId}
                            data-testid="transfer-category"
                            value={category}
                            onChange={(event) =>
                                setCategory(event.target.value)
                            }
                        >
                            <option value="">
                                {t('inbox.transfer.category_placeholder')}
                            </option>
                            {targets.map((item) => (
                                <option key={item.slug} value={item.slug}>
                                    {item.label}
                                </option>
                            ))}
                        </NativeSelect>
                        {fromServer && targets.length === 0 && (
                            <p
                                data-testid="transfer-no-categories"
                                className="text-xs text-muted-foreground"
                            >
                                {t('inbox.transfer.no_categories')}
                            </p>
                        )}
                    </TabsContent>
                </Tabs>

                {error && (
                    <p
                        data-testid="transfer-error"
                        role="alert"
                        className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm"
                    >
                        {error}
                    </p>
                )}

                <DialogFooter>
                    <Button
                        type="button"
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                    >
                        {t('inbox.cancel')}
                    </Button>
                    <Button
                        type="button"
                        data-testid="transfer-confirm"
                        disabled={target === null || pending}
                        onClick={() => void submit()}
                    >
                        {pending && <Busy />}
                        {t('inbox.transfer.confirm')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
