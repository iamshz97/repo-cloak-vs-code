/**
 * Sidebar Provider
 * Webview sidebar — clean, minimal, Microsoft-standard design
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
                case 'pullAction':
                    vscode.commands.executeCommand('repo-cloak.pullAction');
                    break;
                case 'pullSource':
                    vscode.commands.executeCommand('repo-cloak.pullSource', message.label);
                    break;
                case 'push':
                    vscode.commands.executeCommand('repo-cloak.push');
                    break;
                case 'pushAction':
                    vscode.commands.executeCommand('repo-cloak.pushAction');
                    break;
                case 'pushAll':
                    vscode.commands.executeCommand('repo-cloak.pushAll');
                    break;
                case 'forcePullSource':
                    vscode.commands.executeCommand('repo-cloak.forcePullSource', message.label);
                    break;
                case 'forcePushSource':
                    vscode.commands.executeCommand('repo-cloak.forcePushSource', message.label);
                    break;

                case 'addSource':
                    vscode.commands.executeCommand('repo-cloak.addSource');
                    break;
                case 'addReplacement':
                    vscode.commands.executeCommand('repo-cloak.addReplacement');
                    break;
                case 'removeReplacement':
                    vscode.commands.executeCommand('repo-cloak.removeReplacement', message.label);
                    break;
                case 'removeSource':
                    vscode.commands.executeCommand('repo-cloak.removeSource', message.label);
                    break;
                case 'pullSourceGit':
                    vscode.commands.executeCommand('repo-cloak.pullSourceGit', message.label);
                    break;
            }
        });

        this.refresh();
    }

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
                const label = escapeHtml(s.label);
                return `
                    <div class="list-item">
                        <div class="list-item-content">
                            <span class="codicon codicon-package"></span>
                            <span class="list-item-label">${label}</span>
                            <span class="list-item-desc">${fileCount} files</span>
                        </div>
                        <div class="list-item-actions">
                            <button class="icon-btn" onclick="send('pullSourceGit','${label}', this)" title="Pull from Git changes">
                                <span class="codicon codicon-git-compare"></span>
                            </button>
                            <button class="icon-btn" onclick="send('pullSource','${label}', this)" title="Interactive Pull (add files)">
                                <span class="codicon codicon-cloud-download"></span>
                            </button>
                            <button class="icon-btn" onclick="send('forcePullSource','${label}', this)" title="Force Pull (update files)">
                                <span class="codicon codicon-repo-pull"></span>
                            </button>
                            <button class="icon-btn" onclick="send('forcePushSource','${label}', this)" title="Force Push (restore files)">
                                <span class="codicon codicon-repo-push"></span>
                            </button>
                            <button class="icon-btn danger" onclick="send('removeSource','${label}', this)" title="Remove">
                                <span class="codicon codicon-trash"></span>
                            </button>
                        </div>
                    </div>`;
            }).join('')
            : '<p class="empty">No sources added yet</p>';

        const replacementsHtml = m && m.replacements && m.replacements.length > 0
            ? (m.replacements as any[]).map(r => {
                const orig = r.encrypted ? 'encrypted' : escapeHtml(r.original || '');
                const rawOrig = r.original ? r.original.replace(/'/g, "\\'") : '';
                return `
                    <div class="list-item replacement">
                        <div class="list-item-content">
                            <code class="from">${orig}</code>
                            <span class="arrow">&rarr;</span>
                            <code class="to">${escapeHtml(r.replacement)}</code>
                        </div>
                        <div class="list-item-actions">
                            ${r.encrypted ? '' : `<button class="icon-btn danger" onclick="send('removeReplacement','${rawOrig}', this)" title="Remove">
                                <span class="codicon codicon-trash"></span>
                            </button>`}
                        </div>
                    </div>`;
            }).join('')
            : '<p class="empty">No replacements</p>';

        const hasSession = !!m;
        const totalSources = m?.stats?.totalSources || m?.sources?.length || 0;
        const totalFiles = m?.stats?.totalFiles || 0;
        const totalTotalReplacements = m?.stats?.replacementsCount || m?.replacements?.length || 0;
        const nonce = new Date().getTime().toString() + Math.random().toString();

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="nonce" content="${nonce}">
<style>
    :root {
        --section-spacing: 14px;
        --item-radius: 3px;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        padding: 0 12px 12px;
        line-height: 1.4;
    }

    /* ── Actions ─── */
    .action-bar {
        display: flex;
        gap: 4px;
        padding: 10px 0;
        border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border));
        margin-bottom: var(--section-spacing);
    }
    .action-btn {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 5px;
        padding: 5px 8px;
        background: transparent;
        color: var(--vscode-foreground);
        border: 1px solid var(--vscode-widget-border);
        border-radius: var(--item-radius);
        cursor: pointer;
        font: inherit;
        font-size: 11px;
        transition: background 0.1s, border-color 0.1s;
    }
    .action-btn:hover {
        background: var(--vscode-toolbar-hoverBackground);
        border-color: var(--vscode-focusBorder);
    }

    /* ── Status ─── */
    .status-bar {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: var(--section-spacing);
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
    }
    .status-dot {
        width: 6px; height: 6px;
        border-radius: 50%;
        background: var(--vscode-descriptionForeground);
    }
    .status-bar.active .status-dot {
        background: var(--vscode-testing-iconPassed, #73c991);
    }
    .stats {
        display: flex;
        gap: 16px;
        margin-bottom: var(--section-spacing);
    }
    .stat {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
    }
    .stat strong {
        color: var(--vscode-foreground);
        font-weight: 600;
    }

    /* ── Sections ─── */
    .section { margin-bottom: var(--section-spacing); }
    .section-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 4px;
    }
    .section-title {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 1px;
        color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
    }
    .section-action {
        font-size: 11px;
        color: var(--vscode-textLink-foreground);
        background: none;
        border: none;
        cursor: pointer;
        font: inherit;
        padding: 0;
    }
    .section-action:hover { text-decoration: underline; }

    /* ── List items ─── */
    .list-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 3px 6px;
        border-radius: var(--item-radius);
        min-height: 24px;
    }
    .list-item:hover {
        background: var(--vscode-list-hoverBackground);
    }
    .list-item-content {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        flex: 1;
    }
    .list-item-label {
        font-size: 12px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .list-item-desc {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        white-space: nowrap;
    }
    .list-item-actions {
        display: flex;
        gap: 2px;
        opacity: 0;
        transition: opacity 0.1s;
    }
    .list-item:hover .list-item-actions { opacity: 1; }

    /* ── Replacements ─── */
    .replacement {
        gap: 4px;
        font-size: 11px;
    }
    .replacement code {
        font-family: var(--vscode-editor-font-family);
        font-size: 11px;
        padding: 1px 4px;
        border-radius: 2px;
        background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.1));
    }
    .replacement .from { color: var(--vscode-errorForeground); }
    .replacement .to { color: var(--vscode-testing-iconPassed, #73c991); }
    .replacement .arrow {
        color: var(--vscode-descriptionForeground);
        font-size: 10px;
    }

    /* ── Icon buttons ─── */
    .icon-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 22px; height: 22px;
        background: none;
        border: none;
        border-radius: var(--item-radius);
        cursor: pointer;
        color: var(--vscode-foreground);
    }
    .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
    .icon-btn.danger:hover { color: var(--vscode-errorForeground); }

    .codicon { font-size: 14px; }

    @keyframes spin {
        100% { transform: rotate(360deg); }
    }
    .spinning { animation: spin 1s linear infinite; }

    /* ── Empty ─── */
    .empty {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        padding: 4px 6px;
        font-style: italic;
    }
</style>
<link href="https://unpkg.com/@vscode/codicons@0.0.36/dist/codicon.css" rel="stylesheet">
</head>
<body>
    <div class="action-bar">
        <button class="action-btn" onclick="send('pullAction')">
            <span class="codicon codicon-cloud-download"></span> Pull
        </button>
        <button class="action-btn" onclick="send('pushAction')">
            <span class="codicon codicon-cloud-upload"></span> Push
        </button>
    </div>

    <div class="status-bar ${hasSession ? 'active' : ''}">
        <span class="status-dot"></span>
        <span>${hasSession ? 'Active workspace' : 'No active session'}</span>
    </div>

    ${hasSession ? `
    <div class="stats">
        <span class="stat"><strong>${totalSources}</strong> sources</span>
        <span class="stat"><strong>${totalFiles}</strong> files</span>
        <span class="stat"><strong>${totalTotalReplacements}</strong> replacements</span>
    </div>
    ` : ''}

    <div class="section">
        <div class="section-header">
            <span class="section-title">Sources</span>
            <button class="section-action" onclick="send('addSource')">Add</button>
        </div>
        ${sourcesHtml}
    </div>

    <div class="section">
        <div class="section-header">
            <span class="section-title">Replacements</span>
            <button class="section-action" onclick="send('addReplacement')">Add</button>
        </div>
        ${replacementsHtml}
    </div>

    ${hasSession ? `
    <div class="action-bar" style="border-top: 1px solid var(--vscode-panel-border, var(--vscode-widget-border)); border-bottom: none; padding-top: 10px;">
        <button class="action-btn" onclick="send('pushAll')">
            <span class="codicon codicon-repo-push"></span> Push All
        </button>
    </div>
    ` : ''}

    <script>
        const vscode = acquireVsCodeApi();
        function send(cmd, label, btn) {
            if (btn) {
                const icon = btn.querySelector('.codicon');
                if (icon) {
                    icon.className = 'codicon codicon-sync spinning';
                }
                const actionsContainer = btn.closest('.list-item-actions');
                if (actionsContainer) {
                    const allButtons = actionsContainer.querySelectorAll('button');
                    allButtons.forEach(b => {
                        b.disabled = true;
                        b.style.pointerEvents = 'none';
                        if (b !== btn) {
                            b.style.opacity = '0.3';
                        }
                    });
                }
            }
            vscode.postMessage({ command: cmd, label: label || undefined });
        }
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
