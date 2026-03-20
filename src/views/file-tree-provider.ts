/**
 * File Tree Provider
 * Native TreeView with checkboxes for file selection during Pull
 */

import * as vscode from 'vscode';
import { readdirSync } from 'fs';
import { join, relative } from 'path';
import { shouldIgnore } from '../core/scanner';

export class FileTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly fullPath: string,
        public readonly isDir: boolean,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly rootPath: string
    ) {
        super(label, collapsibleState);
        this.tooltip = relative(rootPath, fullPath);
        this.description = isDir ? '' : relative(rootPath, fullPath);
        this.iconPath = isDir
            ? new vscode.ThemeIcon('folder')
            : new vscode.ThemeIcon('file');
        this.checkboxState = vscode.TreeItemCheckboxState.Unchecked;
        this.contextValue = isDir ? 'directory' : 'file';
        this.id = fullPath;
    }
}

export class FileTreeProvider implements vscode.TreeDataProvider<FileTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<FileTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private _rootPath: string | null = null;
    private _checkedPaths = new Set<string>();
    private _allowedPaths: Set<string> | null = null;
    private _precheck: Set<string> | null = null;
    private _resolveSelection: ((paths: string[]) => void) | null = null;
    private _treeView: vscode.TreeView<FileTreeItem> | null = null;

    get rootPath(): string | null {
        return this._rootPath;
    }

    get checkedPaths(): Set<string> {
        return this._checkedPaths;
    }

    setTreeView(treeView: vscode.TreeView<FileTreeItem>): void {
        this._treeView = treeView;
    }

    /**
     * Set the root directory to show in the tree
     */
    setRoot(rootPath: string, options?: {
        allowedPaths?: Set<string>;
        precheck?: string[];
    }): void {
        this._rootPath = rootPath;
        this._checkedPaths.clear();
        this._allowedPaths = options?.allowedPaths || null;

        if (options?.precheck) {
            this._precheck = new Set(options.precheck);
            for (const p of options.precheck) {
                this._checkedPaths.add(p);
            }
        } else {
            this._precheck = null;
        }

        this._onDidChangeTreeData.fire();
    }

    /**
     * Clear the tree
     */
    clear(): void {
        this._rootPath = null;
        this._checkedPaths.clear();
        this._allowedPaths = null;
        this._precheck = null;
        this._resolveSelection = null;
        this._onDidChangeTreeData.fire();
    }

    /**
     * Start file selection and return a promise that resolves with selected paths
     */
    startSelection(rootPath: string, options?: {
        allowedPaths?: Set<string>;
        precheck?: string[];
    }): Promise<string[]> {
        this.setRoot(rootPath, options);
        vscode.commands.executeCommand('setContext', 'repo-cloak.fileTreeVisible', true);

        return new Promise((resolve) => {
            this._resolveSelection = resolve;
        });
    }

    /**
     * Confirm the current selection
     */
    confirmSelection(): void {
        const selectedFiles = this.getSelectedFiles();
        vscode.commands.executeCommand('setContext', 'repo-cloak.fileTreeVisible', false);
        if (this._resolveSelection) {
            this._resolveSelection(selectedFiles);
            this._resolveSelection = null;
        }
        this.clear();
    }

    /**
     * Cancel the selection
     */
    cancelSelection(): void {
        vscode.commands.executeCommand('setContext', 'repo-cloak.fileTreeVisible', false);
        if (this._resolveSelection) {
            this._resolveSelection([]);
            this._resolveSelection = null;
        }
        this.clear();
    }

    /**
     * Get all selected file paths (not directories)
     */
    getSelectedFiles(): string[] {
        return Array.from(this._checkedPaths).filter(p => {
            try {
                const stat = require('fs').statSync(p);
                return stat.isFile();
            } catch {
                return false;
            }
        });
    }

    /**
     * Handle checkbox state changes with cascading logic
     */
    handleCheckboxChange(item: FileTreeItem, state: vscode.TreeItemCheckboxState): void {
        const isChecked = state === vscode.TreeItemCheckboxState.Checked;

        if (isChecked) {
            this._checkedPaths.add(item.fullPath);
        } else {
            this._checkedPaths.delete(item.fullPath);
        }

        // Cascade to children if directory
        if (item.isDir) {
            this._cascadeToChildren(item.fullPath, isChecked);
        }

        // Update parent state
        this._updateParentState(item.fullPath);

        this._onDidChangeTreeData.fire();
    }

    private _cascadeToChildren(dirPath: string, checked: boolean): void {
        try {
            const entries = readdirSync(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                if (shouldIgnore(entry.name)) { continue; }
                const fullPath = join(dirPath, entry.name);

                if (this._allowedPaths && !this._allowedPaths.has(fullPath)) { continue; }

                if (checked) {
                    this._checkedPaths.add(fullPath);
                } else {
                    this._checkedPaths.delete(fullPath);
                }

                if (entry.isDirectory()) {
                    this._cascadeToChildren(fullPath, checked);
                }
            }
        } catch {
            // ignore
        }
    }

    private _updateParentState(childPath: string): void {
        if (!this._rootPath) { return; }

        const { dirname } = require('path');
        let parentPath = dirname(childPath);

        while (parentPath && parentPath !== this._rootPath && parentPath.startsWith(this._rootPath)) {
            try {
                const entries = readdirSync(parentPath, { withFileTypes: true });
                const visibleChildren = entries.filter(e => !shouldIgnore(e.name));
                const allChecked = visibleChildren.every(e =>
                    this._checkedPaths.has(join(parentPath, e.name))
                );

                if (allChecked && visibleChildren.length > 0) {
                    this._checkedPaths.add(parentPath);
                } else {
                    this._checkedPaths.delete(parentPath);
                }
            } catch {
                break;
            }

            parentPath = dirname(parentPath);
        }
    }

    // ─── TreeDataProvider ─────────────────────────────────────────────────────────

    getTreeItem(element: FileTreeItem): vscode.TreeItem {
        element.checkboxState = this._checkedPaths.has(element.fullPath)
            ? vscode.TreeItemCheckboxState.Checked
            : vscode.TreeItemCheckboxState.Unchecked;
        return element;
    }

    getChildren(element?: FileTreeItem): FileTreeItem[] {
        const dirPath = element ? element.fullPath : this._rootPath;
        if (!dirPath) { return []; }

        try {
            const entries = readdirSync(dirPath, { withFileTypes: true });

            // Sort: directories first, then alphabetical
            entries.sort((a, b) => {
                if (a.isDirectory() && !b.isDirectory()) { return -1; }
                if (!a.isDirectory() && b.isDirectory()) { return 1; }
                return a.name.localeCompare(b.name);
            });

            return entries
                .filter(entry => {
                    if (shouldIgnore(entry.name)) { return false; }
                    const fullPath = join(dirPath, entry.name);
                    if (this._allowedPaths) {
                        return this._allowedPaths.has(fullPath) || this._isPathAncestorOfAllowed(fullPath);
                    }
                    return true;
                })
                .map(entry => {
                    const fullPath = join(dirPath, entry.name);
                    return new FileTreeItem(
                        entry.name,
                        fullPath,
                        entry.isDirectory(),
                        entry.isDirectory()
                            ? vscode.TreeItemCollapsibleState.Collapsed
                            : vscode.TreeItemCollapsibleState.None,
                        this._rootPath!
                    );
                });
        } catch {
            return [];
        }
    }

    private _isPathAncestorOfAllowed(dirPath: string): boolean {
        if (!this._allowedPaths) { return true; }
        for (const allowed of this._allowedPaths) {
            if (allowed.startsWith(dirPath + '/') || allowed.startsWith(dirPath + '\\')) {
                return true;
            }
        }
        return false;
    }
}
