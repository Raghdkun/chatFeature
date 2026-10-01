/**
 * Chat types shared by the embed panel (4D) and the agent dashboard (4C).
 *
 * The data shapes are the PHP Data classes (`app/Data/Chat`, generated into `App.Data.Chat.*`): this file only gives them
 * short names and adds the types that exist on the client alone (a message that is still being sent, the typing whisper).
 * Never copy a shape here by hand.
 */

export type MessageData = App.Data.Chat.MessageData;
export type MessageSenderData = App.Data.Chat.MessageSenderData;
export type AttachmentData = App.Data.Chat.AttachmentData;
export type ConversationPublic = App.Data.Chat.ConversationPublicData;
export type ConversationStaff = App.Data.Chat.ConversationStaffData;
export type OfferData = App.Data.Chat.OfferData;
export type RatingData = App.Data.Chat.RatingData;
export type PresenceData = App.Data.Chat.PresenceData;
export type PresenceMemberData = App.Data.Chat.PresenceMemberData;
export type CategoryRef = App.Data.Chat.CategoryRefData;
export type AgentRef = App.Data.Chat.AgentRefData;
export type StaffAgentRef = App.Data.Chat.StaffAgentRefData;

export type ConversationStatus = App.Domain.Chat.Enums.ConversationStatus;
export type ConversationType = App.Domain.Chat.Enums.ConversationType;
export type ConversationEndedBy = App.Domain.Chat.Enums.ConversationEndedBy;
export type ConversationCloseReason =
    App.Domain.Chat.Enums.ConversationCloseReason;
export type MessageType = App.Domain.Chat.Enums.MessageType;
export type SenderType = App.Domain.Chat.Enums.SenderType;
export type OfferResponse = App.Domain.Chat.Enums.OfferResponse;
export type PresenceStatus = App.Domain.Chat.Enums.PresenceStatus;
export type SessionRevokeReason = App.Domain.Chat.Enums.SessionRevokeReason;

/** A conversation as either audience gets it. */
export type AnyConversation = ConversationPublic | ConversationStaff;

/**
 * Where a message is on its way. `sending` and `failed` exist on this device only; `sent` means the server numbered it,
 * `delivered` / `seen` come from the receipts (`deliveredAt` / `seenAt`).
 */
export type MessageStatus =
    | 'sending'
    | 'sent'
    | 'delivered'
    | 'seen'
    | 'failed';

/**
 * A message in a client's list. Server messages are `MessageData` plus a status; a message that is still being sent has no
 * `ulid` and no `seq` yet (the server assigns both) and is matched to its server copy by `clientMsgId`.
 */
export type LocalMessage = Omit<MessageData, 'ulid' | 'seq'> & {
    ulid: string | null;
    seq: number | null;
    status: MessageStatus;
};

/** A message the server has numbered. */
export type SequencedMessage = LocalMessage & { ulid: string; seq: number };

/** The `client-typing` whisper: `{actor, typing}`; debounced to one every 3 s, expires after 5 s (see `typing.ts`). */
export type TypingActor = 'visitor' | 'agent';
export type TypingWhisper = { actor: TypingActor; typing: boolean };
