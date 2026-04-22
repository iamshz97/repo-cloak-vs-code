/**
 * Bundle Formatter
 * Builds an AI-friendly Markdown bundle of file contents and/or diffs.
 * Pure module (no vscode imports) so it stays easy to reason about and test.
 */

import { extname } from 'path';

export type BundleType =
    | 'manual-cloaked'
    | 'manual-source'
    | 'uncommitted'
    | 'commits'
    | 'commit-diff';

export interface BundleFile {
    /** Path shown to the AI (already anonymized). */
    path: string;
    /** File contents (already anonymized). */
    content: string;
}

export interface BundleOptions {
    type: BundleType;
    sourceLabel?: string;
    /** Free-form metadata (commit hashes, range, etc.). */
    extra?: Record<string, string | undefined>;
    files?: BundleFile[];
    /** Optional unified diff already anonymized. */
    diff?: string;
}

const TYPE_LABEL: Record<BundleType, string> = {
    'manual-cloaked': 'Manual selection (cloaked workspace)',
    'manual-source': 'Manual selection (source repository)',
    'uncommitted': 'Uncommitted changes (source repository)',
    'commits': 'Files from commits (source repository)',
    'commit-diff': 'Commit diff (source repository)'
};

/** Short, human-readable label for toast/clipboard messages. */
export function describeBundleType(type: BundleType): string {
    return TYPE_LABEL[type];
}

export function buildBundle(options: BundleOptions): string {
    const { type, sourceLabel, extra = {}, files = [], diff } = options;
    const lines: string[] = [];

    lines.push('# Repo Cloak Bundle');
    lines.push('');
    lines.push(`- **Type:** ${TYPE_LABEL[type]}`);
    if (sourceLabel) { lines.push(`- **Source:** ${sourceLabel}`); }
    lines.push(`- **Generated:** ${new Date().toISOString()}`);
    if (files.length > 0) { lines.push(`- **Files:** ${files.length}`); }
    for (const [k, v] of Object.entries(extra)) {
        if (v) { lines.push(`- **${k}:** ${v}`); }
    }
    lines.push('');
    lines.push('> Note: identifiers in this bundle have been anonymized by Repo Cloak.');
    lines.push('');

    if (files.length > 0) {
        lines.push('## Files');
        lines.push('');
        for (const f of files) {
            const lang = languageHint(f.path);
            const fence = pickFence(f.content);
            lines.push(`### \`${f.path}\``);
            lines.push('');
            lines.push(`${fence}${lang}`);
            lines.push(f.content.replace(/\s+$/g, ''));
            lines.push(fence);
            lines.push('');
        }
    }

    if (diff) {
        lines.push('## Diff');
        lines.push('');
        const fence = pickFence(diff);
        lines.push(`${fence}diff`);
        lines.push(diff.replace(/\s+$/g, ''));
        lines.push(fence);
        lines.push('');
    }

    return lines.join('\n');
}

/** Pick a fence longer than any backtick run inside the content. */
function pickFence(content: string): string {
    const longest = (content.match(/`+/g) || []).reduce((m, s) => Math.max(m, s.length), 0);
    return '`'.repeat(Math.max(3, longest + 1));
}

function languageHint(path: string): string {
    const ext = extname(path).toLowerCase().replace(/^\./, '');
    const map: Record<string, string> = {
        ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
        json: 'json', md: 'md', yml: 'yaml', yaml: 'yaml', toml: 'toml',
        py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
        cs: 'csharp', cpp: 'cpp', cc: 'cpp', c: 'c', h: 'c', hpp: 'cpp',
        php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash',
        html: 'html', css: 'css', scss: 'scss', less: 'less',
        sql: 'sql', xml: 'xml', dockerfile: 'dockerfile', proto: 'proto'
    };
    return map[ext] || '';
}
