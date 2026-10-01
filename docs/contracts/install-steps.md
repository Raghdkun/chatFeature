# Install steps

> Status: contract v1 (P0). Implemented in P1 (`app/Domain/Install`); P2 adds mode-2 steps.

The wizard runs a sequence of **idempotent, resumable** steps. State lives in
`storage/app/install-state.json` (there is no database before `migrate` runs). A `flock` on
`storage/app/install.running` rejects concurrent runs.

```php
namespace App\Domain\Install\Contracts;

interface InstallStep
{
    /** Stable machine id, e.g. 'check-environment', 'run-migrations'. Used as the route segment. */
    public function key(): string;

    /** Human label for the progress UI (translated by the caller). */
    public function label(): string;

    /** Only run for these modes; null = all modes. */
    public function modes(): ?array; // ['fortify'] | ['pizzasys'] | null

    /** Safe to call again after a failure or partial run. Must not require DB unless it ran after migrate. */
    public function run(InstallContext $context): StepResult;
}
```

`InstallContext` carries the validated wizard answers (mode, admin credentials, auth environments,
app basics) and the `InstallState` handle. `StepResult` is `ok | failed(message) | needsInput(fields)`.

## Step order (as implemented in `config/install.php`)

| # | Key | Modes | Notes |
|---|---|---|---|
| 0 | `check-environment` | all | PHP extensions, writable `storage/`, `APP_KEY`, DB connect (opens a PDO connection, runs no queries), optional Redis ping. |
| 1 | `choose-mode` | all | Persists `mode` to install state. |
| 2 | `configure-pizzasys` | pizzasys | **P2 replaces this placeholder in place.** Domains, service client, live `token-verify` probe, verified portal-admin login. Fails with "available in P2" until then. |
| 3 | `app-basics` | all | App name/URL, locale (`en`/`ar`), timezone, default idle timeout. **Runs before migrations**: its answers are file-only (install state) and `seed-defaults` writes them to the DB. |
| 4 | `run-migrations` | all | `migrate --force`. First step that touches the database. |
| 5 | `seed-defaults` | all | Settings defaults + the answers above; runs every class tagged `install.seeders` (P3 registers the "General" category and a disabled sample widget this way). |
| 6 | `create-admin` | fortify | First admin. (In pizzasys mode the verified portal admin is the first admin.) |
| 7 | `write-lock` | all | Writes `storage/app/installed.lock` + DB flag `app.installed`. After this `/setup/*` is 404 forever. |

Changing an earlier answer resets the run steps that consumed it; the UI re-runs from the first pending step.

Non-interactive: `php artisan chat:install --mode=local|pizzasys` runs the same steps from env
(`INSTALL_ADMIN_*`, `INSTALL_AUTH_*`) for Docker provisioning and e2e.
