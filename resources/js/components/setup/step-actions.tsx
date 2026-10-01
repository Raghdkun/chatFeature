import { ArrowLeft, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useTrans } from '@/hooks/use-trans';

/** Steps the user may revisit; the arrow mirrors in RTL locales. */
export function BackButton({
    onClick,
    disabled = false,
}: {
    onClick: () => void;
    disabled?: boolean;
}) {
    const { t } = useTrans();

    return (
        <Button
            type="button"
            variant="ghost"
            onClick={onClick}
            disabled={disabled}
            data-testid="setup-back"
        >
            <ArrowLeft className="rtl:rotate-180" />
            {t('common.back')}
        </Button>
    );
}

/** Primary form action with a pending state. */
export function SubmitButton({
    label,
    processing = false,
    disabled = false,
    testId,
}: {
    label: string;
    processing?: boolean;
    disabled?: boolean;
    testId: string;
}) {
    return (
        <Button
            type="submit"
            disabled={processing || disabled}
            data-testid={testId}
        >
            {processing && <Spinner />}
            {label}
            {!processing && <ArrowRight className="rtl:rotate-180" />}
        </Button>
    );
}
