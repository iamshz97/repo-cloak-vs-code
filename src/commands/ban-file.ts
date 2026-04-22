/**
 * Ban File Command
 * Bans a tracked file: removes it from the cloaked workspace,
 * removes it from the mapping, and adds it to the encrypted ban list
 * so it is never pulled again.
 */

import * as vscode from 'vscode';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { SidebarProvider } from '../views/sidebar-provider';
import {
    hasMapping, loadRawMapping, saveMapping
} from '../core/mapper';
import { getOrCreateSecret, hasSecret, decrypt } from '../core/crypto';
import { addBan } from '../core/ban-list';

export async function executeBanFile(
    uriOrItem: vscode.Uri | { fullPath: string } | undefined,
    sidebarProvider: SidebarProvider,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    // Resolve the target file — works from both explorer/context (Uri) and
    // view/item/context on a FileTreeItem ({ fullPath: string })
    let targetUri: vscode.Uri | undefined;
    if (uriOrItem instanceof vscode.Uri) {
        targetUri = uriOrItem;
    } else if (uriOrItem && typeof (uriOrItem as any).fullPath === 'string') {
        targetUri = vscode.Uri.file((uriOrItem as any).fullPath);
    } else {
        targetUri = vscode.window.activeTextEditor?.document.uri;
    }

    if (!targetUri || targetUri.scheme !== 'file') {
        vscode.window.showWarningMessage('No file selected.');
        return;
    }
    const targetPath = targetUri.fsPath;

    // Find the cloaked directory
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showWarningMessage('No workspace open.');
        return;
    }

    let cloakedDir: string | null = null;
    for (const folder of workspaceFolders) {
        if (hasMapping(folder.uri.fsPath)) {
            cloakedDir = folder.uri.fsPath;
            break;
        }
    }

    if (!cloakedDir) {
        vscode.window.showWarningMessage('No Repo Cloak workspace found.');
        return;
    }

    // Load raw mapping (fields are encrypted strings, cloaked paths are plaintext)
    const mapping = loadRawMapping(cloakedDir);
    if (!mapping) {
        vscode.window.showWarningMessage('Could not load mapping.');
        return;
    }

    if (!hasSecret()) {
        vscode.window.showWarningMessage('Secret key not found. Cannot access mapping.');
        return;
    }

    const secret = getOrCreateSecret();

    // Find the FileEntry whose cloaked path (plaintext) matches the target file.
    // The `original` field may be encrypted — decrypt it only to get the ban key.
    let foundSourceLabel: string | null = null;
    let foundOriginalRelPath: string | null = null;
    let foundCloakedRelPath: string | null = null;

    outer: for (const source of mapping.sources) {
        for (const file of source.files) {
            const abs = join(cloakedDir, file.cloaked);
            if (abs === targetPath) {
                foundSourceLabel = source.label;
                foundCloakedRelPath = file.cloaked;
                // Decrypt the original path (it may be encrypted or plain)
                try {
                    const dec = decrypt(file.original, secret);
                    foundOriginalRelPath = dec ?? file.original;
                } catch {
                    foundOriginalRelPath = file.original;
                }
                break outer;
            }
        }
    }

    if (!foundSourceLabel || !foundOriginalRelPath || !foundCloakedRelPath) {
        vscode.window.showWarningMessage('This file is not tracked by Repo Cloak.');
        return;
    }

    // Add to ban list (uses decrypted original path as the key)
    addBan(foundSourceLabel, foundOriginalRelPath, secret);

    // Remove the FileEntry from the raw mapping (keep other encrypted entries intact)
    const cloakedRelToRemove = foundCloakedRelPath;
    for (const source of mapping.sources) {
        if (source.label === foundSourceLabel) {
            source.files = source.files.filter(f => f.cloaked !== cloakedRelToRemove);
            break;
        }
    }
    mapping.stats = {
        ...mapping.stats,
        totalFiles: mapping.sources.reduce((n, s) => n + s.files.length, 0)
    };
    mapping.updatedAt = new Date().toISOString();

    saveMapping(cloakedDir, mapping);

    // Delete physical file
    try {
        unlinkSync(targetPath);
    } catch {
        outputChannel.appendLine(`[ban-file] Could not delete ${targetPath}`);
    }

    sidebarProvider.refresh();
    vscode.window.setStatusBarMessage(
        `$(circle-slash) Banned "${foundOriginalRelPath.split('/').pop()}" from "${foundSourceLabel}"`,
        4000
    );
}

