import * as vscode from 'vscode';
import { join, resolve, dirname } from 'path';
import { existsSync, unlinkSync, rmdirSync, readdirSync } from 'fs';
import {
    loadMapping, loadRawMapping, getSourceLabels, getSourceByLabel,
    decryptMappingV2, getStaleFiles, removeFilesFromSource, saveMapping
} from '../core/mapper';
import { createAnonymizer, Replacement } from '../core/anonymizer';
import { copyFiles } from '../core/copier';
import { getOrCreateSecret, hasSecret } from '../core/crypto';
import { SidebarProvider } from '../views/sidebar-provider';

function findCloakedDirectory(): string | null {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) { return null; }
    for (const folder of workspaceFolders) {
        if (existsSync(join(folder.uri.fsPath, '.repo-cloak-map.json'))) {
            return folder.uri.fsPath;
        }
    }
    return null;
}

/**
 * Force Pull all sources (quietly updates all logged files from original paths)
 */
export async function executeForcePullAll(
    sidebarProvider: SidebarProvider,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    try {
        const cloakedDir = findCloakedDirectory();
        if (!cloakedDir) {
            vscode.window.showErrorMessage('No cloaked workspace found. Open a cloaked directory first.');
            return;
        }

        const rawMapping = loadRawMapping(cloakedDir);
        if (!rawMapping) { return; }

        let mapping = loadMapping(cloakedDir);
        if (mapping.encrypted && hasSecret()) {
            try {
                mapping = decryptMappingV2(mapping, getOrCreateSecret());
            } catch {
                vscode.window.showWarningMessage('Could not decrypt mapping for force pull. Ensure secret is entered.');
                return;
            }
        }

        const sourceLabels = getSourceLabels(mapping);
        if (sourceLabels.length === 0) {
            vscode.window.showWarningMessage('No sources found to update.');
            return;
        }

        outputChannel.clear();
        outputChannel.appendLine('[Force Pull All] Started updating mapped files...');
        outputChannel.show();

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Updating all sources...',
                cancellable: false
            },
            async (progress) => {
                const replacements = (mapping.replacements as Replacement[] || []).filter(r => r.original);
                const anonymizer = createAnonymizer(replacements);

                for (let i = 0; i < sourceLabels.length; i++) {
                    const label = sourceLabels[i];
                    const source = getSourceByLabel(mapping, label)!;

                    if (!source.path || !existsSync(source.path)) {
                        outputChannel.appendLine(`[warn] Skipping "${label}" — original path not found: ${source.path}`);
                        continue;
                    }

                    const sourceDir = source.path;
                    const destSubdir = join(cloakedDir, label);

                    const validFiles = source.files
                        .map((f: any) => resolve(sourceDir, f.original))
                        .filter(f => existsSync(f));

                    if (validFiles.length === 0) {
                        outputChannel.appendLine(`[warn] Skipping "${label}" — none of the mapped files exist locally anymore.`);
                        continue;
                    }

                    progress.report({
                        message: `${label} (${i + 1}/${sourceLabels.length})`,
                        increment: (1 / sourceLabels.length) * 100
                    });

                    const results = await copyFiles(
                        validFiles, sourceDir, destSubdir, anonymizer, undefined, replacements
                    );

                    outputChannel.appendLine(`[done] "${label}" — Updated ${results.copied} files`);
                    if (results.errors.length > 0) {
                        outputChannel.appendLine(`  [warn] ${results.errors.length} errors`);
                        results.errors.forEach(e => outputChannel.appendLine(`    - ${e.file}: ${e.error}`));
                    }
                }
            }
        );

        vscode.window.showInformationMessage(`Force Pull complete for all sources.`);

        for (const label of sourceLabels) {
            await maybeHandleOrphans(cloakedDir, mapping, label, outputChannel);
        }

    } catch (error) {
        vscode.window.showErrorMessage(`Force Pull failed: ${(error as Error).message}`);
    } finally {
        sidebarProvider.refresh();
    }
}

/**
 * Force Pull a specific source (quietly updates mapped files for ONE source)
 */
