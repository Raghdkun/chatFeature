<?php

namespace App\Models;

use App\Domain\Widgets\Enums\OfflineMode;
use Database\Factories\WidgetFactory;
use Illuminate\Contracts\Encryption\DecryptException;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Attributes\Hidden;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\SoftDeletes;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Crypt;

/**
 * An embeddable chat widget. `public_key` (`wk_...`) is what visitors and the loader see; `ulid` is the dashboard id.
 * `config` is what visitors get, `draft_config` what the builder edits until it is published.
 *
 * @property int $id
 * @property string $ulid
 * @property int|null $workspace_id
 * @property string $public_key
 * @property string $name
 * @property bool $is_enabled
 * @property string $locale
 * @property array<string, mixed> $config
 * @property array<string, mixed> $draft_config
 * @property int $config_version
 * @property int $idle_timeout_minutes
 * @property int $queue_timeout_seconds
 * @property OfflineMode $offline_mode
 * @property string $timezone
 * @property bool $allow_non_browser_clients
 * @property string|null $identity_secret_encrypted
 * @property Carbon|null $created_at
 * @property Carbon|null $updated_at
 * @property Carbon|null $deleted_at
 * @property-read int|null $domains_count
 * @property-read int|null $categories_count
 */
#[Fillable(['name', 'is_enabled', 'locale', 'idle_timeout_minutes', 'queue_timeout_seconds', 'offline_mode', 'timezone', 'allow_non_browser_clients'])]
#[Hidden(['identity_secret_encrypted'])]
class Widget extends Model
{
    /** @use HasFactory<WidgetFactory> */
    use HasFactory, HasUlids, SoftDeletes;

    /**
     * @var array<string, mixed>
     */
    protected $attributes = [
        'is_enabled' => false,
        'locale' => 'en',
        'config_version' => 1,
        'idle_timeout_minutes' => 120,
        'queue_timeout_seconds' => 90,
        'offline_mode' => 'auto_hours',
        'timezone' => 'UTC',
        'allow_non_browser_clients' => false,
    ];

    /**
     * `ulid` is a public id next to the integer primary key, not the primary key itself.
     *
     * @return list<string>
     */
    public function uniqueIds(): array
    {
        return ['ulid'];
    }

    public function getRouteKeyName(): string
    {
        return 'ulid';
    }

    /**
     * @return array<string, mixed>
     */
    protected function casts(): array
    {
        return [
            'workspace_id' => 'integer',
            'is_enabled' => 'boolean',
            'config' => 'array',
            'draft_config' => 'array',
            'config_version' => 'integer',
            'idle_timeout_minutes' => 'integer',
            'queue_timeout_seconds' => 'integer',
            'offline_mode' => OfflineMode::class,
            'allow_non_browser_clients' => 'boolean',
        ];
    }

    /**
     * @return HasMany<WidgetDomain, $this>
     */
    public function domains(): HasMany
    {
        return $this->hasMany(WidgetDomain::class)->orderBy('host');
    }

    /**
     * @return HasMany<WidgetGreeting, $this>
     */
    public function greetings(): HasMany
    {
        return $this->hasMany(WidgetGreeting::class)->orderBy('sort_order')->orderBy('id');
    }

    /**
     * Categories linked to this widget, in display order (active or not; consumers filter).
     *
     * @return BelongsToMany<Category, $this>
     */
    public function categories(): BelongsToMany
    {
        return $this->belongsToMany(Category::class, 'widget_category')
            ->withPivot('sort_order')
            ->withTimestamps()
            ->orderBy('widget_category.sort_order')
            ->orderBy('categories.id');
    }

    public function hasIdentitySecret(): bool
    {
        return $this->identity_secret_encrypted !== null && $this->identity_secret_encrypted !== '';
    }

    /**
     * The decrypted HS256 secret for signed visitor identities (null when none was generated or the app key changed).
     */
    public function identitySecret(): ?string
    {
        if (! $this->hasIdentitySecret()) {
            return null;
        }

        try {
            return Crypt::decryptString((string) $this->identity_secret_encrypted);
        } catch (DecryptException) {
            return null;
        }
    }
}
