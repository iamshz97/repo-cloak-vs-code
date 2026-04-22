/**
 * Language Model Tool: probe whether a file exists in a cloaked source.
 *
 * Privacy guarantees:
 *  - NEVER returns a directory listing.
 *  - Only returns matches for paths/basenames the model already guessed.
 *  - Marks already-pulled and banned files so the model doesn't re-request them.
 */

import * as vscode from 'vscode';
import { basename } from 'path';
import {
    loadRawMapping, decryptMappingV2, getSourceByLabel, getSourceLabels
} from '../core/mapper';
import { hasSecret, getOrCreateSecret } from '../core/crypto';
import { getAllFiles } from '../core/scanner';
import { getBannedSet, hasBanList } from '../core/ban-list';
import { findCloakedDirectory, normalize } from './pull-helper';

interface ProbeInput {
    pathHint: string;
    sourceLabel?: string;
    maxResults?: number;
}

interface ProbeMatch {
    sourceLabel: string;
    relativePath: string;
    matchType: 'exact' | 'basename' | 'substring';
    status: 'available' | 'already-pulled' | 'banned';
}

interface ProbeOutput {
    pathHint: string;
    matches: ProbeMatch[];
    truncated: boolean;
    sourcesSearched: string[];
    note?: string;
}

const HARD_CAP = 25;

export class ProbeFileTool implements vscode.LanguageModelTool<ProbeInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ProbeInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const cloakedDir = findCloakedDirectory();
        if (!cloakedDir) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    'No Repo Cloak workspace open. The user must initialize one first.'
                )
            ]);
        }

        const raw = loadRawMapping(cloakedDir);
        if (!raw) {
            return errorResult('Mapping not found.');
        }
        let mapping = raw;
        if (raw.encrypted && hasSecret()) {
            mapping = decryptMappingV2(raw, getOrCreateSecret());
        } else if (raw.encrypted) {
            return errorResult('Mapping is encrypted but no secret available.');
        }

        const hint = normalize(options.input.pathHint || '');
        if (!hint) {
            return errorResult('pathHint is required.');
        }

        const max = Math.min(options.input.maxResults ?? 10, HARD_CAP);
        const requestedLabels = options.input.sourceLabel
            ? [options.input.sourceLabel]
            : getSourceLabels(mapping);

        const matches: ProbeMatch[] = [];
        const sourcesSearched: string[] = [];

        for (const label of requestedLabels) {
            const source = getSourceByLabel(mapping, label);
            if (!source || !source.path) { continue; }
            sourcesSearched.push(label);

            // Already-pulled set (decrypted relative paths)
            const alreadyPulled = new Set(source.files.map(f => normalize(f.original)));

            // Banned set
            const banned = (hasBanList() && hasSecret())
                ? getBannedSet(label, getOrCreateSecret())
                : new Set<string>();

            // Walk source dir (cheap — uses existing ignore rules)
            let files;
            try {
                files = getAllFiles(source.path);
            } catch {
                continue;
            }

            const hintBase = basename(hint).toLowerCase();
            const hintLower = hint.toLowerCase();

            for (const f of files) {
                const rel = normalize(f.relativePath);
                const relLower = rel.toLowerCase();
                const baseLower = f.name.toLowerCase();

                let matchType: ProbeMatch['matchType'] | null = null;
                if (relLower === hintLower) {
                    matchType = 'exact';
                } else if (baseLower === hintBase) {
                    matchType = 'basename';
                } else if (relLower.includes(hintLower) || baseLower.includes(hintBase)) {
                    matchType = 'substring';
                }
                if (!matchType) { continue; }

                let status: ProbeMatch['status'] = 'available';
                if (banned.has(rel)) {
                    status = 'banned';
                } else if (alreadyPulled.has(rel)) {
                    status = 'already-pulled';
                }

                matches.push({ sourceLabel: label, relativePath: rel, matchType, status });
                if (matches.length >= max) { break; }
            }
            if (matches.length >= max) { break; }
        }

        // Sort by match quality
        const order = { exact: 0, basename: 1, substring: 2 };
        matches.sort((a, b) => order[a.matchType] - order[b.matchType]);

        const output: ProbeOutput = {
            pathHint: hint,
            matches,
            truncated: matches.length >= max,
            sourcesSearched,
            note: matches.length === 0
                ? 'No matches. Try a different filename — directory listings are not exposed.'
                : 'Use repo_cloak_request_pull with the relativePath(s) you want pulled. The user must confirm.'
        };

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(output, null, 2))
        ]);
    }

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<ProbeInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        // Read-only probe — no confirmation needed.
        return {
            invocationMessage: 'Probing cloaked sources for file…'
        };
    }
}

function errorResult(msg: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(msg)]);
}
