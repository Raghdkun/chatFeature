<?php

namespace App\Domain\Widgets\Embed;

use App\Data\Widgets\IdentityExampleData;
use App\Data\Widgets\WidgetSnippetsData;
use App\Domain\Widgets\Support\AppOrigin;
use App\Models\Widget;

/**
 * Builds the copy-paste embed codes of a widget (script, iframe, hosted link) and the server-side examples that
 * mint a signed visitor identity. The identity secret itself is never part of a snippet (placeholders only).
 */
final class EmbedSnippetBuilder
{
    public function __construct(private readonly AppOrigin $origin) {}

    public function build(Widget $widget): WidgetSnippetsData
    {
        $origin = $this->origin->url();
        $key = $widget->public_key;

        return new WidgetSnippetsData(
            script: '<script async src="'.$origin.'/w/'.$key.'.js"></script>',
            iframe: '<iframe src="'.$origin.'/embed/'.$key.'?mode=inline" title="Chat" loading="lazy" '
                .'style="width:100%;height:620px;border:0" allow="clipboard-write"></iframe>',
            hosted: $origin.'/c/'.$key,
            identity_example: new IdentityExampleData(
                php: $this->php($key),
                node: $this->node($key),
                python: $this->python($key),
            ),
        );
    }

    private function php(string $key): string
    {
        return <<<PHP
<?php
// Run on YOUR server, never in the browser. The secret is shown once when you generate it in the dashboard.
\$secret = getenv('PNE_CHAT_IDENTITY_SECRET');
\$base64Url = static fn (string \$data): string => rtrim(strtr(base64_encode(\$data), '+/', '-_'), '=');

\$header = \$base64Url(json_encode(['alg' => 'HS256', 'typ' => 'JWT']));
\$payload = \$base64Url(json_encode([
    'iss' => '{$key}',
    'sub' => (string) \$user->id,
    'name' => \$user->name,
    'email' => \$user->email,
    'exp' => time() + 300, // tokens must expire within 5 minutes
]));
\$signature = \$base64Url(hash_hmac('sha256', "\$header.\$payload", \$secret, true));

\$identityToken = "\$header.\$payload.\$signature";
// <script async src="..." data-identity-token="<?= htmlspecialchars(\$identityToken) ?>"></script>
// or in JavaScript: ChatFeature('identify', { token: identityToken });
PHP;
    }

    private function node(string $key): string
    {
        return <<<JS
// Run on YOUR server, never in the browser. The secret is shown once when you generate it in the dashboard.
import { createHmac } from 'node:crypto';

const base64Url = (value) => Buffer.from(value).toString('base64url');

const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const payload = base64Url(JSON.stringify({
  iss: '{$key}',
  sub: String(user.id),
  name: user.name,
  email: user.email,
  exp: Math.floor(Date.now() / 1000) + 300, // tokens must expire within 5 minutes
}));
const signature = createHmac('sha256', process.env.PNE_CHAT_IDENTITY_SECRET)
  .update(`\${header}.\${payload}`)
  .digest('base64url');

const identityToken = `\${header}.\${payload}.\${signature}`;
// <script async src="..." data-identity-token="..."></script>  or  ChatFeature('identify', { token: identityToken });
JS;
    }

    private function python(string $key): string
    {
        return <<<PY
# Run on YOUR server, never in the browser. The secret is shown once when you generate it in the dashboard.
import base64, hashlib, hmac, json, os, time


def base64_url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def compact(value: dict) -> bytes:
    return json.dumps(value, separators=(",", ":")).encode()


header = base64_url(compact({"alg": "HS256", "typ": "JWT"}))
payload = base64_url(compact({
    "iss": "{$key}",
    "sub": str(user.id),
    "name": user.name,
    "email": user.email,
    "exp": int(time.time()) + 300,  # tokens must expire within 5 minutes
}))
signature = base64_url(hmac.new(
    os.environ["PNE_CHAT_IDENTITY_SECRET"].encode(),
    f"{header}.{payload}".encode(),
    hashlib.sha256,
).digest())

identity_token = f"{header}.{payload}.{signature}"
PY;
    }
}
