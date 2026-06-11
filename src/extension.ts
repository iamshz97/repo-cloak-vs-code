/**
 * Repo Cloak — VS Code Extension Entry Point
 * Selectively extract and anonymize files from repositories
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { rmSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import { SidebarProvider } from './views/sidebar-provider';
import { FileTreeProvider } from './views/file-tree-provider';
import { executePull, executePullSource, executePullSourceGit, executePullAction } from './commands/pull';
import { executePush, executePushAll, executePushAction, executeForcePushSource } from './commands/push';
import { executeForcePullAll, executeForcePullSource } from './commands/force-pull';
import { executeResetSource } from './commands/reset-source';
import { executeFreshStart } from './commands/fresh-start';
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
import { executeBanFile } from './commands/ban-file';
import { addPattern, addOverride, getBanPatterns, setBanPatterns } from './core/ban-patterns';
import { notifySuccess, notifyWarn } from './core/notify';
import { ProbeFileTool } from './lm-tools/probe-file';
import { RequestPullTool } from './lm-tools/request-pull';

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
        vscode.commands.registerCommand('repo-cloak.pullAction', async () => {
            sidebarProvider.setProcessing(true);
            try { await executePullAction(fileTreeProvider, sidebarProvider, outputChannel); }
            finally { sidebarProvider.setProcessing(false); }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.pull', async () => {
            sidebarProvider.setProcessing(true);
            try { await executePull(fileTreeProvider, sidebarProvider, outputChannel); }
            finally { sidebarProvider.setProcessing(false); }
        })
    );

    // Pull for a specific source (re-pull / add more files)
    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.pullSource', async (label?: string) => {
            sidebarProvider.setProcessing(true);
            try { await executePullSource(label, fileTreeProvider, sidebarProvider, outputChannel); }
            finally { sidebarProvider.setProcessing(false); }
        })
    );

    // Pull from Git changes for a specific source
    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.pullSourceGit', async (label?: string) => {
            sidebarProvider.setProcessing(true);
            try { await executePullSourceGit(label, fileTreeProvider, sidebarProvider, outputChannel); }
            finally { sidebarProvider.setProcessing(false); }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.forcePullAll', async () => {
            sidebarProvider.setProcessing(true);
            try { await executeForcePullAll(sidebarProvider, outputChannel); }
            finally { sidebarProvider.setProcessing(false); }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.forcePullSource', async (label?: string) => {
            if (label) {
                sidebarProvider.setProcessing(true);
                try { await executeForcePullSource(label, sidebarProvider, outputChannel); }
                finally { sidebarProvider.setProcessing(false); }
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.resetSource', async (label?: string) => {
            sidebarProvider.setProcessing(true);
            try { await executeResetSource(label, sidebarProvider, outputChannel); }
            finally { sidebarProvider.setProcessing(false); }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.freshStart', async (label?: string) => {
            sidebarProvider.setProcessing(true);
            try { await executeFreshStart(label, fileTreeProvider, sidebarProvider, outputChannel); }
            finally { sidebarProvider.setProcessing(false); }
        })
    );

    // ─── Push ───────────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.pushAction', async () => {
            sidebarProvider.setProcessing(true);
            try { await executePushAction(sidebarProvider, outputChannel); }
            finally { sidebarProvider.setProcessing(false); }
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.push', async () => {
            sidebarProvider.setProcessing(true);
            try { await executePush(sidebarProvider, outputChannel); }
            finally { sidebarProvider.setProcessing(false); }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.pushAll', async () => {
            sidebarProvider.setProcessing(true);
            try { await executePushAll(sidebarProvider, outputChannel); }
            finally { sidebarProvider.setProcessing(false); }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.forcePushSource', async (label?: string) => {
            if (label) {
                sidebarProvider.setProcessing(true);
                try { await executeForcePushSource(label, sidebarProvider, outputChannel); }
                finally { sidebarProvider.setProcessing(false); }
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

            // Capture file list before modifying the mapping
            const sourceEntry = mapping.sources.find(s => s.label === label);
            const cloakedFiles = (sourceEntry?.files || []).map(f => f.cloaked);

            const choice = await vscode.window.showWarningMessage(
                `Remove source "${label}"?`,
                { modal: true },
                'Remove & Delete Files',
                'Remove Only'
            );
            if (!choice) { return; }

            const deleteFiles = choice === 'Remove & Delete Files';

            if (deleteFiles) {
                // Delete individual tracked files
                for (const rel of cloakedFiles) {
                    const abs = path.join(cloakedDir, rel);
                    if (existsSync(abs)) { rmSync(abs, { force: true }); }
                }
                // Remove the entire label subdirectory (catches any untracked files inside it too)
                const labelDir = path.join(cloakedDir, label);
                if (existsSync(labelDir)) { rmSync(labelDir, { recursive: true, force: true }); }
            }

            mapping = removeSourceFromMapping(mapping, label);
            saveMapping(cloakedDir, mapping);
            notifySuccess(deleteFiles
                ? `Removed source "${label}" and deleted ${cloakedFiles.length} file(s)`
                : `Removed source "${label}" from mapping (files kept on disk)`);
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
            notifySuccess(`Added replacement: "${original}" → "${replacement}"`);
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
                notifySuccess(`Removed replacement for "${original}"`);
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
        vscode.commands.registerCommand('repo-cloak.copyForAI', async (label?: string) => {
            sidebarProvider.setProcessing(true);
            try { await executeCopyForAI(label, fileTreeProvider, sidebarProvider, outputChannel); }
            finally { sidebarProvider.setProcessing(false); }
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
                    notifyWarn('No pairs entered — preset not saved.');
                    return;
                }
                savePreset({ name: name.trim(), pairs });
                notifySuccess(`Preset "${name.trim()}" created with ${pairs.length} pair(s).`);
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
                    notifySuccess(`Preset "${preset.name}" deleted.`);
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
            notifySuccess(
                `Preset "${preset.name}" updated — ${combined.length} pair(s).`
            );
        })
    );

    // ─── Language Model Tools (Copilot file probe + pull request) ───────────
    context.subscriptions.push(
        vscode.lm.registerTool('repo_cloak_probe_file', new ProbeFileTool()),
        vscode.lm.registerTool('repo_cloak_request_pull', new RequestPullTool(sidebarProvider, outputChannel))
    );

    // ─── Auto-refresh ───────────────────────────────────────────────────────
    const watcher = vscode.workspace.createFileSystemWatcher('**/.repo-cloak-map.json');
    const updateHasMappingCtx = () => {
        vscode.commands.executeCommand(
            'setContext', 'repo-cloak.hasMapping', !!findCloakedDirectory()
        );
    };
    watcher.onDidChange(() => { sidebarProvider.refresh(); updateHasMappingCtx(); });
    watcher.onDidCreate(() => { sidebarProvider.refresh(); updateHasMappingCtx(); });
    watcher.onDidDelete(() => { sidebarProvider.refresh(); updateHasMappingCtx(); });
    context.subscriptions.push(watcher);
    updateHasMappingCtx(); // Set initial value on activation

    // ─── Ban File ───────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.banFile', (uriOrItem?: vscode.Uri | { fullPath: string }) => {
            executeBanFile(uriOrItem, sidebarProvider, outputChannel, fileTreeProvider);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.addBanPattern', async () => {
            const input = await vscode.window.showInputBox({
                title: 'Add Wildcard Ban Pattern',
                prompt: 'Enter a glob pattern for files to always exclude (e.g. *.Designer.cs, **/Migrations/**, *.env)',
                placeHolder: '*.Designer.cs',
                validateInput: v => (v && v.trim()) ? null : 'Pattern cannot be empty'
            });
            if (input && input.trim()) {
                addPattern(input.trim());
                sidebarProvider.refresh();
                vscode.window.setStatusBarMessage(`$(regex) Ban pattern added: "${input.trim()}"`, 3000);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.addBanOverride', async () => {
            const input = await vscode.window.showInputBox({
                title: 'Add Pattern Override',
                prompt: 'Enter the relative path of a file to allow through even if it matches a ban pattern',
                placeHolder: 'src/Migrations/InitialCreate.Designer.cs',
                validateInput: v => (v && v.trim()) ? null : 'Path cannot be empty'
            });
            if (input && input.trim()) {
                addOverride(input.trim());
                sidebarProvider.refresh();
                vscode.window.setStatusBarMessage(`$(debug-step-over) Override added: "${input.trim()}"`, 3000);
            }
        })
    );

    // ─── Bulk edit: wildcard ban patterns ───────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.editBanPatterns', async () => {
            const current = getBanPatterns();
            const tmpPath = path.join(require('os').tmpdir(), 'repo-cloak-ban-patterns.txt');

            const header = [
                '# Repo Cloak — Wildcard Ban Patterns',
                '# One glob pattern per line.  Lines starting with # are comments.',
                '# Examples:  *.Designer.cs   **/Migrations/**   *.env   **/*.min.js',
                '# Save this file to apply changes.  Close without saving to cancel.',
                '#',
                '# ── OVERRIDES (files to allow even if they match a pattern) ──────────',
                '# Prefix override paths with "override:" e.g.  override:src/seed/InitialCreate.Designer.cs',
                '',
            ].join('\n');

            const patternLines = current.patterns.join('\n');
            const overrideLines = current.overrides.map(o => `override:${o}`).join('\n');
            const body = [patternLines, overrideLines].filter(Boolean).join('\n');

            writeFileSync(tmpPath, header + body + '\n', 'utf-8');

            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(tmpPath));
            await vscode.window.showTextDocument(doc, { preview: false });

            const watcher = vscode.workspace.onDidSaveTextDocument(saved => {
                if (saved.uri.fsPath !== tmpPath) { return; }

                const lines = saved.getText().split('\n')
                    .map(l => l.trim())
                    .filter(l => l && !l.startsWith('#'));

                const patterns: string[] = [];
                const overrides: string[] = [];
                for (const line of lines) {
                    if (line.startsWith('override:')) {
                        const o = line.slice('override:'.length).trim();
                        if (o) { overrides.push(o); }
                    } else {
                        patterns.push(line);
                    }
                }

                setBanPatterns(patterns, overrides);
                sidebarProvider.refresh();
                vscode.window.setStatusBarMessage(
                    `$(regex) Ban patterns saved — ${patterns.length} pattern(s), ${overrides.length} override(s)`,
                    4000
                );
            });

            // Clean up watcher when the document is closed
            const closeWatcher = vscode.workspace.onDidCloseTextDocument(closed => {
                if (closed.uri.fsPath !== tmpPath) { return; }
                watcher.dispose();
                closeWatcher.dispose();
                try { unlinkSync(tmpPath); } catch { /* ignore */ }
            });

            context.subscriptions.push(watcher, closeWatcher);
        })
    );

    // ─── Bulk edit: keyword replacements (global presets) ───────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('repo-cloak.editReplacements', async () => {
            const cloakedDir = findCloakedDirectory();
            const tmpPath = path.join(require('os').tmpdir(), 'repo-cloak-replacements.txt');

            // Load existing replacements from the active mapping (decrypted)
            let existingPairs: { original: string; replacement: string }[] = [];
            if (cloakedDir) {
                const raw = loadRawMapping(cloakedDir);
                if (raw && raw.encrypted && hasSecret()) {
                    try {
                        const dec = decryptMappingV2(raw, getOrCreateSecret());
                        existingPairs = (dec.replacements as any[] || [])
                            .filter((r: any) => r.original)
                            .map((r: any) => ({ original: r.original, replacement: r.replacement }));
                    } catch { /* ignore */ }
                }
            }

            const header = [
                '# Repo Cloak — Keyword Replacements',
                '# Format:  original text  →  replacement text',
                '# Use a literal " → " (space-arrow-space) as separator.',
                '# Lines starting with # are comments.  Save to apply.  Close to cancel.',
                '',
            ].join('\n');

            const body = existingPairs
                .map(p => `${p.original} → ${p.replacement}`)
                .join('\n');

            writeFileSync(tmpPath, header + body + '\n', 'utf-8');

            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(tmpPath));
            await vscode.window.showTextDocument(doc, { preview: false });

            const watcher = vscode.workspace.onDidSaveTextDocument(async saved => {
                if (saved.uri.fsPath !== tmpPath) { return; }

                const pairs: { original: string; replacement: string }[] = [];
                for (const line of saved.getText().split('\n')) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('#')) { continue; }
                    const sep = trimmed.indexOf(' → ');
                    if (sep === -1) { continue; } // skip malformed lines silently
                    const orig = trimmed.slice(0, sep).trim();
                    const repl = trimmed.slice(sep + 3).trim();
                    if (orig && repl) { pairs.push({ original: orig, replacement: repl }); }
                }

                if (!cloakedDir) {
                    notifyWarn('No cloaked workspace open — changes saved to file but not applied.');
                    return;
                }

                const raw = loadRawMapping(cloakedDir);
                if (!raw) { return; }

                const secret = getOrCreateSecret();
                raw.replacements = encryptReplacements(pairs, secret);
                raw.stats = { ...raw.stats, replacementsCount: pairs.length };
                saveMapping(cloakedDir, raw);
                sidebarProvider.refresh();
                vscode.window.setStatusBarMessage(
                    `$(replace-all) Replacements saved — ${pairs.length} pair(s)`,
                    4000
                );
            });

            const closeWatcher = vscode.workspace.onDidCloseTextDocument(closed => {
                if (closed.uri.fsPath !== tmpPath) { return; }
                watcher.dispose();
                closeWatcher.dispose();
                try { unlinkSync(tmpPath); } catch { /* ignore */ }
            });

            context.subscriptions.push(watcher, closeWatcher);
        })
    );

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
