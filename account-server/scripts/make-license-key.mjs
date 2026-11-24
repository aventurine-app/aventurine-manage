// Makes the Ed25519 key pair that signs Aventurine Manage's licenses
// (worker/src/license.js).
//
//   node scripts/make-license-key.mjs <private-key-file>
//
// Writes the private key (PKCS#8, base64) to <private-key-file>, readable by
// you only, and prints the public key (SPKI, base64). Then:
//   1. wrangler secret put LICENSE_SIGNING_KEY --config worker/wrangler.toml < <private-key-file>
//   2. Put the public key in LICENSE_PUBLIC_KEY in the Manage repo's
//      electron/licensePolicy.js and release Manage.
//   3. Keep the private key file somewhere safe, or delete it: the secret in
//      Cloudflare is the copy that matters.
//
// Replacing the key later means every copy of Manage built with the old public
// key rejects new licenses (and locks again) until it is updated.

import fs from 'node:fs';

const target = process.argv[2];
if (!target) {
    console.error('usage: node scripts/make-license-key.mjs <private-key-file>');
    process.exit(1);
}
if (fs.existsSync(target)) {
    console.error(`${target} already exists; refusing to overwrite a key`);
    process.exit(1);
}

const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const base64 = async (format, key) => Buffer.from(await crypto.subtle.exportKey(format, key)).toString('base64');

fs.writeFileSync(target, await base64('pkcs8', privateKey), { mode: 0o600 });
console.log(`Private key written to ${target}`);
console.log(`Public key for Manage (LICENSE_PUBLIC_KEY):\n${await base64('spki', publicKey)}`);