export async function executeForcePullSource(
    label: string,
    sidebarProvider: SidebarProvider,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    try {
        const cloakedDir = findCloakedDirectory();
        if (!cloakedDir) {
            vscode.window.showErrorMessage('No cloaked workspace found.');
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

        const source = getSourceByLabel(mapping, label);
        if (!source || !source.path || !existsSync(source.path)) {
            vscode.window.showWarningMessage(`Original path not found or not accessible for "${label}".`);
            return;
        }

        const sourceDir = source.path;
        const destSubdir = join(cloakedDir, label);
        const replacements = (mapping.replacements as Replacement[] || []).filter(r => r.original);
        const anonymizer = createAnonymizer(replacements);

        const validFiles = source.files
            .map((f: any) => resolve(sourceDir, f.original))
            .filter(f => existsSync(f));

        if (validFiles.length === 0) {
            vscode.window.showWarningMessage(`No previously mapped files currently exist in "${label}".`);
            return;
        }

        // Confirm — this overwrites the cloaked workspace copy
        const confirm = await vscode.window.showWarningMessage(
            `Force Pull will overwrite the cloaked copy of "${label}" with files from the source.`,
            {
                modal: true,
                detail: `Source: ${sourceDir}\n\nAny unsaved edits to the cloaked copy will be lost. Force Push writes cloaked changes back to the source instead.`
            },
            'Force Pull'
        );
        if (confirm !== 'Force Pull') { return; }

        outputChannel.clear();
        outputChannel.appendLine(`[Force Pull Source] Updating mapped files for "${label}"...`);

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: `$(shield) $(cloud-download) Force Pulling "${label}"...` },
            async (progress) => {
                const results = await copyFiles(
                    validFiles, sourceDir, destSubdir, anonymizer,
                    (current, total) => {
                        progress.report({
                            increment: (1 / total) * 100,
                            message: `${current}/${total}`
                        });
                    },
                    replacements
                );

                outputChannel.appendLine(`[done] Updated ${results.copied} files`);
                if (results.errors.length > 0) {
                    outputChannel.appendLine(`  [warn] ${results.errors.length} errors`);
                    results.errors.forEach(e => outputChannel.appendLine(`    - ${e.file}: ${e.error}`));
                }
            }
        );

        vscode.window.showInformationMessage(`Updated ${validFiles.length} files for "${label}"`);

        await maybeHandleOrphans(cloakedDir, mapping, label, outputChannel);

    } catch (error) {
        vscode.window.showErrorMessage(`Force Pull failed: ${(error as Error).message}`);
    } finally {
        sidebarProvider.refresh();
    }
}

// ─── Orphan handling ────────────────────────────────────────────────────────────

type OrphanPolicy = 'prompt' | 'delete' | 'keep';

function getOrphanPolicy(): OrphanPolicy {
    const cfg = vscode.workspace.getConfiguration('repo-cloak');
    const v = cfg.get<string>('forcePull.orphanPolicy', 'prompt');
    return (v === 'delete' || v === 'keep') ? v : 'prompt';
}

async function maybeHandleOrphans(
    cloakedDir: string,
    mapping: any,
    label: string,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    const stale = getStaleFiles(mapping, label);
    if (stale.length === 0) { return; }

    const policy = getOrphanPolicy();

    if (policy === 'keep') {
        outputChannel.appendLine(`[orphan] "${label}" — ${stale.length} file(s) no longer in source (kept by policy).`);
        return;
    }

    let shouldDelete = policy === 'delete';
    if (policy === 'prompt') {
        const choice = await vscode.window.showWarningMessage(
            `${stale.length} file(s) in "${label}" no longer exist in the source repository.`,
            { modal: true },
            'Delete from cloaked workspace',
            'Resolve interactively',
            'Keep'
        );
        if (!choice || choice === 'Keep') { return; }
        if (choice === 'Resolve interactively') {
            await vscode.commands.executeCommand('repo-cloak.resolveOrphans', label);
            return;
        }
        shouldDelete = true;
    }

    if (shouldDelete) {
        const removed: string[] = [];
        for (const s of stale) {
            const abs = join(cloakedDir, s.cloaked);
            try {
                if (existsSync(abs)) { unlinkSync(abs); }
                pruneEmptyDirs(dirname(abs), cloakedDir);
                removed.push(s.cloaked);
            } catch (err) {
                outputChannel.appendLine(`[orphan] Failed to delete ${abs}: ${(err as Error).message}`);
            }
        }
        // Reload raw mapping so we re-encrypt against the latest on-disk state.
        const raw = loadRawMapping(cloakedDir);
        if (raw) {
            const updated = removeFilesFromSource(raw, label, removed);
            saveMapping(cloakedDir, updated);
        }
        outputChannel.appendLine(`[orphan] "${label}" — removed ${removed.length} orphaned file(s).`);
        vscode.window.showInformationMessage(`Removed ${removed.length} orphaned file(s) from "${label}".`);
    }
}

function pruneEmptyDirs(startDir: string, stopAt: string): void {
    let dir = startDir;
    while (dir.startsWith(stopAt) && dir !== stopAt) {
        try {
            if (readdirSync(dir).length === 0) {
                rmdirSync(dir);
                dir = dirname(dir);
            } else { break; }
        } catch { break; }
    }
}
