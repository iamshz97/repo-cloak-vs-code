/**
 * Git Integration
 * Utilities to interact with Git repositories
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { join } from 'path';

const execAsync = promisify(exec);

/**
 * Check if a directory is a Git repository
 */
export function isGitRepo(dirPath: string): boolean {
    return existsSync(join(dirPath, '.git'));
}

export interface Commit {
    hash: string;
    message: string;
}

/**
 * Get list of changed/added/untracked files
 */
export async function getChangedFiles(dirPath: string): Promise<string[]> {
    try {
        const { stdout } = await execAsync('git status --porcelain -u', { cwd: dirPath });

        if (!stdout) { return []; }

        const files = stdout
            .split('\n')
            .filter(line => line.trim() !== '')
            .map(line => {
                const status = line.substring(0, 2);
                let file = line.substring(3).trim();

                if (file.includes(' -> ')) {
                    file = file.split(' -> ')[1];
                }

                const cleanFile = file.replace(/^"|"$/g, '');
                return { status, file: cleanFile };
            })
            .filter(item => !item.status.includes('D'))
            .map(item => item.file);

        return files;
    } catch (error) {
        return [];
    }
}

/**
 * Get recent commits
 */
export async function getRecentCommits(dirPath: string, count: number = 10): Promise<Commit[]> {
    try {
        const { stdout } = await execAsync(`git log -n ${count} --pretty=format:"%h - %s"`, { cwd: dirPath });
        if (!stdout) { return []; }

        return stdout
            .split(/\r?\n/)
            .filter(line => line.trim() !== '')
            .map(line => {
                const sepIndex = line.indexOf(' - ');
                if (sepIndex === -1) { return { hash: line.trim(), message: '' }; }
                const hash = line.substring(0, sepIndex).trim();
                const message = line.substring(sepIndex + 3).trim();
                return { hash, message };
            });
    } catch (error) {
        return [];
    }
}

/**
 * Get list of files changed in specific commits
 */
export async function getFilesChangedInCommits(dirPath: string, commits: string[]): Promise<string[]> {
    if (!commits || commits.length === 0) { return []; }

    try {
        const filesSet = new Set<string>();

        for (const commit of commits) {
            const { stdout } = await execAsync(`git show --name-status --pretty="" ${commit}`, { cwd: dirPath });
            if (stdout) {
                const lines = stdout.split(/\r?\n/).filter(line => line.trim() !== '');
                for (const line of lines) {
                    const parts = line.split('\t');
                    if (parts.length < 2) { continue; }

                    const status = parts[0];
                    if (!status.startsWith('D')) {
                        const file = parts.length > 2 ? parts[2] : parts[1];
                        const cleanFile = file.replace(/^"|"$/g, '');
                        filesSet.add(cleanFile);
                    }
                }
            }
        }

        return Array.from(filesSet);
    } catch (error) {
        return [];
    }
}

/**
 * Get a unified diff for one commit (vs its parent) or between two commits.
 * If `commitB` is omitted, uses `git show --patch <commitA>`.
 */
export async function getCommitDiff(
    dirPath: string,
    commitA: string,
    commitB?: string
): Promise<string> {
    try {
        const cmd = commitB
            ? `git diff --no-color ${commitA}..${commitB}`
            : `git show --no-color --patch --pretty=fuller ${commitA}`;
        const { stdout } = await execAsync(cmd, { cwd: dirPath, maxBuffer: 50 * 1024 * 1024 });
        return stdout || '';
    } catch (error) {
        return '';
    }
}

/**
 * Get the contents of a file at a specific commit. Returns null on failure
 * (e.g., file did not exist in that commit).
 */
export async function getFileAtCommit(
    dirPath: string,
    commit: string,
    relativePath: string
): Promise<string | null> {
    try {
        const { stdout } = await execAsync(
            `git show ${commit}:${shellQuote(relativePath)}`,
            { cwd: dirPath, maxBuffer: 50 * 1024 * 1024 }
        );
        return stdout;
    } catch {
        return null;
    }
}

function shellQuote(value: string): string {
    // Use single quotes; escape any embedded single quotes.
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
