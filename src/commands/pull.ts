/**
 * Pull Command
 * Extract files from a source repo, scan for secrets, anonymize, and save to cloaked workspace.
 * Supports: full pull, per-source pull (add more files to existing source), force pull.
 */

import * as vscode from 'vscode';
import { resolve, relative, join, basename } from 'path';
import { existsSync, writeFileSync } from 'fs';
import { FileTreeProvider } from '../views/file-tree-provider';
import { SidebarProvider } from '../views/sidebar-provider';
import { createAnonymizer, Replacement } from '../core/anonymizer';
import { copyFiles } from '../core/copier';
import { scanFilesForSecrets } from '../core/secrets';
import { getAgentsMarkdown } from '../core/agents-template';
import { isGitRepo, getChangedFiles, getRecentCommits, getFilesChangedInCommits } from '../core/git';
import {
    hasMapping, loadRawMapping, createSingleSourceMapping, addSourceToMapping,
    mergeFilesIntoSource, saveMapping, decryptMappingV2, MappingV2, getSourceLabels,
    getSourceByLabel
} from '../core/mapper';
import { hasSecret, getOrCreateSecret, decryptReplacements } from '../core/crypto';
import { addSourcePath, addDestPath } from '../core/path-cache';

export async function executePull(
    fileTreeProvider: FileTreeProvider,
    sidebarProvider: SidebarProvider,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    try {
        // ── Step 1: Pick source folder ──────────────────────────────────────
        const sourceUris = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Select Source Repository',
            title: 'Which repo do you want to extract files from?'
        });

        if (!sourceUris || sourceUris.length === 0) { return; }
        const sourceDir = sourceUris[0].fsPath;
        addSourcePath(sourceDir);

        // ── Step 2: Determine destination ───────────────────────────────────
        let destDir: string | null = null;
        let existingMapping: MappingV2 | null = null;
        let existingReplacements: Replacement[] = [];

        // Check if any workspace folder is already a cloaked directory
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders) {
            for (const folder of workspaceFolders) {
                if (hasMapping(folder.uri.fsPath)) {
                    destDir = folder.uri.fsPath;
                    existingMapping = loadRawMapping(folder.uri.fsPath);
                    break;
                }
            }
        }

        // If we found existing mapping, ask the user what to do
        let sourceLabel = basename(sourceDir);
        let isAddToExisting = false;

        if (existingMapping) {
            // Decrypt replacements
            if (existingMapping.encrypted && hasSecret()) {
                try {
                    const decrypted = decryptMappingV2(existingMapping, getOrCreateSecret());
                    existingReplacements = (decrypted.replacements as Replacement[]).filter(r => r.original);
                } catch { /* ignore */ }
            }

            const existingLabels = getSourceLabels(existingMapping);
            const choices: vscode.QuickPickItem[] = [
                { label: '$(add) Add as new source', description: 'Add this repo alongside existing sources' },
                { label: '$(new-folder) Fresh start', description: 'Pick a new output folder' }
            ];

            // If the source already exists as a label, offer quick-add
            if (existingLabels.some(l => l === sourceLabel || sourceDir.includes(l))) {
                choices.unshift({
                    label: '$(sync) Quick add files',
                    description: `Add more files to existing "${sourceLabel}" source`
                });
            }

            const choice = await vscode.window.showQuickPick(choices, {
                title: 'Existing cloaked workspace detected',
                placeHolder: 'What would you like to do?'
            });

            if (!choice) { return; }

            if (choice.label.includes('Fresh start')) {
                destDir = null;
                existingMapping = null;
                existingReplacements = [];
            } else if (choice.label.includes('Quick add')) {
                isAddToExisting = true;
            } else {
                // Add as new source — prompt for label
                const labelInput = await vscode.window.showInputBox({
                    prompt: 'Label for this source (e.g., "backend", "frontend")',
                    value: sourceLabel,
                    validateInput: (value) => {
                        if (!value.trim()) { return 'Label cannot be empty'; }
                        if (existingLabels.includes(value.trim())) { return 'Label already exists'; }
                        return null;
                    }
                });
                if (!labelInput) { return; }
                sourceLabel = labelInput.trim();
                isAddToExisting = true;
            }
        }

        // If no dest yet, ask user
        if (!destDir) {
            const destUris = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: 'Select Destination',
                title: 'Where should the cloaked files be saved?'
            });

            if (!destUris || destUris.length === 0) { return; }
            destDir = destUris[0].fsPath;
            addDestPath(destDir);

            // Ask for source label for new workspace
            const labelInput = await vscode.window.showInputBox({
                prompt: 'Label for this source (e.g., "backend", "frontend")',
                value: sourceLabel
            });
            if (!labelInput) { return; }
            sourceLabel = labelInput.trim();
        }

        // ── Step 3: Git-aware file selection ────────────────────────────────
        let selectedFiles: string[] = [];
        let precheck: string[] = [];
        let allowedPaths: Set<string> | undefined;

        if (isGitRepo(sourceDir)) {
            const gitMode = await vscode.window.showQuickPick([
                { label: '$(file-directory) Manual selection', description: 'Browse and pick files', value: 'manual' },
                { label: '$(git-commit) Uncommitted changes', description: 'Files with pending changes', value: 'uncommitted' },
                { label: '$(history) Recent commits', description: 'Pick files from commits', value: 'commits' },
                { label: '$(git-commit) Specific commit ID', description: 'Enter a commit hash', value: 'commit_id' }
            ], {
                title: 'This is a Git repo — how do you want to pick files?'
            });

            if (!gitMode) { return; }

            if ((gitMode as any).value === 'uncommitted') {
                const gitFiles = await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'Scanning uncommitted files...' },
                    () => getChangedFiles(sourceDir)
                );
                if (gitFiles.length === 0) {
                    vscode.window.showWarningMessage('No uncommitted files found.');
                    return;
                }
                precheck = gitFiles.map(f => resolve(sourceDir, f)).filter(f => existsSync(f));
                allowedPaths = buildAllowedPaths(precheck, sourceDir);
            } else if ((gitMode as any).value === 'commits') {
                const commits = await getRecentCommits(sourceDir, 15);
                if (commits.length === 0) {
                    vscode.window.showWarningMessage('No commits found.');
                    return;
                }
                const selected = await vscode.window.showQuickPick(
                    commits.map(c => ({ label: c.hash, description: c.message, value: c.hash })),
                    { canPickMany: true, title: 'Select commits to pull files from' }
                );
                if (!selected || selected.length === 0) { return; }
                const commitFiles = await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'Fetching files from commits...' },
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
                    { location: vscode.ProgressLocation.Notification, title: `Fetching files from ${commitHash}...` },
                    () => getFilesChangedInCommits(sourceDir, [commitHash.trim()])
                );
                if (commitFiles.length === 0) {
                    vscode.window.showWarningMessage('No files found in that commit.');
                    return;
                }
                precheck = commitFiles.map(f => resolve(sourceDir, f)).filter(f => existsSync(f));
                allowedPaths = buildAllowedPaths(precheck, sourceDir);
            }
            // 'manual' falls through — no precheck/allowedPaths
        }

        // ── Step 4: Show file tree for selection ────────────────────────────
        selectedFiles = await fileTreeProvider.startSelection(sourceDir, {
            precheck: precheck.length > 0 ? precheck : undefined,
            allowedPaths
        });

        if (selectedFiles.length === 0) {
            vscode.window.showWarningMessage('No files selected. Operation cancelled.');
            return;
        }

        vscode.window.showInformationMessage(`Selected ${selectedFiles.length} files`);

        // ── Step 5: Secret scan ─────────────────────────────────────────────
        const secretFindings = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Scanning for sensitive data...' },
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
                for (const secret of secrets) {
                    outputChannel.appendLine(`    - ${secret}`);
                }
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
                    vscode.window.showWarningMessage('All selected files contained secrets. Operation cancelled.');
                    return;
                }
                vscode.window.showInformationMessage(`Removed ${filesWithSecrets.size} file(s) with secrets. Continuing with ${selectedFiles.length} file(s).`);
            } else if (proceed !== 'Continue anyway') {
                vscode.window.showInformationMessage('Operation cancelled.');
                return;
            }
        }

        // ── Step 6: Keyword replacements ────────────────────────────────────
        let replacements: Replacement[] = [...existingReplacements];

        if (existingReplacements.length > 0) {
            const useExisting = await vscode.window.showInformationMessage(
                `Using ${existingReplacements.length} existing replacement(s). Add more?`,
                'Add more', 'Continue'
            );
            if (useExisting === 'Add more') {
                replacements = [...replacements, ...await promptReplacements()];
            }
        } else {
            replacements = await promptReplacements();
        }

        // ── Step 7: Confirm ─────────────────────────────────────────────────
        const confirm = await vscode.window.showInformationMessage(
            `Pull ${selectedFiles.length} files from "${sourceLabel}" with ${replacements.length} replacement(s)?`,
            { modal: true },
            'Go'
        );

        if (confirm !== 'Go') {
            vscode.window.showInformationMessage('Operation cancelled.');
            return;
        }

        // ── Step 8: Copy and anonymize ──────────────────────────────────────
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Extracting and anonymizing...',
                cancellable: false
            },
            async (progress) => {
                const anonymizer = createAnonymizer(replacements);

                // Files are placed under sourceLabel subdirectory
                const destBase = join(destDir!, sourceLabel);

                const results = await copyFiles(
                    selectedFiles,
                    sourceDir,
                    destBase,
                    anonymizer,
                    (current, total, file) => {
                        progress.report({
                            increment: (1 / total) * 100,
                            message: `${current}/${total} — ${file}`
                        });
                    },
                    replacements
                );

                outputChannel.appendLine(`\n[done] Extracted ${results.copied} files`);
                if (results.pathsRenamed > 0) {
                    outputChannel.appendLine(`  ${results.pathsRenamed} paths renamed`);
                }
                if (results.transformed > 0) {
                    outputChannel.appendLine(`  ${results.transformed} files had content replaced`);
                }
                if (results.errors.length > 0) {
                    outputChannel.appendLine(`  [warn] ${results.errors.length} errors`);
                    results.errors.forEach(e => outputChannel.appendLine(`    - ${e.file}: ${e.error}`));
                }
            }
        );

        // ── Step 9: Save mapping ────────────────────────────────────────────
        const newFiles = selectedFiles.map(f => {
            const originalPath = relative(sourceDir, f);
            let anonymizedPath = join(sourceLabel, originalPath);
            for (const { original, replacement } of replacements) {
                const regex = new RegExp(original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                anonymizedPath = anonymizedPath.replace(regex, replacement);
            }
            return { original: relative(sourceDir, f), cloaked: anonymizedPath };
        });

        let mapping: MappingV2;

        if (existingMapping && isAddToExisting) {
            const existingLabels = getSourceLabels(existingMapping);

            if (existingLabels.includes(sourceLabel)) {
                // Merge files into existing source
                mapping = mergeFilesIntoSource(existingMapping, sourceLabel, newFiles);
            } else {
                // Add as new source
                mapping = addSourceToMapping(existingMapping, {
                    label: sourceLabel,
                    sourceDir,
                    files: newFiles
                }, replacements.filter(r => !existingReplacements.some(er => er.original === r.original)));
            }
        } else {
            mapping = createSingleSourceMapping({
                label: sourceLabel,
                sourceDir,
                destDir: destDir!,
                replacements,
                files: newFiles
            });

            // Write AGENTS.md
            const agentsPath = join(destDir!, 'AGENTS.md');
            if (!existsSync(agentsPath)) {
                writeFileSync(agentsPath, getAgentsMarkdown(), 'utf-8');
            }
        }

        saveMapping(destDir!, mapping);

        // ── Done! ───────────────────────────────────────────────────────────
        sidebarProvider.refresh();
        vscode.window.showInformationMessage(`Extracted ${selectedFiles.length} files from "${sourceLabel}"`);

    } catch (error) {
        vscode.window.showErrorMessage(`Pull failed: ${(error as Error).message}`);
    }
}

