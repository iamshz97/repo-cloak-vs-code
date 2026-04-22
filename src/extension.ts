/**
 * Repo Cloak — VS Code Extension Entry Point
 * Selectively extract and anonymize files from repositories
 */

import * as vscode from 'vscode';
import { SidebarProvider } from './views/sidebar-provider';
import { FileTreeProvider } from './views/file-tree-provider';
import { executePull, executePullSource, executePullSourceGit, executePullAction } from './commands/pull';
import { executePush, executePushAll, executePushAction, executeForcePushSource } from './commands/push';
import { executeForcePullAll, executeForcePullSource } from './commands/force-pull';
import { executeCopyForAI } from './commands/copy-for-ai';
import { executeResolveOrphans } from './commands/orphans';
import {
    hasMapping, loadRawMapping, decryptMappingV2,
    removeSourceFromMapping, saveMapping, getSourceLabels
} from './core/mapper';
import { getOrCreateSecret, encryptReplacements, hasSecret } from './core/crypto';
import { getPresets, savePreset, deletePreset, ReplacementPair } from './core/presets';
import { executePrSummary, executeManagePrTemplates } from './commands/pr-summary';
import { registerChatParticipant } from './chat/participant';

export function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('Repo Cloak');

    // ─── PR Summary ─────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.prSummary', () => executePrSummary())
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.managePrTemplates', () => executeManagePrTemplates())
    );

    // ─── Chat participant (@repo-cloak) ─────────────────────────────────────
    registerChatParticipant(context);

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
        vscode.commands.registerCommand('repo-cloak.pullAction', () => {
            executePullAction(fileTreeProvider, sidebarProvider, outputChannel);
        })
    );

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

    // Pull from Git changes for a specific source
    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.pullSourceGit', (label?: string) => {
            executePullSourceGit(label, fileTreeProvider, sidebarProvider, outputChannel);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.forcePullAll', () => {
            executeForcePullAll(sidebarProvider, outputChannel);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.forcePullSource', (label?: string) => {
            if (label) {
                executeForcePullSource(label, sidebarProvider, outputChannel);
            }
        })
    );

    // ─── Push ───────────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.pushAction', () => {
            executePushAction(sidebarProvider, outputChannel);
        })
    );
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

    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.forcePushSource', (label?: string) => {
            if (label) {
                executeForcePushSource(label, sidebarProvider, outputChannel);
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
            try {
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
            vscode.window.showInformationMessage(`Removed source "${label}"`);
            } finally { sidebarProvider.refresh(); }
        })
    );

    // ─── Replacements ───────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.addReplacement', async () => {
            try {
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
            vscode.window.showInformationMessage(`Added replacement: "${original}" \u2192 "${replacement}"`);
            } finally { sidebarProvider.refresh(); }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.removeReplacement', async (original?: string) => {
            try {
            const cloakedDir = findCloakedDirectory();
            if (!cloakedDir) {
                vscode.window.showErrorMessage('No cloaked workspace found.');
                return;
            }

            let mapping = loadRawMapping(cloakedDir);
            if (!mapping || !mapping.replacements || mapping.replacements.length === 0) { return; }

            let removedCount = 0;

            if (mapping.encrypted && hasSecret()) {
                const secret = getOrCreateSecret();
                const decrypted = decryptMappingV2(mapping, secret);
                
                if (!original) {
                    const pick = await vscode.window.showQuickPick(
                        (decrypted.replacements as any[]).map(r => ({ label: r.original, description: `→ ${r.replacement}` })),
                        { title: 'Which replacement do you want to remove?' }
                    );
                    if (!pick) { return; }
                    original = pick.label;
                }

                const confirm = await vscode.window.showWarningMessage(
                    `Remove replacement for "${original}"?`,
                    { modal: true },
                    'Remove'
                );
                if (confirm !== 'Remove') { return; }

                const remainingDecrypted = (decrypted.replacements as any[]).filter(r => r.original !== original);
                mapping.replacements = encryptReplacements(remainingDecrypted, secret);
                removedCount = (decrypted.replacements.length - remainingDecrypted.length);
            } else if (!mapping.encrypted) {
                if (!original) {
                    const pick = await vscode.window.showQuickPick(
                        (mapping.replacements as any[]).map(r => ({ label: r.original, description: `→ ${r.replacement}` })),
                        { title: 'Which replacement do you want to remove?' }
                    );
                    if (!pick) { return; }
                    original = pick.label;
                }

                const confirm = await vscode.window.showWarningMessage(
                    `Remove replacement for "${original}"?`,
                    { modal: true },
                    'Remove'
                );
                if (confirm !== 'Remove') { return; }

                const initialLength = mapping.replacements.length;
                mapping.replacements = (mapping.replacements as any[]).filter(r => r.original !== original);
                removedCount = initialLength - mapping.replacements.length;
            } else {
                vscode.window.showErrorMessage('Cannot remove replacement because mapping is encrypted and secret is missing.');
                return;
            }

            if (removedCount > 0) {
                mapping.stats = {
                    ...mapping.stats,
                    replacementsCount: mapping.replacements.length
                };
                saveMapping(cloakedDir, mapping);
                vscode.window.showInformationMessage(`Removed replacement for "${original}"`);
            }
            } finally { sidebarProvider.refresh(); }
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
    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.searchFileSelection', async () => {
            const term = await vscode.window.showInputBox({
                prompt: 'Enter search term to filter files',
                placeHolder: 'e.g., config, auth, utils'
            });
            // undefined means user cancelled; empty string means clear filter
            if (term !== undefined) {
                fileTreeProvider.setSearchFilter(term);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.clearFileSelectionSearch', () => {
            fileTreeProvider.setSearchFilter('');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.selectAllFiles', () => {
            fileTreeProvider.selectAll();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.deselectAllFiles', () => {
            fileTreeProvider.deselectAll();
        })
    );

    // ─── Copy for AI ────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.copyForAI', (label?: string) => {
            executeCopyForAI(label, fileTreeProvider, sidebarProvider, outputChannel);
        })
    );

    // ─── Resolve orphaned files ─────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.resolveOrphans', (label?: string) => {
            executeResolveOrphans(label, sidebarProvider, outputChannel);
        })
    );

    // ─── Manage replacement presets ─────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.managePresets', async () => {
            const presets = getPresets();

            if (presets.length === 0) {
                const choice = await vscode.window.showInformationMessage(
                    'No replacement presets saved yet. Create one now?',
                    'Create preset', 'Cancel'
                );
                if (choice !== 'Create preset') { return; }

                const name = await vscode.window.showInputBox({
                    prompt: 'Preset name',
                    placeHolder: 'e.g., ACME project, Client A',
                    validateInput: v => v.trim() ? null : 'Name cannot be empty'
                });
                if (!name?.trim()) { return; }

                const pairs: ReplacementPair[] = [];
                while (true) {
                    const original = await vscode.window.showInputBox({
                        prompt: `Keyword to replace — ${pairs.length} pair(s) so far (leave empty to finish)`,
                        placeHolder: 'e.g., Microsoft Corp'
                    });
                    if (!original?.trim()) { break; }
                    const replacement = await vscode.window.showInputBox({
                        prompt: `Replace "${original}" with:`,
                        placeHolder: 'e.g., ACME Inc',
                        validateInput: v => v.trim() ? null : 'Replacement cannot be empty'
                    });
                    if (!replacement) { break; }
                    pairs.push({ original: original.trim(), replacement: replacement.trim() });
                }
                if (pairs.length === 0) {
                    vscode.window.showWarningMessage('No pairs entered — preset not saved.');
                    return;
                }
                savePreset({ name: name.trim(), pairs });
                vscode.window.showInformationMessage(`Preset "${name.trim()}" created with ${pairs.length} pair(s).`);
                return;
            }

            // List presets to select one to manage
            type PresetItem = vscode.QuickPickItem & { presetName: string };
            const items: PresetItem[] = presets.map(p => ({
                label: p.name,
                description: `${p.pairs.length} pair(s)`,
                detail: p.pairs.slice(0, 3).map(r => `"${r.original}" → "${r.replacement}"`).join(', ') +
                    (p.pairs.length > 3 ? ` …+${p.pairs.length - 3} more` : ''),
                presetName: p.name
            }));
            items.push({ label: '$(add) Create new preset', description: '', presetName: '__new__' });

            const pick = await vscode.window.showQuickPick(items, {
                title: 'Replacement Presets',
                placeHolder: 'Select a preset to edit or delete'
            });
            if (!pick) { return; }

            if ((pick as any).presetName === '__new__') {
                vscode.commands.executeCommand('repo-cloak.managePresets');
                return;
            }

            const preset = presets.find(p => p.name === pick.presetName)!;

            const action = await vscode.window.showQuickPick([
                { label: '$(edit) Edit pairs', description: 'Re-enter all replacement pairs', value: 'edit' },
                { label: '$(add) Add pairs', description: 'Append more pairs to this preset', value: 'add' },
                { label: '$(trash) Delete preset', description: 'Permanently remove this preset', value: 'delete' }
            ], {
                title: `Preset: ${preset.name}`,
                placeHolder: 'Choose an action'
            });
            if (!action) { return; }

            if ((action as any).value === 'delete') {
                const confirm = await vscode.window.showWarningMessage(
                    `Delete preset "${preset.name}"? This cannot be undone.`,
                    { modal: true },
                    'Delete'
                );
                if (confirm === 'Delete') {
                    deletePreset(preset.name);
                    vscode.window.showInformationMessage(`Preset "${preset.name}" deleted.`);
                }
                return;
            }

            const existingPairs = (action as any).value === 'edit' ? [] : [...preset.pairs];

            // Prompt for new/additional pairs
            const newPairs: ReplacementPair[] = [];
            while (true) {
                const original = await vscode.window.showInputBox({
                    prompt: `Keyword to replace — ${newPairs.length + existingPairs.length} pair(s) so far (leave empty to finish)`,
                    placeHolder: 'e.g., Microsoft Corp'
                });
                if (!original?.trim()) { break; }
                const replacement = await vscode.window.showInputBox({
                    prompt: `Replace "${original}" with:`,
                    placeHolder: 'e.g., ACME Inc',
                    validateInput: v => v.trim() ? null : 'Replacement cannot be empty'
                });
                if (!replacement) { break; }
                newPairs.push({ original: original.trim(), replacement: replacement.trim() });
            }

            const combined = (action as any).value === 'edit'
                ? newPairs
                : [...existingPairs, ...newPairs.filter(n => !existingPairs.some(e => e.original === n.original))];

            if (combined.length === 0 && (action as any).value === 'edit') {
                const ok = await vscode.window.showWarningMessage(
                    'No pairs entered — preset would be empty. Save anyway (to clear all pairs)?',
                    { modal: true },
                    'Save empty', 'Cancel'
                );
                if (ok !== 'Save empty') { return; }
            }

            savePreset({ name: preset.name, pairs: combined });
            vscode.window.showInformationMessage(
                `Preset "${preset.name}" updated — ${combined.length} pair(s).`
            );
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
