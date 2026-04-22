/**
 * Copy for AI Command
 * Builds an anonymized Markdown bundle of files / diffs and copies it to the
 * clipboard so the user can paste it into Claude / ChatGPT / etc.
 */

import * as vscode from 'vscode';
import { existsSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';
import { FileTreeProvider } from '../views/file-tree-provider';
import { SidebarProvider } from '../views/sidebar-provider';
import { createAnonymizer, anonymizePath, Replacement } from '../core/anonymizer';
import { isBinaryFile } from '../core/scanner';
import { scanFilesForSecrets } from '../core/secrets';
import {
    hasMapping, loadRawMapping, decryptMappingV2, MappingV2,
    getSourceByLabel, getSourceLabels
} from '../core/mapper';
import { hasSecret, getOrCreateSecret } from '../core/crypto';
import {
    isGitRepo, getChangedFiles, getRecentCommits,
    getFilesChangedInCommits, getCommitDiff, getFileAtCommit
} from '../core/git';
import { buildBundle, BundleFile, BundleType, describeBundleType } from '../core/bundle';

const SIZE_WARN_BYTES = 500 * 1024;

export async function executeCopyForAI(
    initialLabel: string | undefined,
    fileTreeProvider: FileTreeProvider,
    sidebarProvider: SidebarProvider,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    try {
        const cloakedDir = findCloakedDirectory();
        if (!cloakedDir) {
            vscode.window.showErrorMessage('No cloaked workspace found. Pull files first.');
            return;
        }

        const raw = loadRawMapping(cloakedDir);
        if (!raw) {
            vscode.window.showErrorMessage('Could not load mapping.');
            return;
        }

        let mapping: MappingV2 = raw;
        if (raw.encrypted && hasSecret()) {
            try { mapping = decryptMappingV2(raw, getOrCreateSecret()); }
            catch {
                vscode.window.showErrorMessage('Could not decrypt mapping.');
                return;
            }
        }

        const replacements = (mapping.replacements as Replacement[] || []).filter(r => r.original);
        const anonymizer = createAnonymizer(replacements);

        // ── Pick source ─────────────────────────────────────────────────────
        const labels = getSourceLabels(mapping);
        if (labels.length === 0) {
            vscode.window.showWarningMessage('No sources available.');
            return;
        }

        let label = initialLabel;
        if (!label) {
            if (labels.length === 1) {
                label = labels[0];
            } else {
                const pick = await vscode.window.showQuickPick(
                    labels.map(l => ({ label: l })),
                    { title: 'Copy for AI — pick a source' }
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

        const sourceDir = source.path;
        const cloakedSubdir = join(cloakedDir, label);
        const sourceIsGit = sourceDir && existsSync(sourceDir) && isGitRepo(sourceDir);

        // ── Pick mode ───────────────────────────────────────────────────────
        type ModeItem = vscode.QuickPickItem & { value: BundleType | 'commits-diff' };
        const modes: ModeItem[] = [
            { label: '$(files) Files from cloaked workspace',
              description: 'Already-anonymized files in this repo', value: 'manual-cloaked' }
        ];
        if (sourceDir && existsSync(sourceDir)) {
            modes.push({ label: '$(files) Files from source repository',
                description: 'Pick live files from the source repo', value: 'manual-source' });
        }
        if (sourceIsGit) {
            modes.push(
                { label: '$(git-compare) Uncommitted changes (source)',
                  description: 'Files with pending changes', value: 'uncommitted' },
                { label: '$(history) Files from commits (source)',
                  description: 'Pick commits, get the union of changed files', value: 'commits' },
                { label: '$(diff) Diff of commit(s) (source)',
                  description: 'Pick 1 commit (vs parent) or 2 commits (range)', value: 'commit-diff' }
            );
        }

        const mode = await vscode.window.showQuickPick(modes, {
            title: `Copy for AI — "${label}"`,
            placeHolder: 'How would you like to assemble the bundle?'
        });
        if (!mode) { return; }

        let bundleMd = '';
        let bundleType: BundleType = mode.value as BundleType;
        let fileCount = 0;
        const extra: Record<string, string | undefined> = {};

        // ── Branch on mode ──────────────────────────────────────────────────
        if (mode.value === 'manual-cloaked') {
            // Browse the cloaked subdirectory; files are already anonymized.
            const picked = await fileTreeProvider.startSelection(cloakedSubdir);
            if (picked.length === 0) {
                vscode.window.showInformationMessage('No files selected.');
                return;
            }
            const files = readFilesAsBundle(picked, cloakedSubdir, /*anonymize*/ null, replacements, /*anonymizePathFn*/ false);
            fileCount = files.length;
            bundleMd = buildBundle({ type: bundleType, sourceLabel: label, extra, files });

        } else if (mode.value === 'manual-source') {
            const picked = await fileTreeProvider.startSelection(sourceDir);
            if (picked.length === 0) {
                vscode.window.showInformationMessage('No files selected.');
                return;
            }
            const findings = await scanIfNeeded(picked, outputChannel);
            const finalFiles = await maybeStripSecrets(picked, findings);
            if (!finalFiles) { return; }
            const files = readFilesAsBundle(finalFiles, sourceDir, anonymizer, replacements, /*anonymizePathFn*/ true);
            fileCount = files.length;
            bundleMd = buildBundle({ type: bundleType, sourceLabel: label, extra, files });

        } else if (mode.value === 'uncommitted') {
            const changed = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Window, title: '$(shield) Scanning uncommitted files...' },
                () => getChangedFiles(sourceDir)
            );
            const candidates = changed.map(f => resolve(sourceDir, f)).filter(existsSync);
            if (candidates.length === 0) {
                vscode.window.showWarningMessage('No uncommitted files found.');
                return;
            }
            const picked = await fileTreeProvider.startSelection(sourceDir, {
                precheck: candidates,
                allowedPaths: buildAllowedPaths(candidates, sourceDir)
            });
            if (picked.length === 0) { return; }
            const findings = await scanIfNeeded(picked, outputChannel);
            const finalFiles = await maybeStripSecrets(picked, findings);
            if (!finalFiles) { return; }
            const files = readFilesAsBundle(finalFiles, sourceDir, anonymizer, replacements, true);
            fileCount = files.length;
            bundleMd = buildBundle({ type: bundleType, sourceLabel: label, extra, files });

        } else if (mode.value === 'commits') {
            const commits = await getRecentCommits(sourceDir, 30);
            if (commits.length === 0) {
                vscode.window.showWarningMessage('No commits found.');
                return;
            }
            const picked = await vscode.window.showQuickPick(
                commits.map(c => ({ label: c.hash, description: c.message, value: c.hash })),
                { canPickMany: true, title: 'Pick commit(s) — files changed will be bundled' }
            );
            if (!picked || picked.length === 0) { return; }
            const hashes = picked.map(p => (p as any).value as string);
            const changed = await getFilesChangedInCommits(sourceDir, hashes);
            const candidates = changed.map(f => resolve(sourceDir, f)).filter(existsSync);
            if (candidates.length === 0) {
                vscode.window.showWarningMessage('No surviving files in those commits.');
                return;
            }
            const refined = await fileTreeProvider.startSelection(sourceDir, {
                precheck: candidates,
                allowedPaths: buildAllowedPaths(candidates, sourceDir)
            });
            if (refined.length === 0) { return; }
            const findings = await scanIfNeeded(refined, outputChannel);
            const finalFiles = await maybeStripSecrets(refined, findings);
            if (!finalFiles) { return; }
            extra['Commits'] = hashes.join(', ');
            const files = readFilesAsBundle(finalFiles, sourceDir, anonymizer, replacements, true);
            fileCount = files.length;
            bundleMd = buildBundle({ type: bundleType, sourceLabel: label, extra, files });

        } else if (mode.value === 'commit-diff') {
            const commits = await getRecentCommits(sourceDir, 50);
            if (commits.length === 0) {
                vscode.window.showWarningMessage('No commits found.');
                return;
            }
            const picked = await vscode.window.showQuickPick(
                commits.map(c => ({ label: c.hash, description: c.message, value: c.hash })),
                { canPickMany: true, title: 'Pick commit(s): 1 = diff vs parent · 2 = range · 3+ = each commit diffed individually' }
            );
            if (!picked || picked.length === 0) { return; }

            const hashes = picked.map(p => (p as any).value as string);
            // Sort oldest→newest (log is newest-first, so higher index = older)
            const sorted = [...hashes].sort((a, b) =>
                commits.findIndex(c => c.hash === b) - commits.findIndex(c => c.hash === a)
            );

            const rawDiff = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Window, title: '$(shield) Computing diff...' },
                async () => {
                    if (sorted.length === 1) {
                        // Single commit: diff vs its parent
                        return getCommitDiff(sourceDir, sorted[0]);
                    } else if (sorted.length === 2) {
                        // Two commits: range diff oldest..newest
                        return getCommitDiff(sourceDir, sorted[0], sorted[1]);
                    } else {
                        // 3+ commits: each commit's individual diff concatenated chronologically
                        const parts: string[] = [];
                        for (const hash of sorted) {
                            const d = await getCommitDiff(sourceDir, hash);
                            if (d.trim()) {
                                const msg = commits.find(c => c.hash === hash)?.message || hash;
                                parts.push(`# ${hash} — ${msg}\n\n${d}`);
                            }
                        }
                        return parts.join('\n\n' + '─'.repeat(72) + '\n\n');
                    }
                }
            );

            if (!rawDiff.trim()) {
                vscode.window.showWarningMessage('Empty diff.');
                return;
            }
            const findings = scanStringForSecretsLite(rawDiff);
            if (findings.length > 0) {
                const choice = await vscode.window.showWarningMessage(
                    `Possible sensitive data detected in diff (${findings.length} hit(s)). Continue?`,
                    { modal: true }, 'Continue', 'Cancel'
                );
                if (choice !== 'Continue') { return; }
            }
            const anonymizedDiff = anonymizer(rawDiff);
            extra['Commits'] = sorted.length === 2
                ? `${sorted[0]}..${sorted[1]}`
                : sorted.length === 1
                    ? `${sorted[0]} (vs parent)`
                    : sorted.join(', ');
            if (sorted.length >= 3) { extra['Diff mode'] = 'individual per-commit diffs, concatenated'; }
            bundleMd = buildBundle({ type: bundleType, sourceLabel: label, extra, diff: anonymizedDiff });

        } else {
            return;
        }

        // ── Size guard ──────────────────────────────────────────────────────
        const sizeBytes = Buffer.byteLength(bundleMd, 'utf-8');
        if (sizeBytes > SIZE_WARN_BYTES) {
            const ok = await vscode.window.showWarningMessage(
                `Bundle is ${(sizeBytes / 1024).toFixed(0)} KB. Copy anyway?`,
                { modal: true }, 'Copy'
            );
            if (ok !== 'Copy') { return; }
        }

        // ── Clipboard ───────────────────────────────────────────────────────
        await vscode.env.clipboard.writeText(bundleMd);

        const desc = describeBundleType(bundleType);
        const summary = fileCount > 0
            ? `Copied ${fileCount} file(s) — ${desc} from "${label}" — paste into your AI tool.`
            : `Copied diff — ${desc} from "${label}" — paste into your AI tool.`;

        const action = await vscode.window.showInformationMessage(summary, 'Show preview');
        if (action === 'Show preview') {
            const doc = await vscode.workspace.openTextDocument({ content: bundleMd, language: 'markdown' });
            await vscode.window.showTextDocument(doc, { preview: true });
        }

    } catch (error) {
        vscode.window.showErrorMessage(`Copy for AI failed: ${(error as Error).message}`);
    } finally {
        sidebarProvider.refresh();
    }
}

