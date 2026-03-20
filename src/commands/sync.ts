/**
 * Sync Command
 * Re-pull files from sources — all at once or per-source
 */

import * as vscode from 'vscode';
import { existsSync } from 'fs';
import { resolve, join } from 'path';
import { SidebarProvider } from '../views/sidebar-provider';
import { createAnonymizer, Replacement } from '../core/anonymizer';
import { copyFiles } from '../core/copier';
import { getAllFiles } from '../core/scanner';
import {
    hasMapping, loadMapping, decryptMappingV2, MappingV2,
    getSourceLabels, getSourceByLabel, SourceEntry
} from '../core/mapper';
import { hasSecret, getOrCreateSecret } from '../core/crypto';

/**
 * Sync all sources
 */
export async function executeSync(
    sidebarProvider: SidebarProvider,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    try {
        const { cloakedDir, mapping } = await loadAndDecrypt();
        if (!cloakedDir || !mapping) { return; }

        const sourceLabels = getSourceLabels(mapping);
        if (sourceLabels.length === 0) {
            vscode.window.showWarningMessage('No sources found.');
            return;
        }

        const confirm = await vscode.window.showInformationMessage(
            `Re-pull all files from ${sourceLabels.length} source(s)?`,
            { modal: true },
            'Sync All'
        );
        if (confirm !== 'Sync All') { return; }

        const replacements = extractReplacements(mapping);
        await syncSources(cloakedDir, mapping, replacements, sourceLabels, outputChannel);

        sidebarProvider.refresh();
        vscode.window.showInformationMessage(`Sync complete — ${sourceLabels.length} source(s) updated`);

    } catch (error) {
        vscode.window.showErrorMessage(`Sync failed: ${(error as Error).message}`);
    }
}

/**
 * Sync a single source by label
 */
export async function executeSyncSource(
    label: string,
    sidebarProvider: SidebarProvider,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    try {
        const { cloakedDir, mapping } = await loadAndDecrypt();
        if (!cloakedDir || !mapping) { return; }

        const source = getSourceByLabel(mapping, label);
        if (!source) {
            vscode.window.showErrorMessage(`Source "${label}" not found.`);
            return;
        }

        const replacements = extractReplacements(mapping);
        await syncSources(cloakedDir, mapping, replacements, [label], outputChannel);

        sidebarProvider.refresh();
        vscode.window.showInformationMessage(`Synced "${label}"`);

    } catch (error) {
        vscode.window.showErrorMessage(`Sync failed: ${(error as Error).message}`);
    }
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

async function loadAndDecrypt(): Promise<{ cloakedDir: string | null; mapping: MappingV2 | null }> {
    const cloakedDir = findCloakedDirectory();
    if (!cloakedDir) {
        vscode.window.showErrorMessage('No cloaked workspace found.');
        return { cloakedDir: null, mapping: null };
    }

    let mapping = loadMapping(cloakedDir);
    if (mapping.encrypted && hasSecret()) {
        try {
            mapping = decryptMappingV2(mapping, getOrCreateSecret());
        } catch {
            vscode.window.showErrorMessage('Could not decrypt mapping.');
            return { cloakedDir: null, mapping: null };
        }
    }

    return { cloakedDir, mapping };
}

function extractReplacements(mapping: MappingV2): Replacement[] {
    return (mapping.replacements as any[] || [])
        .filter((r: any) => r.original)
        .map((r: any) => ({ original: r.original, replacement: r.replacement }));
}

async function syncSources(
    cloakedDir: string,
    mapping: MappingV2,
    replacements: Replacement[],
    labels: string[],
    outputChannel: vscode.OutputChannel
): Promise<void> {
    const anonymizer = createAnonymizer(replacements);

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: labels.length === 1 ? `Syncing "${labels[0]}"...` : 'Syncing sources...',
            cancellable: false
        },
        async (progress) => {
            let totalSynced = 0;

            for (let i = 0; i < labels.length; i++) {
                const label = labels[i];
                const source = getSourceByLabel(mapping, label)!;

                progress.report({
                    message: labels.length > 1 ? `${label} (${i + 1}/${labels.length})` : label,
                    increment: (1 / labels.length) * 100
                });

                if (!source.path || !existsSync(source.path)) {
                    outputChannel.appendLine(`[warn] Skipping "${label}" — source path not found: ${source.path}`);
                    continue;
                }

                const filesToSync = source.files
                    .map(f => resolve(source.path, f.original))
                    .filter(f => existsSync(f));

                // Check for locally-added files
                const sourceSubdir = join(cloakedDir, label);
                if (existsSync(sourceSubdir)) {
                    const localFiles = getAllFiles(sourceSubdir);
                    const reverseReplacements = replacements.map(r => ({
                        original: r.replacement,
                        replacement: r.original
                    }));

                    for (const localFile of localFiles) {
                        let relPath = localFile.relativePath;
                        for (const { original, replacement } of reverseReplacements) {
                            const regex = new RegExp(original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                            relPath = relPath.replace(regex, replacement);
                        }
                        const absSourcePath = resolve(source.path, relPath);
                        if (existsSync(absSourcePath) && !filesToSync.includes(absSourcePath)) {
                            filesToSync.push(absSourcePath);
                        }
                    }
                }

                if (filesToSync.length === 0) {
                    outputChannel.appendLine(`[warn] No files to sync for "${label}"`);
                    continue;
                }

                const destBase = join(cloakedDir, label);
                const results = await copyFiles(
                    filesToSync,
                    source.path,
                    destBase,
                    anonymizer,
                    undefined,
                    replacements
                );

                totalSynced += results.copied;
                outputChannel.appendLine(`[done] ${label}: ${results.copied} files synced`);
            }

            outputChannel.appendLine(`\n[done] Total: ${totalSynced} files synced`);
        }
    );
}

function findCloakedDirectory(): string | null {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) { return null; }
    for (const folder of workspaceFolders) {
        if (hasMapping(folder.uri.fsPath)) { return folder.uri.fsPath; }
    }
    return null;
}
