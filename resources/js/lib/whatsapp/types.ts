/**
 * WhatsApp types shared by the inbox and the settings page (admin-only, P6).
 *
 * The data shapes are the PHP Data classes (`app/Data/WhatsApp`, generated into `App.Data.WhatsApp.*`, enums into
 * `App.Domain.WhatsApp.Enums.*`): this file only gives them short names. Never copy a shape here by hand.
 */

export type WhatsAppSession = App.Data.WhatsApp.WhatsAppSessionData;
export type WaSessionRef = App.Data.WhatsApp.WaSessionRefData;
/** The widget and topic a chat is linked to (the P4 refs). */
export type WaWidgetRef = App.Data.Chat.WidgetRefData;
export type WaCategoryRef = App.Data.Chat.CategoryRefData;
export type WaChat = App.Data.WhatsApp.WaChatData;
export type WaChatDetail = App.Data.WhatsApp.WaChatDetailData;
export type WaVisitorRef = App.Data.WhatsApp.WaVisitorRefData;
export type WaHandoffRef = App.Data.WhatsApp.WaHandoffRefData;
export type WaMessage = App.Data.WhatsApp.WaMessageData;
export type WaMedia = App.Data.WhatsApp.WaMediaData;
/**
 * The response of the public hand-off call: the only WhatsApp shape a visitor ever gets. `ttlSeconds` (how long the code still works,
 * counted by the SERVER from the moment it answered: no clock of the visitor's is involved) is newer than the first backend: absent there.
 */
export type HandoffResponse = App.Data.WhatsApp.HandoffData;

export type SessionStatus = App.Domain.WhatsApp.Enums.SessionStatus;
export type WaChatStatus = App.Domain.WhatsApp.Enums.WaChatStatus;
export type WaDirection = App.Domain.WhatsApp.Enums.WaDirection;
export type WaMessageType = App.Domain.WhatsApp.Enums.WaMessageType;
export type WaMessageStatus = App.Domain.WhatsApp.Enums.WaMessageStatus;
