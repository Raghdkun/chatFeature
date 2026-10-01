/**
 * Auth mode 2 (pizzasys) payload shapes: aliases of the PHP-generated `App.Data.Auth.*` types
 * (`composer types:generate`). Never carries a secret: only `has_*` flags tell whether one is stored.
 */
export type PizzasysEnvKey = App.Data.Auth.EnvironmentKey;
export type PizzasysEnvironmentData = App.Data.Auth.PizzasysEnvironmentData;
export type PortalCheckKey = App.Data.Auth.PortalCheckKey;
export type PortalCheck = App.Data.Auth.PortalCheckData;
export type PortalTestResult = App.Data.Auth.PortalTestResultData;
export type PizzasysRoles = App.Data.Auth.PizzasysRolesData;
/** `SetupData.pizzasys`: non-null only when the wizard mode is `pizzasys`. */
export type PizzasysSetupData = App.Data.Auth.PizzasysSetupData;
export type PortalHealthStatus = App.Data.Auth.PortalHealthStatus;
export type AuthSettingsData = App.Data.Auth.AuthSettingsData;

/** Why `POST /setup/portal-admin` said no. */
export type PortalAdminCode =
    | 'invalid'
    | 'unavailable'
    | 'no_chat_access'
    | 'not_admin';

export type SettingsAuthProps = {
    authSettings: AuthSettingsData;
};
