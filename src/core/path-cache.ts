/**
 * Path Cache Module
 * Stores recently used source and destination paths, encrypted with the user's secret key.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { encrypt, decrypt, getOrCreateSecret, hasSecret } from './crypto';

const CONFIG_DIR = join(homedir(), '.repo-cloak');
const CACHE_FILE = join(CONFIG_DIR, 'path-cache.json');
const MAX_PATHS = 10;

interface PathCache {
    sources: string[];
    destinations: string[];
}

function loadRawCache(): PathCache {
    try {
        if (!existsSync(CACHE_FILE)) {
            return { sources: [], destinations: [] };
        }
        const raw = readFileSync(CACHE_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        return {
            sources: Array.isArray(parsed.sources) ? parsed.sources : [],
            destinations: Array.isArray(parsed.destinations) ? parsed.destinations : []
        };
    } catch {
        return { sources: [], destinations: [] };
    }
}

function saveRawCache(cache: PathCache): void {
    try {
        if (!existsSync(CONFIG_DIR)) {
            mkdirSync(CONFIG_DIR, { recursive: true });
        }
        writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
    } catch {
        // Silently ignore write errors
    }
}

function decryptPaths(encrypted: string[], secret: string): string[] {
    return encrypted
        .map(e => {
            try {
                return decrypt(e, secret);
            } catch {
                return null;
            }
        })
        .filter((p): p is string => p !== null);
}

/**
 * Get recently used source paths (decrypted)
 */
export function getSourcePaths(): string[] {
    if (!hasSecret()) { return []; }
    const secret = getOrCreateSecret();
    const cache = loadRawCache();
    return decryptPaths(cache.sources, secret);
}

/**
 * Get recently used destination paths (decrypted)
 */
export function getDestPaths(): string[] {
    if (!hasSecret()) { return []; }
    const secret = getOrCreateSecret();
    const cache = loadRawCache();
    return decryptPaths(cache.destinations, secret);
}

/**
 * Persist a source path to the cache (encrypted)
 */
export function addSourcePath(path: string): void {
    try {
        const secret = getOrCreateSecret();
        const cache = loadRawCache();
        const existing = decryptPaths(cache.sources, secret);
        const deduped = [path, ...existing.filter(p => p !== path)].slice(0, MAX_PATHS);
        cache.sources = deduped.map(p => encrypt(p, secret));
        saveRawCache(cache);
    } catch {
        // Silently ignore
    }
}

/**
 * Persist a destination path to the cache (encrypted)
 */
export function addDestPath(path: string): void {
    try {
        const secret = getOrCreateSecret();
        const cache = loadRawCache();
        const existing = decryptPaths(cache.destinations, secret);
        const deduped = [path, ...existing.filter(p => p !== path)].slice(0, MAX_PATHS);
        cache.destinations = deduped.map(p => encrypt(p, secret));
        saveRawCache(cache);
    } catch {
        // Silently ignore
    }
}