// ─── helpers ────────────────────────────────────────────────────────────────────

function findCloakedDirectory(): string | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) { return null; }
    for (const f of folders) {
        if (hasMapping(f.uri.fsPath)) { return f.uri.fsPath; }
    }
    return null;
}

function buildAllowedPaths(files: string[], rootDir: string): Set<string> {
    const allowed = new Set<string>();
    for (const file of files) {
        let p = file;
        while (p.length > rootDir.length) {
            allowed.add(p);
            p = resolve(p, '..');
        }
        allowed.add(rootDir);
    }
    return allowed;
}

function readFilesAsBundle(
    absPaths: string[],
    baseDir: string,
    anonymizer: ((c: string) => string) | null,
    replacements: Replacement[],
    anonymizePathFn: boolean
): BundleFile[] {
    const out: BundleFile[] = [];
    for (const abs of absPaths) {
        try {
            const stat = statSync(abs);
            if (!stat.isFile()) { continue; }
            if (isBinaryFile(abs)) { continue; }
            const rel = relative(baseDir, abs);
            const displayPath = anonymizePathFn ? anonymizePath(rel, replacements) : rel;
            const raw = readFileSync(abs, 'utf-8');
            const content = anonymizer ? anonymizer(raw) : raw;
            out.push({ path: displayPath, content });
        } catch { /* skip */ }
    }
    return out;
}

