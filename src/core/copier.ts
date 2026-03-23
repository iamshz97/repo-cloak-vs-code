/**
 * File Copier
 * Copies files while preserving directory structure and anonymizing paths
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import { isBinaryFile } from './scanner';
import { Replacement, anonymizePath } from './anonymizer';

/**
 * Copy a single file, creating directories as needed
 */
export function copyFile(sourcePath: string, destPath: string): void {
    const destDir = dirname(destPath);
    mkdirSync(destDir, { recursive: true });
    copyFileSync(sourcePath, destPath);
}

interface TransformResult {
    transformed: boolean;
    originalLength?: number;
    newLength?: number;
    error?: string;
}

/**
 * Copy a file with content transformation
 */
export function copyFileWithTransform(
    sourcePath: string,
    destPath: string,
    transformFn: (content: string) => string
): TransformResult {
    const destDir = dirname(destPath);
    mkdirSync(destDir, { recursive: true });

    if (isBinaryFile(sourcePath)) {
        copyFileSync(sourcePath, destPath);
        return { transformed: false };
    }

    try {
        let content = readFileSync(sourcePath, 'utf-8');
        const originalContent = content;
        content = transformFn(content);
        writeFileSync(destPath, content, 'utf-8');
        return {
            transformed: content !== originalContent,
            originalLength: originalContent.length,
            newLength: content.length
        };
    } catch (error) {
        copyFileSync(sourcePath, destPath);
        return { transformed: false, error: (error as Error).message };
    }
}

export interface CopyResults {
    total: number;
    copied: number;
    transformed: number;
    pathsRenamed: number;
    errors: Array<{ file: string; error: string }>;
}

export type FileInput = string | { absolutePath: string; relativePath: string };
export type ProgressCallback = (current: number, total: number, file: string) => void;

/**
 * Copy multiple files with progress callback
 */
export async function copyFiles(
    files: FileInput[],
    sourceBase: string,
    destBase: string,
    transformFn: ((content: string) => string) | null,
    onProgress?: ProgressCallback,
    replacements: Replacement[] = []
): Promise<CopyResults> {
    const results: CopyResults = {
        total: files.length,
        copied: 0,
        transformed: 0,
        pathsRenamed: 0,
        errors: []
    };

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const originalRelativePath = typeof file === 'string'
            ? relative(sourceBase, file)
            : file.relativePath;
        const sourcePath = typeof file === 'string' ? file : file.absolutePath;

        const anonymizedPath = anonymizePath(originalRelativePath, replacements);
        const destPath = join(destBase, anonymizedPath);

        if (anonymizedPath !== originalRelativePath) {
            results.pathsRenamed++;
        }

        try {
            if (transformFn) {
                const result = copyFileWithTransform(sourcePath, destPath, transformFn);
                if (result.transformed) {
                    results.transformed++;
                }
            } else {
                copyFile(sourcePath, destPath);
            }
            results.copied++;
        } catch (error) {
            results.errors.push({
                file: originalRelativePath,
                error: (error as Error).message
            });
        }

        if (onProgress) {
            onProgress(i + 1, files.length, anonymizedPath);
        }
    }

    return results;
}
