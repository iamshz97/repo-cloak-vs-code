/**
 * Ban List Module
 * Stores an encrypted per-source list of file paths that are permanently excluded
 * from pull operations and removed from the cloaked workspace.
 * Stored at ~/.repo-cloak/ban-list.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { encrypt, decrypt, getOrCreateSecret, hasSecret } from './crypto';

const CONFIG_DIR = join(homedir(), '.repo-cloak');
const BAN_FILE = join(CONFIG_DIR, 'ban-list.json');

interface RawBanEntry {
    /** encrypt(sourceLabel) */
    sl: string;
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
            return { version: '1.0', entries: [] };
        }
        const raw = readFileSync(BAN_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        return {
            version: parsed.version || '1.0',
            entries: Array.isArray(parsed.entries) ? parsed.entries : []
        };
    } catch {
        return { version: '1.0', entries: [] };
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
 * Returns the set of banned original-relative paths for a given source label.
 */
export function getBannedSet(sourceLabel: string, secret: string): Set<string> {
    const data = loadRaw();
    const result = new Set<string>();
    for (const entry of data.entries) {
        try {
            const sl = decrypt(entry.sl, secret);
            if (sl !== sourceLabel) { continue; }
            const rp = decrypt(entry.rp, secret);
            if (rp !== null) { result.add(rp); }
        } catch {
            // skip corrupt entries
        }
    }
    return result;
}

/**
 * Add a file to the ban list for the given source.
 * originalRelPath is the path relative to the source repo root.
 */
export function addBan(sourceLabel: string, originalRelPath: string, secret: string): void {
    const data = loadRaw();

    // Avoid duplicates
    for (const entry of data.entries) {
        try {
            const sl = decrypt(entry.sl, secret);
            const rp = decrypt(entry.rp, secret);
            if (sl === sourceLabel && rp === originalRelPath) { return; }
        } catch {
            // skip
        }
    }

    data.entries.push({
        sl: encrypt(sourceLabel, secret),
        rp: encrypt(originalRelPath, secret)
    });
    saveRaw(data);
}

/**
 * Remove a file from the ban list for the given source.
 */
export function removeBan(sourceLabel: string, originalRelPath: string, secret: string): void {
    const data = loadRaw();
    data.entries = data.entries.filter(entry => {
        try {
            const sl = decrypt(entry.sl, secret);
            const rp = decrypt(entry.rp, secret);
            return !(sl === sourceLabel && rp === originalRelPath);
        } catch {
            return true; // keep unreadable entries
        }
    });
    saveRaw(data);
}

/**
 * Returns all bans, decrypted, grouped by source label.
 */
export function getAllBans(secret: string): Array<{ sourceLabel: string; originalRelPath: string }> {
    const data = loadRaw();
    const result: Array<{ sourceLabel: string; originalRelPath: string }> = [];
    for (const entry of data.entries) {
        try {
            const sl = decrypt(entry.sl, secret);
            const rp = decrypt(entry.rp, secret);
            if (sl !== null && rp !== null) {
                result.push({ sourceLabel: sl, originalRelPath: rp });
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
