/**
 * Mapping File Manager — v2 with Multi-Source Support
 * Tracks multiple source repos, replacements, and file mappings
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getOrCreateSecret, encryptReplacements, decryptReplacements, encrypt, decrypt, EncryptedReplacement } from './crypto';

const MAP_FILENAME = '.repo-cloak-map.json';

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface FileEntry {
    original: string;   // relative path in source repo (encrypted in storage)
    cloaked: string;     // relative path in cloaked workspace
}

export interface SourceEntry {
    label: string;       // user-friendly name (e.g., "backend")
    path: string;        // absolute path to source repo (encrypted in storage)
    files: FileEntry[];
}

export interface MappingV2 {
    version: string;
    tool: string;
    timestamp: string;
    encrypted: boolean;
    sources: SourceEntry[];
    replacements: EncryptedReplacement[] | { original: string; replacement: string }[];
    stats: {
        totalFiles: number;
        totalSources: number;
        replacementsCount: number;
    };
    pullHistory?: Array<{
        timestamp: string;
        sourceLabel: string;
        filesAdded: number;
        totalFiles: number;
    }>;
    updatedAt?: string;
}

// ─── Create ─────────────────────────────────────────────────────────────────────

export interface CreateMappingOptions {
    sources: Array<{
        label: string;
        sourceDir: string;
        files: FileEntry[];
    }>;
    destDir: string;
    replacements: { original: string; replacement: string }[];
    timestamp?: string;
}

/**
 * Create a new v2 mapping object (encrypted)
 */
export function createMapping(options: CreateMappingOptions): MappingV2 {
    const {
        sources,
        destDir,
        replacements,
        timestamp = new Date().toISOString()
    } = options;

    const secret = getOrCreateSecret();

    const encryptedSources: SourceEntry[] = sources.map(s => ({
        label: s.label,
        path: encrypt(s.sourceDir, secret),
        files: s.files.map(f => ({
            original: encrypt(f.original, secret),
            cloaked: f.cloaked
        }))
    }));

    const encryptedReplacements = encryptReplacements(replacements, secret);

    const totalFiles = sources.reduce((sum, s) => sum + s.files.length, 0);

    return {
        version: '2.0.0',
        tool: 'repo-cloak',
        timestamp,
        encrypted: true,
        sources: encryptedSources,
        replacements: encryptedReplacements,
        stats: {
            totalFiles,
            totalSources: sources.length,
            replacementsCount: replacements.length
        }
    };
}

/**
 * Create mapping from a single source (convenience wrapper)
 */
export function createSingleSourceMapping(options: {
    label: string;
    sourceDir: string;
    destDir: string;
    replacements: { original: string; replacement: string }[];
    files: FileEntry[];
}): MappingV2 {
    return createMapping({
        sources: [{ label: options.label, sourceDir: options.sourceDir, files: options.files }],
        destDir: options.destDir,
        replacements: options.replacements
    });
}

// ─── Save / Load ────────────────────────────────────────────────────────────────

/**
 * Save mapping to destination directory
 */
export function saveMapping(destDir: string, mapping: MappingV2): string {
    const mapPath = join(destDir, MAP_FILENAME);
    writeFileSync(mapPath, JSON.stringify(mapping, null, 2), 'utf-8');
    return mapPath;
}

/**
 * Load mapping (raw, without decryption)
 */
export function loadRawMapping(dir: string): MappingV2 | null {
    const mapPath = join(dir, MAP_FILENAME);

    if (!existsSync(mapPath)) {
        return null;
    }

    try {
        const content = readFileSync(mapPath, 'utf-8');
        return JSON.parse(content);
    } catch {
        return null;
    }
}

/**
 * Load mapping with optional decryption
 */
export function loadMapping(dir: string): MappingV2 {
    const mapPath = join(dir, MAP_FILENAME);

    if (!existsSync(mapPath)) {
        throw new Error(`No mapping file found in ${dir}. Is this a repo-cloak backup?`);
    }

    const content = readFileSync(mapPath, 'utf-8');
    return JSON.parse(content);
}

/**
 * Check if a directory has a mapping file
 */
export function hasMapping(dir: string): boolean {
    return existsSync(join(dir, MAP_FILENAME));
}

// ─── Decrypt ────────────────────────────────────────────────────────────────────

/**
 * Fully decrypt a v2 mapping
 */
