declare namespace App {
namespace Auth {
namespace Enums {
export type AuthMode = 'fortify' | 'pizzasys';
export type AuthOutcome = 'ok' | 'invalid' | 'unavailable' | 'no_chat_access';
export type SessionVerdict = 'fresh' | 'revalidated' | 'revoked' | 'degraded';
export type UserRole = 'admin' | 'agent';
}
}
namespace Data {
namespace Auth {
export type AuthCapabilitiesData = {
canRegister: boolean,
canResetPassword: boolean,
canManage2fa: boolean,
profileEditable: boolean,
portalUrl: string | null,
};
export type AuthUserData = {
id: number,
name: string,
email: string,
avatar: string | null,
is_admin: boolean,
is_agent: boolean,
auth_source: string,
};
}
namespace Setup {
export type SetupAdminData = {
name: string,
email: string,
};
export type SetupCheckData = {
key: string,
label: string,
ok: boolean,
message?: undefined | string,
};
export type SetupData = {
step: App.Data.Setup.SetupStepKey,
steps: App.Data.Setup.SetupStepData[],
needsToken: boolean,
tokenVerified: boolean,
mode: App.Auth.Enums.AuthMode | null,
pizzasysAvailable: boolean,
environment: App.Data.Setup.SetupEnvironmentData,
defaults: App.Data.Setup.SetupDefaultsData,
admin: App.Data.Setup.SetupAdminData | null,
run: App.Data.Setup.SetupRunStepData[],
};
export type SetupDefaultsData = {
app_name: string,
app_url: string,
locale: string,
timezone: string,
idle_timeout_minutes: number,
};
export type SetupEnvironmentData = {
ok: boolean,
checks: App.Data.Setup.SetupCheckData[],
};
export type SetupRunStatus = 'pending' | 'running' | 'done' | 'failed';
export type SetupRunStepData = {
key: string,
label: string,
status: App.Data.Setup.SetupRunStatus,
message?: undefined | string,
};
export type SetupStepData = {
key: App.Data.Setup.SetupStepKey,
label: string,
status: App.Data.Setup.SetupStepStatus,
};
export type SetupStepKey = 'welcome' | 'mode' | 'admin' | 'basics' | 'run' | 'done';
export type SetupStepStatus = 'pending' | 'current' | 'done';
}
namespace Shared {
export type FlashData = {
success?: undefined | string,
error?: undefined | string,
};
export type SharedAuthData = {
user: App.Data.Auth.AuthUserData | null,
mode: App.Auth.Enums.AuthMode,
capabilities: App.Data.Auth.AuthCapabilitiesData,
};
export type SharedPropsData = {
name: string,
auth: App.Data.Shared.SharedAuthData,
locale: string,
direction: App.Data.Shared.TextDirection,
installed: boolean,
sidebarOpen: boolean,
flash: App.Data.Shared.FlashData,
};
export type TextDirection = 'ltr' | 'rtl';
}
}
namespace Domain {
namespace Settings {
export type SettingGroup = 'app' | 'auth' | 'chat' | 'notifications' | 'storage' | 'whatsapp';
export type SettingType = 'string' | 'bool' | 'int' | 'json';
}
}
}