async function scanIfNeeded(files: string[], outputChannel: vscode.OutputChannel) {
    const findings = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: '$(shield) Scanning for sensitive data...' },
        () => scanFilesForSecrets(files)
    );
    if (findings.length > 0) {
        outputChannel.appendLine('[warn] Potential sensitive data detected before AI copy:');
        for (const f of findings) {
            outputChannel.appendLine(`  ${f.file}:${f.line} — ${f.type}`);
        }
    }
    return findings;
}

async function maybeStripSecrets(
    files: string[],
    findings: Array<{ file: string }>
): Promise<string[] | null> {
    if (findings.length === 0) { return files; }
    const proceed = await vscode.window.showWarningMessage(
        `${findings.length} potential secret(s) detected. What now?`,
        { modal: true },
        'Continue anyway',
        'Remove files with secrets',
        'Cancel'
    );
    if (proceed === 'Cancel' || !proceed) { return null; }
    if (proceed === 'Remove files with secrets') {
        const bad = new Set(findings.map(f => f.file));
        const remaining = files.filter(f => !bad.has(f));
        if (remaining.length === 0) {
            vscode.window.showWarningMessage('All selected files contained secrets.');
            return null;
        }
        return remaining;
    }
    return files;
}

/** Lightweight regex sweep for diffs (we don't have file paths to scan). */
function scanStringForSecretsLite(text: string): Array<{ type: string }> {
    const patterns: Array<{ type: string; re: RegExp }> = [
        { type: 'AWS Access Key', re: /AKIA[0-9A-Z]{16}/g },
        { type: 'Generic API key', re: /api[_-]?key["'\s:=]+[A-Za-z0-9_\-]{20,}/gi },
        { type: 'Password assignment', re: /password["'\s:=]+[^\s"']{6,}/gi },
        { type: 'Bearer token', re: /bearer\s+[A-Za-z0-9._\-]{20,}/gi },
        { type: 'PEM private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g }
    ];
    const findings: Array<{ type: string }> = [];
    for (const { type, re } of patterns) {
        if (re.test(text)) { findings.push({ type }); }
    }
    return findings;
}
