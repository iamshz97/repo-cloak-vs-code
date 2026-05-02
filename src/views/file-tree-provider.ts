/**
 * File Tree Provider
 * Native TreeView with checkboxes for file selection during Pull
 */

import * as vscode from 'vscode';
import { readdirSync } from 'fs';
import { join, relative } from 'path';
import { shouldIgnore, getAllFiles } from '../core/scanner';

export class FileTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly fullPath: string,
        public readonly isDir: boolean,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly rootPath: string,
        public readonly sourceLabel?: string
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

    private _searchedPaths: Set<string> | null = null;
    private _searchFilter: string = '';
    private _purpose: { title: string; message?: string } | null = null;
    private _bannedPaths: Set<string> | null = null;
    private _currentSourceLabel: string | null = null;

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
        bannedPaths?: Set<string>;
    }): void {
        this._rootPath = rootPath;
        this._checkedPaths.clear();
        this._allowedPaths = options?.allowedPaths || null;
        this._bannedPaths = options?.bannedPaths || null;

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
        this._searchedPaths = null;
        this._searchFilter = '';
        this._resolveSelection = null;
        this._purpose = null;
        this._currentSourceLabel = null;
        this._applyPurposeToView();
        this._onDidChangeTreeData.fire();
    }

    /**
     * Start file selection and return a promise that resolves with selected paths
     */
    startSelection(rootPath: string, options?: {
        allowedPaths?: Set<string>;
        precheck?: string[];
        bannedPaths?: Set<string>;
        purpose?: { title: string; message?: string };
        sourceLabel?: string;
    }): Promise<string[]> {
        this._currentSourceLabel = options?.sourceLabel || null;
        this.setRoot(rootPath, options);
        this._purpose = options?.purpose || null;
        this._applyPurposeToView();
        vscode.commands.executeCommand('setContext', 'repo-cloak.fileTreeVisible', true);

        return new Promise((resolve) => {
            this._resolveSelection = resolve;
        });
    }

    private _applyPurposeToView(): void {
        if (!this._treeView) { return; }
        if (this._purpose) {
            this._treeView.title = this._purpose.title;
            this._treeView.message = this._purpose.message;
        } else {
            this._treeView.title = 'Repo Cloak — File Selection';
            this._treeView.message = undefined;
        }
    }

    /**
     * Apply a text filter to search the tree
     */
    setSearchFilter(term: string): void {
        this._searchFilter = (term || '').trim().toLowerCase();
        
        // Let VS Code know if we have an active search (to show/hide clear button)
        vscode.commands.executeCommand('setContext', 'repo-cloak.fileTreeHasSearch', !!this._searchFilter);

        if (!this._searchFilter || !this._rootPath) {
            this._searchedPaths = null;
        } else {
            this._searchedPaths = new Set<string>();
            const allFiles = getAllFiles(this._rootPath);
            for (const f of allFiles) {
                if (f.relativePath.toLowerCase().includes(this._searchFilter)) {
                    this._searchedPaths.add(f.absolutePath);
                }
            }
        }
        this._onDidChangeTreeData.fire();
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
        const purposeTitle = this._purpose?.title;
        vscode.commands.executeCommand('setContext', 'repo-cloak.fileTreeVisible', false);
        if (this._resolveSelection) {
            this._resolveSelection([]);
            this._resolveSelection = null;
        }
        this.clear();
        vscode.window.setStatusBarMessage(
            `$(circle-slash) ${purposeTitle ? `${purposeTitle} cancelled` : 'File selection cancelled'}`,
            3000
        );
    }

    /**
     * Select all visible files (respects allowedPaths and search filter)
     */
    selectAll(): void {
        if (!this._rootPath) { return; }
        const allFiles = getAllFiles(this._rootPath);
        for (const f of allFiles) {
            if (this._allowedPaths && !this._allowedPaths.has(f.absolutePath)) { continue; }
            if (this._searchedPaths && !this._searchedPaths.has(f.absolutePath)) { continue; }
            if (this._bannedPaths && this._bannedPaths.has(f.absolutePath)) { continue; }
            this._checkedPaths.add(f.absolutePath);
        }
        // Tick parent folders bottom-up so the UI reflects the full selection
        this._tickFullySelectedDirs(this._rootPath);
        this._onDidChangeTreeData.fire();
    }

    /**
     * Walk the visible tree post-order; mark a directory as checked
     * iff every visible child is checked. Returns true if `dirPath` got ticked.
     */
    private _tickFullySelectedDirs(dirPath: string): boolean {
        let entries: { name: string; isDir: boolean; fullPath: string }[];
        try {
            entries = readdirSync(dirPath, { withFileTypes: true })
                .filter(e => !shouldIgnore(e.name))
                .map(e => ({ name: e.name, isDir: e.isDirectory(), fullPath: join(dirPath, e.name) }))
                .filter(e => {
                    if (this._allowedPaths && !this._allowedPaths.has(e.fullPath) && !this._isPathAncestorOfAllowed(e.fullPath)) { return false; }
                    if (this._searchedPaths && !this._searchedPaths.has(e.fullPath) && !this._isPathAncestorOfSearched(e.fullPath)) { return false; }
                    return true;
                });
        } catch {
            return false;
        }

        if (entries.length === 0) { return false; }

        let allChildrenChecked = true;
        for (const e of entries) {
            if (e.isDir) {
                const childChecked = this._tickFullySelectedDirs(e.fullPath);
                if (!childChecked) { allChildrenChecked = false; }
            } else if (!this._checkedPaths.has(e.fullPath)) {
                allChildrenChecked = false;
            }
        }

        if (allChildrenChecked) {
            this._checkedPaths.add(dirPath);
            return true;
        }
        return false;
    }

    /**
     * Deselect all files
     */
    deselectAll(): void {
        this._checkedPaths.clear();
        this._onDidChangeTreeData.fire();
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

                if (this._allowedPaths) {
                    if (!this._allowedPaths.has(fullPath) && !this._isPathAncestorOfAllowed(fullPath)) {
                        continue;
                    }
                }

                if (this._searchedPaths) {
                    if (!this._searchedPaths.has(fullPath) && !this._isPathAncestorOfSearched(fullPath)) {
                        continue;
                    }
                }

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
                        if (!this._allowedPaths.has(fullPath) && !this._isPathAncestorOfAllowed(fullPath)) {
                            return false;
                        }
                    }
                    if (this._searchedPaths) {
                        if (!this._searchedPaths.has(fullPath) && !this._isPathAncestorOfSearched(fullPath)) {
                            return false;
                        }
                    }
                    if (this._bannedPaths && !entry.isDirectory() && this._bannedPaths.has(fullPath)) {
                        return false;
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
                            ? (this._searchFilter ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
                            : vscode.TreeItemCollapsibleState.None,
                        this._rootPath!,
                        this._currentSourceLabel ?? undefined
                    );
                });
        } catch {
            return [];
        }
    }

    /**
     * Mark a path as banned in the active tree selection:
     * unchecks it and hides it from the tree immediately.
     */
    banPathInTree(fullPath: string): void {
        this._checkedPaths.delete(fullPath);
        if (!this._bannedPaths) { this._bannedPaths = new Set(); }
        this._bannedPaths.add(fullPath);
        this._onDidChangeTreeData.fire();
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

    private _isPathAncestorOfSearched(dirPath: string): boolean {
        if (!this._searchedPaths) { return true; }
        for (const searched of this._searchedPaths) {
            if (searched.startsWith(dirPath + '/') || searched.startsWith(dirPath + '\\')) {
                return true;
            }
        }
        return false;
    }
}
