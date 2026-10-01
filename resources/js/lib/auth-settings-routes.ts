/**
 * The ONE place that knows the Settings > Auth URLs (docs/contracts/auth-pizzasys.md,
 * controller `Settings\AuthSettingsController`, routes/web/settings-auth.php).
 *
 * Plain strings on purpose: Wayfinder cannot generate these until track 2A merges. After that,
 * swap each entry for the generated `AuthSettingsController.<action>.url(...)`; call sites only
 * use this module, so it is a one-file change.
 */
import type { PizzasysEnvKey } from '@/types/pizzasys';

const BASE = '/settings/auth';

export const authSettingsRoutes = {
    /** GET /settings/auth: Inertia `settings/auth` with `{ authSettings }`. */
    index: BASE,
    /** PUT /settings/auth/environments/{key}: save one environment (redirects back). */
    environment: (key: PizzasysEnvKey): string => `${BASE}/environments/${key}`,
    /** POST /settings/auth/environments/{key}/test: JSON `PortalTestResult` (tests the SAVED values). */
    environmentTest: (key: PizzasysEnvKey): string =>
        `${BASE}/environments/${key}/test`,
    /** POST /settings/auth/active-environment: JSON `{ ok, redirect }` or 422 `{ ok:false, message }`. */
    activeEnvironment: `${BASE}/active-environment`,
    /** PUT /settings/auth/roles: role mapping (redirects back). */
    roles: `${BASE}/roles`,
} as const;
