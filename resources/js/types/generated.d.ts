declare namespace App {
namespace Auth {
namespace Enums {
export type AuthMode = 'fortify' | 'pizzasys';
export type AuthOutcome = 'ok' | 'invalid' | 'unavailable' | 'no_chat_access' | 'two_factor_required';
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
namespace Analytics {
export type AnalyticsBreakdownData = {
by: string,
range: App.Data.Analytics.AnalyticsRangeData,
rows: App.Data.Analytics.AnalyticsBreakdownRowData[],
meta: App.Data.Analytics.AnalyticsMetaData,
};
export type AnalyticsBreakdownRowData = {
key: string,
label: string,
deleted: boolean,
kpis: App.Data.Analytics.AnalyticsKpisData,
sparkline: number[],
};
export type AnalyticsDurationData = {
averageSeconds: number | null,
maxSeconds: number,
count: number,
};
export type AnalyticsFiltersData = {
from: string,
to: string,
widget: string | null,
category: string | null,
agent: number | null,
compare: boolean,
};
export type AnalyticsHeatmapData = {
timezone: string,
metric: string,
range: App.Data.Analytics.AnalyticsRangeData,
matrix: number[][],
max: number,
total: number,
meta: App.Data.Analytics.AnalyticsMetaData,
};
export type AnalyticsKpisData = {
started: number | null,
handled: number,
reclaimed: number,
transferred: number,
missed: number | null,
cancelled: number | null,
ended: number,
closed: number | null,
answerRate: number | null,
wait: App.Data.Analytics.AnalyticsDurationData,
firstResponse: App.Data.Analytics.AnalyticsDurationData,
handling: App.Data.Analytics.AnalyticsDurationData,
ratings: App.Data.Analytics.AnalyticsRatingsData,
messages: App.Data.Analytics.AnalyticsMessagesData,
peakConcurrent: number,
queuePeak: number | null,
resolution: App.Data.Analytics.AnalyticsResolutionData,
offline: App.Data.Analytics.AnalyticsOfflineData,
offers: App.Data.Analytics.AnalyticsOffersData,
};
export type AnalyticsMessagesData = {
visitor: number | null,
agent: number,
perChat: number | null,
};
export type AnalyticsMetaData = {
timezone: string,
today: string,
live: boolean,
rolledUpTo: string | null,
missingDays: number,
timezoneChanged: boolean,
generatedAt: string,
};
export type AnalyticsOffersData = {
received: number,
acceptRate: number | null,
};
export type AnalyticsOfflineData = {
created: number | null,
answered: number,
closed: number | null,
averageResponseSeconds: number | null,
};
export type AnalyticsOptionData = {
key: string,
label: string,
deleted: boolean,
};
export type AnalyticsOptionsData = {
widgets: App.Data.Analytics.AnalyticsOptionData[],
categories: App.Data.Analytics.AnalyticsOptionData[],
agents: App.Data.Analytics.AnalyticsOptionData[],
};
export type AnalyticsOverviewData = {
range: App.Data.Analytics.AnalyticsRangeData,
previousRange: App.Data.Analytics.AnalyticsRangeData | null,
scope: App.Data.Analytics.AnalyticsScopeData,
current: App.Data.Analytics.AnalyticsKpisData,
previous: App.Data.Analytics.AnalyticsKpisData | null,
meta: App.Data.Analytics.AnalyticsMetaData,
};
export type AnalyticsPageData = {
scope: App.Data.Analytics.AnalyticsPageScopeData,
timezone: string,
today: string,
filters: App.Data.Analytics.AnalyticsFiltersData,
options: App.Data.Analytics.AnalyticsOptionsData,
};
export type AnalyticsPageScopeData = {
role: string,
userId: number,
whatsapp: boolean,
};
export type AnalyticsPointData = {
date: string,
value: number | null,
days: number,
};
export type AnalyticsRangeData = {
from: string,
to: string,
days: number,
};
export type AnalyticsRatingEntryData = {
conversation: string,
score: number,
comment: string | null,
createdAt: string,
widget: string | null,
category: string | null,
agent: string | null,
};
export type AnalyticsRatingsData = {
count: number,
average: number | null,
distribution: number[],
};
export type AnalyticsRatingsReportData = {
range: App.Data.Analytics.AnalyticsRangeData,
ratings: App.Data.Analytics.AnalyticsRatingsData,
recent: App.Data.Analytics.AnalyticsRatingEntryData[],
meta: App.Data.Analytics.AnalyticsMetaData,
};
export type AnalyticsResolutionData = {
visitor: number,
agent: number,
system: number,
idle: number,
};
export type AnalyticsScopeData = {
role: string,
dimension: string,
key: string | null,
whatsapp: boolean,
};
export type AnalyticsSeriesData = {
metric: string,
unit: string,
points: App.Data.Analytics.AnalyticsPointData[],
};
export type AnalyticsTimeseriesData = {
range: App.Data.Analytics.AnalyticsRangeData,
interval: string,
series: App.Data.Analytics.AnalyticsSeriesData[],
meta: App.Data.Analytics.AnalyticsMetaData,
};
export type AnalyticsWhatsAppData = {
range: App.Data.Analytics.AnalyticsRangeData,
previousRange: App.Data.Analytics.AnalyticsRangeData | null,
interval: string,
current: App.Data.Analytics.AnalyticsWhatsAppTotalsData,
previous: App.Data.Analytics.AnalyticsWhatsAppTotalsData | null,
series: App.Data.Analytics.AnalyticsWhatsAppPointData[],
meta: App.Data.Analytics.AnalyticsMetaData,
};
export type AnalyticsWhatsAppPointData = {
date: string,
chats: number,
inbound: number,
outbound: number,
averageResponseSeconds: number | null,
};
export type AnalyticsWhatsAppTotalsData = {
chats: number,
linkedChats: number,
linkedShare: number | null,
inbound: number,
outbound: number,
averageResponseSeconds: number | null,
responseCount: number,
};
}
namespace Auth {
export type ApiTokenData = {
id: number,
name: string,
abilities: string[],
lastUsedAt: string | null,
createdAt: string,
expiresAt: string | null,
current: boolean,
};
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
export type StaffMeData = {
user: App.Data.Auth.AuthUserData,
mode: App.Auth.Enums.AuthMode,
capabilities: App.Data.Auth.AuthCapabilitiesData,
token: App.Data.Auth.ApiTokenData | null,
realtime: App.Data.Chat.RealtimeEndpointData | null,
serverTime: string,
};
export type StaffSignInData = {
token: string,
tokenType: string,
expiresAt: string | null,
user: App.Data.Auth.AuthUserData,
mode: App.Auth.Enums.AuthMode,
capabilities: App.Data.Auth.AuthCapabilitiesData,
realtime: App.Data.Chat.RealtimeEndpointData | null,
serverTime: string,
};
export type StaffTwoFactorChallengeData = {
twoFactor: boolean,
challenge: string,
expiresAt: string,
methods: string[],
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
export type MessageDeliveredPayload = {
v: number,
upToSeq: number,
by: App.Domain.Chat.Enums.SenderType,
at: string,
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
namespace Notifications {
export type DeviceTokenData = {
id: string,
platform: string,
lastSeenAt: string | null,
};
export type NotificationSettingsData = {
sound: boolean,
pushOffers: boolean,
pushMessages: boolean,
includePreview: boolean,
quietHours: App.Data.Notifications.QuietHoursData,
promptState: App.Domain.Notifications.Enums.PromptState,
promptedAt: string | null,
snoozedUntil: string | null,
previewsAllowed: boolean,
pushAvailable: boolean,
snoozeDays: number,
};
export type PushSubscriptionData = {
id: string,
label: string,
userAgent: string | null,
host: string,
endpointHash: string,
createdAt: string | null,
lastUsedAt: string | null,
expiresAt: string | null,
};
export type PushTestResultData = {
devices: number,
sent: number,
failed: number,
removed: number,
};
export type QuietHoursData = {
enabled: boolean,
start: string,
end: string,
timezone: string,
};
}
namespace Privacy {
export type RetentionData = {
days: number,
minimumDays: number,
};
export type VisitorErasureData = {
visitor: string,
erased: boolean,
sessions: number | null,
conversations: number | null,
offlineTickets: number | null,
messages: number | null,
attachments: number | null,
ratings: number | null,
events: number | null,
whatsappChatsUnlinked: number | null,
handoffTickets: number | null,
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
export type PushConfigData = {
vapidPublicKey: string,
};
export type RealtimeEndpointData = {
key: string,
host: string,
port: number,
scheme: string,
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
realtime: App.Data.Shared.RealtimeEndpointData | null,
push: App.Data.Shared.PushConfigData | null,
};
export type TextDirection = 'ltr' | 'rtl';
}
namespace WhatsApp {
export type HandoffData = {
code: string,
waUrl: string,
expiresAt: string,
ttlSeconds: number,
};
export type WaChatData = {
ulid: string,
session: App.Data.WhatsApp.WaSessionRefData,
phone: string | null,
pushName: string | null,
isGroup: boolean,
status: App.Domain.WhatsApp.Enums.WaChatStatus,
linked: boolean,
widget: App.Data.Chat.WidgetRefData | null,
category: App.Data.Chat.CategoryRefData | null,
unreadByAdmin: number,
inboundInitiated: boolean,
lastInboundAt: string | null,
lastMessageAt: string | null,
lastMessagePreview: string | null,
createdAt: string,
};
export type WaChatDetailData = {
chat: App.Data.WhatsApp.WaChatData,
visitor: App.Data.WhatsApp.WaVisitorRefData | null,
handoff: App.Data.WhatsApp.WaHandoffRefData | null,
};
export type WaHandoffRefData = {
code: string,
createdAt: string,
consumedAt: string | null,
};
export type WaMediaData = {
mime: string | null,
filename: string | null,
size: number | null,
available: boolean,
url: string | null,
};
export type WaMessageData = {
ulid: string,
chat: string,
direction: App.Domain.WhatsApp.Enums.WaDirection,
type: App.Domain.WhatsApp.Enums.WaMessageType,
body: string | null,
media: App.Data.WhatsApp.WaMediaData | null,
status: App.Domain.WhatsApp.Enums.WaMessageStatus,
error: string | null,
sentBy: App.Data.Chat.StaffAgentRefData | null,
waTimestamp: string,
createdAt: string,
};
export type WaSessionRefData = {
ulid: string,
name: string,
};
export type WaVisitorRefData = {
ulid: string,
name: string | null,
email: string | null,
phone: string | null,
verified: boolean,
};
export type WhatsAppConnectionTestData = {
ok: boolean,
role: string | null,
engine: string | null,
canOperate: boolean,
reason: string | null,
message: string | null,
};
export type WhatsAppQrData = {
qr: string,
updatedAt: string,
};
export type WhatsAppSessionData = {
ulid: string,
name: string,
engine: string,
status: App.Domain.WhatsApp.Enums.SessionStatus,
phone: string | null,
maskedPhone: string | null,
pushName: string | null,
qrAvailable: boolean,
lastQrAt: string | null,
webhookRegistered: boolean,
webhookUrl: string,
readyAt: string | null,
lastError: string | null,
linkedWidgetsCount: number,
isLinkedToWidgets: boolean,
sendMinIntervalMs: number,
dailySendCap: number,
pacingOverridden: boolean,
createdAt: string,
};
export type WhatsAppSettingsData = {
enabled: boolean,
baseUrl: string,
hasApiKey: boolean,
handoffTtlMinutes: number,
handoffText: string,
ignoreGroups: boolean,
replyOnlyToInbound: boolean,
sendMinIntervalMs: number,
dailySendCap: number,
mediaMaxBytes: number,
retentionDays: number,
rawRetentionDays: number,
};
export type WidgetWhatsAppLinkData = {
widget: App.Data.Chat.WidgetRefData,
session: App.Data.WhatsApp.WaSessionRefData | null,
status: App.Domain.WhatsApp.Enums.SessionStatus | null,
maskedPhone: string | null,
connected: boolean,
};
namespace Events {
export type WaChatUpdatedPayload = {
v: number,
chat: App.Data.WhatsApp.WaChatData,
};
export type WaMessageCreatedPayload = {
v: number,
message: App.Data.WhatsApp.WaMessageData,
chat: App.Data.WhatsApp.WaChatData,
};
export type WaMessageUpdatedPayload = {
v: number,
message: App.Data.WhatsApp.WaMessageData,
};
export type WaSessionStatusPayload = {
v: number,
session: App.Data.WhatsApp.WhatsAppSessionData,
};
}
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
namespace Analytics {
export type AnalyticsMetric = 'started' | 'handled' | 'reclaimed' | 'transferred' | 'missed' | 'cancelled' | 'ended' | 'closed' | 'answer_rate' | 'wait_avg' | 'wait_max' | 'frt_avg' | 'frt_max' | 'handling_avg' | 'handling_max' | 'rating_avg' | 'rating_count' | 'messages_visitor' | 'messages_agent' | 'messages_per_chat' | 'peak_concurrent' | 'queue_peak' | 'offline_created' | 'offline_answered' | 'offline_closed' | 'offline_response_avg' | 'offers' | 'offer_accept_rate' | 'res_visitor' | 'res_agent' | 'res_system' | 'res_idle';
}
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
export type RealtimeEvent = 'chat.offered' | 'chat.taken' | 'chat.assigned' | 'chat.claimed' | 'conversation.updated' | 'unread.updated' | 'queue.updated' | 'session.revoked' | 'presence.changed' | 'message.created' | 'message.delivered' | 'message.seen' | 'conversation.ended' | 'conversation.closed' | 'conversation.missed' | 'conversation.transferred' | 'offline-ticket.created' | 'conversation.rated' | 'typing';
}
}
namespace Notifications {
namespace Enums {
export type PromptState = 'never' | 'granted' | 'denied' | 'snoozed';
export type PushType = 'offer' | 'message' | 'dismiss' | 'test';
}
}
namespace Settings {
export type SettingGroup = 'app' | 'auth' | 'chat' | 'notifications' | 'storage' | 'whatsapp';
export type SettingType = 'string' | 'bool' | 'int' | 'json';
}
namespace WhatsApp {
namespace Enums {
export type SessionStatus = 'created' | 'starting' | 'qr' | 'ready' | 'disconnected' | 'failed';
export type WaChatStatus = 'open' | 'archived';
export type WaDirection = 'in' | 'out';
export type WaMessageStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed' | 'received';
export type WaMessageType = 'text' | 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker' | 'location' | 'contact' | 'other';
export type WaRealtimeEvent = 'wa.message.created' | 'wa.message.updated' | 'wa.chat.updated' | 'wa.session.status';
export type WebhookOutcome = 'processed' | 'duplicate' | 'rejected' | 'ignored' | 'failed';
}
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
namespace Support {
namespace ApiDocs {
export type ApiAudience = 'management' | 'public';
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
