/**
 * Repo Cloak — Chat Participant (`@repo-cloak`)
 *
 * Security boundary:
 *   Copilot NEVER receives source-repo file contents or absolute source paths.
 *   We expose:
 *     • Source labels and aggregate counts (no paths, no file lists)
 *     • Preset names (no replacement values)
 *     • Dispatch into existing commands — which always go through the
 *       user-facing file-tree confirmation flow before any data moves.
 */

import * as vscode from 'vscode';
import { hasMapping, loadRawMapping, getSourceLabels } from '../core/mapper';
import { getPresets } from '../core/presets';

const PARTICIPANT_ID = 'repo-cloak.chat';

interface ResultMeta extends vscode.ChatResult { command?: string }

function findCloakedDirectory(): string | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) { return null; }
    for (const f of folders) {
        if (hasMapping(f.uri.fsPath)) { return f.uri.fsPath; }
    }
    return null;
}

function ensureCloaked(stream: vscode.ChatResponseStream): string | null {
    const dir = findCloakedDirectory();
    if (!dir) {
        stream.markdown(
            '⚠️ No cloaked workspace is open.\n\n' +
            'Open a folder that contains a `.repo-cloak-map.json`, or run **Repo Cloak: Pull** to create one.'
        );
        return null;
    }
    return dir;
}

// ─── Handlers ───────────────────────────────────────────────────────────────

async function handleSources(
    _request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream
): Promise<void> {
    const dir = ensureCloaked(stream); if (!dir) { return; }
    const mapping = loadRawMapping(dir);
    if (!mapping) { stream.markdown('No mapping found.'); return; }

    const labels = getSourceLabels(mapping);
    if (labels.length === 0) {
        stream.markdown('No sources configured yet. Use `@repo-cloak /pull` to add one.');
        return;
    }

    stream.markdown(`**${labels.length} source${labels.length === 1 ? '' : 's'} configured:**\n\n`);
    for (const label of labels) {
        const src = mapping.sources.find(s => s.label === label);
        const count = src?.files.length ?? 0;
        stream.markdown(`- \`${label}\` — ${count} file${count === 1 ? '' : 's'}\n`);
    }
    stream.markdown('\n_Source paths are kept private — Copilot only sees labels and counts._');
}

async function handlePull(
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream
): Promise<void> {
    const dir = ensureCloaked(stream); if (!dir) { return; }
    const mapping = loadRawMapping(dir);
    const labels = mapping ? getSourceLabels(mapping) : [];

    if (labels.length === 0) {
        stream.markdown('No sources yet. Click below to add one:');
        stream.button({ command: 'repo-cloak.pull', title: '$(add) Add a source' });
        return;
    }

    // Try to match a label mentioned in the prompt.
    const prompt = request.prompt.toLowerCase();
    const matched = labels.find(l => prompt.includes(l.toLowerCase()));

    if (matched) {
        stream.markdown(
            `Ready to pull more files into **${matched}**.\n\n` +
            `You'll see the file tree to pick exactly what gets cloaked. ` +
            `_Copilot does not read any files from the source repo._`
        );
        stream.button({
            command: 'repo-cloak.pullSource',
            title: `$(arrow-down) Pull into "${matched}"`,
            arguments: [matched]
        });
        return;
    }

    stream.markdown('Which source would you like to pull into?\n\n');
    for (const label of labels) {
        stream.button({
            command: 'repo-cloak.pullSource',
            title: `$(arrow-down) ${label}`,
            arguments: [label]
        });
    }
}

async function handlePresets(
    _request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream
): Promise<void> {
    const presets = getPresets();
    if (presets.length === 0) {
        stream.markdown('No replacement presets saved yet.\n\n');
        stream.button({ command: 'repo-cloak.managePresets', title: '$(bookmark) Manage presets' });
        return;
    }
    stream.markdown(`**${presets.length} preset${presets.length === 1 ? '' : 's'}:**\n\n`);
    for (const p of presets) {
        stream.markdown(`- \`${p.name}\` — ${p.pairs.length} pair${p.pairs.length === 1 ? '' : 's'}\n`);
    }
    stream.markdown('\n_Replacement values are kept private — only names and counts are shown._');
    stream.button({ command: 'repo-cloak.managePresets', title: '$(bookmark) Manage presets' });
}

function handleHelp(stream: vscode.ChatResponseStream): void {
    stream.markdown(
        '**Repo Cloak chat** — I help you manage cloaked repos without exposing source code to Copilot.\n\n' +
        '**Slash commands:**\n' +
        '- `/sources` — list configured sources (labels + counts only)\n' +
        '- `/pull [source]` — start a pull (you pick files in the tree)\n' +
        '- `/presets` — list replacement presets\n' +
        '- `/pr-summary` — draft a PR description from the cloaked workspace diff\n' +
        '- `/help` — show this message\n\n' +
        '**Privacy guarantee:** I never read files from your source repos. ' +
        'Anything Copilot sees from a source goes through your confirmation and the anonymizer first.'
    );
}

async function handlePrSummary(
    _request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream
): Promise<void> {
    const dir = ensureCloaked(stream); if (!dir) { return; }
    stream.markdown(
        'Drafting a PR summary uses your cloaked workspace diff (never the source repo) ' +
        'and the Copilot model you select. Click below to start:'
    );
    stream.button({ command: 'repo-cloak.prSummary', title: '$(git-pull-request) Generate PR summary' });
    stream.button({ command: 'repo-cloak.managePrTemplates', title: '$(notebook-template) Manage templates' });
}

// ─── Participant ────────────────────────────────────────────────────────────

export function registerChatParticipant(context: vscode.ExtensionContext): void {
    const handler: vscode.ChatRequestHandler = async (request, _ctx, stream, _token): Promise<ResultMeta> => {
        try {
            switch (request.command) {
                case 'sources':    await handleSources(request, stream);   return { command: 'sources' };
                case 'pull':       await handlePull(request, stream);      return { command: 'pull' };
                case 'presets':    await handlePresets(request, stream);   return { command: 'presets' };
                case 'pr-summary': await handlePrSummary(request, stream); return { command: 'pr-summary' };
                case 'help':       handleHelp(stream);                     return { command: 'help' };
                default:
                    handleHelp(stream);
                    return {};
            }
        } catch (err) {
            stream.markdown(`❌ \`${(err as Error).message}\``);
            return {};
        }
    };

    const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
    participant.iconPath = new vscode.ThemeIcon('shield');
    participant.followupProvider = {
        provideFollowups(result: vscode.ChatResult & { command?: string }) {
            const cmd = (result as ResultMeta).command;
            if (cmd === 'sources') {
                return [{ prompt: 'Pull more files', command: 'pull', label: '$(arrow-down) Pull' }];
            }
            if (cmd === 'pull') {
                return [{ prompt: 'Show all sources', command: 'sources', label: '$(list-unordered) Sources' }];
            }
            return [
                { prompt: 'Show my sources',  command: 'sources', label: '$(list-unordered) Sources' },
                { prompt: 'Show my presets',  command: 'presets', label: '$(bookmark) Presets' }
            ];
        }
    };

    context.subscriptions.push(participant);
}
