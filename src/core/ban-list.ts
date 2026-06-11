/**
 * Ban List Module
 * Stores an encrypted per-source list of file paths that are permanently excluded
 * from pull operations and removed from the cloaked workspace.
 * Stored at ~/.repo-cloak/ban-list.json
 *
 * KEY DESIGN: entries are keyed on the absolute source repo path (encrypted),
 * NOT the human-readable label. This means:
 *   - Renaming a source label does NOT lose its bans
 *   - Two workspaces pointing at the same repo path share the same bans
 *   - Two workspaces pointing at different repos never bleed bans
 *
 * File format v2.0: { version: "2.0", entries: [{ sp, rp }] }
 *   sp = encrypt(absoluteSourcePath)
 *   rp = encrypt(originalRelPath)
 *
 * v1.0 entries used sl = encrypt(sourceLabel). They are preserved as-is and
 * silently ignored by path-based lookups (harmless orphans).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { encrypt, decrypt, getOrCreateSecret, hasSecret } from './crypto';

const CONFIG_DIR = join(homedir(), '.repo-cloak');
const BAN_FILE = join(CONFIG_DIR, 'ban-list.json');

interface RawBanEntry {
    /** v2: encrypt(absoluteSourcePath). v1 legacy: encrypt(sourceLabel) stored in `sl`. */
    sp?: string;
    /** v1 legacy only — kept so old entries are not corrupted on read */
    sl?: string;
    /** encrypt(originalRelPath) */
    rp: string;
}

interface RawBanList {
    version: string;
    entries: RawBanEntry[];
}

function loadRaw(): RawBanList {
    try {
        if (!existsSync(BAN_FILE)) {
            return { version: '2.0', entries: [] };
        }
        const raw = readFileSync(BAN_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        return {
            version: parsed.version || '1.0',
            entries: Array.isArray(parsed.entries) ? parsed.entries : []
        };
    } catch {
        return { version: '2.0', entries: [] };
    }
}

function saveRaw(data: RawBanList): void {
    try {
        if (!existsSync(CONFIG_DIR)) {
            mkdirSync(CONFIG_DIR, { recursive: true });
        }
        writeFileSync(BAN_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
    } catch {
        // Silently ignore write errors
    }
}

/**
 * Returns the set of banned original-relative paths for a given source repo path.
 * sourcePath must be the absolute path to the source repo root.
 */
export function getBannedSet(sourcePath: string, secret: string): Set<string> {
    const data = loadRaw();
    const result = new Set<string>();
    for (const entry of data.entries) {
        try {
            // v2 path-keyed entry
            if (entry.sp !== undefined) {
                const sp = decrypt(entry.sp, secret);
                if (sp !== sourcePath) { continue; }
            } else {
                // v1 label-keyed entry — skip for path-based lookups
                continue;
            }
            const rp = decrypt(entry.rp, secret);
            if (rp !== null) { result.add(rp); }
        } catch {
            // skip corrupt entries
        }
    }
    return result;
}

/**
 * Add a file to the ban list for the given source repo.
 * sourcePath: absolute path to the source repo root.
 * originalRelPath: path relative to that root.
 */
export function addBan(sourcePath: string, originalRelPath: string, secret: string): void {
    const data = loadRaw();

    // Avoid duplicates
    for (const entry of data.entries) {
        if (entry.sp === undefined) { continue; } // skip v1 entries
        try {
            const sp = decrypt(entry.sp, secret);
            const rp = decrypt(entry.rp, secret);
            if (sp === sourcePath && rp === originalRelPath) { return; }
        } catch {
            // skip
        }
    }

    data.entries.push({
        sp: encrypt(sourcePath, secret),
        rp: encrypt(originalRelPath, secret)
    });
    // Upgrade version marker once we've written a v2 entry
    data.version = '2.0';
    saveRaw(data);
}

/**
 * Remove a file from the ban list for the given source repo.
 * sourcePath: absolute path to the source repo root.
 */
export function removeBan(sourcePath: string, originalRelPath: string, secret: string): void {
    const data = loadRaw();
    data.entries = data.entries.filter(entry => {
        if (entry.sp === undefined) { return true; } // keep v1 entries untouched
        try {
            const sp = decrypt(entry.sp, secret);
            const rp = decrypt(entry.rp, secret);
            return !(sp === sourcePath && rp === originalRelPath);
        } catch {
            return true; // keep unreadable entries
        }
    });
    saveRaw(data);
}

/**
 * Returns all v2 bans, decrypted, keyed by source path.
 * sourcePath is the absolute source repo path (used as the canonical key).
 */
export function getAllBans(secret: string): Array<{ sourcePath: string; originalRelPath: string }> {
    const data = loadRaw();
    const result: Array<{ sourcePath: string; originalRelPath: string }> = [];
    for (const entry of data.entries) {
        if (entry.sp === undefined) { continue; } // skip v1 label-keyed entries
        try {
            const sp = decrypt(entry.sp, secret);
            const rp = decrypt(entry.rp, secret);
            if (sp !== null && rp !== null) {
                result.push({ sourcePath: sp, originalRelPath: rp });
            }
        } catch {
            // skip
        }
    }
    return result;
}

/**
 * Whether the ban-list file exists at all (used to skip unnecessary reads).
 */
export function hasBanList(): boolean {
    return existsSync(BAN_FILE);
}
