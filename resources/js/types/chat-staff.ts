/**
 * Inertia props of the staff chat pages (docs/contracts/chat-ui-p4.md). Every nested shape is a generated PHP Data type
 * (`App.Data.Chat.*`); the compile-time guard in `chat-staff.conformance.ts` fails `npm run types:check` when they drift.
 */
import type {
    ConversationStaff,
    MessageData,
    PresenceStatus,
    RatingData,
} from '@/lib/chat/types';
import type { CategoryData } from '@/types/widgets';

/** The shell every inbox page shares: the live lists as the server sees them, the caller's status, the categories to transfer to. */
export type InboxShellProps = {
    /** Live chats waiting for an agent (offers; admins: all). */
    queue: ConversationStaff[];
    /** Live chats being worked on (admins: everybody's) and the ones finished in the last hours. */
    mine: ConversationStaff[];
    presence: { status: PresenceStatus };
    categories: CategoryData[];
    /** Whether chats can reach the caller (an agent who serves no category never gets one). */
    serving?: App.Data.Dashboard.ServingStatusData;
};

export type InboxPageProps = InboxShellProps;

export type InboxShowProps = InboxShellProps & {
    conversation: ConversationStaff;
    /** The whole transcript, oldest first, in the staff form (`sender.id` present for agents). */
    messages: MessageData[];
};

export type OfflineTicketsPageProps = {
    tickets: ConversationStaff[];
};

export type HistoryFilters = {
    status: string;
    type: string;
    category: string;
    widget: string;
    agent: string;
    from: string;
    to: string;
    q: string;
};

export type HistoryPagination = {
    page: number;
    perPage: number;
    total: number;
    lastPage: number;
    from: number | null;
    to: number | null;
};

export type HistoryFilterOptions = {
    categories: { ulid: string; name: string }[];
    widgets: { ulid: string; name: string }[];
    agents: { id: number; name: string }[];
};

export type HistoryPageProps = {
    conversations: ConversationStaff[];
    pagination: HistoryPagination;
    filters: HistoryFilters;
    /** Ratings of the conversations on this page (admin only). */
    ratings: RatingData[];
    filterOptions: HistoryFilterOptions;
};
