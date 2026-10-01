# Contracts

> Status: living. Written by the orchestrator **before** a phase fans out to parallel tracks. A track
> may *read* every contract and may only *change* one through the orchestrator (open a note in your
> hand-back report; the orchestrator edits the contract and re-syncs the other tracks).

| Contract | Needed by | Status |
|---|---|---|
| [inertia-shared-props.md](inertia-shared-props.md) | P1 (all tracks) | written (P0) |
| [install-steps.md](install-steps.md) | P1, P2 | written (P0) |
| [setup-wizard.md](setup-wizard.md) | P1 (1A backend, 1B frontend, 1C e2e) | written (P1) |
| [auth-driver.md](auth-driver.md) | P1, P2 | written (P0) |
| [ownership.md](ownership.md) | every phase | written (P0), extended per phase |
| [widget-config.md](widget-config.md) | P3 (3A, 3B, 3C), P4 (4D) | written (ahead of P3) |
| [postmessage-protocol.md](postmessage-protocol.md) | P3 (3B), P4 (4D) | written (ahead of P3) |
| [rest-shapes.md](rest-shapes.md) | P3, P4 | conventions + P3 widget endpoints + P4 chat endpoints written |
| [realtime-events.md](realtime-events.md) | P4, P5, P6 | written (ahead of P4) |

## Rules

1. **PHP is the source of truth for shared shapes.** Define payloads as `spatie/laravel-data` classes in
   `app/Data/<Context>/` with `#[TypeScript]`; run `composer types:generate` and import the generated
   `App.Data.*` types from `resources/js/types/generated.d.ts`. Never hand-copy a shape into TypeScript.
2. **Public identifiers are ULIDs or `public_key`s.** Integer primary keys never appear in a payload that
   leaves the server (visitor-facing or API). Staff-only Inertia props may use integer user ids.
3. **Additive changes only inside a phase.** New optional fields are fine; renaming/removing a field
   needs an orchestrator-approved contract change.
4. **Tests assert the contract.** Every Data class that crosses a boundary has a feature test that
   fetches it through the real endpoint/page and checks the key set.
