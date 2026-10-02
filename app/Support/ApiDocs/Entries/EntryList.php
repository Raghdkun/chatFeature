<?php

namespace App\Support\ApiDocs\Entries;

use App\Support\ApiDocs\Doc;

/** A file of reference entries, grouped the way the endpoints are filed. */
interface EntryList
{
    /**
     * @return list<Doc>
     */
    public static function docs(): array;
}
