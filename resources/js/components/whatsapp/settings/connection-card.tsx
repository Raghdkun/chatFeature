import { CircleCheck, PlugZap, Save } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import PasswordInput from '@/components/password-input';
import { describedBy, Field } from '@/components/setup/field';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Busy, Notice } from '@/components/widgets/form-bits';
import { useTrans } from '@/hooks/use-trans';
import { useWaApi } from '@/lib/realtime/whatsapp/context';
import { describeWaError } from '@/lib/whatsapp-api/client';
import {
    WA_LIMITS,
    type ConnectionTestResult,
    type WaSettings,
} from '@/lib/whatsapp-api/types';
import { isApiError } from '@/lib/api-client';
import { isPrivateAddress } from '@/lib/whatsapp/address';

const REASONS = [
    'not_configured',
    'blocked',
    'unreachable',
    'unauthorized',
    'rejected',
    'unexpected_response',
] as const;

type TestState =
    | { status: 'idle' }
    | { status: 'running' }
    | { status: 'done'; result: ConnectionTestResult }
    | { status: 'error'; error: unknown };

/**
 * The connection to OpenWA: its address and the API key. The key is write-only: the input starts empty, a saved key is only indicated,
 * and a blank input keeps it. A new address needs the key again (the server never reuses a stored key for a new destination, and says so
 * early here). "Test connection" asks OpenWA with what is SAVED, so it is offered once the form is clean.
 */
