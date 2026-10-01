<?php

namespace Tests\Support\Nats;

use RuntimeException;

/**
 * A throwaway self-signed certificate for the TLS tests of the NATS stub: `$pem` (certificate + key, what the stub
 * serves) and `$ca` (the certificate alone, what a client trusts). The certificate is valid for `$commonName` only.
 */
final class SelfSignedCertificate
{
    private function __construct(public readonly string $pem, public readonly string $ca) {}

    public static function create(string $commonName): self
    {
        $key = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
        $csr = $key !== false ? openssl_csr_new(['commonName' => $commonName], $key, ['digest_alg' => 'sha256']) : false;
        $certificate = $csr !== false && $key !== false ? openssl_csr_sign($csr, null, $key, 1, ['digest_alg' => 'sha256']) : false;

        if ($key === false || $certificate === false || ! openssl_x509_export($certificate, $certificatePem) || ! openssl_pkey_export($key, $keyPem)) {
            throw new RuntimeException('Could not create a test certificate.');
        }

        $directory = storage_path('framework/testing');
        @mkdir($directory, 0775, true);
        $base = $directory.'/nats-tls-'.bin2hex(random_bytes(4));
        file_put_contents($base.'.pem', $certificatePem.$keyPem);
        file_put_contents($base.'.ca.pem', $certificatePem);

        return new self($base.'.pem', $base.'.ca.pem');
    }

    public function delete(): void
    {
        @unlink($this->pem);
        @unlink($this->ca);
    }
}
