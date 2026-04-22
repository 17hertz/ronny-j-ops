/**
 * Symmetric encryption for sensitive PII at rest.
 *
 * Used for:
 *   - vendors.tax_id_encrypted       (EIN / SSN)
 *   - vendors.ach_bank_details_encrypted  (routing + account numbers)
 *
 * Why not pgsodium?
 *   pgsodium is the long-term plan — it keeps the key in the DB and means
 *   the service-role client never sees the plaintext secret key. But the
 *   Supabase pgsodium setup (key rotation, server-side decrypt for admin
 *   views) is non-trivial to wire up. For now we use AES-256-GCM at the
 *   application layer with `ENCRYPTION_KEY` pulled from env. The bytes
 *   we write to `bytea` columns are a drop-in replacement — swapping to
 *   pgsodium later just means re-encrypting the column.
 *
 * Ciphertext format (stored as bytea):
 *   [ 1 byte version | 12 bytes IV | N bytes ciphertext | 16 bytes auth tag ]
 *
 * Version byte future-proofs rekey / algorithm changes: a background job
 * can identify rows still on v1 and re-encrypt them as v2.
 */
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

const VERSION = 0x01;
const IV_LEN = 12; // GCM standard
const TAG_LEN = 16;

/**
 * Resolve the 32-byte encryption key from env. Accepts either 64-char hex
 * or 44-char base64. Throws loudly so a misconfigured prod deployment
 * fails at first sensitive write rather than silently writing in the
 * clear (or, worse, writing with a key nobody can reproduce).
 */
function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "ENCRYPTION_KEY is not set — cannot encrypt vendor PII. " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  // Hex (64 chars) or base64 (~44 chars, may include padding).
  let buf: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    buf = Buffer.from(raw, "hex");
  } else {
    buf = Buffer.from(raw, "base64");
  }
  if (buf.length !== 32) {
    throw new Error(
      `ENCRYPTION_KEY must decode to 32 bytes (got ${buf.length}). Expected 64-char hex or 44-char base64.`
    );
  }
  return buf;
}

export function encryptString(plain: string): Buffer {
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), iv, ct, tag]);
}

export function decryptToString(blob: Buffer): string {
  if (blob.length < 1 + IV_LEN + TAG_LEN) {
    throw new Error("encrypted blob too short");
  }
  const version = blob[0];
  if (version !== VERSION) {
    throw new Error(`unsupported encryption version: ${version}`);
  }
  const iv = blob.subarray(1, 1 + IV_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ct = blob.subarray(1 + IV_LEN, blob.length - TAG_LEN);
  const key = getKey();
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

/**
 * Helper that stringifies an object and encrypts it. The inverse is
 * `decryptToString` + `JSON.parse`.
 */
export function encryptJson(obj: unknown): Buffer {
  return encryptString(JSON.stringify(obj));
}

/**
 * Pulls the last 4 chars off a digit string (strips non-digits first).
 * Returns null for values shorter than 4 digits.
 */
export function last4(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}
