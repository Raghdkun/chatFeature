/**
 * The ONE place that knows the Settings > Auth URLs (docs/contracts/auth-pizzasys.md).
 * Thin adapter over the generated Wayfinder actions; call sites keep a stable shape.
 */
import AuthSettingsController from '@/actions/App/Http/Controllers/Settings/AuthSettingsController';
import type { PizzasysEnvKey } from '@/types/pizzasys';

export const authSettingsRoutes = {
    /** GET /settings/auth: Inertia `settings/auth` with `{ authSettings }`. */
    index: AuthSettingsController.edit.url(),
    /** PUT /settings/auth/environments/{key}: save one environment (redirects back). */
    environment: (key: PizzasysEnvKey): string =>
        AuthSettingsController.updateEnvironment.url({ key }),
    /** POST /settings/auth/environments/{key}/test: JSON `PortalTestResult` (tests the SAVED values). */
    environmentTest: (key: PizzasysEnvKey): string =>
        AuthSettingsController.testEnvironment.url({ key }),
    /** POST /settings/auth/active-environment: JSON `{ ok, redirect }` or 422 `{ ok:false, message }`. */
    activeEnvironment: AuthSettingsController.activateEnvironment.url(),
    /** PUT /settings/auth/roles: role mapping (redirects back). */
    roles: AuthSettingsController.updateRoles.url(),
} as const;
