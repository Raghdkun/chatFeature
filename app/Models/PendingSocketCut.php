<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * A socket tag (table `socket_cutoffs`) (see `SocketTags`) that still has to be terminated at Reverb at or after `due_at`: the retry of a call that failed and the
 * follow-up of every cut-off. `chat:realtime-sweep` works them off and deletes them.
 *
 * @property int $id
 * @property string $tag
 * @property string $reason
 * @property int $attempts
 * @property Carbon $due_at
 * @property Carbon|null $created_at
 */
#[Fillable(['tag', 'reason', 'attempts', 'due_at', 'created_at'])]
class PendingSocketCut extends Model
{
    protected $table = 'socket_cutoffs';

    public $timestamps = false;

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'attempts' => 'integer',
            'due_at' => 'datetime',
            'created_at' => 'datetime',
        ];
    }
}
