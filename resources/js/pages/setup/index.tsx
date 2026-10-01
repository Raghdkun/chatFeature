import { Head, router } from '@inertiajs/react';
import { useEffect, useRef, useState } from 'react';
import { SetupStepper } from '@/components/setup/setup-stepper';
import { StepAdmin } from '@/components/setup/step-admin';
import { StepBasics } from '@/components/setup/step-basics';
import { StepDone } from '@/components/setup/step-done';
import { StepMode } from '@/components/setup/step-mode';
import { StepRun } from '@/components/setup/step-run';
import { StepWelcome } from '@/components/setup/step-welcome';
import { useTrans } from '@/hooks/use-trans';
import {
    nextStep,
    previousStep,
    resolveView,
    type ViewOverride,
} from '@/lib/setup-flow';
import { LOGIN_URL } from '@/lib/setup-routes';
import type { SetupProps, SetupStepKey } from '@/types/setup';

/**
 * The whole install wizard (docs/contracts/setup-wizard.md). The server decides the step
 * (`setup.step`); the client may look back at an earlier step, and finishes on its own
 * once the run steps succeed (after the lock is written `/setup` is gone, so "done" is
 * rendered from client state).
 */
export default function Setup({ setup }: SetupProps) {
    const { t } = useTrans();
    const [override, setOverride] = useState<ViewOverride | null>(null);
    const [completion, setCompletion] = useState<{ redirect: string } | null>(
        null,
    );

    const serverView = resolveView(setup.step, override);
    const view: SetupStepKey = completion ? 'done' : serverView;

    const goTo = (target: SetupStepKey | null) => {
        if (target) {
            setOverride({ from: setup.step, view: target });
        }
    };
    const goBack = () => goTo(previousStep(view, setup.mode));

    // A successful form post/reload hands control back to the server's step. Validation
    // errors do not fire `success`, so the user stays on the step they are fixing.
    useEffect(() => router.on('success', () => setOverride(null)), []);

    // Move keyboard/screen-reader focus to the new step's heading after a transition
    // (not on first paint, which would fight autofocus).
    const previousView = useRef(view);

    useEffect(() => {
        if (previousView.current !== view) {
            previousView.current = view;
            document.getElementById(`setup-${view}-title`)?.focus({
                preventScroll: true,
            });
        }
    }, [view]);

    return (
        <>
            <Head title={t('setup.brand.subtitle')} />

            <div className="grid md:grid-cols-[15rem_minmax(0,1fr)]">
                <SetupStepper steps={setup.steps} view={view} />

                <div
                    key={view}
                    className="flex min-h-[26rem] min-w-0 flex-col"
                    data-testid="setup-wizard"
                    data-view={view}
                >
                    {view === 'welcome' && (
                        <StepWelcome
                            setup={setup}
                            onContinue={() =>
                                goTo(nextStep('welcome', setup.mode))
                            }
                        />
                    )}
                    {view === 'mode' && (
                        <StepMode setup={setup} onBack={goBack} />
                    )}
                    {view === 'admin' && (
                        <StepAdmin setup={setup} onBack={goBack} />
                    )}
                    {view === 'basics' && (
                        <StepBasics setup={setup} onBack={goBack} />
                    )}
                    {view === 'run' && (
                        <StepRun
                            setup={setup}
                            onBack={goBack}
                            onCompleted={(redirect) =>
                                setCompletion({ redirect })
                            }
                        />
                    )}
                    {view === 'done' && (
                        <StepDone
                            redirect={completion?.redirect ?? LOGIN_URL}
                        />
                    )}
                </div>
            </div>
        </>
    );
}
