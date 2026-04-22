/**
 * Language Model Tool: request that specific files be pulled into the
 * cloaked workspace. ALWAYS shows a confirmation modal — the user is the
 * gatekeeper for any write to disk.
 */

import * as vscode from 'vscode';
import { SidebarProvider } from '../views/sidebar-provider';
import { findCloakedDirectory, getAvailableSources, pullFilesProgrammatically } from './pull-helper';

interface RequestPullInput {
    sourceLabel: string;
    relativePaths: string[];
    reason?: string;
}

interface RequestPullOutput {
    sourceLabel: string;
    requested: number;
    pulled: number;
    pulledPaths: string[];
    skippedAlreadyPulled: string[];
    skippedBanned: string[];
    skippedNotFound: string[];
    skippedSecrets: Array<{ path: string; findings: string[] }>;
    errors: Array<{ file: string; error: string }>;
    note: string;
}

export class RequestPullTool implements vscode.LanguageModelTool<RequestPullInput> {
    constructor(
        private readonly sidebarProvider: SidebarProvider,
        private readonly outputChannel: vscode.OutputChannel
    ) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<RequestPullInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const cloakedDir = findCloakedDirectory();
        if (!cloakedDir) {
            return text('No Repo Cloak workspace open.');
        }

        const { sourceLabel, relativePaths } = options.input;
        if (!sourceLabel || !Array.isArray(relativePaths) || relativePaths.length === 0) {
            return text('sourceLabel and a non-empty relativePaths array are required.');
        }

        try {
            const result = await pullFilesProgrammatically(
                { cloakedDir, sourceLabel, relativePaths },
                this.sidebarProvider,
                this.outputChannel
            );

            const output: RequestPullOutput = {
                sourceLabel,
                requested: result.requested,
                pulled: result.pulled,
                pulledPaths: result.pulledPaths,
                skippedAlreadyPulled: result.skippedAlreadyPulled,
                skippedBanned: result.skippedBanned,
                skippedNotFound: result.skippedNotFound,
                skippedSecrets: result.skippedSecrets,
                errors: result.errors,
                note: buildNote(result.pulled, result.requested, result)
            };

            if (result.pulled > 0) {
                vscode.window.setStatusBarMessage(
                    `$(check) Repo Cloak: pulled ${result.pulled} file(s) into "${sourceLabel}"`,
                    3500
                );
            }

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify(output, null, 2))
            ]);
        } catch (err) {
            return text(`Pull failed: ${(err as Error).message}`);
        }
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<RequestPullInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const { sourceLabel, relativePaths, reason } = options.input;

        const cloakedDir = findCloakedDirectory();
        const knownSources = cloakedDir ? getAvailableSources(cloakedDir) : [];
        const sourceOk = knownSources.length === 0 || knownSources.includes(sourceLabel);

        const list = (relativePaths || []).slice(0, 15)
            .map(p => `  • ${p}`).join('\n');
        const overflow = (relativePaths || []).length > 15
            ? `\n  …and ${relativePaths.length - 15} more`
            : '';

        const detail = new vscode.MarkdownString();
        detail.appendMarkdown(`Copilot is requesting **${(relativePaths || []).length} file(s)** from \`${sourceLabel}\`:\n\n`);
        detail.appendMarkdown(`\`\`\`\n${list}${overflow}\n\`\`\`\n`);
        if (reason) {
            detail.appendMarkdown(`\n**Reason:** ${reason}\n`);
        }
        if (!sourceOk) {
            detail.appendMarkdown(`\n> ⚠️ Source \`${sourceLabel}\` is not in your mapping. Known sources: ${knownSources.join(', ') || '(none)'}\n`);
        }
        detail.appendMarkdown('\nFiles will be anonymized and secret-scanned before being added to the cloaked workspace.');

        return {
            invocationMessage: `Pulling ${(relativePaths || []).length} file(s) into "${sourceLabel}"…`,
            confirmationMessages: {
                title: 'Repo Cloak: Pull files requested by Copilot?',
                message: detail
            }
        };
    }
}

function text(msg: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(msg)]);
}

function buildNote(
    pulled: number,
    requested: number,
    r: { skippedSecrets: unknown[]; skippedBanned: unknown[]; skippedNotFound: unknown[]; skippedAlreadyPulled: unknown[]; errors: unknown[] }
): string {
    const parts: string[] = [];
    if (pulled > 0) { parts.push(`Pulled ${pulled}/${requested}.`); }
    else { parts.push(`Pulled 0/${requested}.`); }
    if (r.skippedSecrets.length > 0) { parts.push(`Skipped ${r.skippedSecrets.length} due to detected secrets.`); }
    if (r.skippedBanned.length > 0) { parts.push(`Skipped ${r.skippedBanned.length} banned.`); }
    if (r.skippedNotFound.length > 0) { parts.push(`Skipped ${r.skippedNotFound.length} not found on disk.`); }
    if (r.skippedAlreadyPulled.length > 0) { parts.push(`${r.skippedAlreadyPulled.length} were already in the cloaked workspace.`); }
    if (r.errors.length > 0) { parts.push(`${r.errors.length} copy error(s).`); }
    return parts.join(' ');
}
