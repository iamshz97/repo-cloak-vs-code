/**
 * Push Command
 * Restore files from cloaked workspace back to their original source directories
 */

import * as vscode from 'vscode';
import { existsSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';
import { SidebarProvider } from '../views/sidebar-provider';
import { createDeanonymizer } from '../core/anonymizer';
import { copyFiles } from '../core/copier';
import { getAllFiles } from '../core/scanner';
import {
    hasMapping, loadMapping, decryptMappingV2, MappingV2,
    getSourceLabels, getSourceByLabel
} from '../core/mapper';
import { hasSecret, getOrCreateSecret } from '../core/crypto';

/**
 * Push a single source or let user pick which source to push
 */
export async function executePush(
    sidebarProvider: SidebarProvider,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    try {
        // ── Step 1: Find cloaked directory ───────────────────────────────────
        let cloakedDir = findCloakedDirectory();

        if (!cloakedDir) {
            const uris = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: 'Select Cloaked Directory',
                title: 'Where is the cloaked workspace you want to restore from?'
            });
            if (!uris || uris.length === 0) { return; }
            cloakedDir = uris[0].fsPath;
        }

        if (!hasMapping(cloakedDir)) {
            vscode.window.showErrorMessage('No repo-cloak mapping file found in this directory.');
            return;
        }

        // ── Step 2: Load and decrypt mapping ────────────────────────────────
        let mapping = loadMapping(cloakedDir);

        if (mapping.encrypted && hasSecret()) {
            try {
                mapping = decryptMappingV2(mapping, getOrCreateSecret());
            } catch {
                vscode.window.showWarningMessage('Could not decrypt mapping with current secret key.');
            }
        }

        // ── Step 3: Pick which source to push ───────────────────────────────
        const sourceLabels = getSourceLabels(mapping);

        if (sourceLabels.length === 0) {
            vscode.window.showErrorMessage('No sources found in the mapping.');
            return;
        }

        let targetLabel: string;

        if (sourceLabels.length === 1) {
            targetLabel = sourceLabels[0];
        } else {
            const pick = await vscode.window.showQuickPick(
                sourceLabels.map(label => {
                    const source = getSourceByLabel(mapping, label);
                    return {
                        label: label,
                        description: `${source?.files.length || 0} files → ${source?.path || '[encrypted]'}`,
                        value: label
                    };
                }),
                { title: 'Which source do you want to push?' }
            );
            if (!pick) { return; }
            targetLabel = (pick as any).value;
        }

        const source = getSourceByLabel(mapping, targetLabel);
        if (!source) {
            vscode.window.showErrorMessage(`Source "${targetLabel}" not found in mapping.`);
            return;
        }

        // ── Step 4: Show mapping info ───────────────────────────────────────
        outputChannel.clear();
        outputChannel.appendLine(`Source: ${targetLabel}`);
        outputChannel.appendLine(`  Original path: ${source.path}`);
        outputChannel.appendLine(`  Files: ${source.files.length}`);
        outputChannel.appendLine(`  Replacements: ${mapping.replacements?.length || 0}`);

        if (mapping.replacements && mapping.replacements.length > 0) {
            outputChannel.appendLine('  Replacements to reverse:');
            for (const r of mapping.replacements as any[]) {
                const orig = r.original || '[encrypted]';
                outputChannel.appendLine(`    "${r.replacement}" -> "${orig}"`);
            }
        }

        // ── Step 5: Get destination ─────────────────────────────────────────
        let destDir: string;

        if (source.path && existsSync(source.path)) {
            const useOriginal = await vscode.window.showInformationMessage(
                `Restore to original location? (${source.path})`,
                { modal: true },
                'Restore to original',
                'Choose different location'
            );

            if (useOriginal === 'Restore to original') {
                destDir = source.path;
            } else if (useOriginal === 'Choose different location') {
                const uris = await vscode.window.showOpenDialog({
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false,
                    openLabel: 'Select Destination',
                    title: 'Where should files be restored to?'
                });
                if (!uris || uris.length === 0) { return; }
                destDir = uris[0].fsPath;
            } else {
                return;
            }
        } else {
            if (source.path) {
                vscode.window.showWarningMessage(`Original path no longer exists: ${source.path}`);
            }
            const uris = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: 'Select Destination',
                title: 'Where should files be restored to?'
            });
            if (!uris || uris.length === 0) { return; }
            destDir = uris[0].fsPath;
        }

        // ── Step 6: Confirm ─────────────────────────────────────────────────
        const confirm = await vscode.window.showInformationMessage(
            `Restore ${source.files.length} files from "${targetLabel}" to ${destDir}?`,
            { modal: true },
            'Restore'
        );

        if (confirm !== 'Restore') { return; }

        // ── Step 7: Create destination if needed ────────────────────────────
        if (!existsSync(destDir)) {
            mkdirSync(destDir, { recursive: true });
        }

        // ── Step 8: Copy and de-anonymize ───────────────────────────────────
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Restoring "${targetLabel}"...`,
                cancellable: false
            },
            async (progress) => {
                const validReplacements = (mapping.replacements as any[] || []).filter((r: any) => r.original);
                const deanonymizer = createDeanonymizer(validReplacements);

                const reversedReplacements = validReplacements.map((r: any) => ({
                    original: r.replacement,
                    replacement: r.original
                }));

                // Get all files from the source subdirectory in the cloaked workspace
                const sourceSubdir = join(cloakedDir!, targetLabel);
                const files = getAllFiles(sourceSubdir).filter(f => f.name !== 'AGENTS.md');

                if (files.length === 0) {
                    vscode.window.showWarningMessage('No files found in the cloaked directory.');
                    return;
                }

                const results = await copyFiles(
                    files,
                    sourceSubdir,
                    destDir,
                    deanonymizer,
                    (current, total, file) => {
                        progress.report({
                            increment: (1 / total) * 100,
                            message: `${current}/${total} — ${file}`
                        });
                    },
                    reversedReplacements
                );

                outputChannel.appendLine(`\n[done] Restored ${results.copied} files`);
                if (results.pathsRenamed > 0) {
                    outputChannel.appendLine(`  ${results.pathsRenamed} paths restored`);
                }
                if (results.transformed > 0) {
                    outputChannel.appendLine(`  ${results.transformed} files had content restored`);
                }
                if (results.errors.length > 0) {
                    outputChannel.appendLine(`  [warn] ${results.errors.length} errors`);
                    results.errors.forEach(e => outputChannel.appendLine(`    - ${e.file}: ${e.error}`));
                }
            }
        );

        sidebarProvider.refresh();
        vscode.window.showInformationMessage(`Restored "${targetLabel}" to ${destDir}`);

    } catch (error) {
        vscode.window.showErrorMessage(`Push failed: ${(error as Error).message}`);
    }
}

/**
 * Push all sources at once
 */
export async function executePushAll(
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
                vscode.window.showWarningMessage('Could not decrypt mapping.');
                return;
            }
        }

        const sourceLabels = getSourceLabels(mapping);
        if (sourceLabels.length === 0) {
            vscode.window.showWarningMessage('No sources found.');
            return;
        }

        // Show summary
        const sourceInfo = sourceLabels.map(label => {
            const source = getSourceByLabel(mapping, label);
            return `  ${label} -> ${source?.path || '[unknown]'} (${source?.files.length || 0} files)`;
        }).join('\n');

        const confirm = await vscode.window.showInformationMessage(
            `Push all ${sourceLabels.length} source(s) to their original locations?`,
            { modal: true, detail: sourceInfo },
            'Push All'
        );

        if (confirm !== 'Push All') { return; }

        // Push each source
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Restoring all sources...',
                cancellable: false
            },
            async (progress) => {
                const validReplacements = (mapping.replacements as any[] || []).filter((r: any) => r.original);
                const deanonymizer = createDeanonymizer(validReplacements);
                const reversedReplacements = validReplacements.map((r: any) => ({
                    original: r.replacement,
                    replacement: r.original
                }));

                let totalRestored = 0;

                for (let i = 0; i < sourceLabels.length; i++) {
                    const label = sourceLabels[i];
                    const source = getSourceByLabel(mapping, label)!;

                    if (!source.path || !existsSync(source.path)) {
                        outputChannel.appendLine(`[warn] Skipping "${label}" — original path not found: ${source.path}`);
                        continue;
                    }

                    const sourceSubdir = join(cloakedDir!, label);
                    const files = getAllFiles(sourceSubdir).filter(f => f.name !== 'AGENTS.md');

                    progress.report({
                        message: `${label} (${i + 1}/${sourceLabels.length})`,
                        increment: (1 / sourceLabels.length) * 100
                    });

                    const results = await copyFiles(
                        files,
                        sourceSubdir,
                        source.path,
                        deanonymizer,
                        undefined,
                        reversedReplacements
                    );

                    totalRestored += results.copied;
                    outputChannel.appendLine(`[done] ${label}: ${results.copied} files restored to ${source.path}`);
                }

                outputChannel.appendLine(`\n[done] Total: ${totalRestored} files restored across ${sourceLabels.length} sources`);
            }
        );

        sidebarProvider.refresh();
        vscode.window.showInformationMessage(`All ${sourceLabels.length} sources restored`);

    } catch (error) {
        vscode.window.showErrorMessage(`Push All failed: ${(error as Error).message}`);
    }
}

/**
 * Find cloaked directory in workspace
 */
function findCloakedDirectory(): string | null {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) { return null; }

    for (const folder of workspaceFolders) {
        if (hasMapping(folder.uri.fsPath)) {
            return folder.uri.fsPath;
        }
    }
    return null;
}
