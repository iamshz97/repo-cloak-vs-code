/**
 * Replacement Presets
 * Stores named, reusable sets of keyword replacements encrypted on the local machine.
 * File: ~/.repo-cloak/presets.json (mode 0o600)
 *
 * Preset names are stored plaintext so the list is readable without decryption.
 * All original/replacement values are AES-256 encrypted.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { encrypt, decrypt, getOrCreateSecret, hasSecret } from './crypto';

const CONFIG_DIR = join(homedir(), '.repo-cloak');
const PRESETS_FILE = join(CONFIG_DIR, 'presets.json');

export interface ReplacementPair {
    original: string;
    replacement: string;
}

export interface ReplacementPreset {
    name: string;
    /** Pairs are stored with original/replacement encrypted in the file. */
    pairs: ReplacementPair[];
}

// ─── Internal storage types (on-disk) ────────────────────────────────────────

interface StoredPair {
    original: string;   // encrypted
    replacement: string; // encrypted
}

interface StoredPreset {
    name: string;        // plaintext
    pairs: StoredPair[];
}

interface PresetsFile {
    presets: StoredPreset[];
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function loadRaw(): PresetsFile {
    try {
        if (!existsSync(PRESETS_FILE)) { return { presets: [] }; }
        const raw = readFileSync(PRESETS_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        return { presets: Array.isArray(parsed.presets) ? parsed.presets : [] };
    } catch {
        return { presets: [] };
    }
}

function saveRaw(data: PresetsFile): void {
    try {
        if (!existsSync(CONFIG_DIR)) { mkdirSync(CONFIG_DIR, { recursive: true }); }
        writeFileSync(PRESETS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
    } catch { /* silently ignore */ }
}

function decryptPairs(stored: StoredPair[], secret: string): ReplacementPair[] {
    const out: ReplacementPair[] = [];
    for (const p of stored) {
        try {
            const original = decrypt(p.original, secret);
            const replacement = decrypt(p.replacement, secret);
            if (original && replacement) { out.push({ original, replacement }); }
        } catch { /* skip corrupt entry */ }
    }
    return out;
}

function encryptPairs(pairs: ReplacementPair[], secret: string): StoredPair[] {
    return pairs.map(p => ({
        original: encrypt(p.original, secret),
        replacement: encrypt(p.replacement, secret)
    }));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Return all presets with pairs fully decrypted.
 * Returns [] if no secret exists yet.
 */
export function getPresets(): ReplacementPreset[] {
    if (!hasSecret()) { return []; }
    const secret = getOrCreateSecret();
    const { presets } = loadRaw();
    return presets.map(sp => ({
        name: sp.name,
        pairs: decryptPairs(sp.pairs, secret)
    }));
}

/**
 * Persist a preset (create or overwrite by name).
 */
export function savePreset(preset: ReplacementPreset): void {
    const secret = getOrCreateSecret();
    const data = loadRaw();
    const stored: StoredPreset = {
        name: preset.name,
        pairs: encryptPairs(preset.pairs, secret)
    };
    const idx = data.presets.findIndex(p => p.name === preset.name);
    if (idx >= 0) {
        data.presets[idx] = stored;
    } else {
        data.presets.push(stored);
    }
    saveRaw(data);
}

/**
 * Delete a preset by name. No-op if not found.
 */
export function deletePreset(name: string): void {
    const data = loadRaw();
    data.presets = data.presets.filter(p => p.name !== name);
    saveRaw(data);
}

/**
 * Append pairs to an existing preset. Creates it if it doesn't exist.
 */
export function appendToPreset(name: string, pairs: ReplacementPair[]): void {
    const existing = getPresets().find(p => p.name === name);
    const base = existing?.pairs ?? [];
    // Deduplicate by original keyword
    const merged = [...base];
    for (const pair of pairs) {
        if (!merged.some(m => m.original === pair.original)) {
            merged.push(pair);
        }
    }
    savePreset({ name, pairs: merged });
}
