import { router } from '@inertiajs/react';
import { useEffect } from 'react';

/**
 * While `dirty`, closing the tab asks for confirmation and so does any Inertia visit away from
 * the page. (Saving clears `dirty`, which removes both listeners.)
 */
export function useUnsavedChangesGuard(dirty: boolean, message: string): void {
    useEffect(() => {
        if (!dirty) {
            return;
        }

        const onBeforeUnload = (event: BeforeUnloadEvent) => {
            event.preventDefault();
            // Required by some browsers to show the native prompt.
            event.returnValue = '';
        };

        window.addEventListener('beforeunload', onBeforeUnload);

        const removeVisitGuard = router.on('before', (event) => {
            if (!window.confirm(message)) {
                event.preventDefault();
            }
        });

        return () => {
            window.removeEventListener('beforeunload', onBeforeUnload);
            removeVisitGuard();
        };
    }, [dirty, message]);
}
