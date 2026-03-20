/**
 * Repo Cloak — VS Code Extension Entry Point
 * Selectively extract and anonymize files from repositories
 */

import * as vscode from 'vscode';
import { SidebarProvider } from './views/sidebar-provider';
import { FileTreeProvider } from './views/file-tree-provider';
import { executePull, executePullSource } from './commands/pull';
import { executePush, executePushAll } from './commands/push';
import { executeSync, executeSyncSource } from './commands/sync';
import {
    hasMapping, loadRawMapping,
    removeSourceFromMapping, saveMapping, getSourceLabels
} from './core/mapper';
import { getOrCreateSecret, encryptReplacements } from './core/crypto';

export function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('Repo Cloak');

    // ─── Sidebar ────────────────────────────────────────────────────────────
    const sidebarProvider = new SidebarProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebarProvider)
    );

    // ─── File Tree ──────────────────────────────────────────────────────────
    const fileTreeProvider = new FileTreeProvider();
    const treeView = vscode.window.createTreeView('repo-cloak.fileTree', {
        treeDataProvider: fileTreeProvider,
        manageCheckboxStateManually: true,
        showCollapseAll: true
    });
    fileTreeProvider.setTreeView(treeView);

    treeView.onDidChangeCheckboxState((e) => {
        for (const [item, state] of e.items) {
            fileTreeProvider.handleCheckboxChange(item, state);
        }
    });

    context.subscriptions.push(treeView);

    // ─── Pull ───────────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.pull', () => {
            executePull(fileTreeProvider, sidebarProvider, outputChannel);
        })
    );

    // Pull for a specific source (re-pull / add more files)
    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.pullSource', (label?: string) => {
            executePullSource(label, fileTreeProvider, sidebarProvider, outputChannel);
        })
    );

    // ─── Push ───────────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.push', () => {
            executePush(sidebarProvider, outputChannel);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.pushAll', () => {
            executePushAll(sidebarProvider, outputChannel);
        })
    );

    // ─── Sync ───────────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.sync', () => {
            executeSync(sidebarProvider, outputChannel);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.syncSource', (label?: string) => {
            if (label) {
                executeSyncSource(label, sidebarProvider, outputChannel);
            }
        })
    );

    // ─── Source management ──────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.addSource', () => {
            executePull(fileTreeProvider, sidebarProvider, outputChannel);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.removeSource', async (label?: string) => {
            const cloakedDir = findCloakedDirectory();
            if (!cloakedDir) {
                vscode.window.showErrorMessage('No cloaked workspace found.');
                return;
            }

            let mapping = loadRawMapping(cloakedDir);
            if (!mapping) { return; }

            const sourceLabels = getSourceLabels(mapping);

            if (!label) {
                const pick = await vscode.window.showQuickPick(
                    sourceLabels.map(l => ({ label: l })),
                    { title: 'Which source do you want to remove?' }
                );
                if (!pick) { return; }
                label = pick.label;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Remove source "${label}" from the mapping? Files in the cloaked directory will not be deleted.`,
                { modal: true },
                'Remove'
            );
            if (confirm !== 'Remove') { return; }

            mapping = removeSourceFromMapping(mapping, label);
            saveMapping(cloakedDir, mapping);
            sidebarProvider.refresh();
            vscode.window.showInformationMessage(`Removed source "${label}"`);
        })
    );

    // ─── Replacements ───────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.addReplacement', async () => {
            const cloakedDir = findCloakedDirectory();
            if (!cloakedDir) {
                vscode.window.showErrorMessage('No cloaked workspace found. Pull files first.');
                return;
            }

            const original = await vscode.window.showInputBox({
                prompt: 'Keyword to replace',
                placeHolder: 'e.g., Microsoft Corp'
            });
            if (!original || !original.trim()) { return; }

            const replacement = await vscode.window.showInputBox({
                prompt: `Replace "${original}" with:`,
                placeHolder: 'e.g., ACME Inc',
                validateInput: v => v.trim() ? null : 'Replacement cannot be empty'
            });
            if (!replacement) { return; }

            const mapping = loadRawMapping(cloakedDir);
            if (!mapping) { return; }

            const secret = getOrCreateSecret();
            const newRepl = encryptReplacements(
                [{ original: original.trim(), replacement: replacement.trim() }],
                secret
            );

            mapping.replacements = [...(mapping.replacements || []), ...newRepl];
            mapping.stats = {
                ...mapping.stats,
                replacementsCount: mapping.replacements.length
            };

            saveMapping(cloakedDir, mapping);
            sidebarProvider.refresh();
            vscode.window.showInformationMessage(`Added replacement: "${original}" \u2192 "${replacement}"`);
        })
    );

    // ─── File tree controls ─────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.confirmFileSelection', () => {
            fileTreeProvider.confirmSelection();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.cancelFileSelection', () => {
            fileTreeProvider.cancelSelection();
        })
    );

    // ─── Auto-refresh ───────────────────────────────────────────────────────
    const watcher = vscode.workspace.createFileSystemWatcher('**/.repo-cloak-map.json');
    watcher.onDidChange(() => sidebarProvider.refresh());
    watcher.onDidCreate(() => sidebarProvider.refresh());
    watcher.onDidDelete(() => sidebarProvider.refresh());
    context.subscriptions.push(watcher);

    outputChannel.appendLine('Repo Cloak extension activated');
}

export function deactivate() { }

function findCloakedDirectory(): string | null {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) { return null; }
    for (const folder of workspaceFolders) {
        if (hasMapping(folder.uri.fsPath)) { return folder.uri.fsPath; }
    }
    return null;
}
