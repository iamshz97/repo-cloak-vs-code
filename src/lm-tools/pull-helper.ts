/**
 * Programmatic pull helper used by Language Model Tools.
 * Pulls a specific list of source-relative paths into an existing cloaked
 * source — same anonymizer + secret-scan + mapping pipeline as the manual
 * pull, but without any user prompts.
 */

import * as vscode from 'vscode';
import { existsSync } from 'fs';
import { join, relative } from 'path';
import {
    loadRawMapping, decryptMappingV2, getSourceByLabel, getSourceLabels,
    mergeFilesIntoSource, saveMapping, FileEntry
} from '../core/mapper';
import { hasSecret, getOrCreateSecret } from '../core/crypto';
import { createAnonymizer, anonymizePath, Replacement } from '../core/anonymizer';
import { copyFiles } from '../core/copier';
import { commitCloakedChange, pullSubject } from '../core/cloaked-git';
import { scanFilesForSecrets } from '../core/secrets';
import { getBannedSet, hasBanList } from '../core/ban-list';
import { SidebarProvider } from '../views/sidebar-provider';

export interface ProgrammaticPullInput {
    cloakedDir: string;
    sourceLabel: string;
    relativePaths: string[];
    skipSecretScan?: boolean;
}

export interface ProgrammaticPullResult {
    requested: number;
    pulled: number;
    skippedNotFound: string[];
    skippedBanned: string[];
    skippedAlreadyPulled: string[];
    skippedSecrets: Array<{ path: string; findings: string[] }>;
    pulledPaths: string[];
    errors: Array<{ file: string; error: string }>;
}

export async function pullFilesProgrammatically(
    input: ProgrammaticPullInput,
    sidebarProvider: SidebarProvider | null,
    outputChannel: vscode.OutputChannel
): Promise<ProgrammaticPullResult> {
    const { cloakedDir, sourceLabel, relativePaths, skipSecretScan } = input;

    const result: ProgrammaticPullResult = {
        requested: relativePaths.length,
        pulled: 0,
        skippedNotFound: [],
        skippedBanned: [],
        skippedAlreadyPulled: [],
        skippedSecrets: [],
        pulledPaths: [],
        errors: []
    };

    const rawMapping = loadRawMapping(cloakedDir);
    if (!rawMapping) {
        throw new Error('No mapping found in cloaked directory.');
    }

    let decryptedMapping = rawMapping;
    let replacements: Replacement[] = [];
    if (rawMapping.encrypted && hasSecret()) {
        decryptedMapping = decryptMappingV2(rawMapping, getOrCreateSecret());
        replacements = (decryptedMapping.replacements as Replacement[]).filter(r => r.original);
    }

    const source = getSourceByLabel(decryptedMapping, sourceLabel);
    if (!source) {
        throw new Error(`Source "${sourceLabel}" not found.`);
    }
    const sourceDir = source.path;
    if (!sourceDir || !existsSync(sourceDir)) {
        throw new Error(`Source path not accessible: ${sourceDir || '[encrypted]'}`);
    }

    // Already-pulled set (decrypted relative paths)
    const alreadyPulled = new Set(source.files.map(f => normalize(f.original)));

    // Banned set
    let banned = new Set<string>();
    if (hasBanList() && hasSecret()) {
        banned = getBannedSet(sourceLabel, getOrCreateSecret());
    }

    // Filter incoming paths
    const candidates: string[] = [];
    for (const raw of relativePaths) {
        const rel = normalize(raw);
        const abs = join(sourceDir, rel);
        if (banned.has(rel)) {
            result.skippedBanned.push(rel);
            continue;
        }
        if (alreadyPulled.has(rel)) {
            result.skippedAlreadyPulled.push(rel);
            continue;
        }
        if (!existsSync(abs)) {
            result.skippedNotFound.push(rel);
            continue;
        }
        candidates.push(abs);
    }

    if (candidates.length === 0) {
        return result;
    }

    // Secret scan
    if (!skipSecretScan) {
        const findings = await scanFilesForSecrets(candidates);
        if (findings.length > 0) {
            const findingsByFile = new Map<string, string[]>();
            for (const f of findings) {
                const arr = findingsByFile.get(f.file) || [];
                arr.push(`${f.type} (line ${f.line})`);
                findingsByFile.set(f.file, arr);
            }
            const safeCandidates: string[] = [];
            for (const abs of candidates) {
                if (findingsByFile.has(abs)) {
                    result.skippedSecrets.push({
                        path: relative(sourceDir, abs),
                        findings: findingsByFile.get(abs)!
                    });
                } else {
                    safeCandidates.push(abs);
                }
            }
            candidates.length = 0;
            candidates.push(...safeCandidates);
        }
    }

    if (candidates.length === 0) {
        return result;
    }

    // Copy + anonymize
    const anonymizer = createAnonymizer(replacements);
    const destBase = join(cloakedDir, sourceLabel);

    const copyResults = await copyFiles(
        candidates,
        sourceDir,
        destBase,
        anonymizer,
        undefined,
        replacements
    );

    result.errors = copyResults.errors;

    // Update mapping
    const newFiles: FileEntry[] = candidates
        .filter(abs => !copyResults.errors.some(e => e.file === relative(sourceDir, abs)))
        .map(abs => {
            const originalPath = relative(sourceDir, abs);
            const anonymized = anonymizePath(originalPath, replacements);
            return { original: originalPath, cloaked: join(sourceLabel, anonymized) };
        });

    if (newFiles.length > 0) {
        const updatedMapping = mergeFilesIntoSource(rawMapping, sourceLabel, newFiles);
        saveMapping(cloakedDir, updatedMapping);

        await commitCloakedChange(
            cloakedDir,
            pullSubject(sourceLabel, newFiles.length),
            newFiles.map(f => f.cloaked)
        );
    }

    result.pulled = newFiles.length;
    result.pulledPaths = newFiles.map(f => f.original);

    outputChannel.appendLine(
        `[lm-pull] "${sourceLabel}": pulled ${result.pulled}/${result.requested} ` +
        `(skipped — already:${result.skippedAlreadyPulled.length} banned:${result.skippedBanned.length} ` +
        `missing:${result.skippedNotFound.length} secrets:${result.skippedSecrets.length})`
    );

    if (sidebarProvider) {
        sidebarProvider.refresh();
    }

    return result;
}

/** Find the cloaked workspace folder, if any. */
export function findCloakedDirectory(): string | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) { return null; }
    for (const f of folders) {
        const candidate = join(f.uri.fsPath, '.repo-cloak-map.json');
        if (existsSync(candidate)) { return f.uri.fsPath; }
    }
    return null;
}

/** Normalize a relative path: strip leading ./, convert to forward slashes, drop trailing slash. */
export function normalize(p: string): string {
    return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
}

/** Get list of source labels (sync helper for tools). */
export function getAvailableSources(cloakedDir: string): string[] {
    const raw = loadRawMapping(cloakedDir);
    if (!raw) { return []; }
    let mapping = raw;
    if (raw.encrypted && hasSecret()) {
        mapping = decryptMappingV2(raw, getOrCreateSecret());
    }
    return getSourceLabels(mapping);
}
