/**
 * Directory Scanner
 * Scans and builds file tree structure
 */

import { readdirSync, statSync } from 'fs';
import { join, relative, extname } from 'path';

// Binary file extensions to copy without modification
const BINARY_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
    '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.webm',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2',
    '.exe', '.dll', '.so', '.dylib', '.bin',
    '.ttf', '.otf', '.woff', '.woff2', '.eot',
    '.sqlite', '.db', '.mdb'
]);

// Directories to always ignore
const IGNORE_DIRS = new Set([
    'node_modules',
    '.git',
    '.svn',
    '.hg',
    '.DS_Store',
    'Thumbs.db',
    '.idea',
    '.vscode',
    '__pycache__',
    '.pytest_cache',
    'dist',
    'build',
    '.next',
    '.nuxt',
    'coverage',
    '.nyc_output',
    '.repo-cloak-map.json',
    '.env',
    '.env.local'
]);

export interface ScannedFile {
    absolutePath: string;
    relativePath: string;
    name: string;
    isBinary: boolean;
}

export interface TreeNode {
    name: string;
    path: string;
    relativePath: string;
    isDirectory: boolean;
    depth: number;
}

/**
 * Check if a file is binary based on extension
 */
export function isBinaryFile(filePath: string): boolean {
    const ext = extname(filePath).toLowerCase();
    return BINARY_EXTENSIONS.has(ext);
}

/**
 * Check if a file/folder should be ignored
 */
export function shouldIgnore(name: string): boolean {
    return IGNORE_DIRS.has(name) || name.startsWith('.');
}

/**
 * Recursively get all files in a directory
 */
export function getAllFiles(dir: string, basePath: string = dir, files: ScannedFile[] = []): ScannedFile[] {
    try {
        const entries = readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = join(dir, entry.name);

            if (shouldIgnore(entry.name)) { continue; }

            if (entry.isDirectory()) {
                getAllFiles(fullPath, basePath, files);
            } else {
                files.push({
                    absolutePath: fullPath,
                    relativePath: relative(basePath, fullPath),
                    name: entry.name,
                    isBinary: isBinaryFile(fullPath)
                });
            }
        }
    } catch (error) {
        // Permission denied or other errors - skip
    }

    return files;
}

/**
 * Get directory structure for display
 */
export function getDirectoryTree(dir: string, basePath: string = dir, depth: number = 0, maxDepth: number = 5): TreeNode[] {
    const tree: TreeNode[] = [];

    if (depth > maxDepth) { return tree; }

    try {
        const entries = readdirSync(dir, { withFileTypes: true });

        entries.sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) { return -1; }
            if (!a.isDirectory() && b.isDirectory()) { return 1; }
            return a.name.localeCompare(b.name);
        });

        for (const entry of entries) {
            if (shouldIgnore(entry.name)) { continue; }

            const fullPath = join(dir, entry.name);
            const node: TreeNode = {
                name: entry.name,
                path: fullPath,
                relativePath: relative(basePath, fullPath),
                isDirectory: entry.isDirectory(),
                depth
            };

            tree.push(node);

            if (entry.isDirectory()) {
                const children = getDirectoryTree(fullPath, basePath, depth + 1, maxDepth);
                tree.push(...children);
            }
        }
    } catch (error) {
        // Skip inaccessible directories
    }

    return tree;
}

/**
 * Count files in a directory (recursive)
 */
export function countFiles(dir: string): number {
    return getAllFiles(dir).length;
}