export function decryptMappingV2(mapping: MappingV2, secret: string): MappingV2 {
    if (!mapping.encrypted) {
        return mapping;
    }

    const decryptedSources: SourceEntry[] = mapping.sources.map(s => ({
        label: s.label,
        path: decrypt(s.path, secret) || s.path,
        files: s.files.map(f => ({
            original: decrypt(f.original, secret) || f.original,
            cloaked: f.cloaked
        }))
    }));

    const decryptedReplacements = decryptReplacements(
        mapping.replacements as EncryptedReplacement[],
        secret
    );

    return {
        ...mapping,
        sources: decryptedSources,
        replacements: decryptedReplacements.map(r => ({
            original: r.original || '',
            replacement: r.replacement
        }))
    };
}

// ─── Multi-Source Operations ─────────────────────────────────────────────────────

/**
 * Add a new source to an existing mapping
 */
export function addSourceToMapping(
    mapping: MappingV2,
    source: { label: string; sourceDir: string; files: FileEntry[] },
    replacements?: { original: string; replacement: string }[]
): MappingV2 {
    const secret = getOrCreateSecret();

    const encryptedSource: SourceEntry = {
        label: source.label,
        path: encrypt(source.sourceDir, secret),
        files: source.files.map(f => ({
            original: encrypt(f.original, secret),
            cloaked: f.cloaked
        }))
    };

    const updatedSources = [...mapping.sources, encryptedSource];

    // Merge new replacements if provided
    let updatedReplacements = mapping.replacements;
    if (replacements && replacements.length > 0) {
        const newEncrypted = encryptReplacements(replacements, secret);
        updatedReplacements = [...(mapping.replacements || []), ...newEncrypted];
    }

    const totalFiles = updatedSources.reduce((sum, s) => sum + s.files.length, 0);

    const pullHistory = mapping.pullHistory || [];
    pullHistory.push({
        timestamp: new Date().toISOString(),
        sourceLabel: source.label,
        filesAdded: source.files.length,
        totalFiles
    });

    return {
        ...mapping,
        sources: updatedSources,
        replacements: updatedReplacements,
        stats: {
            totalFiles,
            totalSources: updatedSources.length,
            replacementsCount: (updatedReplacements || []).length
        },
        pullHistory,
        updatedAt: new Date().toISOString()
    };
}

/**
 * Remove a source from the mapping by label
 */
export function removeSourceFromMapping(mapping: MappingV2, label: string): MappingV2 {
    const updatedSources = mapping.sources.filter(s => s.label !== label);
    const totalFiles = updatedSources.reduce((sum, s) => sum + s.files.length, 0);

    return {
        ...mapping,
        sources: updatedSources,
        stats: {
            ...mapping.stats,
            totalFiles,
            totalSources: updatedSources.length
        },
        updatedAt: new Date().toISOString()
    };
}

/**
 * Merge new files into an existing source within the mapping
 */
export function mergeFilesIntoSource(mapping: MappingV2, sourceLabel: string, newFiles: FileEntry[]): MappingV2 {
    const secret = getOrCreateSecret();

    const updatedSources = mapping.sources.map(s => {
        if (s.label !== sourceLabel) { return s; }

        const existingCloaked = new Set(s.files.map(f => f.cloaked));
        const uniqueNewFiles = newFiles
            .filter(f => !existingCloaked.has(f.cloaked))
            .map(f => ({
                original: encrypt(f.original, secret),
                cloaked: f.cloaked
            }));

        return {
            ...s,
            files: [...s.files, ...uniqueNewFiles]
        };
    });

    const totalFiles = updatedSources.reduce((sum, s) => sum + s.files.length, 0);

    const pullHistory = mapping.pullHistory || [];
    const addedCount = totalFiles - (mapping.stats?.totalFiles || 0);
    pullHistory.push({
        timestamp: new Date().toISOString(),
        sourceLabel,
        filesAdded: addedCount,
        totalFiles
    });

    return {
        ...mapping,
        sources: updatedSources,
        stats: {
            ...mapping.stats,
            totalFiles,
            totalSources: updatedSources.length
        },
        pullHistory,
        updatedAt: new Date().toISOString()
    };
}

/**
 * Get source by label
 */
export function getSourceByLabel(mapping: MappingV2, label: string): SourceEntry | undefined {
    return mapping.sources.find(s => s.label === label);
}

/**
 * Get all source labels
 */
export function getSourceLabels(mapping: MappingV2): string[] {
    return mapping.sources.map(s => s.label);
}

/**
 * Get the original source path from a source entry (assumes decrypted)
 */
export function getOriginalSourcePath(source: SourceEntry): string {
    return source.path;
}
