/**
 * Push Command
 * Restore files from cloaked workspace back to their original source directories
 */

import * as vscode from 'vscode';
import { existsSync, mkdirSync, unlinkSync } from 'fs';
import { resolve, join } from 'path';
import { SidebarProvider } from '../views/sidebar-provider';
import { createDeanonymizer, anonymizePath, Replacement } from '../core/anonymizer';
import { copyFiles } from '../core/copier';
import { commitCloakedChange, pushSubject, forcePushSubject } from '../core/cloaked-git';
import { getAllFiles } from '../core/scanner';
import {
    hasMapping, loadMapping, loadRawMapping, decryptMappingV2, MappingV2, StaleFile, FileEntry,
    getSourceLabels, getSourceByLabel, getPendingDeletions, removeFilesFromSource, saveMapping,
    mergeFilesIntoSource
} from '../core/mapper';
import { hasSecret, getOrCreateSecret } from '../core/crypto';
import { notifySuccess, notifyWarn } from '../core/notify';

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
                notifyWarn('Could not decrypt mapping with current secret key.');
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

        // ── Step 4: Check for deleted cloaked files ─────────────────────────
        outputChannel.clear();
        const pendingDels = getPendingDeletions(mapping, cloakedDir!, targetLabel);
        await resolvePendingDeletions(cloakedDir!, mapping, pendingDels, outputChannel);

        // ── Step 5: Show mapping info ───────────────────────────────────────
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

        // ── Step 6: Get destination ─────────────────────────────────────────
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
                notifyWarn(`Original path no longer exists: ${source.path}`);
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

        // ── Step 7: Confirm ─────────────────────────────────────────────────
        const confirm = await vscode.window.showInformationMessage(
            `Restore ${source.files.length} files from "${targetLabel}" to ${destDir}?`,
            { modal: true },
            'Restore'
        );

        if (confirm !== 'Restore') { return; }

        // ── Step 8: Create destination if needed ────────────────────────────
        if (!existsSync(destDir)) {
            mkdirSync(destDir, { recursive: true });
        }

        // ── Step 9: Copy and de-anonymize ───────────────────────────────────
        let cloakedRelPaths: string[] = [];
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Window,
                title: `$(shield) $(cloud-upload) Pushing "${targetLabel}"...`,
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
                cloakedRelPaths = files.map(f => join(targetLabel, f.relativePath));

                if (files.length === 0) {
                    notifyWarn('No files found in the cloaked directory.');
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
                            message: `${current}/${total} files`
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

        // Track any files in the cloaked workspace that aren't in the mapping yet
        // (covers renames and new files added by the user or an AI agent)
        await trackUnmappedFiles(cloakedDir!, mapping, targetLabel, outputChannel);

        sidebarProvider.refresh();
        notifySuccess(`Restored "${targetLabel}" to ${destDir}`);

        await commitCloakedChange(
            cloakedDir!,
            pushSubject(targetLabel, cloakedRelPaths.length),
            cloakedRelPaths
        );

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
                notifyWarn('Could not decrypt mapping.');
                return;
            }
        }

        const sourceLabels = getSourceLabels(mapping);
        if (sourceLabels.length === 0) {
            notifyWarn('No sources found.');
            return;
        }

        // Show summary
        // Check for deleted cloaked files across all sources before confirming
        outputChannel.clear();
        const allPending = getPendingDeletions(mapping, cloakedDir!);
        await resolvePendingDeletions(cloakedDir!, mapping, allPending, outputChannel);

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
        let allCloakedRelPaths: string[] = [];
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Window,
                title: '$(shield) $(cloud-upload) Pushing all...',
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
                    allCloakedRelPaths.push(...files.map(f => join(label, f.relativePath)));

                    progress.report({
                        message: `${label} (${i + 1}/${sourceLabels.length} sources)`,
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

        // Track any unmapped files across all sources (renames, AI-created files, etc.)
        for (const label of sourceLabels) {
            await trackUnmappedFiles(cloakedDir!, mapping, label, outputChannel);
        }

        sidebarProvider.refresh();
        notifySuccess(`All ${sourceLabels.length} sources restored`);

        await commitCloakedChange(
            cloakedDir!,
            `repo-cloak: push all (${sourceLabels.length} source${sourceLabels.length === 1 ? '' : 's'})`,
            allCloakedRelPaths
        );

    } catch (error) {
        vscode.window.showErrorMessage(`Push All failed: ${(error as Error).message}`);
    }
}