export function ConnectionCard({
    settings,
    privateHostsAllowed,
    onSaved,
}: {
    settings: WaSettings;
    privateHostsAllowed: boolean;
    onSaved: (next: WaSettings) => void;
}) {
    const { t, locale } = useTrans();
    const api = useWaApi();
    const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
    const [apiKey, setApiKey] = useState('');
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [problem, setProblem] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [test, setTest] = useState<TestState>({ status: 'idle' });
    const addressChanged = baseUrl.trim() !== settings.baseUrl;
    const dirty = addressChanged || apiKey.trim() !== '';
    const needsKey =
        addressChanged && settings.hasApiKey && apiKey.trim() === '';
    const privateAddress = isPrivateAddress(baseUrl);
    const blocked = privateAddress && !privateHostsAllowed;

    const change = (field: 'base_url' | 'api_key', next: () => void): void => {
        next();
        setTest({ status: 'idle' });
        setProblem(null);
        setErrors((held) => {
            const copy = { ...held };

            delete copy[field];

            return copy;
        });
    };

    const save = async (
        extra: { clearApiKey?: boolean } = {},
    ): Promise<void> => {
        if (saving || (!dirty && !extra.clearApiKey)) {
            return;
        }

        const found: Record<string, string> = {};
        const url = baseUrl.trim();

        if (url === '' || !/^https?:\/\//i.test(url)) {
            found.base_url = t('whatsapp.connection.error.base_url');
        }

        if (apiKey.length > WA_LIMITS.apiKeyMax) {
            found.api_key = t('whatsapp.connection.error.api_key_long');
        }

        if (needsKey && !extra.clearApiKey) {
            found.api_key = t('whatsapp.connection.error.key_again');
        }

        setErrors(found);

        if (Object.keys(found).length > 0) {
            return;
        }

        setSaving(true);
        setProblem(null);

        try {
            const next = await api.saveSettings({
                ...(addressChanged ? { baseUrl: url } : {}),
                ...(apiKey.trim() !== '' ? { apiKey } : {}),
                ...(extra.clearApiKey ? { clearApiKey: true } : {}),
            });

            onSaved(next);
            setBaseUrl(next.baseUrl);
            setApiKey('');
            setTest({ status: 'idle' });
            toast.success(t('whatsapp.connection.saved'));
        } catch (error) {
            if (isApiError(error) && error.isValidation) {
                const mapped: Record<string, string> = {};

                for (const field of ['base_url', 'api_key'] as const) {
                    const message = error.firstMessage(field);

                    if (message) {
                        mapped[field] = message;
                    }
                }

                setErrors(mapped);

                if (Object.keys(mapped).length === 0) {
                    setProblem(describeWaError(error, t, locale));
                }
            } else {
                setProblem(describeWaError(error, t, locale));
            }
        } finally {
            setSaving(false);
        }
    };

    const runTest = async (): Promise<void> => {
        if (test.status === 'running' || dirty || saving) {
            return;
        }

        setTest({ status: 'running' });

        try {
            setTest({ status: 'done', result: await api.testConnection() });
        } catch (error) {
            setTest({ status: 'error', error });
        }
    };

    return (
        <Card
            role="region"
            aria-labelledby="wa-connection-title"
            data-testid="wa-connection-card"
        >
            <CardHeader>
                <CardTitle
                    id="wa-connection-title"
                    role="heading"
                    aria-level={2}
                >
                    {t('whatsapp.connection.title')}
                </CardTitle>
                <CardDescription>
                    {t('whatsapp.connection.description')}
                </CardDescription>
            </CardHeader>

            <form
                onSubmit={(event: FormEvent<HTMLFormElement>) => {
                    event.preventDefault();
                    void save();
                }}
                noValidate
                data-testid="wa-connection-form"
                className="grid gap-6"
            >
                <CardContent className="grid gap-5">
                    {problem && (
                        <Notice
                            tone="danger"
                            data-testid="wa-connection-problem"
                        >
                            {problem}
                        </Notice>
                    )}

                    <Field
                        id="wa-base-url"
                        label={t('whatsapp.connection.base_url')}
                        hint={t('whatsapp.connection.base_url_hint')}
                        error={errors.base_url}
                    >
                        <Input
                            id="wa-base-url"
                            data-testid="wa-base-url"
                            dir="ltr"
                            type="url"
                            inputMode="url"
                            autoCapitalize="none"
                            autoComplete="off"
                            spellCheck={false}
                            placeholder="http://openwa:2785"
                            value={baseUrl}
                            disabled={saving}
                            aria-invalid={errors.base_url ? true : undefined}
                            aria-describedby={describedBy('wa-base-url', {
                                hint: true,
                                error: errors.base_url,
                            })}
                            onChange={(event) =>
                                change('base_url', () =>
                                    setBaseUrl(event.target.value),
                                )
                            }
                        />
                    </Field>

                    {blocked && (
                        <Notice
                            tone="warning"
                            data-testid="wa-private-host-notice"
                        >
                            {t('whatsapp.connection.private_host')}
                        </Notice>
                    )}

                    <Field
                        id="wa-api-key"
                        label={
                            needsKey
                                ? `${t('whatsapp.connection.api_key')} ${t('whatsapp.connection.required_marker')}`
                                : t('whatsapp.connection.api_key')
                        }
                        hint={
                            settings.hasApiKey ? (
                                <>
                                    <span
                                        className="inline-flex items-center gap-1 font-medium text-foreground"
                                        data-testid="wa-api-key-saved"
                                    >
                                        <CircleCheck
                                            className="size-3.5 text-primary"
                                            aria-hidden
                                        />
                                        {t('whatsapp.connection.key_saved')}
                                    </span>{' '}
                                    <span
                                        data-testid="wa-api-key-hint"
                                        className={
                                            needsKey
                                                ? 'font-medium text-foreground'
                                                : undefined
                                        }
                                    >
                                        {needsKey
                                            ? t('whatsapp.connection.key_again')
                                            : t('whatsapp.connection.key_keep')}
                                    </span>
                                </>
                            ) : (
                                t('whatsapp.connection.key_hint')
                            )
                        }
                        error={errors.api_key}
                    >
                        <PasswordInput
                            id="wa-api-key"
                            data-testid="wa-api-key"
                            autoCapitalize="none"
                            autoComplete="off"
                            spellCheck={false}
                            maxLength={WA_LIMITS.apiKeyMax}
                            placeholder={
                                settings.hasApiKey ? '••••••••' : undefined
                            }
                            value={apiKey}
                            disabled={saving}
                            aria-required={needsKey ? true : undefined}
                            aria-invalid={errors.api_key ? true : undefined}
                            aria-describedby={describedBy('wa-api-key', {
                                hint: true,
                                error: errors.api_key,
                            })}
                            onChange={(event) =>
                                change('api_key', () =>
                                    setApiKey(event.target.value),
                                )
                            }
                        />
                    </Field>
                </CardContent>

                <CardFooter className="flex-col items-stretch gap-4">
                    <div className="flex flex-wrap items-center gap-3">
                        <Button
                            type="submit"
                            disabled={!dirty || saving}
                            data-testid="wa-connection-save"
                        >
                            {saving ? <Busy /> : <Save aria-hidden />}
                            {t('whatsapp.connection.save')}
                        </Button>
                        <Button
                            type="button"
                            variant="outline"
                            disabled={
                                dirty || saving || test.status === 'running'
                            }
                            data-testid="wa-connection-test"
                            onClick={() => void runTest()}
                        >
                            {test.status === 'running' ? (
                                <Busy />
                            ) : (
                                <PlugZap aria-hidden />
                            )}
                            {test.status === 'running'
                                ? t('whatsapp.connection.testing')
                                : t('whatsapp.connection.test')}
                        </Button>
                        {settings.hasApiKey && (
                            <Button
                                type="button"
                                variant="ghost"
                                disabled={saving}
                                data-testid="wa-connection-clear-key"
                                onClick={() => void save({ clearApiKey: true })}
                            >
                                {t('whatsapp.connection.clear_key')}
                            </Button>
                        )}
                    </div>

                    {dirty && settings.hasApiKey && (
                        <p
                            className="text-sm text-muted-foreground"
                            data-testid="wa-connection-dirty-hint"
                        >
                            {t('whatsapp.connection.dirty_hint')}
                        </p>
                    )}

                    <TestResult state={test} />
                </CardFooter>
            </form>
        </Card>
    );
}

