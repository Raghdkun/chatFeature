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
namespace Agents {
export type AgentListItemData = {
id: number,
name: string,
email: string,
avatar: string | null,
is_admin: boolean,
is_agent: boolean,
is_active: boolean,
auth_source: string,
category_ulids: string[],
max_concurrent_chats: number,
last_seen_at: string | null,
};
}
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
namespace Catalog {
export type CategoryData = {
ulid: string,
slug: string,
name: string,
name_i18n: Record<string, string>,
description: string | null,
icon: string | null,
color: string | null,
sort_order: number,
is_active: boolean,
agents_count: number,
widgets_count: number,
};
}
namespace Chat {
export type AgentRefData = {
name: string,
avatarUrl: string | null,
};
export type AttachmentData = {
ulid: string,
mime: string,
size: number,
width: number | null,
height: number | null,
url: string,
thumbUrl: string | null,
};
export type CategoryRefData = {
slug: string,
label: string,
};
export type ConversationPublicData = {
ulid: string,
ticketNo: string,
status: App.Domain.Chat.Enums.ConversationStatus,
type: App.Domain.Chat.Enums.ConversationType,
category: App.Data.Chat.CategoryRefData | null,
agent: App.Data.Chat.AgentRefData | null,
createdAt: string,
endedAt: string | null,
ratingRequested: boolean,
lastSeq: number,
};
export type ConversationStaffData = {
ulid: string,
ticketNo: string,
status: App.Domain.Chat.Enums.ConversationStatus,
type: App.Domain.Chat.Enums.ConversationType,
category: App.Data.Chat.CategoryRefData | null,
agent: App.Data.Chat.AgentRefData | null,
createdAt: string,
endedAt: string | null,
ratingRequested: boolean,
lastSeq: number,
visitor: App.Data.Chat.VisitorSummaryData,
widget: App.Data.Chat.WidgetRefData,
assignedAgent: App.Data.Chat.StaffAgentRefData | null,
unseenByAgent: number,
claimedAt: string | null,
lastMessageAt: string | null,
lastMessagePreview: string | null,
queueExpiresAt: string | null,
pageUrl: string | null,
pageTitle: string | null,
};
export type MessageData = {
ulid: string,
seq: number,
conversation: string,
sender: App.Data.Chat.MessageSenderData,
type: App.Domain.Chat.Enums.MessageType,
body: string | null,
attachments: App.Data.Chat.AttachmentData[],
clientMsgId: string | null,
createdAt: string,
deliveredAt: string | null,
seenAt: string | null,
};
export type MessageSenderData = {
type: App.Domain.Chat.Enums.SenderType,
name: string | null,
avatarUrl: string | null,
id?: number,
};
export type OfferData = {
v: number,
conversation: string,
category: App.Data.Chat.CategoryRefData | null,
visitor: App.Data.Chat.OfferVisitorData,
preview: string | null,
widget: App.Data.Chat.WidgetRefData,
wave: number,
expiresAt: string,
ttlSeconds: number,
};
export type OfferVisitorData = {
name: string | null,
verified: boolean,
};
export type PresenceData = {
userId: number,
status: App.Domain.Chat.Enums.PresenceStatus,
isManual: boolean,
lastSeenAt: string | null,
};
export type PresenceMemberData = {
id: number,
name: string,
avatarUrl: string | null,
status: App.Domain.Chat.Enums.PresenceStatus,
};
export type RatingData = {
conversation: string,
score: number,
comment: string | null,
createdAt: string,
};
export type RealtimeEndpointData = {
key: string,
host: string,
port: number,
scheme: string,
};
export type SessionData = {
visitorToken: string,
expiresAt: string,
conversation: App.Data.Chat.ConversationPublicData | null,
ws: App.Data.Chat.RealtimeEndpointData | null,
limits: App.Data.Chat.SessionLimitsData,
};
export type SessionLimitsData = {
maxMessageLength: number,
attachmentMaxBytes: number,
attachmentMaxDimension: number,
attachmentMaxPerMessage: number,
};
export type StaffAgentRefData = {
id: number,
name: string,
};
export type TransferAgentData = {
id: number,
name: string,
avatarUrl: string | null,
status: App.Domain.Chat.Enums.PresenceStatus,
activeChats: number,
maxConcurrentChats: number,
reachable: boolean,
};
export type TransferTargetsData = {
agents: App.Data.Chat.TransferAgentData[],
categories: App.Data.Chat.CategoryRefData[],
};
export type VisitorSummaryData = {
ulid: string,
name: string | null,
email: string | null,
phone: string | null,
verified: boolean,
meta: Record<string, number | string | boolean | null>,
};
export type WidgetRefData = {
ulid: string,
name: string,
};
namespace Events {
export type ChatAssignedPayload = {
v: number,
conversation: string,
};
export type ChatClaimedPayload = {
v: number,
agent: App.Data.Chat.AgentRefData,
claimedAt: string,
};
export type ChatTakenPayload = {
v: number,
conversation: string,
by: App.Data.Chat.StaffAgentRefData,
};
export type ConversationClosedPayload = {
v: number,
reason: App.Domain.Chat.Enums.ConversationCloseReason,
};
export type ConversationEndedPayload = {
v: number,
endedBy: App.Domain.Chat.Enums.ConversationEndedBy,
ratingRequested: boolean,
};
export type ConversationMissedPayload = {
v: number,
};
export type ConversationRatedPayload = {
v: number,
conversation: string,
score: number,
};
export type ConversationTransferredPayload = {
v: number,
};
export type ConversationUpdatedPayload = {
v: number,
conversation: App.Data.Chat.ConversationStaffData,
};
export type MessageCreatedPayload = {
v: number,
message: App.Data.Chat.MessageData,
};
export type MessageSeenPayload = {
v: number,
upToSeq: number,
by: App.Domain.Chat.Enums.SenderType,
at: string,
};
export type OfflineTicketCreatedPayload = {
v: number,
conversation: App.Data.Chat.ConversationStaffData,
};
export type PresenceChangedPayload = {
v: number,
userId: number,
status: App.Domain.Chat.Enums.PresenceStatus,
};
export type QueueUpdatedPayload = {
v: number,
queued: number,
};
export type SessionRevokedPayload = {
v: number,
reason: App.Domain.Chat.Enums.SessionRevokeReason,
};
export type UnreadUpdatedPayload = {
v: number,
conversation: string,
unseen: number,
};
}
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
namespace Widgets {
export type GreetingData = {
ulid: string,
body: string,
agent_name: string | null,
agent_avatar_url: string | null,
locale: string | null,
weight: number,
is_active: boolean,
sort_order: number,
};
export type IdentityExampleData = {
php: string,
node: string,
python: string,
};
export type WidgetBuilderData = {
widget: App.Data.Widgets.WidgetData,
config: App.Domain.Widgets.Data.WidgetConfigData,
draft_config: App.Domain.Widgets.Data.WidgetConfigData,
greetings: App.Data.Widgets.GreetingData[],
domains: string[],
category_ulids: string[],
all_categories: App.Data.Catalog.CategoryData[],
snippets: App.Data.Widgets.WidgetSnippetsData,
preview: App.Data.Widgets.WidgetPreviewData,
};
export type WidgetData = {
ulid: string,
name: string,
public_key: string,
is_enabled: boolean,
locale: string,
idle_timeout_minutes: number,
queue_timeout_seconds: number,
offline_mode: App.Domain.Widgets.Enums.OfflineMode,
timezone: string,
allow_non_browser_clients: boolean,
config_version: number,
has_identity_secret: boolean,
has_unpublished_changes: boolean,
whatsapp_connected: boolean,
created_at: string,
updated_at: string,
};
export type WidgetListItemData = {
ulid: string,
name: string,
public_key: string,
is_enabled: boolean,
config_version: number,
has_unpublished_changes: boolean,
whatsapp_connected: boolean,
updated_at: string,
domains_count: number,
categories_count: number,
};
export type WidgetPreviewData = {
embed_url: string,
app_origin: string,
};
export type WidgetSnippetsData = {
script: string,
iframe: string,
hosted: string,
identity_example: App.Data.Widgets.IdentityExampleData,
};
}
}
namespace Domain {
namespace Chat {
namespace Enums {
export type ActorType = 'visitor' | 'agent' | 'admin' | 'system';
export type ConversationCloseReason = 'rated' | 'skipped' | 'idle' | 'timeout' | 'system' | 'cancelled';
export type ConversationEndedBy = 'visitor' | 'agent' | 'admin' | 'system';
export type ConversationStatus = 'queued' | 'active' | 'ended' | 'closed' | 'missed';
export type ConversationType = 'live' | 'offline';
export type MessageType = 'text' | 'image' | 'system';
export type OfferResponse = 'accepted' | 'taken' | 'expired' | 'dismissed';
export type PresenceStatus = 'online' | 'away' | 'offline';
export type SenderType = 'visitor' | 'agent' | 'system';
export type SessionRevokeReason = 'role_removed' | 'deactivated' | 'auth_revoked';
}
namespace Realtime {
export type RealtimeEvent = 'chat.offered' | 'chat.taken' | 'chat.assigned' | 'chat.claimed' | 'conversation.updated' | 'unread.updated' | 'queue.updated' | 'session.revoked' | 'presence.changed' | 'message.created' | 'message.seen' | 'conversation.ended' | 'conversation.closed' | 'conversation.missed' | 'conversation.transferred' | 'offline-ticket.created' | 'conversation.rated' | 'typing';
}
}
namespace Settings {
export type SettingGroup = 'app' | 'auth' | 'chat' | 'notifications' | 'storage' | 'whatsapp';
export type SettingType = 'string' | 'bool' | 'int' | 'json';
}
namespace Widgets {
namespace Data {
export type AvailabilityData = {
online: boolean,
openNow: boolean,
nextOpenAt: string | null,
categories: App.Domain.Widgets.Data.CategoryAvailabilityData[],
whatsapp: App.Domain.Widgets.Data.WhatsappAvailabilityData,
};
export type BootApiData = {
base: string,
embed: string,
appOrigin: string,
};
export type BootCategoryData = {
slug: string,
label: string,
description: string | null,
icon: string | null,
color: string | null,
};
export type BootGreetingData = {
id: string,
body: string,
agentName: string | null,
agentAvatarUrl: string | null,
locale: string | null,
weight: number,
};
export type CategoryAvailabilityData = {
slug: string,
online: boolean,
};
export type FeaturesConfigData = {
attachments: boolean,
rating: boolean,
sounds: boolean,
preChat: boolean,
whatsapp: boolean,
offlineForm: boolean,
titleBadge: boolean,
endChatByVisitor: boolean,
poweredBy: boolean,
};
export type GreetingsConfigData = {
enabled: boolean,
onPageLoad: boolean,
delaySeconds: number,
intervalMinutes: number,
autoHideSeconds: number,
dismissPolicy: App.Domain.Widgets.Enums.DismissPolicy,
showAgent: boolean,
};
export type HolidayData = {
date: string,
label: string,
};
export type HoursConfigData = {
mode: App.Domain.Widgets.Enums.OfflineMode,
timezone: string,
schedule: App.Domain.Widgets.Data.ScheduleRangeData[],
holidays: App.Domain.Widgets.Data.HolidayData[],
};
export type LauncherConfigData = {
style: App.Domain.Widgets.Enums.LauncherStyle,
icon: App.Domain.Widgets.Enums.LauncherIcon,
iconUrl: string | null,
label: string,
avatarUrl: string | null,
};
export type PreChatConfigData = {
fields: App.Domain.Widgets.Data.PreChatFieldsData,
consentText: string | null,
};
export type PreChatFieldData = {
enabled: boolean,
required: boolean,
};
export type PreChatFieldsData = {
name: App.Domain.Widgets.Data.PreChatFieldData,
email: App.Domain.Widgets.Data.PreChatFieldData,
phone: App.Domain.Widgets.Data.PreChatFieldData,
};
export type PublicWidgetConfigData = {
v: number,
defaultLocale: string,
localeDetect: boolean,
theme: App.Domain.Widgets.Data.ThemeConfigData,
launcher: App.Domain.Widgets.Data.LauncherConfigData,
texts: Record<string, Record<string, string>>,
features: App.Domain.Widgets.Data.FeaturesConfigData,
preChat: App.Domain.Widgets.Data.PreChatConfigData,
greetings: App.Domain.Widgets.Data.GreetingsConfigData,
hours: App.Domain.Widgets.Data.HoursConfigData,
};
export type ResolvedBootConfigData = {
v: number,
key: string,
configVersion: number,
generatedAt: string,
locale: string,
api: App.Domain.Widgets.Data.BootApiData,
config: App.Domain.Widgets.Data.PublicWidgetConfigData,
greetings: App.Domain.Widgets.Data.BootGreetingData[],
categories: App.Domain.Widgets.Data.BootCategoryData[],
availability: App.Domain.Widgets.Data.AvailabilityData,
};
export type RoutingConfigData = {
waves: App.Domain.Widgets.Data.RoutingWaveData[],
wakeOfflineViaPush: boolean,
queueTimeoutSeconds: number,
};
export type RoutingWaveData = {
afterSeconds: number,
statuses: App.Domain.Widgets.Enums.RoutingStatus[],
};
export type ScheduleRangeData = {
day: number,
start: string,
end: string,
};
export type SessionConfigData = {
idleTimeoutMinutes: number,
};
export type ThemeConfigData = {
mode: App.Domain.Widgets.Enums.ThemeMode,
primary: string,
primaryText: string,
accent: string,
surface: string,
text: string,
fontFamily: string,
fontUrl: string | null,
radius: number,
shadow: App.Domain.Widgets.Enums.ShadowLevel,
launcherSize: App.Domain.Widgets.Enums.LauncherSize,
panelWidth: number,
panelHeight: number,
position: App.Domain.Widgets.Enums.PanelPosition,
offsetX: number,
offsetY: number,
zIndex: number,
};
export type WhatsappAvailabilityData = {
enabled: boolean,
};
export type WidgetConfigData = {
v: number,
defaultLocale: string,
localeDetect: boolean,
theme: App.Domain.Widgets.Data.ThemeConfigData,
launcher: App.Domain.Widgets.Data.LauncherConfigData,
texts: Record<string, Record<string, string>>,
features: App.Domain.Widgets.Data.FeaturesConfigData,
preChat: App.Domain.Widgets.Data.PreChatConfigData,
greetings: App.Domain.Widgets.Data.GreetingsConfigData,
hours: App.Domain.Widgets.Data.HoursConfigData,
routing: App.Domain.Widgets.Data.RoutingConfigData,
session: App.Domain.Widgets.Data.SessionConfigData,
};
}
namespace Enums {
export type DismissPolicy = 'session' | 'interval' | 'never';
export type LauncherIcon = 'chat' | 'help' | 'sparkle' | 'custom';
export type LauncherSize = 'sm' | 'md' | 'lg';
export type LauncherStyle = 'bubble' | 'pill';
export type OfflineMode = 'auto_hours' | 'always_online' | 'always_offline';
export type PanelPosition = 'bottom-right' | 'bottom-left';
export type RoutingStatus = 'online' | 'away' | 'offline';
export type ShadowLevel = 'none' | 'soft' | 'strong';
export type ThemeMode = 'auto' | 'light' | 'dark';
}
namespace Identity {
export type IdentityFailure = 'no_secret' | 'malformed' | 'unsupported_algorithm' | 'bad_signature' | 'wrong_issuer' | 'missing_expiry' | 'expired' | 'expiry_too_far' | 'not_yet_valid' | 'invalid_claims' | 'replayed';
}
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
