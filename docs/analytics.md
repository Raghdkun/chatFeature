# Analytics (P7)

Reporting for administrators, and a personal "My performance" view for agents. Everything is computed from the raw chat tables by **one implementation** (`App\Domain\Analytics\Collection\MetricCalculator`): the scheduled rollup stores its result in `analytics_daily` / `analytics_slots`, and today's live numbers are the same call, so a stored day and a live day cannot drift apart. API: [rest-api.md](rest-api.md#analytics-api-p7); operations: [runbook.md](runbook.md#analytics-p7).

Code: `app/Domain/Analytics` (`Collection/` = collectors + calculator, `Actions/` = rollup, `Reports/` = the read side), `app/Console/Commands/AnalyticsRollup.php`, `app/Http/Controllers/Api/V1/Management/AnalyticsController.php`, `app/Data/Analytics/*` (TypeScript types), UI `resources/js/pages/analytics`, `resources/js/components/analytics`, `resources/js/lib/analytics`.

## 1. The rules every number follows

1. **Days are counted in the application time zone** (setting `app.timezone`, default UTC). The database stores UTC (`config('app.timezone')`); a day is the half-open UTC window `[local midnight, next local midnight)`, so a DST day is 23 or 25 hours long and a chat at 23:59:59 local belongs to that day, one second later to the next. Rows remember the zone they were counted in (`tz`); after changing the setting, rebuild with `analytics:rollup --from=... --force` (the API says `meta.timezoneChanged` until you do).
2. **A number is counted on the day its event happened** (event-time attribution). A chat that starts at 23:58 and is accepted at 00:01 is *started* on the first day and *handled* (with its wait) on the second. A duration between two events belongs to the day of the **later** one (the one that completes it). Consequence: a day's numbers depend only on events of that day and on history before it, so **a finished day never changes** (the nightly run only re-checks the last three days for late writes).
3. **Counts and sums are stored, averages never.** Every duration is `*_sum_s` + `*_count`; the API divides the sums of the whole range, so an average over a week is "all seconds / all samples", never an average of daily averages. Maxima (`*_max_s`, `peak_concurrent`, `queue_peak`) are combined with `max`. **No percentiles**: a percentile cannot be merged from daily rows exactly, so it is not offered; use the maxima.
4. **Rows hold numbers, not references.** There is no foreign key: deleting a widget, a topic, an agent, a chat or a WhatsApp chat never changes a stored day. The widget / topic / agent name is looked up when you read (soft-deleted widgets and topics keep their names; a hard-deleted one reads "Deleted widget / topic", an erased account "Deleted account", with `deleted: true`).
5. **The agent in a row is whoever did the thing**, taken from the audit trail (`conversation_events.actor_id` has no foreign key, so it survives a deleted account), not from the nullable `conversations.assigned_agent_id`.

## 2. Definitions

"Live chat" = `conversations.type = live`; "ticket" = an offline ticket (`type = offline`). All timestamps are the stored UTC instants, to the second.

### Live chats

| Metric (column) | Counted on the day of | Definition |
|---|---|---|
| **started** (`started`) | `conversations.created_at` | Live chats created (queued). In the row of the widget and the topic the conversation has *now* (a transfer to another topic moves it; a chat without a topic is category `0`). |
| **handled** (`handled`) | the chat's *first* `claimed` event | A live chat an agent accepted for the first time. Agent row: the agent who accepted. |
| **reclaimed** (`reclaimed`) | a later `claimed` event of the same chat | Accepted again after a transfer or a re-queue. `handled + reclaimed` = accepts. |
| **transferred** (`transferred`) | a `transferred` event | A chat an agent or admin handed on (agent row: the agent who let go). |
| **missed** (`missed`) | the `missed` event | The queue timeout ran out with nobody accepting. |
| **cancelled** (`closed_cancelled`) | `closed_at` with reason `cancelled` | The visitor left the queue. |
| **ended** (`ended`) | `conversations.ended_at` | Either side ended an active chat. Agent row: the agent who held it last. |
| **closed** (`closed_<reason>`) | `conversations.closed_at` | Chats that reached `closed`, by reason: `rated`, `skipped`, `idle`, `timeout`, `system` (staff closed it, or any reason the code does not know), `cancelled`. `closed` = their sum. |
| **wait time** (`wait_sum_s`, `wait_count`, `wait_max_s`) | the first `claimed` event | First claim - `created_at` (queued -> accepted). One sample per chat; a chat accepted again after a transfer adds no second sample. Agent row: the first claimer. |
| **first response time** (`frt_*`) | the first agent message | First agent message - first claim. One sample per chat. Agent row: whoever wrote first. A chat nobody wrote in has no sample. |
| **handling time** (`handling_*`) | the chat's termination | Termination - first claim (so time spent re-queued by a transfer is included). Agent row: the agent who held it last. |
| **resolution** (`res_visitor`, `res_agent`, `res_system`, `res_idle`) | the chat's termination | How a handled chat finished. A chat is **terminated** when it leaves the agents for good: at `ended_at` (`ended_by` visitor -> `res_visitor`; agent or admin -> `res_agent`; system -> `res_system`), or, if it was never ended, at `closed_at` when an agent had accepted it (reason `idle` -> `res_idle`; staff close / anything else -> `res_system`). A queued chat staff dismissed was never handled: it is `closed_system`, not a resolution. |
| **messages per chat** (`msgs_sum`, `msgs_count`) | the chat's termination | Visitor + agent messages of the terminated chat (system lines such as "Ann joined the chat" are not messages). |
| **message volume** (`messages_visitor`, `messages_agent`) | `messages.created_at` | Visitor and agent messages sent in the day, live chats **and** tickets. An agent's row only has the messages that agent sent. |
| **ratings** (`rating_count`, `rating_sum`, `rating_1..5`) | `ratings.created_at` | Count, sum (average = sum / count) and 1-5 distribution. Agent row: the agent who held the chat last. |
| **offers** (`offers`) | the `offered` / `transferred` event | One per agent a queued chat was offered to (`offered` events list the agents, one per wave) plus one for a colleague a chat was transferred to. Agent row: the agent offered. Accept rate = `(handled + reclaimed) / offers` of that row, capped at 1. The offers table is not read: the routing code deletes a chat's offers when it is re-queued, the audit events are never deleted. |
| **peak concurrent** (`peak_concurrent`) | the day | The most chats **active** at the same instant (see "Concurrency" below). Agent row: that agent's own chats. |
| **queue depth** (`queue_peak`) | the day | The most chats **queued** at the same instant (not in agent rows). |

