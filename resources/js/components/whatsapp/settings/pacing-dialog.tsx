import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { useReturnFocus } from '@/components/inbox/use-return-focus';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    Busy,
    Notice,
    NumberField,
    SwitchRow,
} from '@/components/widgets/form-bits';
import { useTrans } from '@/hooks/use-trans';
import { isApiError } from '@/lib/api-client';
import { describeWaError } from '@/lib/whatsapp-api/client';
import { WA_LIMITS, type SessionPacingInput } from '@/lib/whatsapp-api/types';
import type { WhatsAppSession } from '@/lib/whatsapp/types';

export type GlobalPacing = { sendMinIntervalMs: number; dailySendCap: number };

/**
 * One session's own sending limits (`PATCH /whatsapp/sessions/{ulid}`): a session can be paced more gently than the global setting, for
 * example a young number. "Use the global limits" sends `null` for both, which drops the override. The form is rebuilt for every
 * session that opens (keyed), so nothing of the previous one lingers.
 */
export function PacingDialog({
    session,
    global,
    onClose,
    onSave,
}: {
    session: WhatsAppSession | null;
    global: GlobalPacing;
    onClose: () => void;
    onSave: (ulid: string, input: SessionPacingInput) => Promise<unknown>;
}) {
    const returnFocus = useReturnFocus(session !== null);

    return (
        <Dialog
            open={session !== null}
            onOpenChange={(next) => {
                if (!next) {
                    onClose();
                }
            }}
        >
            <DialogContent
                data-testid="wa-pacing-dialog"
                {...returnFocus}
                className="sm:max-w-md"
            >
                {session && (
                    <PacingForm
                        key={session.ulid}
                        session={session}
                        global={global}
                        onClose={onClose}
                        onSave={onSave}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

function PacingForm({
    session,
    global,
    onClose,
    onSave,
}: {
    session: WhatsAppSession;
    global: GlobalPacing;
    onClose: () => void;
    onSave: (ulid: string, input: SessionPacingInput) => Promise<unknown>;
}) {
    const { t, locale } = useTrans();
    const uid = useId();
    const [useGlobal, setUseGlobal] = useState(!session.pacingOverridden);
    const [interval, setInterval] = useState(session.sendMinIntervalMs);
    const [cap, setCap] = useState(session.dailySendCap);
    const [saving, setSaving] = useState(false);
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [problem, setProblem] = useState<string | null>(null);

    const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
        event.preventDefault();

        if (saving) {
            return;
        }

        setSaving(true);
        setErrors({});
        setProblem(null);

        try {
            await onSave(
                session.ulid,
                useGlobal
                    ? { sendMinIntervalMs: null, dailySendCap: null }
                    : { sendMinIntervalMs: interval, dailySendCap: cap },
            );
            toast.success(
                t('whatsapp.toast.pacing_saved', { name: session.name }),
            );
            onClose();
        } catch (error) {
            if (isApiError(error) && error.isValidation) {
                const mapped: Record<string, string> = {};

                for (const [field, messages] of Object.entries(error.details)) {
                    mapped[field] = messages[0] ?? '';
                }

                setErrors(mapped);

                if (
                    !('send_min_interval_ms' in mapped) &&
                    !('daily_send_cap' in mapped)
                ) {
                    setProblem(describeWaError(error, t, locale));
                }
            } else {
                setProblem(describeWaError(error, t, locale));
            }
        } finally {
            setSaving(false);
        }
    };

    return (
        <form
            onSubmit={(event) => void submit(event)}
            noValidate
            data-testid="wa-pacing-form"
            className="grid min-w-0 gap-5"
        >
            <DialogHeader>
                <DialogTitle className="[overflow-wrap:anywhere]">
                    {t('whatsapp.pacing.title', { name: session.name })}
                </DialogTitle>
                <DialogDescription>
                    {t('whatsapp.pacing.description')}
                </DialogDescription>
            </DialogHeader>

            {problem && (
                <Notice tone="danger" data-testid="wa-pacing-problem">
                    {problem}
                </Notice>
            )}

            <SwitchRow
                id={`${uid}-global`}
                label={t('whatsapp.pacing.use_global')}
                description={t('whatsapp.pacing.use_global_hint', {
                    interval: (global.sendMinIntervalMs / 1000).toLocaleString(
                        locale,
                    ),
                    cap: global.dailySendCap.toLocaleString(locale),
                })}
                checked={useGlobal}
                disabled={saving}
                testId="wa-pacing-global"
                onCheckedChange={setUseGlobal}
            />

            <div className="grid gap-5 sm:grid-cols-2">
                <NumberField
                    id={`${uid}-interval`}
                    label={t('whatsapp.behavior.interval')}
                    value={interval}
                    min={WA_LIMITS.sendMinIntervalMs.min}
                    max={WA_LIMITS.sendMinIntervalMs.max}
                    suffix={t('whatsapp.behavior.milliseconds')}
                    error={errors.send_min_interval_ms}
                    disabled={saving || useGlobal}
                    onValueChange={setInterval}
                />
                <NumberField
                    id={`${uid}-cap`}
                    label={t('whatsapp.behavior.cap')}
                    value={cap}
                    min={WA_LIMITS.dailySendCap.min}
                    max={WA_LIMITS.dailySendCap.max}
                    suffix={t('whatsapp.behavior.per_day')}
                    error={errors.daily_send_cap}
                    disabled={saving || useGlobal}
                    onValueChange={setCap}
                />
            </div>

            <DialogFooter>
                <Button
                    type="button"
                    variant="outline"
                    disabled={saving}
                    data-testid="wa-pacing-cancel"
                    onClick={onClose}
                >
                    {t('whatsapp.cancel')}
                </Button>
                <Button
                    type="submit"
                    disabled={saving}
                    data-testid="wa-pacing-save"
                >
                    {saving && <Busy />}
                    {t('whatsapp.pacing.save')}
                </Button>
            </DialogFooter>
        </form>
    );
}
