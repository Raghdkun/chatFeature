/**
 * Auth-related shared types. The user shape is generated from PHP
 * (`App\Data\Auth\AuthUserData`); never hand-copy it here.
 * See docs/contracts/inertia-shared-props.md.
 */
export type AuthUser = App.Data.Auth.AuthUserData;

/** Alias kept for components that were written against the starter kit. */
export type User = AuthUser;

export type AuthMode = 'fortify' | 'pizzasys';

/** Mirrors `AuthDriver::capabilities()`: hide any UI the active driver cannot honour. */
export type AuthCapabilities = {
    canRegister: boolean;
    canResetPassword: boolean;
    canManage2fa: boolean;
    profileEditable: boolean;
    portalUrl: string | null;
};

export type Auth = {
    user: AuthUser | null;
    mode: AuthMode;
    capabilities: AuthCapabilities;
};

/** The `auth` prop on pages that sit behind the `auth` middleware. */
export type AuthenticatedAuth = Auth & { user: AuthUser };

export type Passkey = {
    id: number;
    name: string;
    authenticator: string | null;
    created_at_diff: string;
    last_used_at_diff: string | null;
};

export type TwoFactorSetupData = {
    svg: string;
    url: string;
};

export type TwoFactorSecretKey = {
    secretKey: string;
};
