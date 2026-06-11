/**
 * Fresh Start Command
 * Wipes all cloaked files for a source, removes it from the mapping, then
 * opens the full interactive pull flow (git-mode picker + file tree) so the
 * user can re-select files from scratch — without touching the source path or
 * any other sources.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { existsSync, rmSync } from 'fs';
import { resolve, relative, join } from 'path';
import { FileTreeProvider } from '../views/file-tree-provider';
import { SidebarProvider } from '../views/sidebar-provider';
import {
    hasMapping, loadRawMapping, decryptMappingV2,
    removeSourceFromMapping, saveMapping, addSourceToMapping,
    getSourceByLabel
} from '../core/mapper';
import { hasSecret, getOrCreateSecret } from '../core/crypto';
import { createAnonymizer, Replacement, anonymizePath } from '../core/anonymizer';
import { copyFiles } from '../core/copier';
import { scanFilesForSecrets } from '../core/secrets';
import { isGitRepo, getChangedFiles, getRecentCommits, getFilesChangedInCommits } from '../core/git';
import { getBannedSet, hasBanList } from '../core/ban-list';
import { matchesAnyPattern, hasPatterns } from '../core/ban-patterns';
import { getAllFiles } from '../core/scanner';
import { commitCloakedChange, pullSubject } from '../core/cloaked-git';
import { promptReplacementsWithPresets } from './pull';
import { notifySuccess, notifyWarn, notifyInfo } from '../core/notify';

function findCloakedDirectory(): string | null {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) { return null; }
    for (const folder of workspaceFolders) {
        if (hasMapping(folder.uri.fsPath)) { return folder.uri.fsPath; }
    }
    return null;
}

function buildAllowedPaths(files: string[], sourceDir: string): Set<string> {
    const allowed = new Set<string>(files);
    for (const file of files) {
        let dir = resolve(file, '..');
        while (dir && dir !== sourceDir && dir !== '/' && dir !== resolve(dir, '..')) {
            allowed.add(dir);
            dir = resolve(dir, '..');
        }
    }
    allowed.add(sourceDir);
    return allowed;
}

async function buildBannedPaths(sourceDir: string): Promise<Set<string>> {
    const bannedPaths = new Set<string>();
    if (hasBanList() && hasSecret()) {
        const secret = getOrCreateSecret();
        const bannedRels = getBannedSet(sourceDir, secret);
        for (const r of bannedRels) { bannedPaths.add(join(sourceDir, r)); }
    }
    if (hasPatterns()) {
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: '$(search) Applying ban patterns…' },
            () => new Promise<void>(res => {
                for (const f of getAllFiles(sourceDir)) {
                    const rel = f.relativePath.replace(/\\/g, '/');
                    if (matchesAnyPattern(rel)) { bannedPaths.add(join(sourceDir, rel)); }
                }
                res();
            })
        );
    }
    return bannedPaths;
}

export async function executeFreshStart(
    label: string | undefined,
    fileTreeProvider: FileTreeProvider,
    sidebarProvider: SidebarProvider,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    if (!label) { return; }

    try {
        // ── Locate cloaked workspace ────────────────────────────────────────
        const cloakedDir = findCloakedDirectory();
        if (!cloakedDir) {
            vscode.window.showErrorMessage('No cloaked workspace found.');
            return;
        }

        const rawMapping = loadRawMapping(cloakedDir);
        if (!rawMapping) { return; }

        let decryptedMapping = rawMapping;
        let replacements: Replacement[] = [];
        if (rawMapping.encrypted && hasSecret()) {
            try {
                decryptedMapping = decryptMappingV2(rawMapping, getOrCreateSecret());
                replacements = (decryptedMapping.replacements as Replacement[]).filter(r => r.original);
            } catch { /* use raw */ }
        }

        const source = getSourceByLabel(decryptedMapping, label);
        if (!source) {
            vscode.window.showErrorMessage(`Source "${label}" not found.`);
            return;
        }

        const sourceDir = source.path;
        if (!sourceDir || !existsSync(sourceDir)) {
            notifyWarn(`Source path not accessible: ${sourceDir || '[encrypted]'}`);
            return;
        }

        // ── Confirm wipe ────────────────────────────────────────────────────
        const fileCount = source.files?.length ?? 0;
        const confirm = await vscode.window.showWarningMessage(
            `Fresh Start will delete all ${fileCount} cloaked file(s) for "${label}" and let you re-select from scratch. This cannot be undone.`,
            { modal: true },
            'Fresh Start'
        );
        if (confirm !== 'Fresh Start') { return; }

        // ── Delete cloaked files + label subdirectory ───────────────────────
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: `$(trash) Clearing "${label}"…` },
            () => new Promise<void>(res => {
                for (const f of source.files ?? []) {
                    const abs = path.join(cloakedDir, f.cloaked);
                    if (existsSync(abs)) { rmSync(abs, { force: true }); }
                }
                const labelDir = path.join(cloakedDir, label);
                if (existsSync(labelDir)) { rmSync(labelDir, { recursive: true, force: true }); }
                res();
            })
        );

        // ── Remove source from mapping and save ─────────────────────────────
        const clearedMapping = removeSourceFromMapping(rawMapping, label);
        saveMapping(cloakedDir, clearedMapping);
        outputChannel.appendLine(`[fresh-start] Cleared ${fileCount} file(s) for "${label}"`);

        // ── Re-pull flow: git-mode picker → file tree → copy ────────────────

        // Step 1 — Git-aware pre-selection
        let precheck: string[] = [];
        let allowedPaths: Set<string> | undefined;

        if (isGitRepo(sourceDir)) {
            const gitMode = await vscode.window.showQuickPick([
                { label: '$(file-directory) Manual selection', description: 'Browse and pick files', value: 'manual' },
                { label: '$(git-commit) Uncommitted changes', description: 'Files with pending changes', value: 'uncommitted' },
                { label: '$(history) Recent commits', description: 'Pick files from commits', value: 'commits' },
                { label: '$(git-commit) Specific commit ID', description: 'Enter a commit hash', value: 'commit_id' }
            ], {
                title: `Fresh Start — ${label}: how do you want to pick files?`
            });

            if (!gitMode) { return; }

            if ((gitMode as any).value === 'uncommitted') {
                const gitFiles = await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Window, title: '$(shield) $(search) Scanning uncommitted files...' },
                    () => getChangedFiles(sourceDir)
                );
                if (gitFiles.length === 0) {
                    notifyWarn('No uncommitted files found.');
                    return;
                }
                precheck = gitFiles.map(f => resolve(sourceDir, f)).filter(f => existsSync(f));
                allowedPaths = buildAllowedPaths(precheck, sourceDir);
            } else if ((gitMode as any).value === 'commits') {
                const commits = await getRecentCommits(sourceDir, 15);
                if (commits.length === 0) {
                    notifyWarn('No commits found.');
                    return;
                }
                const selected = await vscode.window.showQuickPick(
                    commits.map(c => ({ label: c.hash, description: c.message, value: c.hash })),
                    { canPickMany: true, title: 'Select commits to pull files from' }
                );
                if (!selected || selected.length === 0) { return; }
                const commitFiles = await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Window, title: '$(shield) $(git-commit) Fetching files from commits...' },
                    () => getFilesChangedInCommits(sourceDir, selected.map(s => (s as any).value))
                );
                precheck = commitFiles.map(f => resolve(sourceDir, f)).filter(f => existsSync(f));
                allowedPaths = buildAllowedPaths(precheck, sourceDir);
            } else if ((gitMode as any).value === 'commit_id') {
                const commitHash = await vscode.window.showInputBox({
                    prompt: 'Enter commit hash',
                    validateInput: v => v.trim() ? null : 'Commit hash cannot be empty'
                });
                if (!commitHash) { return; }
                const commitFiles = await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Window, title: `$(shield) $(git-commit) Fetching files from ${commitHash}...` },
                    () => getFilesChangedInCommits(sourceDir, [commitHash.trim()])
                );
                if (commitFiles.length === 0) {
                    notifyWarn('No files found in that commit.');
                    return;
                }
                precheck = commitFiles.map(f => resolve(sourceDir, f)).filter(f => existsSync(f));
                allowedPaths = buildAllowedPaths(precheck, sourceDir);
            }
            // 'manual' falls through — no precheck/allowedPaths
        }

        // Step 2 — Build banned paths + show file tree
        const bannedPathsSet = await buildBannedPaths(sourceDir);
        const bannedPaths = bannedPathsSet.size > 0 ? bannedPathsSet : undefined;

        let selectedFiles = await fileTreeProvider.startSelection(sourceDir, {
            precheck: precheck.length > 0 ? precheck : undefined,
            allowedPaths,
            bannedPaths,
            sourceLabel: label,
            purpose: {
                title: `Fresh Start → ${label}`,
                message: `Re-select files for "${label}". Confirm (✓) when done.`
            }
        });

        if (selectedFiles.length === 0) {
            notifyWarn('No files selected — source was cleared but nothing pulled.');
            sidebarProvider.refresh();
            return;
        }

        // Step 3 — Wildcard pattern safety-net filter
        if (hasPatterns()) {
            const before = selectedFiles.length;
            selectedFiles = selectedFiles.filter(f => {
                const rel = relative(sourceDir, f).replace(/\\/g, '/');
                const matchedPattern = matchesAnyPattern(rel);
                if (matchedPattern) {
                    outputChannel.appendLine(`[ban-pattern] Skipped "${rel}" — matches wildcard pattern "${matchedPattern}"`);
                    return false;
                }
                return true;
            });
            if (selectedFiles.length < before) {
                notifyInfo(`Skipped ${before - selectedFiles.length} file(s) matching wildcard ban patterns.`);
                outputChannel.show(true);
            }
            if (selectedFiles.length === 0) {
                notifyWarn('All selected files were excluded by wildcard ban patterns.');
                sidebarProvider.refresh();
                return;
            }
        }

        // Step 4 — Secret scan
        const secretFindings = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: '$(shield) $(search) Scanning for sensitive data...' },
            () => scanFilesForSecrets(selectedFiles)
        );

        if (secretFindings.length > 0) {
            outputChannel.clear();
            outputChannel.appendLine('[warn] Potential sensitive data detected\n');
            const findingsByFile = secretFindings.reduce((acc, finding) => {
                const relPath = relative(sourceDir, finding.file);
                if (!acc[relPath]) { acc[relPath] = []; }
                acc[relPath].push(`${finding.type} (Line ${finding.line})`);
                return acc;
            }, {} as Record<string, string[]>);
            for (const [file, secrets] of Object.entries(findingsByFile)) {
                outputChannel.appendLine(`  ${file}:`);
                for (const secret of secrets) { outputChannel.appendLine(`    - ${secret}`); }
            }
            outputChannel.show();

            const proceed = await vscode.window.showWarningMessage(
                `${secretFindings.length} potential secret(s) detected. Check Output panel for details.`,
                { modal: true },
                'Continue anyway',
                'Remove files with secrets',
                'Cancel'
            );
            if (proceed === 'Remove files with secrets') {
                const filesWithSecrets = new Set(secretFindings.map(f => f.file));
                selectedFiles = selectedFiles.filter(f => !filesWithSecrets.has(f));
                if (selectedFiles.length === 0) {
                    notifyWarn('All selected files contained secrets.');
                    sidebarProvider.refresh();
                    return;
                }
                notifyInfo(`Removed ${filesWithSecrets.size} file(s) with secrets, continuing with ${selectedFiles.length}.`);
            } else if (proceed !== 'Continue anyway') {
                sidebarProvider.refresh();
                return;
            }
        }

        // Step 5 — Keyword replacements (re-use existing mapping replacements)
        replacements = await promptReplacementsWithPresets(replacements);

        // Step 6 — Copy and anonymize
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: `$(shield) $(cloud-download) Pulling "${label}"...`, cancellable: false },
            async (progress) => {
                const anonymizer = createAnonymizer(replacements);
                const destBase = join(cloakedDir, label);
                await copyFiles(
                    selectedFiles, sourceDir, destBase, anonymizer,
                    (current, total) => {
                        progress.report({ increment: (1 / total) * 100, message: `${current}/${total} files` });
                    },
                    replacements
                );
            }
        );

        // Step 7 — Re-add source to mapping
        const newFiles = selectedFiles.map(f => {
            const originalPath = relative(sourceDir, f);
            const anonymizedPath = anonymizePath(originalPath, replacements);
            return { original: originalPath, cloaked: join(label, anonymizedPath) };
        });

        // Re-add the source to the (now cleared) mapping
        const freshRaw = loadRawMapping(cloakedDir) ?? clearedMapping;
        const updatedMapping = addSourceToMapping(freshRaw, { label, sourceDir, files: newFiles });
        saveMapping(cloakedDir, updatedMapping);

        await commitCloakedChange(
            cloakedDir,
            pullSubject(label, newFiles.length),
            newFiles.map(f => f.cloaked)
        );

        notifySuccess(`Fresh Start complete — pulled ${selectedFiles.length} files into "${label}"`);

    } catch (error) {
        vscode.window.showErrorMessage(`Fresh Start failed: ${(error as Error).message}`);
    } finally {
        sidebarProvider.refresh();
    }
}