function TestResult({ state }: { state: TestState }) {
    const { t, locale } = useTrans();

    if (state.status === 'idle' || state.status === 'running') {
        return null;
    }

    if (state.status === 'error') {
        return (
            <Notice
                tone="danger"
                data-testid="wa-test-result"
                data-status="error"
            >
                {describeWaError(state.error, t, locale)}
            </Notice>
        );
    }

    const { result } = state;

    if (result.ok) {
        return (
            <div
                className="grid gap-2"
                data-testid="wa-test-result"
                data-status="ok"
            >
                <Notice tone="success">
                    {t('whatsapp.connection.test_ok', {
                        role: result.role ?? t('whatsapp.connection.unknown'),
                        engine:
                            result.engine ?? t('whatsapp.connection.unknown'),
                    })}
                </Notice>
                {result.canOperate === false && (
                    <Notice tone="warning" data-testid="wa-test-cannot-operate">
                        {t('whatsapp.connection.cannot_operate')}
                    </Notice>
                )}
            </div>
        );
    }

    const known = (REASONS as readonly string[]).includes(result.reason);

    return (
        <Notice
            tone="danger"
            data-testid="wa-test-result"
            data-status="failed"
            data-reason={result.reason}
        >
            <p className="font-medium">
                {known
                    ? t(`whatsapp.connection.reason.${result.reason}.title`)
                    : t('whatsapp.connection.reason.other.title')}
            </p>
            {result.message !== '' && (
                <p className="mt-0.5 [overflow-wrap:anywhere]">
                    {result.message}
                </p>
            )}
            <p className="mt-1 text-xs opacity-90">
                {known
                    ? t(`whatsapp.connection.reason.${result.reason}.hint`)
                    : t('whatsapp.connection.reason.other.hint')}
            </p>
        </Notice>
    );
}
