declare namespace App {
namespace Auth {
namespace Enums {
export type AuthMode = 'fortify' | 'pizzasys';
export type AuthOutcome = 'ok' | 'invalid' | 'unavailable' | 'no_chat_access';
export type SessionVerdict = 'fresh' | 'revalidated' | 'revoked' | 'degraded' | 'unavailable';
export type UserRole = 'admin' | 'agent';
}
namespace Pizzasys {
namespace Results {
export type PortalStatus = 'ok' | 'inactive' | 'invalid' | 'service_rejected' | 'unavailable';
}
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
export type AuthHealthData = {
portal: App.Data.Auth.PortalHealthStatus,
circuit_open: boolean,
last_verify_at: string | null,
nats: App.Data.Auth.AuthNatsHealthData,
service_credential_rejected: boolean,
};
export type AuthNatsHealthData = {
enabled: boolean,
connected: boolean | null,
last_event_at: string | null,
};
export type AuthSettingsData = {
mode: App.Auth.Enums.AuthMode,
active_env: App.Data.Auth.EnvironmentKey,
environments: App.Data.Auth.PizzasysEnvironmentData[],
roles: App.Data.Auth.PizzasysRolesData,
health: App.Data.Auth.AuthHealthData,
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
export type EnvironmentKey = 'production' | 'testing';
export type PizzasysEnvironmentData = {
key: App.Data.Auth.EnvironmentKey,
label: string,
configured: boolean,
base_url: string | null,
service_name: string | null,
has_service_token: boolean,
nats_url: string | null,
has_nats_token: boolean,
verify_tls: boolean,
last_check_at: string | null,
last_check_status: App.Data.Auth.PortalCheckStatus | null,
last_check_message: string | null,
};
export type PizzasysEnvironmentsData = {
production: App.Data.Auth.PizzasysEnvironmentData,
testing: App.Data.Auth.PizzasysEnvironmentData,
};
export type PizzasysPortalAdminData = {
name: string,
email: string,
};
export type PizzasysRolesData = {
admin_permission: string,
agent_permission: string,
super_roles: string[],
};
export type PizzasysSetupData = {
environments: App.Data.Auth.PizzasysEnvironmentsData,
active_env: App.Data.Auth.EnvironmentKey,
roles: App.Data.Auth.PizzasysRolesData,
tested: App.Data.Auth.PizzasysTestedData,
portal_admin: App.Data.Auth.PizzasysPortalAdminData | null,
};
export type PizzasysTestedData = {
production: boolean,
testing: boolean,
};
export type PortalCheckData = {
key: App.Data.Auth.PortalCheckKey,
label: string,
ok: boolean,
message?: string,
};
export type PortalCheckKey = 'reachable' | 'service_credential' | 'latency' | 'nats';
export type PortalCheckStatus = 'ok' | 'failed';
export type PortalHealthStatus = 'ok' | 'degraded' | 'down' | 'unknown';
export type PortalTestResultData = {
ok: boolean,
checks: App.Data.Auth.PortalCheckData[],
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
message?: string,
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
pizzasys: App.Data.Auth.PizzasysSetupData | null,
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
message?: string,
};
export type SetupStepData = {
key: App.Data.Setup.SetupStepKey,
label: string,
status: App.Data.Setup.SetupStepStatus,
};
export type SetupStepKey = 'welcome' | 'mode' | 'admin' | 'pizzasys' | 'portal-admin' | 'basics' | 'run' | 'done';
export type SetupStepStatus = 'pending' | 'current' | 'done';
}
namespace Shared {
export type FlashData = {
success?: string,
error?: string,
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
namespace Infrastructure {
namespace Nats {
export type EventOutcome = 'flush_user' | 'flush_all' | 'deactivate_user' | 'noop' | 'unknown' | 'duplicate';
}
}
}
declare namespace Illuminate {
export type CursorPaginator<TKey, TValue> = {
data: TKey extends string ? Record<TKey, TValue> : TValue[],
links: {
url: string | null,
label: string,
active: boolean,
}[],
meta: {
path: string,
per_page: number,
next_cursor: string | null,
next_page_url: string | null,
prev_cursor: string | null,
prev_page_url: string | null,
},
};
export type CursorPaginatorInterface<TKey, TValue> = Illuminate.CursorPaginator<TKey, TValue>;
export type LengthAwarePaginator<TKey, TValue> = {
data: TKey extends string ? Record<TKey, TValue> : TValue[],
links: {
url: string | null,
label: string,
active: boolean,
}[],
meta: {
total: number,
current_page: number,
first_page_url: string,
from: number | null,
last_page: number,
last_page_url: string,
next_page_url: string | null,
path: string,
per_page: number,
prev_page_url: string | null,
to: number | null,
},
};
export type LengthAwarePaginatorInterface<TKey, TValue> = Illuminate.LengthAwarePaginator<TKey, TValue>;
}
declare namespace Spatie {
namespace LaravelData {
export type CursorPaginatedDataCollection<TKey, TValue> = Illuminate.CursorPaginator<TKey, TValue>;
export type PaginatedDataCollection<TKey, TValue> = Illuminate.LengthAwarePaginator<TKey, TValue>;
}
}
