/**
 * Sidebar Provider
 * Webview sidebar — clean, minimal, Microsoft-standard design
 */

import * as vscode from 'vscode';
import { hasMapping, loadRawMapping, decryptMappingV2, MappingV2, getStaleFiles } from '../core/mapper';
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
                case 'copyForAI':
                    vscode.commands.executeCommand('repo-cloak.copyForAI', message.label);
                    break;
                case 'resolveOrphans':
                    vscode.commands.executeCommand('repo-cloak.resolveOrphans', message.label);
                    break;
                case 'managePresets':
                    vscode.commands.executeCommand('repo-cloak.managePresets');
                    break;
                case 'sourceMenu':
                    await this._showSourceMenu(message.label);
                    break;
            }
        });

        this.refresh();
    }

    private async _showSourceMenu(label: string): Promise<void> {
        if (!label) { return; }
        const items: (vscode.QuickPickItem & { cmd?: string })[] = [
            { label: '$(sparkle) Copy for AI', description: 'Bundle files & copy to clipboard', cmd: 'repo-cloak.copyForAI' },
            { label: '$(cloud-download) Pull more files', description: 'Interactive file picker', cmd: 'repo-cloak.pullSource' },
            { label: '$(git-compare) Pull from Git changes', description: 'Uncommitted or commit-based', cmd: 'repo-cloak.pullSourceGit' },
            { label: '', kind: vscode.QuickPickItemKind.Separator },
            { label: '$(trash) Remove source', description: 'Delete from this workspace', cmd: 'repo-cloak.removeSource' }
        ] as any;
        const pick = await vscode.window.showQuickPick(items, {
            title: `Source: ${label}`,
            placeHolder: 'Choose an action'
        });
        if (pick?.cmd) {
            vscode.commands.executeCommand(pick.cmd, label);
        }
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
                const orphanCount = m ? getStaleFiles(m, s.label).length : 0;
                const orphanBadge = orphanCount > 0
                    ? `<span class="orphan-badge" title="${orphanCount} file(s) no longer in source" onclick="send('resolveOrphans','${label}', this)">${orphanCount}</span>`
                    : '';
                return `
                    <div class="list-item">
                        <div class="list-item-content">
                            <span class="codicon codicon-package dim"></span>
                            <span class="list-item-label">${label}</span>
                            ${orphanBadge}
                            <span class="list-item-desc">${fileCount}</span>
                        </div>
                        <div class="list-item-actions">
                            <button class="icon-btn" onclick="send('copyForAI','${label}', this)" title="Copy for AI">
                                <span class="codicon codicon-sparkle"></span>
                            </button>
                            <button class="icon-btn pull-btn" onclick="send('forcePullSource','${label}', this)" title="Force Pull — refresh cloaked copy from source (asks to confirm)">
                                <span class="codicon codicon-arrow-down"></span>
                            </button>
                            <button class="icon-btn push-btn" onclick="send('forcePushSource','${label}', this)" title="Force Push — write cloaked changes back to source (asks to confirm)">
                                <span class="codicon codicon-arrow-up"></span>
                            </button>
                            <span class="action-divider"></span>
                            <button class="icon-btn" onclick="send('sourceMenu','${label}', this)" title="More actions…">
                                <span class="codicon codicon-ellipsis"></span>
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
        height: 22px;
    }
    .section-title {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.6px;
        color: var(--vscode-descriptionForeground);
    }
    .header-actions {
        display: flex;
        align-items: center;
        gap: 0;
        opacity: 0.55;
        transition: opacity 0.1s;
    }
    .header-actions:hover { opacity: 1; }
    .section-header > .icon-btn { opacity: 0.55; transition: opacity 0.1s; }
    .section-header > .icon-btn:hover { opacity: 1; }

    /* ── List items ─── */
    .list-item {
        position: relative;
        display: flex;
        align-items: center;
        padding: 2px 6px;
        border-radius: var(--item-radius);
        min-height: 24px;
    }
    .list-item:hover {
        background: var(--vscode-list-hoverBackground);
    }
    .list-item-content {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        flex: 1;
        padding-right: 4px;
    }
    .list-item-label {
        font-size: 12px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex: 1;
        min-width: 0;
    }
    .list-item-desc {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        white-space: nowrap;
        flex-shrink: 0;
        font-variant-numeric: tabular-nums;
        opacity: 0.7;
    }
    .list-item:hover .list-item-desc { opacity: 0; }
    .list-item-actions {
        position: absolute;
        right: 4px;
        top: 50%;
        transform: translateY(-50%);
        display: flex;
        gap: 0;
        opacity: 0;
        transition: opacity 0.1s;
    }
    .list-item:hover .list-item-actions { opacity: 1; }
    .dim { opacity: 0.55; }

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
        padding: 0;
    }
    .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
    .icon-btn.danger:hover { color: var(--vscode-errorForeground); }
    .icon-btn.xs { width: 18px; height: 18px; }
    .icon-btn.xs .codicon { font-size: 12px; }

    /* Pull / Push — bold arrows, easy to scan */
    .icon-btn.pull-btn .codicon,
    .icon-btn.push-btn .codicon { font-size: 14px; font-weight: bold; }

    .action-divider {
        width: 1px;
        height: 12px;
        background: var(--vscode-widget-border, var(--vscode-panel-border));
        margin: 0 1px;
        opacity: 0.35;
        align-self: center;
    }

    .orphan-badge {
        font-size: 10px;
        padding: 0 5px;
        min-width: 16px;
        height: 14px;
        line-height: 14px;
        text-align: center;
        border-radius: 7px;
        background: var(--vscode-inputValidation-warningBackground, rgba(255,170,0,0.18));
        color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground));
        cursor: pointer;
        white-space: nowrap;
        flex-shrink: 0;
        font-variant-numeric: tabular-nums;
    }
    .orphan-badge:hover { filter: brightness(1.2); }

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
        ${hasSession ? `
        <button class="action-btn ai-action" onclick="send('copyForAI')" title="Bundle files & copy to clipboard for AI tools">
            <span class="codicon codicon-sparkle"></span> AI
        </button>` : ''}
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
            <button class="icon-btn xs" onclick="send('addSource')" title="Add source"><span class="codicon codicon-add"></span></button>
        </div>
        ${sourcesHtml}
    </div>

    <div class="section">
        <div class="section-header">
            <span class="section-title">Replacements</span>
            <div class="header-actions">
                <button class="icon-btn xs" onclick="send('managePresets')" title="Manage presets"><span class="codicon codicon-bookmark"></span></button>
                <button class="icon-btn xs" onclick="send('addReplacement')" title="Add replacement"><span class="codicon codicon-add"></span></button>
            </div>
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
        const NO_SPINNER = new Set(['sourceMenu', 'managePresets', 'addSource', 'addReplacement', 'resolveOrphans']);
        function send(cmd, label, btn) {
            if (btn && !NO_SPINNER.has(cmd)) {
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
