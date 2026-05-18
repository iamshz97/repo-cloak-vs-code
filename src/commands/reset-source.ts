import * as vscode from 'vscode';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import {
    loadRawMapping, decryptMappingV2, MappingV2,
    getSourceLabels, getSourceByLabel, removeFilesFromSource, saveMapping
} from '../core/mapper';
import { hasSecret, getOrCreateSecret } from '../core/crypto';
import { pullFilesProgrammatically } from '../lm-tools/pull-helper';
import { SidebarProvider } from '../views/sidebar-provider';
import { notifySuccess, notifyWarn } from '../core/notify';

interface FilePickItem extends vscode.QuickPickItem {
    cloakedPath: string;
    originalPath: string;
}

function findCloakedDirectory(): string | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) { return null; }
    for (const f of folders) {
        if (existsSync(join(f.uri.fsPath, '.repo-cloak-map.json'))) { return f.uri.fsPath; }
    }
    return null;
}

export async function executeResetSource(
    labelArg: string | undefined,
    sidebarProvider: SidebarProvider,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    const cloakedDir = findCloakedDirectory();
    if (!cloakedDir) {
        vscode.window.showErrorMessage('No cloaked workspace found.');
        return;
    }

    // Load mapping — decrypt for display
    const rawForDisplay = loadRawMapping(cloakedDir);
    if (!rawForDisplay) {
        vscode.window.showErrorMessage('No mapping found.');
        return;
    }
    let mapping: MappingV2 = rawForDisplay;
    if (rawForDisplay.encrypted) {
        if (!hasSecret()) {
            vscode.window.showErrorMessage('Mapping is encrypted but no secret available.');
            return;
        }
        mapping = decryptMappingV2(rawForDisplay, getOrCreateSecret());
    }

    const sourceLabels = getSourceLabels(mapping);
    if (sourceLabels.length === 0) {
        notifyWarn('No sources found.');
        return;
    }

    // Pick source label
    let label = labelArg;
    if (!label) {
        if (sourceLabels.length === 1) {
            label = sourceLabels[0];
        } else {
            const pick = await vscode.window.showQuickPick(
                sourceLabels.map(l => ({ label: l })),
                { title: 'Repo Cloak: Reset Source — which source?' }
            );
            if (!pick) { return; }
            label = pick.label;
        }
    }

    const source = getSourceByLabel(mapping, label);
    if (!source) {
        vscode.window.showErrorMessage(`Source "${label}" not found.`);
        return;
    }
    if (!source.path || !existsSync(source.path)) {
        vscode.window.showErrorMessage(`Source path not accessible for "${label}". Is the original repository mounted?`);
        return;
    }
    if (source.files.length === 0) {
        notifyWarn(`No files mapped for "${label}".`);
        return;
    }

    // QuickPick: all mapped files, all pre-selected — deselect to keep as-is
    const items: FilePickItem[] = source.files.map(f => ({
        label: f.original,
        description: f.cloaked,
        picked: true,
        cloakedPath: f.cloaked,
        originalPath: f.original
    }));

    const picks = await vscode.window.showQuickPick(items, {
        title: `Reset "${label}" — uncheck files to keep them as-is`,
        placeHolder: 'All files selected — press Enter to reset all, or uncheck individual files',
        canPickMany: true
    }) as FilePickItem[] | undefined;

    if (!picks || picks.length === 0) { return; }

    const confirm = await vscode.window.showWarningMessage(
        `Reset "${label}": delete and re-pull ${picks.length} file(s) fresh from the source?`,
        { modal: true },
        'Reset'
    );
    if (confirm !== 'Reset') { return; }

    outputChannel.clear();
    outputChannel.appendLine(`[reset] "${label}": resetting ${picks.length} file(s)…`);
    outputChannel.show();

    // Step 1: Delete selected cloaked files from disk
    let deleted = 0;
    for (const pick of picks) {
        const absPath = join(cloakedDir, pick.cloakedPath);
        if (existsSync(absPath)) {
            try {
                unlinkSync(absPath);
                deleted++;
            } catch (e) {
                outputChannel.appendLine(`[reset] Could not delete ${absPath}: ${(e as Error).message}`);
            }
        }
    }
    outputChannel.appendLine(`[reset] Deleted ${deleted} cloaked file(s).`);

    // Step 2: Remove selected entries from mapping so they can be re-pulled cleanly
    const rawMapping = loadRawMapping(cloakedDir);
    if (!rawMapping) { return; }
    const cloakedToRemove = picks.map(p => p.cloakedPath);
    const updatedRaw = removeFilesFromSource(rawMapping, label, cloakedToRemove);
    saveMapping(cloakedDir, updatedRaw);

    // Step 3: Re-pull the selected original paths fresh from source
    const originalPaths = picks.map(p => p.originalPath);

    try {
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Re-pulling "${label}"…`, cancellable: false },
            async () => {
                const result = await pullFilesProgrammatically(
                    { cloakedDir, sourceLabel: label!, relativePaths: originalPaths, skipSecretScan: false },
                    sidebarProvider,
                    outputChannel
                );

                outputChannel.appendLine(
                    `[reset] Pulled ${result.pulled}/${result.requested}` +
                    (result.skippedNotFound.length > 0
                        ? ` — ${result.skippedNotFound.length} file(s) no longer found in source`
                        : '')
                );
                if (result.skippedBanned.length > 0) {
                    outputChannel.appendLine(`[reset] Skipped ${result.skippedBanned.length} banned file(s).`);
                }
            }
        );

        notifySuccess(`Reset "${label}": ${picks.length} file(s) refreshed from source`);
    } catch (e) {
        vscode.window.showErrorMessage(`Re-pull failed: ${(e as Error).message}`);
    }

    sidebarProvider.refresh();
}
