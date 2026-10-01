<?php

namespace App\Models;

use Database\Factories\SettingFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * One row of the typed settings store. Read and write through
 * App\Domain\Settings\SettingsRepository, not directly.
 *
 * @property int $id
 * @property int|null $workspace_id
 * @property int $workspace_key Virtual COALESCE(workspace_id, 0).
 * @property string $group
 * @property string $key
 * @property string|null $value JSON, or its encrypted form when is_encrypted.
 * @property bool $is_encrypted
 * @property int|null $updated_by
 * @property Carbon|null $created_at
 * @property Carbon|null $updated_at
 */
#[Fillable(['workspace_id', 'group', 'key', 'value', 'is_encrypted', 'updated_by'])]
class Setting extends Model
{
    /** @use HasFactory<SettingFactory> */
    use HasFactory;

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'is_encrypted' => 'boolean',
        ];
    }
}
