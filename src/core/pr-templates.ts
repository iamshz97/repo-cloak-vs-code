/**
 * PR Summary Templates
 *
 * Stores user-defined Markdown templates for PR summaries on the local machine.
 * File: ~/.repo-cloak/pr-templates.json (mode 0o600)
 *
 * Template names are stored plaintext; the markdown body is AES-256 encrypted
 * (templates may contain proprietary process language teams want kept private).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { encrypt, decrypt, getOrCreateSecret, hasSecret } from './crypto';

const CONFIG_DIR = join(homedir(), '.repo-cloak');
const TEMPLATES_FILE = join(CONFIG_DIR, 'pr-templates.json');

export interface PrTemplate {
    name: string;
    body: string;            // markdown
    isDefault?: boolean;     // built-in, not user-saved
}

interface StoredTemplate {
    name: string;            // plaintext
    body: string;            // encrypted
}

interface TemplatesFile {
    templates: StoredTemplate[];
    activeName?: string;     // last used / preferred
}

// ─── Built-in default ──────────────────────────────────────────────────────

export const DEFAULT_TEMPLATE: PrTemplate = {
    name: 'Default',
    isDefault: true,
    body:
`## Summary
<one or two sentences describing what this PR does and why>

## Changes
- <bullet list of the key code changes>

## Why
<context, links to tickets, design notes>

## Testing
- [ ] Unit tests added/updated
- [ ] Manual verification: <steps>

## Risks / Notes
<edge cases, follow-ups, deployment concerns>
`
};

// ─── Internal ──────────────────────────────────────────────────────────────

function loadRaw(): TemplatesFile {
    try {
        if (!existsSync(TEMPLATES_FILE)) { return { templates: [] }; }
        const parsed = JSON.parse(readFileSync(TEMPLATES_FILE, 'utf-8'));
        return {
            templates: Array.isArray(parsed.templates) ? parsed.templates : [],
            activeName: typeof parsed.activeName === 'string' ? parsed.activeName : undefined
        };
    } catch {
        return { templates: [] };
    }
}

function saveRaw(data: TemplatesFile): void {
    try {
        if (!existsSync(CONFIG_DIR)) { mkdirSync(CONFIG_DIR, { recursive: true }); }
        writeFileSync(TEMPLATES_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
    } catch { /* ignore */ }
}

// ─── Public API ────────────────────────────────────────────────────────────

/** Returns built-in default + all user templates (decrypted). */
export function getTemplates(): PrTemplate[] {
    const out: PrTemplate[] = [DEFAULT_TEMPLATE];
    if (!hasSecret()) { return out; }
    const secret = getOrCreateSecret();
    const { templates } = loadRaw();
    for (const t of templates) {
        try {
            const body = decrypt(t.body, secret);
            if (body) { out.push({ name: t.name, body }); }
        } catch { /* skip */ }
    }
    return out;
}

export function getTemplateByName(name: string): PrTemplate | undefined {
    return getTemplates().find(t => t.name === name);
}

/** Save (create or overwrite). Refuses to overwrite the built-in 'Default'. */
export function saveTemplate(template: PrTemplate): void {
    if (template.name === DEFAULT_TEMPLATE.name) {
        throw new Error(`"${DEFAULT_TEMPLATE.name}" is built-in and cannot be overwritten. Save with a different name.`);
    }
    const secret = getOrCreateSecret();
    const data = loadRaw();
    const stored: StoredTemplate = { name: template.name, body: encrypt(template.body, secret) };
    const idx = data.templates.findIndex(t => t.name === template.name);
    if (idx >= 0) { data.templates[idx] = stored; } else { data.templates.push(stored); }
    saveRaw(data);
}

export function deleteTemplate(name: string): void {
    if (name === DEFAULT_TEMPLATE.name) { return; }
    const data = loadRaw();
    data.templates = data.templates.filter(t => t.name !== name);
    if (data.activeName === name) { data.activeName = undefined; }
    saveRaw(data);
}

export function getActiveTemplateName(): string {
    return loadRaw().activeName || DEFAULT_TEMPLATE.name;
}

export function setActiveTemplateName(name: string): void {
    const data = loadRaw();
    data.activeName = name;
    saveRaw(data);
}