/**
 * Prompt for keyword replacements using InputBox
 */
async function promptReplacements(): Promise<Replacement[]> {
    const replacements: Replacement[] = [];

    while (true) {
        const original = await vscode.window.showInputBox({
            prompt: `Keyword to replace (leave empty to finish) — ${replacements.length} so far`,
            placeHolder: 'e.g., Microsoft Corp'
        });

        if (!original || !original.trim()) { break; }

        const replacement = await vscode.window.showInputBox({
            prompt: `Replace "${original}" with:`,
            placeHolder: 'e.g., ACME Inc',
            validateInput: v => v.trim() ? null : 'Replacement cannot be empty'
        });

        if (!replacement) { break; }

        replacements.push({ original: original.trim(), replacement: replacement.trim() });
        vscode.window.showInformationMessage(`Added: "${original}" \u2192 "${replacement}"`);
    }

    return replacements;
}

/**
 * Pull more files into an existing source (per-source pull from sidebar)
 */
export async function executePullSource(
    label: string | undefined,
    fileTreeProvider: FileTreeProvider,
    sidebarProvider: SidebarProvider,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    if (!label) {
        // Fall back to full pull
        return executePull(fileTreeProvider, sidebarProvider, outputChannel);
    }

    try {
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
            vscode.window.showWarningMessage(`Source path not accessible: ${sourceDir || '[encrypted]'}`);
            return;
        }

        // Show file tree for the source directory
        let selectedFiles = await fileTreeProvider.startSelection(sourceDir);

        if (selectedFiles.length === 0) {
            vscode.window.showWarningMessage('No files selected.');
            return;
        }

        // Secret scan
        const secretFindings = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Scanning for sensitive data...' },
            () => scanFilesForSecrets(selectedFiles)
        );

        if (secretFindings.length > 0) {
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
                    vscode.window.showWarningMessage('All selected files contained secrets. Operation cancelled.');
                    return;
                }
                vscode.window.showInformationMessage(`Removed ${filesWithSecrets.size} file(s) with secrets. Continuing with ${selectedFiles.length} file(s).`);
            } else if (proceed !== 'Continue anyway') {
                return;
            }
        }

        // Copy files
        const anonymizer = createAnonymizer(replacements);
        const destBase = join(cloakedDir, label);

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Adding files to "${label}"...` },
            async (progress) => {
                await copyFiles(
                    selectedFiles, sourceDir, destBase, anonymizer,
                    (current, total, file) => {
                        progress.report({ increment: (1 / total) * 100, message: `${current}/${total}` });
                    },
                    replacements
                );
            }
        );

        // Update mapping
        const newFiles = selectedFiles.map(f => {
            const originalPath = relative(sourceDir, f);
            let anonymizedPath = join(label, originalPath);
            for (const { original, replacement } of replacements) {
                const regex = new RegExp(original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                anonymizedPath = anonymizedPath.replace(regex, replacement);
            }
            return { original: relative(sourceDir, f), cloaked: anonymizedPath };
        });

        const updatedMapping = mergeFilesIntoSource(rawMapping, label, newFiles);
        saveMapping(cloakedDir, updatedMapping);

        sidebarProvider.refresh();
        vscode.window.showInformationMessage(`Added ${selectedFiles.length} files to "${label}"`);

    } catch (error) {
        vscode.window.showErrorMessage(`Pull failed: ${(error as Error).message}`);
    }
}

/**
 * Pull files from Git changes for a specific source (uncommitted or commit-based)
 */
export async function executePullSourceGit(
    label: string | undefined,
    fileTreeProvider: FileTreeProvider,
    sidebarProvider: SidebarProvider,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    if (!label) {
        return executePull(fileTreeProvider, sidebarProvider, outputChannel);
    }

    try {
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
            vscode.window.showWarningMessage(`Source path not accessible: ${sourceDir || '[encrypted]'}`);
            return;
        }

        if (!isGitRepo(sourceDir)) {
            vscode.window.showWarningMessage(`"${label}" is not a Git repository.`);
            return;
        }

        // Pick Git mode
        const gitMode = await vscode.window.showQuickPick([
            { label: '$(git-commit) Uncommitted changes', description: 'Files with pending changes', value: 'uncommitted' },
            { label: '$(history) Recent commits', description: 'Pick files from commits', value: 'commits' },
            { label: '$(git-commit) Specific commit ID', description: 'Enter a commit hash', value: 'commit_id' }
        ], {
            title: `Git pull for "${label}"`
        });

        if (!gitMode) { return; }

        let gitFiles: string[] = [];

        if ((gitMode as any).value === 'uncommitted') {
            gitFiles = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Scanning uncommitted files...' },
                () => getChangedFiles(sourceDir)
            );
        } else if ((gitMode as any).value === 'commits') {
            const commits = await getRecentCommits(sourceDir, 15);
            if (commits.length === 0) {
                vscode.window.showWarningMessage('No commits found.');
                return;
            }
            const selected = await vscode.window.showQuickPick(
                commits.map(c => ({ label: c.hash, description: c.message, value: c.hash })),
                { canPickMany: true, title: `Select commits for "${label}"` }
            );
            if (!selected || selected.length === 0) { return; }
            gitFiles = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Fetching files from commits...' },
                () => getFilesChangedInCommits(sourceDir, selected.map(s => (s as any).value))
            );
        } else if ((gitMode as any).value === 'commit_id') {
            const commitHash = await vscode.window.showInputBox({
                prompt: 'Enter commit hash',
                validateInput: v => v.trim() ? null : 'Cannot be empty'
            });
            if (!commitHash) { return; }
            gitFiles = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `Fetching files from ${commitHash}...` },
                () => getFilesChangedInCommits(sourceDir, [commitHash.trim()])
            );
        }

        if (gitFiles.length === 0) {
            vscode.window.showWarningMessage('No changed files found.');
            return;
        }

        // Resolve to absolute paths
        const absolutePaths = gitFiles.map(f => resolve(sourceDir, f)).filter(f => existsSync(f));
        if (absolutePaths.length === 0) {
            vscode.window.showWarningMessage('None of the changed files exist on disk.');
            return;
        }

        // Show in file tree for user to confirm/deselect
        const allowedPaths = buildAllowedPaths(absolutePaths, sourceDir);
        let selectedFiles = await fileTreeProvider.startSelection(sourceDir, {
            precheck: absolutePaths,
            allowedPaths
        });

        if (selectedFiles.length === 0) {
            vscode.window.showWarningMessage('No files selected.');
            return;
        }

        // Secret scan
        const secretFindings = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Scanning for sensitive data...' },
            () => scanFilesForSecrets(selectedFiles)
        );

        if (secretFindings.length > 0) {
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
                    vscode.window.showWarningMessage('All selected files contained secrets. Operation cancelled.');
                    return;
                }
                vscode.window.showInformationMessage(`Removed ${filesWithSecrets.size} file(s) with secrets. Continuing with ${selectedFiles.length} file(s).`);
            } else if (proceed !== 'Continue anyway') {
                return;
            }
        }

        // Copy and anonymize
        const anonymizer = createAnonymizer(replacements);
        const destBase = join(cloakedDir, label);

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Adding Git changes to "${label}"...` },
            async (progress) => {
                await copyFiles(
                    selectedFiles, sourceDir, destBase, anonymizer,
                    (current, total) => {
                        progress.report({ increment: (1 / total) * 100, message: `${current}/${total}` });
                    },
                    replacements
                );
            }
        );

        // Update mapping
        const newFiles = selectedFiles.map(f => {
            const originalPath = relative(sourceDir, f);
            let anonymizedPath = join(label, originalPath);
            for (const { original, replacement } of replacements) {
                const regex = new RegExp(original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                anonymizedPath = anonymizedPath.replace(regex, replacement);
            }
            return { original: relative(sourceDir, f), cloaked: anonymizedPath };
        });
        const updatedMapping = mergeFilesIntoSource(rawMapping, label, newFiles);
        saveMapping(cloakedDir, updatedMapping);

        sidebarProvider.refresh();
        vscode.window.showInformationMessage(`Added ${selectedFiles.length} Git-changed files to "${label}"`);

    } catch (error) {
        vscode.window.showErrorMessage(`Git pull failed: ${(error as Error).message}`);
    }
}

/**
 * Top-level Pull router (QuickPick for Interactive vs Force)
 */
export async function executePullAction(
    fileTreeProvider: FileTreeProvider,
    sidebarProvider: SidebarProvider,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    const pick = await vscode.window.showQuickPick(
        [
            { label: '$(list-tree) Interactive Pull', description: 'Select files to extract from a source', action: 'pull' },
            { label: '$(repo-pull) Force Pull All', description: 'Quietly update all mapped files from sources', action: 'force' }
        ],
        { placeHolder: 'Choose a pull action...' }
    );

    if (pick?.action === 'pull') {
        executePull(fileTreeProvider, sidebarProvider, outputChannel);
    } else if (pick?.action === 'force') {
        vscode.commands.executeCommand('repo-cloak.forcePullAll');
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

/**
 * Build allowed paths set from file list (includes parent directories)
 */
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
