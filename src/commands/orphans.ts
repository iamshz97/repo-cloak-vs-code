/**
 * Orphan Resolution Command
 * Lets the user resolve files that exist in the cloaked workspace but no
 * longer exist in the source repository.
 */

import * as vscode from 'vscode';
import { existsSync, unlinkSync, rmdirSync, readdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { SidebarProvider } from '../views/sidebar-provider';
import {
    hasMapping, loadRawMapping, decryptMappingV2, MappingV2,
    getStaleFiles, removeFilesFromSource, saveMapping, getSourceByLabel,
    getSourceLabels, StaleFile
} from '../core/mapper';
import { hasSecret, getOrCreateSecret } from '../core/crypto';
import { createDeanonymizer, Replacement } from '../core/anonymizer';
import { copyFileWithTransform } from '../core/copier';
import { notifySuccess, notifyInfo } from '../core/notify';

export async function executeResolveOrphans(
    initialLabel: string | undefined,
    sidebarProvider: SidebarProvider,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    try {
        const cloakedDir = findCloakedDirectory();
        if (!cloakedDir) {
            vscode.window.showErrorMessage('No cloaked workspace found.');
            return;
        }

        const raw = loadRawMapping(cloakedDir);
        if (!raw) { return; }

        let mapping = raw;
        if (raw.encrypted && hasSecret()) {
            try { mapping = decryptMappingV2(raw, getOrCreateSecret()); }
            catch {
                vscode.window.showErrorMessage('Could not decrypt mapping.');
                return;
            }
        }

        let label = initialLabel;
        if (!label) {
            const labels = getSourceLabels(mapping).filter(l => getStaleFiles(mapping, l).length > 0);
            if (labels.length === 0) {
                notifyInfo('No orphaned files detected — everything is in sync.');
                return;
            }
            if (labels.length === 1) {
                label = labels[0];
            } else {
                const pick = await vscode.window.showQuickPick(
                    labels.map(l => ({ label: l, description: `${getStaleFiles(mapping, l).length} orphan(s)` })),
                    { title: 'Pick a source to resolve' }
                );
                if (!pick) { return; }
                label = pick.label;
            }
        }

        const stale = getStaleFiles(mapping, label);
        if (stale.length === 0) {
            notifyInfo(`No orphaned files in "${label}".`);
            return;
        }

        const items = stale.map<vscode.QuickPickItem & { stale: StaleFile }>(s => ({
            label: s.cloaked,
            description: `→ source: ${s.original}`,
            picked: true,
            stale: s
        }));

        const picked = await vscode.window.showQuickPick(items, {
            canPickMany: true,
            title: `Orphaned files in "${label}" — pick which to act on`
        });
        if (!picked || picked.length === 0) { return; }

        const action = await vscode.window.showQuickPick(
            [
                { label: '$(trash) Delete from cloaked workspace', value: 'delete' },
                { label: '$(repo-push) Push back to source repository', value: 'push' },
                { label: '$(eye-closed) Cancel', value: 'cancel' }
            ],
            { title: `What should happen to ${picked.length} file(s)?` }
        );
        if (!action || (action as any).value === 'cancel') { return; }

        const source = getSourceByLabel(mapping, label)!;
        const replacements = (mapping.replacements as Replacement[] || []).filter(r => r.original);

        if ((action as any).value === 'delete') {
            const confirm = await vscode.window.showWarningMessage(
                `Delete ${picked.length} file(s) from the cloaked workspace? This cannot be undone.`,
                { modal: true }, 'Delete'
            );
            if (confirm !== 'Delete') { return; }

            const removed: string[] = [];
            for (const item of picked) {
                const abs = join(cloakedDir, item.stale.cloaked);
                try {
                    if (existsSync(abs)) { unlinkSync(abs); }
                    pruneEmptyDirs(dirname(abs), cloakedDir);
                    removed.push(item.stale.cloaked);
                } catch (err) {
                    outputChannel.appendLine(`[orphan] Failed to delete ${abs}: ${(err as Error).message}`);
                }
            }
            const updated = removeFilesFromSource(mapping, label, removed);
            saveMapping(cloakedDir, updated);
            notifySuccess(`Removed ${removed.length} orphan(s) from "${label}".`);

        } else if ((action as any).value === 'push') {
            if (!source.path || !existsSync(source.path)) {
                vscode.window.showErrorMessage(`Source path not accessible: ${source.path}`);
                return;
            }
            const deanonymizer = createDeanonymizer(replacements);
            let pushed = 0;
            for (const item of picked) {
                const cloakedAbs = join(cloakedDir, item.stale.cloaked);
                const sourceAbs = resolve(source.path, item.stale.original);
                if (!existsSync(cloakedAbs)) { continue; }
                try {
                    copyFileWithTransform(cloakedAbs, sourceAbs, deanonymizer);
                    pushed++;
                } catch (err) {
                    outputChannel.appendLine(`[orphan] Failed to push ${item.stale.original}: ${(err as Error).message}`);
                }
            }
            notifySuccess(`Pushed ${pushed} file(s) back to source.`);
        }

    } catch (error) {
        vscode.window.showErrorMessage(`Resolve orphans failed: ${(error as Error).message}`);
    } finally {
        sidebarProvider.refresh();
    }
}

function findCloakedDirectory(): string | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) { return null; }
    for (const f of folders) {
        if (hasMapping(f.uri.fsPath)) { return f.uri.fsPath; }
    }
    return null;
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
