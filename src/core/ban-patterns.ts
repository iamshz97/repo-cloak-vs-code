/**
 * Ban Patterns Module
 * Stores global wildcard patterns for files that should never be pulled,
 * plus per-file overrides that exempt specific paths from matching patterns.
 *
 * Patterns are plain glob strings (e.g. "*.Designer.cs", "**\/Migrations\/**", "*.env").
 * They are stored unencrypted since they are user-defined glob rules, not sensitive paths.
 *
 * Stored at ~/.repo-cloak/ban-patterns.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';

const CONFIG_DIR = join(homedir(), '.repo-cloak');
const PATTERNS_FILE = join(CONFIG_DIR, 'ban-patterns.json');

export interface BanPatternsData {
    version: string;
    /** Glob patterns — files matching any of these are excluded from all pull operations */
    patterns: string[];
    /**
     * Per-file overrides: relative paths (from any source root) that are explicitly
     * allowed through even if they match a pattern.
     */
    overrides: string[];
}

function loadRaw(): BanPatternsData {
    try {
        if (!existsSync(PATTERNS_FILE)) {
            return { version: '1.0', patterns: [], overrides: [] };
        }
        const raw = readFileSync(PATTERNS_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        return {
            version: parsed.version || '1.0',
            patterns: Array.isArray(parsed.patterns) ? parsed.patterns : [],
            overrides: Array.isArray(parsed.overrides) ? parsed.overrides : [],
        };
    } catch {
        return { version: '1.0', patterns: [], overrides: [] };
    }
}

function saveRaw(data: BanPatternsData): void {
    try {
        if (!existsSync(CONFIG_DIR)) {
            mkdirSync(CONFIG_DIR, { recursive: true });
        }
        writeFileSync(PATTERNS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
    } catch {
        // Silently ignore write errors
    }
}

/** Returns true if the ban-patterns file exists (cheap guard before loading). */
export function hasPatterns(): boolean {
    if (!existsSync(PATTERNS_FILE)) { return false; }
    const data = loadRaw();
    return data.patterns.length > 0;
}

/** Return all current patterns and overrides. */
export function getBanPatterns(): BanPatternsData {
    return loadRaw();
}

/** Add a glob pattern. No-ops if already present. */
export function addPattern(pattern: string): void {
    const data = loadRaw();
    const p = pattern.trim();
    if (!p || data.patterns.includes(p)) { return; }
    data.patterns.push(p);
    saveRaw(data);
}

/** Remove a glob pattern by value. */
export function removePattern(pattern: string): void {
    const data = loadRaw();
    data.patterns = data.patterns.filter(p => p !== pattern);
    saveRaw(data);
}

/** Add an override (relative path exempt from pattern matching). */
export function addOverride(relPath: string): void {
    const data = loadRaw();
    const p = relPath.trim().replace(/\\/g, '/');
    if (!p || data.overrides.includes(p)) { return; }
    data.overrides.push(p);
    saveRaw(data);
}

/** Remove an override. */
export function removeOverride(relPath: string): void {
    const data = loadRaw();
    data.overrides = data.overrides.filter(o => o !== relPath);
    saveRaw(data);
}

/**
 * Minimal glob matcher — supports:
 *   *        matches any sequence of chars within a single path segment
 *   **       matches any sequence of chars including path separators
 *   ?        matches exactly one char (not a separator)
 *   leading *\/ or **\/ anchors to any directory depth
 *
 * The pattern is matched against both the full relative path AND just the
 * basename, so "*.Designer.cs" catches "foo/bar/Widget.Designer.cs".
 */
function globMatch(pattern: string, relPath: string): boolean {
    const norm = relPath.replace(/\\/g, '/');
    const name = basename(norm);

    function toRegex(glob: string): RegExp {
        let src = '';
        let i = 0;
        while (i < glob.length) {
            const ch = glob[i];
            if (ch === '*' && glob[i + 1] === '*') {
                src += '.*';
                i += 2;
                if (glob[i] === '/') { i++; } // skip trailing slash after **
            } else if (ch === '*') {
                src += '[^/]*';
                i++;
            } else if (ch === '?') {
                src += '[^/]';
                i++;
            } else {
                // Escape regex special chars
                src += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
                i++;
            }
        }
        return new RegExp('^' + src + '$', 'i');
    }

    const re = toRegex(pattern);
    return re.test(norm) || re.test(name);
}

/**
 * Returns the first matching pattern if `relPath` matches any ban pattern
 * AND is not in the overrides list. Returns null if the file should be allowed.
 *
 * relPath must be relative to the source repo root (forward slashes).
 */
export function matchesAnyPattern(relPath: string): string | null {
    const data = loadRaw();
    if (data.patterns.length === 0) { return null; }

    const norm = relPath.replace(/\\/g, '/');

    // Check overrides first
    if (data.overrides.some(o => o === norm || o === basename(norm))) {
        return null;
    }

    for (const pattern of data.patterns) {
        if (globMatch(pattern, norm)) {
            return pattern;
        }
    }
    return null;
}
