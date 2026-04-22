/**
 * Cloaked Workspace Git Integration
 *
 * Treats the cloaked workspace as its own git repository so every pull/push
 * operation produces a commit — giving users an audit trail and making
 * PR-summary diffs first-class.
 *
 * Behavior is controlled by the `repo-cloak.git` setting:
 *   "full"        — auto-init + auto-commit (default)
 *   "commit-only" — auto-commit only if a git repo already exists
 *   "off"         — never touch git
 */

import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { isGitRepo } from './git';

const execAsync = promisify(exec);

export type GitMode = 'full' | 'commit-only' | 'off';

const DEFAULT_GITIGNORE =
`# repo-cloak: cloaked workspace .gitignore
node_modules/
.DS_Store
*.log
.env
.env.*
`;

export function getGitMode(): GitMode {
    const cfg = vscode.workspace.getConfiguration('repo-cloak');
    const mode = cfg.get<string>('git', 'full');
    if (mode === 'off' || mode === 'commit-only' || mode === 'full') { return mode; }
    return 'full';
}

async function gitAvailable(cwd: string): Promise<boolean> {
    try {
        await execAsync('git --version', { cwd });
        return true;
    } catch {
        return false;
    }
}

async function ensureGitIdentity(cwd: string): Promise<void> {
    // If user has neither user.email nor user.name, set local fallbacks so the commit doesn't fail.
    try {
        const { stdout: email } = await execAsync('git config user.email', { cwd });
        if (email.trim()) { return; }
    } catch { /* not set */ }
    try {
        await execAsync('git config user.email "noreply@repo-cloak.local"', { cwd });
        await execAsync('git config user.name "Repo Cloak"', { cwd });
    } catch { /* ignore */ }
}

/**
 * Initialize the cloaked dir as a git repo if needed (and allowed by settings).
 * Returns true if a repo exists (already or newly created).
 */
export async function ensureCloakedRepo(cloakedDir: string): Promise<boolean> {
    const mode = getGitMode();
    if (mode === 'off') { return false; }

    if (isGitRepo(cloakedDir)) { return true; }

    if (mode === 'commit-only') { return false; } // exists-only mode; don't init

    if (!(await gitAvailable(cloakedDir))) { return false; }

    try {
        await execAsync('git init', { cwd: cloakedDir });

        const gitignorePath = join(cloakedDir, '.gitignore');
        if (!existsSync(gitignorePath)) {
            writeFileSync(gitignorePath, DEFAULT_GITIGNORE, 'utf-8');
        }

        await ensureGitIdentity(cloakedDir);

        // Initial commit: just the mapping + gitignore. Pre-existing files stay
        // untracked so the user explicitly decides whether to track them.
        await execAsync('git add .gitignore .repo-cloak-map.json', { cwd: cloakedDir });
        await execAsync('git commit -m "repo-cloak: initialize cloaked workspace" --allow-empty', { cwd: cloakedDir });
        return true;
    } catch {
        return false;
    }
}

/**
 * Stage the given paths (relative to cloakedDir) plus the mapping file,
 * then commit with the supplied subject. The body (file list) is built
 * automatically from `git diff --cached --name-status`. Silent no-op on failure.
 */
export async function commitCloakedChange(
    cloakedDir: string,
    subject: string,
    relativePaths: string[],
    options: { allowEmpty?: boolean } = {}
): Promise<void> {
    const mode = getGitMode();
    if (mode === 'off') { return; }

    const repoExists = await ensureCloakedRepo(cloakedDir);
    if (!repoExists) { return; }

    if (!(await gitAvailable(cloakedDir))) { return; }

    try {
        await ensureGitIdentity(cloakedDir);

        // Always include the mapping file — it's the audit trail.
        const toAdd = ['.repo-cloak-map.json', 'AGENTS.md', '.gitignore', ...relativePaths.filter(Boolean)];

        for (const p of toAdd) {
            try {
                await execAsync(`git add -A -- ${shellQuote(p)}`, { cwd: cloakedDir });
            } catch { /* skip missing paths */ }
        }

        const { stdout: nameStatus } = await execAsync('git diff --cached --name-status', { cwd: cloakedDir });
        if (!nameStatus.trim() && !options.allowEmpty) { return; }

        const body = formatChangeBody(nameStatus);
        const message = body ? `${subject}\n\n${body}` : subject;
        const safe = message.replace(/"/g, '\\"');
        const emptyFlag = options.allowEmpty ? ' --allow-empty' : '';
        await execAsync(`git commit${emptyFlag} -m "${safe}"`, { cwd: cloakedDir });

        vscode.window.setStatusBarMessage(`$(git-commit) ${subject}`, 3000);
    } catch {
        // never break the user-facing operation
    }
}

function formatChangeBody(nameStatus: string): string {
    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];
    for (const line of nameStatus.split(/\r?\n/)) {
        if (!line.trim()) { continue; }
        const [status, ...rest] = line.split(/\s+/);
        const path = rest.join(' ');
        if (!path) { continue; }
        if (status.startsWith('A')) { added.push(path); }
        else if (status.startsWith('D')) { deleted.push(path); }
        else { modified.push(path); }
    }
    return [
        fileList('+', added),
        fileList('~', modified),
        fileList('-', deleted)
    ].filter(Boolean).join('\n');
}

function shellQuote(p: string): string {
    // Single-quote for POSIX shells; escape embedded single quotes.
    return `'${p.replace(/'/g, `'\\''`)}'`;
}

function fileList(label: string, paths: string[]): string {
    if (paths.length === 0) { return ''; }
    const shown = paths.slice(0, 20).map(p => `  ${label} ${p}`).join('\n');
    const rest = paths.length > 20 ? `\n  …and ${paths.length - 20} more` : '';
    return shown + rest;
}

// ─── Subject builders ─────────────────────────────────────────────────────

export function pullSubject(sourceLabel: string, fileCount: number): string {
    return `repo-cloak: pull from "${sourceLabel}" (${fileCount} file${fileCount === 1 ? '' : 's'})`;
}

export function pushSubject(sourceLabel: string, fileCount: number): string {
    return `repo-cloak: push to "${sourceLabel}" (${fileCount} file${fileCount === 1 ? '' : 's'})`;
}

export function forcePullSubject(sourceLabel: string, fileCount: number): string {
    return `repo-cloak: force-pull "${sourceLabel}" — refreshed from source repo (${fileCount} file${fileCount === 1 ? '' : 's'})`;
}

export function forcePushSubject(sourceLabel: string, fileCount: number): string {
    return `repo-cloak: force-push "${sourceLabel}" — overwrote source repo (${fileCount} file${fileCount === 1 ? '' : 's'})`;
}