### Offline tickets

`offline_created` (`created_at`), `offline_answered` (the ticket's first agent message, in the sender's row), `offline_response_sum_s` (first agent message - creation; average = sum / `offline_answered`; a ticket answered three days later lands on day 3), `offline_closed` (`closed_at`).

### Concurrency (peak concurrent, queue depth)

Rebuilt per chat from its events, in order: *queued* from `created` (or a `transferred` / `requeued`) until `claimed`, `missed`, `cancelled` or `closed`; *active* from `claimed` until `transferred`, `requeued`, `ended` or `closed`, belonging to the agent who claimed. A chat still open at the end of the window (or "now", for today) is open until then. The peak is the maximum overlap, exact to the second: intervals that end at an instant come before those that start at it, and an interval that opens and closes within one second occupies that second. Chats without any lifecycle event in the 72 hours before the day (or in it) are not looked at (an interval that long is a stuck row, `SweepCollector::LOOKBACK_SECONDS`). If a chat's events are missing while its row says it is over, the open interval ends at `ended_at` / `closed_at` / `queue_expires_at` / `updated_at`.

### Busiest hours (heatmap)

`analytics_slots` counts chats **started** and chats **accepted** (`claimed`, every accept) per **15-minute UTC slot**, in the same dimensions. The heatmap request moves each slot to the viewer's time zone and adds it to its weekday x hour cell. Every real UTC offset is a multiple of 15 minutes, so the result is exact, including DST days and half-hour zones (India) or 45-minute zones (Nepal).

### WhatsApp (administrators only)

Dimension `whatsapp` (key `''`); no endpoint an agent can call reads it, and no other dimension carries a `wa_*` number.

| Metric | Definition |
|---|---|
| `wa_chats_new` | `wa_chats.created_at` in the day (groups included). |
| `wa_chats_linked` | Of those, chats matched to a widget visitor by a hand-off (`widget_id` set). **Linked share** = `wa_chats_linked / wa_chats_new` of the range. |
| `wa_inbound` / `wa_outbound` | Messages by `wa_timestamp`. An outbound message counts once OpenWA took it (`sent`, `delivered` or `read`; not `pending`, not `failed`). |
| `wa_response_sum_s`, `wa_response_count` | An outbound message sent in the day answers the **oldest inbound message of the chat that nobody answered yet**; the sample is the gap, counted on the reply's day. Look-back for that inbound message: 7 days. |

## 3. Dimensions and invariants

`total` (key `''`), `widget` (widget id), `category` (topic id, `0` = none), `agent` (user id, `0` = nobody we can name), `whatsapp`. Every conversation fact is added to `total`, its widget and its topic; the facts an agent causes are also added to that agent's row.

Properties the tests pin (`RollupReconciliationTest`): the widget rows add up to the total, and so do the topic rows, for every conversation-attributed column; the agent rows add up to the total for every column an agent causes (`handled`, `reclaimed`, `transferred`, `ended`, `res_*`, `wait_*`, `frt_*`, `handling_*`, `msgs_*`, `messages_agent`, `rating_*`, `offers`, `offline_answered`, `offline_response_sum_s`). `started`, `missed`, `closed_*`, `messages_visitor`, `queue_peak` and the ticket counters of creation and closing belong to no agent: they are `null` in an agent's own view.

