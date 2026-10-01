import { TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useTrans } from '@/hooks/use-trans';
import { problemCheckKey } from '@/lib/pizzasys-checks';
import type { EnvProblem } from '@/lib/pizzasys-form';

/**
 * What the server refused for an environment that no input shows: the connection test it now runs
 * before saving the active environment (failing checks come back as 422 errors) and any other
 * message it attaches to the form as a whole. A failed check is named and followed by its fix hint;
 * anything else is shown as the server's text.
 */
export function EnvironmentProblems({
    problems,
    testId,
}: {
    problems: EnvProblem[];
    testId: string;
}) {
    const { t, has } = useTrans();

    if (problems.length === 0) {
        return null;
    }

    const checks = problems.filter((problem) => problemCheckKey(problem.key));

    return (
        <Alert variant="destructive" data-testid={testId}>
            <TriangleAlert />
            <AlertTitle>{t('settings.auth.env.problems_title')}</AlertTitle>
            <AlertDescription>
                {checks.length > 0 && (
                    <p>{t('settings.auth.env.problems_checks')}</p>
                )}
                <ul className="grid gap-1.5">
                    {problems.map((problem) => {
                        const check = problemCheckKey(problem.key);
                        const hintKey = check
                            ? `setup.pizzasys.hint.${check}`
                            : null;

                        return (
                            <li
                                key={problem.key}
                                data-testid={`${testId}-${check ?? 'other'}`}
                                className="[overflow-wrap:anywhere]"
                            >
                                {check && (
                                    <span className="font-medium">
                                        {t(`setup.pizzasys.check.${check}`)}
                                        :{' '}
                                    </span>
                                )}
                                {problem.message}
                                {hintKey && has(hintKey) && (
                                    <span className="mt-0.5 block opacity-90">
                                        {t(hintKey)}
                                    </span>
                                )}
                            </li>
                        );
                    })}
                </ul>
            </AlertDescription>
        </Alert>
    );
}
