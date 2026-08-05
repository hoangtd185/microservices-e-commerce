import { randomBytes, scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 64;

/**
 * Password hashing with scrypt from Node's standard library.
 *
 * scrypt is memory-hard: an attacker with a GPU farm cannot parallelise it
 * cheaply, which is the whole point. Argon2id is the modern first choice and
 * bcrypt the traditional one; scrypt is used here because it ships with Node,
 * so there is no native module to compile inside a slim Docker image.
 *
 * Never store a plain SHA-256 of a password. It is designed to be fast, which
 * is exactly the wrong property.
 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = await scryptAsync(plain, salt, KEY_LENGTH);
  return `${salt}:${derived.toString('hex')}`;
}

export async function verifyPassword(plain: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;

  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;

  const derived = await scryptAsync(plain, salt, KEY_LENGTH);
  const expected = Buffer.from(hash, 'hex');

  if (expected.length !== derived.length) return false;

  // Constant-time compare: a normal === returns faster on an early mismatch,
  // which leaks information about the hash one byte at a time.
  return timingSafeEqual(expected, derived);
}