/**
 * Force Push a specific source (instantly restores to original path without prompts)
 */
export async function executeForcePushSource(
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
                notifyWarn('Could not decrypt mapping for force push.');
                return;
            }
        }

        const source = getSourceByLabel(mapping, label);
        if (!source || !source.path || !existsSync(source.path)) {
            vscode.window.showErrorMessage(`Original path not found or inaccessible for "${label}".`);
            return;
        }

        // Confirm — this writes back to the original source repo
        const confirm = await vscode.window.showWarningMessage(
            `Force Push will overwrite files in the source repo for "${label}".`,
            {
                modal: true,
                detail: `Source: ${source.path}\n\nThis writes the cloaked (de-anonymized) files back to your original repository. Make sure that's what you intended — Force Pull updates the cloaked copy from the source instead.`
            },
            'Force Push'
        );
        if (confirm !== 'Force Push') { return; }

        outputChannel.clear();
        outputChannel.appendLine(`[Force Push] Restoring "${label}" to original path: ${source.path}...`);

        let forcePushRelPaths: string[] = [];
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: `$(shield) $(cloud-upload) Force Pushing "${label}"...`, cancellable: false },
            async (progress) => {
                const validReplacements = (mapping.replacements as any[] || []).filter((r: any) => r.original);
                const deanonymizer = createDeanonymizer(validReplacements);
                const reversedReplacements = validReplacements.map((r: any) => ({
                    original: r.replacement,
                    replacement: r.original
                }));

                const sourceSubdir = join(cloakedDir, label);
                const files = getAllFiles(sourceSubdir).filter(f => f.name !== 'AGENTS.md');
                forcePushRelPaths = files.map(f => join(label, f.relativePath));

                if (files.length === 0) {
                    notifyWarn(`No files found in "${label}" to restore.`);
                    return;
                }

                const results = await copyFiles(
                    files, sourceSubdir, source.path, deanonymizer,
                    (current, total) => {
                        progress.report({ increment: (1 / total) * 100, message: `${current}/${total} files` });
                    },
                    reversedReplacements
                );

                outputChannel.appendLine(`[done] Restored ${results.copied} files`);
                if (results.errors.length > 0) {
                    outputChannel.appendLine(`  [warn] ${results.errors.length} errors`);
                    results.errors.forEach(e => outputChannel.appendLine(`    - ${e.file}: ${e.error}`));
                }
            }
        );

        // Track any unmapped files (new or renamed) so future pulls stay in sync
        await trackUnmappedFiles(cloakedDir, mapping, label, outputChannel);

        notifySuccess(`Force Pushed "${label}" successfully.`);

        await commitCloakedChange(
            cloakedDir,
            forcePushSubject(label, forcePushRelPaths.length),
            forcePushRelPaths
        );
    } catch (error) {
        vscode.window.showErrorMessage(`Force Push failed: ${(error as Error).message}`);
    } finally {
        sidebarProvider.refresh();
    }
}

/**
 * Detect files present in the cloaked workspace that have no mapping entry —
 * e.g. files renamed by the user or created by an AI agent. Computes each
 * file's original path by reversing path-level anonymization and silently
 * adds them to the mapping so future pulls stay in sync.
 */
async function trackUnmappedFiles(
    cloakedDir: string,
    mapping: MappingV2,
    label: string,
    outputChannel: vscode.OutputChannel
): Promise<number> {
    const validReplacements = (mapping.replacements as any[] || []).filter((r: any) => r.original);
    // Reverse the replacements so anonymized path segments become the original names
    const reversedReplacements: Replacement[] = validReplacements.map((r: any) => ({
        original: r.replacement as string,
        replacement: r.original as string
    }));

    const sourceSubdir = join(cloakedDir, label);
    const cloakedFiles = getAllFiles(sourceSubdir).filter(f => f.name !== 'AGENTS.md');

    // Load a fresh raw mapping — pending-deletion cleanup may have already saved changes
    const rawMapping = loadRawMapping(cloakedDir);
    if (!rawMapping) { return 0; }

    const src = rawMapping.sources.find(s => s.label === label);
    if (!src) { return 0; }

    const mappedCloakedPaths = new Set(src.files.map(f => f.cloaked));

    const newEntries: FileEntry[] = cloakedFiles
        .map(f => ({
            cloaked: join(label, f.relativePath),
            original: anonymizePath(f.relativePath, reversedReplacements)
        }))
        .filter(e => !mappedCloakedPaths.has(e.cloaked));

    if (newEntries.length === 0) { return 0; }

    const updatedRaw = mergeFilesIntoSource(rawMapping, label, newEntries);
    saveMapping(cloakedDir, updatedRaw);

    outputChannel.appendLine(`\n[tracking] Added ${newEntries.length} new file(s) to the mapping:`);
    for (const e of newEntries) {
        outputChannel.appendLine(`  + ${e.original}`);
    }

    return newEntries.length;
}

