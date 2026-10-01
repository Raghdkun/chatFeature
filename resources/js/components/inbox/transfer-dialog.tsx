import { useId, useMemo, useState } from 'react';
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
import type { TransferTarget } from '@/lib/chat-api/staff';
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

/**
 * Hand a chat to a colleague (picked from the `presence-staff` roster: the management API has no agent directory an agent may read)
 * or to a category (it returns to the queue for that category's agents). The visitor sees "connecting you to another agent".
 */
export function TransferDialog({
    open,
    onOpenChange,
    conversation,
    roster,
    categories,
    viewerId,
    onTransfer,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    conversation: ConversationStaff;
    roster: PresenceMemberData[];
    categories: CategoryData[];
    viewerId: number;
    onTransfer: (target: TransferTarget) => Promise<boolean>;
}) {
    const { t } = useTrans();
    const categoryId = useId();
    const [tab, setTab] = useState<'agent' | 'category'>('agent');
    const [agent, setAgent] = useState('');
    const [category, setCategory] = useState('');
    const [pending, setPending] = useState(false);
    const returnFocus = useReturnFocus(open);
    const agents = useMemo(
        () => transferCandidates(roster, viewerId),
        [roster, viewerId],
    );
    const targets = categories.filter(
        (item) => item.is_active && item.slug !== conversation.category?.slug,
    );
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
                    <TabsList className="w-full">
                        <TabsTrigger
                            value="agent"
                            data-testid="transfer-tab-agent"
                        >
                            {t('inbox.transfer.to_agent')}
                        </TabsTrigger>
                        <TabsTrigger
                            value="category"
                            data-testid="transfer-tab-category"
                        >
                            {t('inbox.transfer.to_category')}
                        </TabsTrigger>
                    </TabsList>

                    <TabsContent value="agent" className="mt-3">
                        {agents.length === 0 ? (
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
                                <option key={item.ulid} value={item.slug}>
                                    {item.name}
                                </option>
                            ))}
                        </NativeSelect>
                    </TabsContent>
                </Tabs>

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
