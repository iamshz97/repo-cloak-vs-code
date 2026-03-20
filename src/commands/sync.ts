/**
 * Sync Command
 * One-click re-pull all files from all sources (equivalent to --force in CLI)
 */

import * as vscode from 'vscode';
import { existsSync } from 'fs';
import { resolve, join, relative } from 'path';
import { SidebarProvider } from '../views/sidebar-provider';
import { createAnonymizer, Replacement } from '../core/anonymizer';
import { copyFiles } from '../core/copier';
import { getAllFiles } from '../core/scanner';
import {
    hasMapping, loadMapping, decryptMappingV2, MappingV2,
    getSourceLabels, getSourceByLabel, saveMapping
} from '../core/mapper';
import { hasSecret, getOrCreateSecret } from '../core/crypto';

export async function executeSync(
    sidebarProvider: SidebarProvider,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    try {
        const cloakedDir = findCloakedDirectory();
        if (!cloakedDir) {
            vscode.window.showErrorMessage('No cloaked workspace found. Open a cloaked directory first.');
            return;
        }

        let mapping = loadMapping(cloakedDir);

        if (mapping.encrypted && hasSecret()) {
            try {
                mapping = decryptMappingV2(mapping, getOrCreateSecret());
            } catch {
                vscode.window.showErrorMessage('Could not decrypt mapping. Cannot sync.');
                return;
            }
        }

        const sourceLabels = getSourceLabels(mapping);
        if (sourceLabels.length === 0) {
            vscode.window.showWarningMessage('No sources found.');
            return;
        }

        // Confirm
        const confirm = await vscode.window.showInformationMessage(
            `Re-pull all files from ${sourceLabels.length} source(s)?`,
            { modal: true },
            'Sync All'
        );

        if (confirm !== 'Sync All') { return; }

        // Get replacements
        const replacements: Replacement[] = (mapping.replacements as any[] || [])
            .filter((r: any) => r.original)
            .map((r: any) => ({ original: r.original, replacement: r.replacement }));

        const anonymizer = createAnonymizer(replacements);

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Syncing all sources...',
                cancellable: false
            },
            async (progress) => {
                let totalSynced = 0;

                for (let i = 0; i < sourceLabels.length; i++) {
                    const label = sourceLabels[i];
                    const source = getSourceByLabel(mapping, label)!;

                    progress.report({
                        message: `${label} (${i + 1}/${sourceLabels.length})`,
                        increment: (1 / sourceLabels.length) * 100
                    });

                    if (!source.path || !existsSync(source.path)) {
                        outputChannel.appendLine(`⚠️ Skipping "${label}" — source path not found: ${source.path}`);
                        continue;
                    }

                    // Get files from source that are in the mapping
                    const filesToSync = source.files
                        .map(f => resolve(source.path, f.original))
                        .filter(f => existsSync(f));

                    // Also scan for any new files in cloaked dir that may have been manually added
                    const localFiles = getAllFiles(join(cloakedDir!, label));
                    const reverseReplacements = replacements.map(r => ({
                        original: r.replacement,
                        replacement: r.original
                    }));

                    for (const localFile of localFiles) {
                        let relPath = localFile.relativePath;
                        // Reverse anonymize to get potential source path
                        for (const { original, replacement } of reverseReplacements) {
                            const regex = new RegExp(original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                            relPath = relPath.replace(regex, replacement);
                        }
                        const absSourcePath = resolve(source.path, relPath);
                        if (existsSync(absSourcePath) && !filesToSync.includes(absSourcePath)) {
                            filesToSync.push(absSourcePath);
                        }
                    }

                    if (filesToSync.length === 0) {
                        outputChannel.appendLine(`⚠️ No files to sync for "${label}"`);
                        continue;
                    }

                    const destBase = join(cloakedDir!, label);
                    const results = await copyFiles(
                        filesToSync,
                        source.path,
                        destBase,
                        anonymizer,
                        undefined,
                        replacements
                    );

                    totalSynced += results.copied;
                    outputChannel.appendLine(`✓ ${label}: ${results.copied} files synced`);
                }

                outputChannel.appendLine(`\n✓ Total: ${totalSynced} files synced across ${sourceLabels.length} sources`);
            }
        );

        sidebarProvider.refresh();
        vscode.window.showInformationMessage(`✓ Sync complete — ${sourceLabels.length} source(s) updated`);

    } catch (error) {
        vscode.window.showErrorMessage(`Sync failed: ${(error as Error).message}`);
    }
}

function findCloakedDirectory(): string | null {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) { return null; }
    for (const folder of workspaceFolders) {
        if (hasMapping(folder.uri.fsPath)) { return folder.uri.fsPath; }
    }
    return null;
}