/**
 * Check for files deleted from the cloaked workspace and offer to propagate
 * those deletions back to the original source repository.
 *
 * - "Delete from source" → QuickPick lets the user choose which files to delete,
 *   then removes all pending entries from the mapping.
 * - "Remove from tracking only" → cleans up the stale mapping entries, no deletion.
 * - Escape / cancel → skips silently; the user will be asked again on the next push.
 */
async function resolvePendingDeletions(
    cloakedDir: string,
    mapping: MappingV2,
    pending: StaleFile[],
    outputChannel: vscode.OutputChannel
): Promise<void> {
    if (pending.length === 0) { return; }

    const preview = pending.slice(0, 8).map(d => `• ${d.original}`).join('\n');
    const overflow = pending.length > 8 ? `\n…and ${pending.length - 8} more` : '';

    const action = await vscode.window.showWarningMessage(
        `${pending.length} tracked file(s) no longer exist in the cloaked workspace`,
        {
            modal: true,
            detail: `${preview}${overflow}\n\nWould you like to also delete them from the original repository, or just remove them from tracking?`
        },
        'Delete from source',
        'Remove from tracking only'
    );

    if (!action) { return; } // Escaped — leave mapping untouched, ask again next push

    if (action === 'Delete from source') {
        const picks = await vscode.window.showQuickPick(
            pending.map(d => ({
                label: d.original.split('/').pop() || d.original,
                description: d.original,
                detail: `Source: ${d.sourceLabel}`,
                picked: true,
                _file: d
            })),
            {
                canPickMany: true,
                title: 'Select files to delete from the original repository',
                placeHolder: 'All pre-selected — deselect any you want to keep'
            }
        );

        if (!picks) { return; } // QuickPick cancelled — skip entirely

        for (const pick of picks) {
            const d = (pick as any)._file as StaleFile;
            const src = mapping.sources.find(s => s.label === d.sourceLabel);
            if (!src?.path) { continue; }
            const absPath = resolve(src.path, d.original);
            if (existsSync(absPath)) {
                try {
                    unlinkSync(absPath);
                    outputChannel.appendLine(`[deleted from source] ${d.sourceLabel}/${d.original}`);
                } catch (e) {
                    outputChannel.appendLine(`[warn] Could not delete ${d.original}: ${(e as Error).message}`);
                }
            }
        }
    }

    // Clean up all pending mapping entries (regardless of delete/tracking-only choice)
    const byLabel = new Map<string, string[]>();
    for (const d of pending) {
        const arr = byLabel.get(d.sourceLabel) ?? [];
        arr.push(d.cloaked);
        byLabel.set(d.sourceLabel, arr);
    }
    let currentRaw = loadRawMapping(cloakedDir);
    if (currentRaw) {
        for (const [lbl, cloakedPaths] of byLabel) {
            currentRaw = removeFilesFromSource(currentRaw, lbl, cloakedPaths);
        }
        saveMapping(cloakedDir, currentRaw);
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

/**
 * Top-level Push router (QuickPick for Interactive vs Force All)
 */
export async function executePushAction(
    sidebarProvider: SidebarProvider,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    const pick = await vscode.window.showQuickPick(
        [
            { label: '$(file-directory) Interactive Push', description: 'Choose a specific source & destination', action: 'push' },
            { label: '$(repo-push) Force Push All', description: 'Quietly restore all files to original paths', action: 'force' }
        ],
        { placeHolder: 'Choose a push action...' }
    );

    if (pick?.action === 'push') {
        vscode.commands.executeCommand('repo-cloak.push');
    } else if (pick?.action === 'force') {
        vscode.commands.executeCommand('repo-cloak.forcePushAll');
    }
}
