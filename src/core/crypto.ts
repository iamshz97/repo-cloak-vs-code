/**
 * Crypto Module
 * Handles encryption/decryption of sensitive data using user-specific secret
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_DIR = join(homedir(), '.repo-cloak');
const SECRET_FILE = join(CONFIG_DIR, 'secret.key');
const ALGORITHM = 'aes-256-gcm';

export interface EncryptedReplacement {
    original: string;
    replacement: string;
    encrypted: boolean;
}

export interface DecryptedReplacement {
    original: string | null;
    replacement: string;
    decryptFailed?: boolean;
}

/**
 * Get or create user's secret key
 */
export function getOrCreateSecret(): string {
    if (!existsSync(CONFIG_DIR)) {
        mkdirSync(CONFIG_DIR, { recursive: true });
    }

    if (existsSync(SECRET_FILE)) {
        return readFileSync(SECRET_FILE, 'utf-8').trim();
    }

    const secret = randomBytes(32).toString('hex');
    writeFileSync(SECRET_FILE, secret, { mode: 0o600 });

    return secret;
}

/**
 * Check if user has a secret key
 */
export function hasSecret(): boolean {
    return existsSync(SECRET_FILE);
}

/**
 * Encrypt a string using user's secret
 */
export function encrypt(text: string, secret: string): string {
    const key = scryptSync(secret, 'repo-cloak-salt', 32);
    const iv = randomBytes(16);
    const cipher = createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();

    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt a string using user's secret
 */
export function decrypt(encryptedData: string, secret: string): string | null {
    try {
        const [ivHex, authTagHex, encrypted] = encryptedData.split(':');

        if (!ivHex || !authTagHex || !encrypted) {
            throw new Error('Invalid encrypted data format');
        }

        const key = scryptSync(secret, 'repo-cloak-salt', 32);
        const iv = Buffer.from(ivHex, 'hex');
        const authTag = Buffer.from(authTagHex, 'hex');
        const decipher = createDecipheriv(ALGORITHM, key, iv);

        decipher.setAuthTag(authTag);

        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');

        return decrypted;
    } catch (error) {
        return null;
    }
}

/**
 * Encrypt replacements for storage
 */
export function encryptReplacements(replacements: { original: string; replacement: string }[], secret: string): EncryptedReplacement[] {
    return replacements.map(r => ({
        original: encrypt(r.original, secret),
        replacement: r.replacement,
        encrypted: true
    }));
}

/**
 * Decrypt replacements from storage
 */
export function decryptReplacements(replacements: EncryptedReplacement[], secret: string): DecryptedReplacement[] {
    return replacements.map(r => {
        if (!r.encrypted) {
            return { original: r.original, replacement: r.replacement };
        }

        const original = decrypt(r.original, secret);

        if (original === null) {
            return {
                original: null,
                replacement: r.replacement,
                decryptFailed: true
            };
        }

        return { original, replacement: r.replacement };
    });
}

/**
 * Get the config directory path
 */
export function getConfigDir(): string {
    return CONFIG_DIR;
}