## 4. Tables

`analytics_daily`: `id`, `date` (DATE, application-zone day), `dimension` (16), `dimension_key` (40), `tz`, then the unsigned counters (`AnalyticsColumns::COUNTERS`) and maxima (`AnalyticsColumns::MAXIMA`), `sealed_at` (total row only), `computed_at`. **Unique `(date, dimension, dimension_key)`**; index `(dimension, dimension_key, date)` for series reads. Only rows with something in them are stored, plus the `total` row of every rolled day (a quiet day is a row of zeros: that is how "rolled" differs from "not rolled yet").

`analytics_slots`: `slot_start` (UTC), `dimension`, `dimension_key`, `started`, `claimed`; unique `(slot_start, dimension, dimension_key)`, index `(dimension, dimension_key, slot_start)`.

Indexes added to existing tables because the rollup reads one day of each by its timestamp: `conversations(created_at)`, `(ended_at)`, `(closed_at)`; `conversation_events(type, created_at)`; `messages(created_at)`; `ratings(created_at)`; `wa_chats(created_at)`; `wa_messages(wa_timestamp)`.

## 5. The rollup

`php artisan analytics:rollup` (see the [runbook](runbook.md#analytics-p7)):

| Call | Rolls |
|---|---|
| `analytics:rollup` | every day since 35 days ago (`--days=N`) that is not sealed, and today: the nightly run, self-healing after downtime |
| `analytics:rollup --days=2` | today and the two days before it: the **hourly** run (so the last hour of a day that just ended is never lost) |
| `analytics:rollup --today` | only today |
| `analytics:rollup --from=Y-m-d [--to=Y-m-d] [--force]` | a backfill; sealed days are skipped unless `--force` |

Scheduled in `routes/console.php`: `--days=2` hourly at minute 7 and the default run daily at 00:25, both `withoutOverlapping` + `onOneServer` (needs the scheduler, [runbook](runbook.md)). A cache lock makes a second concurrent run stop at once.

* **Idempotent and chunked.** One day is recomputed from the raw tables and replaces that day's rows in one transaction (delete + insert, retried on a MySQL deadlock): running it again, or backfilling the same range twice, gives the same rows, and a number that fell to zero disappears instead of lingering. Large tables are read with `chunkById` or grouped queries; memory is flat.
* **Sealing.** A day more than **3 days** old when it is computed gets `sealed_at`. A sealed day is never recomputed without `--force`, so the raw tables can be pruned (retention), a chat erased or a widget deleted without changing history.
* **Retention interplay.** `whatsapp:prune` with `whatsapp.retention_days = N` deletes messages (and then empty chats) older than N days. A WhatsApp day that starts before that cut-off may already be partly gone, so a rebuild (`--force`) **keeps the stored WhatsApp rows** of such a day and recomputes the rest (the command says "WhatsApp rows kept: retention"). `--force` on any other day recomputes from what still exists: a hard-deleted widget (cascades to its conversations) or an erased chat is then really gone from that day.
* **Live today.** The API computes today (and up to 14 past days nobody rolled up yet) with `MetricCalculator`, kept 30 s; days beyond that limit count as empty and are flagged in `meta.missingDays`. A `GET` never writes.
* **Cost.** Each day is about a dozen indexed queries, plus one query per 500 conversations for claims and messages; a two-year backfill is minutes, not hours.

## 6. Permissions

| Caller | Overview, time series, heatmap, ratings | Breakdown, WhatsApp, export |
|---|---|---|
| Administrator | everything, optionally filtered by **one** of widget / topic / agent; the ratings' comments | yes (export is audited as `analytics.exported`) |
| Agent | **only their own row**, decided by the server: `agent=<someone else>` is `403`, a widget or topic filter is `422`, no leaderboard of colleagues, no names of colleagues, never a visitor's rating comment, never a WhatsApp number | `403` |
| Account without a chat role | `403` | `403` |
| Deactivated account, guest, visitor token | `401` | `401` |

Gates `analytics.view`, `analytics.view-all`, `analytics.whatsapp`, `analytics.export` (`AnalyticsPolicy`); the administrator-only routes also carry the `admin` middleware. Agents may see aggregate rating counts and averages of their own chats although the inbox hides ratings from agents (`ConversationPolicy::viewRating`): the numbers are theirs, the visitors' words stay with administrators.

## 7. Known limits

* One filter at a time: the rollup has one row per widget, topic or agent, not their crossings. The breakdown tables are the drill-down.
* A chat transferred to another topic counts under its final topic in every row of every day (re-running an old day after a transfer moves it).
* Offers of a chat that was transferred are counted from the audit events, so they are complete; they are not the `conversation_agent_alerts` rows.
* Peak concurrency looks back 72 hours (see above); WhatsApp response times 7 days.
* The first view of a fresh install (or of days older than the 35-day catch-up) shows "being prepared" until `analytics:rollup --from=...` ran.
