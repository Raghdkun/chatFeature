/**
 * Notification types shared by the settings page, the first-login dialog and the controller.
 *
 * The server shapes are the PHP Data classes (`app/Data/Notifications`, generated into `App.Data.Notifications.*`): this file only
 * gives them short names and adds what exists on the client alone. Never copy a shape here by hand.
 */

export type NotificationSettings =
    App.Data.Notifications.NotificationSettingsData;
export type QuietHoursSetting = App.Data.Notifications.QuietHoursData;
export type PushDevice = App.Data.Notifications.PushSubscriptionData;
export type PushTestResult = App.Data.Notifications.PushTestResultData;
export type PromptState = App.Domain.Notifications.Enums.PromptState;
export type PushConfig = App.Data.Shared.PushConfigData;

/** What `PUT /me/notification-settings` takes: any subset, in the client's camelCase. */
export type NotificationSettingsPatch = Partial<
    Pick<
        NotificationSettings,
        'sound' | 'pushOffers' | 'pushMessages' | 'includePreview'
    >
> & {
    quietHours?: Partial<QuietHoursSetting>;
    promptState?: PromptState;
};

/** The browser's permission, or `unsupported` when it has no Notification API at all. */
export type PermissionState = NotificationPermission | 'unsupported';

/**
 * Why web push cannot work in this browser (the settings page says so in plain words), or `null` when it can.
 *  - `insecure`: not https (and not localhost): service workers and push are refused.
 *  - `no-service-worker` / `no-push` / `no-notification`: the browser lacks the API (an old browser, a private mode that removes it).
 *  - `ios-needs-install`: Safari on iPhone / iPad only delivers push to an app added to the Home Screen.
 */
export type UnsupportedReason =
    | 'insecure'
    | 'no-service-worker'
    | 'no-push'
    | 'no-notification'
    | 'ios-needs-install';

export type PushSupport =
    | { supported: true }
    | { supported: false; reason: UnsupportedReason };
