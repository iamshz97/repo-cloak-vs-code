/**
 * Sidebar Provider
 * Webview-based sidebar panel showing session status, sources, replacements, and action buttons
 */

import * as vscode from 'vscode';
import { hasMapping, loadRawMapping, decryptMappingV2, MappingV2 } from '../core/mapper';
import { hasSecret, getOrCreateSecret } from '../core/crypto';

export class SidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'repo-cloak.sidebar';

    private _view?: vscode.WebviewView;
    private _mapping: MappingV2 | null = null;
    private _destDir: string | null = null;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true
        };

        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'pull':
                    vscode.commands.executeCommand('repo-cloak.pull');
                    break;
                case 'push':
                    vscode.commands.executeCommand('repo-cloak.push');
                    break;
                case 'pushAll':
                    vscode.commands.executeCommand('repo-cloak.pushAll');
                    break;
                case 'sync':
                    vscode.commands.executeCommand('repo-cloak.sync');
                    break;
                case 'addSource':
                    vscode.commands.executeCommand('repo-cloak.addSource');
                    break;
                case 'addReplacement':
                    vscode.commands.executeCommand('repo-cloak.addReplacement');
                    break;
                case 'removeSource':
                    vscode.commands.executeCommand('repo-cloak.removeSource', message.label);
                    break;
            }
        });

        this.refresh();
    }

    /**
     * Refresh the sidebar — re-detect mapping from workspace
     */
    refresh(): void {
        this._detectMapping();
        this._updateView();
    }

    private _detectMapping(): void {
        this._mapping = null;
        this._destDir = null;

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) { return; }

        for (const folder of workspaceFolders) {
            if (hasMapping(folder.uri.fsPath)) {
                const raw = loadRawMapping(folder.uri.fsPath);
                if (raw) {
                    this._destDir = folder.uri.fsPath;

                    // Try to decrypt
                    if (raw.encrypted && hasSecret()) {
                        try {
                            this._mapping = decryptMappingV2(raw, getOrCreateSecret());
                        } catch {
                            this._mapping = raw;
                        }
                    } else {
                        this._mapping = raw;
                    }
                }
                break;
            }
        }
    }

    private _updateView(): void {
        if (!this._view) { return; }
        this._view.webview.html = this._getHtmlContent();
    }

    private _getHtmlContent(): string {
        const m = this._mapping;

        const sourcesHtml = m && m.sources && m.sources.length > 0
            ? m.sources.map(s => {
                const fileCount = s.files?.length || 0;
                return `
                    <div class="source-item">
                        <span class="source-icon">📦</span>
                        <span class="source-label">${escapeHtml(s.label)}</span>
                        <span class="source-count">${fileCount} files</span>
                        <button class="icon-btn danger" onclick="removeSource('${escapeHtml(s.label)}')" title="Remove source">✕</button>
                    </div>
                `;
            }).join('')
            : '<div class="empty-state">No sources configured</div>';

        const replacementsHtml = m && m.replacements && m.replacements.length > 0
            ? (m.replacements as any[]).map(r => {
                const orig = r.encrypted ? '[encrypted]' : escapeHtml(r.original || '');
                return `
                    <div class="replacement-item">
                        <span class="replacement-from">"${orig}"</span>
                        <span class="replacement-arrow">→</span>
                        <span class="replacement-to">"${escapeHtml(r.replacement)}"</span>
                    </div>
                `;
            }).join('')
            : '<div class="empty-state">No replacements</div>';

        const statusHtml = m
            ? `<div class="status active">
                <span class="status-dot"></span>
                <span>Active workspace</span>
               </div>
               <div class="stat-grid">
                   <div class="stat"><span class="stat-num">${m.stats?.totalSources || m.sources?.length || 0}</span><span class="stat-label">sources</span></div>
                   <div class="stat"><span class="stat-num">${m.stats?.totalFiles || 0}</span><span class="stat-label">files</span></div>
                   <div class="stat"><span class="stat-num">${m.stats?.replacementsCount || m.replacements?.length || 0}</span><span class="stat-label">replacements</span></div>
               </div>`
            : '<div class="status inactive"><span class="status-dot"></span><span>No active session</span></div>';

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        padding: 12px;
    }

    .header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 16px;
        padding-bottom: 8px;
        border-bottom: 1px solid var(--vscode-widget-border);
    }
    .header h2 { font-size: 13px; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase; }
    .header .logo { font-size: 18px; }

    .btn-row {
        display: flex;
        gap: 6px;
        margin-bottom: 16px;
    }
    .btn {
        flex: 1;
        padding: 6px 10px;
        border: 1px solid var(--vscode-button-border, var(--vscode-widget-border));
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        border-radius: 4px;
        cursor: pointer;
        font-size: 11px;
        font-family: inherit;
        text-align: center;
        transition: background 0.15s;
    }
    .btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .btn.primary {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
    }
    .btn.primary:hover { background: var(--vscode-button-hoverBackground); }

    .section { margin-bottom: 16px; }
    .section-title {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--vscode-descriptionForeground);
        margin-bottom: 8px;
    }

    .status {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        margin-bottom: 8px;
    }
    .status-dot {
        width: 8px; height: 8px;
        border-radius: 50%;
        display: inline-block;
    }
    .status.active .status-dot { background: #4ec9b0; }
    .status.inactive .status-dot { background: var(--vscode-descriptionForeground); }

    .stat-grid {
        display: flex;
        gap: 12px;
        margin-bottom: 8px;
    }
    .stat { display: flex; flex-direction: column; align-items: center; }
    .stat-num { font-size: 18px; font-weight: 700; color: var(--vscode-foreground); }
    .stat-label { font-size: 10px; color: var(--vscode-descriptionForeground); text-transform: uppercase; }

    .source-item {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 6px;
        border-radius: 3px;
        margin-bottom: 2px;
    }
    .source-item:hover { background: var(--vscode-list-hoverBackground); }
    .source-icon { font-size: 14px; }
    .source-label { flex: 1; font-size: 12px; }
    .source-count { font-size: 11px; color: var(--vscode-descriptionForeground); }

    .replacement-item {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 3px 6px;
        font-size: 11px;
        font-family: var(--vscode-editor-font-family);
        margin-bottom: 2px;
    }
    .replacement-from { color: var(--vscode-errorForeground, #f44747); }
    .replacement-arrow { color: var(--vscode-descriptionForeground); }
    .replacement-to { color: var(--vscode-debugIcon-startForeground, #89d185); }

    .empty-state {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        font-style: italic;
        padding: 4px 6px;
    }

    .icon-btn {
        background: none;
        border: none;
        cursor: pointer;
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
        padding: 2px 4px;
        border-radius: 3px;
        opacity: 0;
        transition: opacity 0.15s;
    }
    .source-item:hover .icon-btn { opacity: 1; }
    .icon-btn.danger:hover { color: var(--vscode-errorForeground); }

    .add-link {
        font-size: 11px;
        color: var(--vscode-textLink-foreground);
        cursor: pointer;
        padding: 4px 6px;
        display: inline-block;
    }
    .add-link:hover { text-decoration: underline; }
</style>
</head>
<body>
    <div class="header">
        <span class="logo">🎭</span>
        <h2>Repo Cloak</h2>
    </div>

    <div class="btn-row">
        <button class="btn primary" onclick="send('pull')">⬇ Pull</button>
        <button class="btn primary" onclick="send('push')">⬆ Push</button>
    </div>

    <div class="section">
        <div class="section-title">Status</div>
        ${statusHtml}
    </div>

    ${m ? `
    <div class="btn-row">
        <button class="btn" onclick="send('sync')">⟳ Sync All</button>
        <button class="btn" onclick="send('pushAll')">⬆ Push All</button>
    </div>
    ` : ''}

    <div class="section">
        <div class="section-title">Sources</div>
        ${sourcesHtml}
        <span class="add-link" onclick="send('addSource')">+ Add source</span>
    </div>

    <div class="section">
        <div class="section-title">Replacements</div>
        ${replacementsHtml}
        <span class="add-link" onclick="send('addReplacement')">+ Add replacement</span>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        function send(cmd) { vscode.postMessage({ command: cmd }); }
        function removeSource(label) { vscode.postMessage({ command: 'removeSource', label }); }
    </script>
</body>
</html>`;
    }
}

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
