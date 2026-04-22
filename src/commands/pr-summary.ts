/**
 * PR Summary Command
 *
 * Generates a PR description from the current diff inside the cloaked workspace,
 * using the user's chosen Markdown template and Copilot's LM API.
 *
 * Privacy:
 *   - Only the cloaked workspace's diff is read (never the source repo).
 *   - The diff is anonymized by definition because it lives in the cloaked copy.
 */

import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { isGitRepo } from '../core/git';
import { hasMapping } from '../core/mapper';
import {
    getTemplates, getTemplateByName, saveTemplate, deleteTemplate,
    getActiveTemplateName, setActiveTemplateName, DEFAULT_TEMPLATE, PrTemplate
} from '../core/pr-templates';

const execAsync = promisify(exec);
const MAX_DIFF_CHARS = 60_000; // keep prompt within reasonable LM context

// ─── helpers ───────────────────────────────────────────────────────────────

function findCloakedDirectory(): string | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) { return null; }
    for (const f of folders) {
        if (hasMapping(f.uri.fsPath)) { return f.uri.fsPath; }
    }
    return null;
}

async function tryExec(cmd: string, cwd: string): Promise<string | null> {
    try {
        const { stdout } = await execAsync(cmd, { cwd, maxBuffer: 20 * 1024 * 1024 });
        return stdout;
    } catch {
        return null;
    }
}

async function detectBaseBranch(cwd: string): Promise<string | null> {
    for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
        const res = await tryExec(`git rev-parse --verify --quiet ${candidate}`, cwd);
        if (res !== null && res.trim() !== '') { return candidate; }
    }
    return null;
}

async function currentBranch(cwd: string): Promise<string> {
    return ((await tryExec('git rev-parse --abbrev-ref HEAD', cwd)) || '').trim() || 'HEAD';
}

interface DiffSource { label: string; ref: string; }

async function pickDiffScope(cwd: string): Promise<{ diff: string; scopeLabel: string; branch: string } | null> {
    const branch = await currentBranch(cwd);
    const base = await detectBaseBranch(cwd);

    const items: (vscode.QuickPickItem & { scope: string })[] = [];
    if (base) {
        items.push({
            label: `$(git-compare) Diff vs ${base}`,
            description: `Everything in "${branch}" not in ${base}`,
            scope: `base:${base}`
        });
    }
    items.push(
        { label: '$(git-commit) Last commit (HEAD~1..HEAD)', description: 'Just the most recent commit', scope: 'last-commit' },
        { label: '$(edit) Uncommitted changes',              description: 'Working tree vs HEAD',         scope: 'uncommitted' }
    );

    const pick = await vscode.window.showQuickPick(items, {
        title: 'Generate PR summary — choose diff scope',
        placeHolder: 'What should the summary describe?'
    });
    if (!pick) { return null; }

    let diff: string | null = null;
    let scopeLabel = pick.label.replace(/^\$\([^)]+\)\s*/, '');

    if (pick.scope.startsWith('base:')) {
        const ref = pick.scope.slice('base:'.length);
        diff = await tryExec(`git diff --no-color ${ref}...HEAD`, cwd);
    } else if (pick.scope === 'last-commit') {
        diff = await tryExec('git show --no-color HEAD', cwd);
    } else if (pick.scope === 'uncommitted') {
        const tracked   = await tryExec('git diff --no-color HEAD', cwd) || '';
        const untracked = await tryExec('git ls-files --others --exclude-standard', cwd) || '';
        diff = tracked + (untracked ? `\n\n[Untracked files]\n${untracked}` : '');
    }

    if (!diff || diff.trim() === '') {
        vscode.window.showWarningMessage('No diff found for that scope.');
        return null;
    }

    if (diff.length > MAX_DIFF_CHARS) {
        diff = diff.slice(0, MAX_DIFF_CHARS) + `\n\n…[diff truncated at ${MAX_DIFF_CHARS} chars]`;
    }

    return { diff, scopeLabel, branch };
}

async function pickTemplate(): Promise<PrTemplate | null> {
    const templates = getTemplates();
    const active = getActiveTemplateName();
    const items: (vscode.QuickPickItem & { name: string })[] = templates.map(t => ({
        label: t.name === active ? `$(check) ${t.name}` : `   ${t.name}`,
        description: t.isDefault ? 'built-in' : undefined,
        name: t.name
    }));
    items.push(
        { label: '', kind: vscode.QuickPickItemKind.Separator, name: '' } as any,
        { label: '$(gear) Manage templates…', name: '__manage' }
    );
    const pick = await vscode.window.showQuickPick(items, {
        title: 'PR Summary — pick template',
        placeHolder: `Active: ${active}`
    });
    if (!pick) { return null; }
    if (pick.name === '__manage') {
        await vscode.commands.executeCommand('repo-cloak.managePrTemplates');
        return null;
    }
    setActiveTemplateName(pick.name);
    return getTemplateByName(pick.name) || null;
}

async function pickModel(): Promise<vscode.LanguageModelChat | null> {
    const all = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (all.length === 0) {
        vscode.window.showErrorMessage(
            'No Copilot language models are available. Make sure GitHub Copilot is installed and signed in.'
        );
        return null;
    }
    if (all.length === 1) { return all[0]; }
    const pick = await vscode.window.showQuickPick(
        all.map((m, i) => ({
            label: `$(sparkle) ${m.name}`,
            description: m.family,
            detail: `${m.vendor} · ${m.maxInputTokens.toLocaleString()} tokens`,
            idx: i
        })),
        { title: 'PR Summary — pick a Copilot model', placeHolder: 'Choose the model to draft your PR' }
    );
    if (!pick) { return null; }
    return all[(pick as any).idx];
}

function buildPrompt(template: PrTemplate, branch: string, scopeLabel: string, diff: string): vscode.LanguageModelChatMessage[] {
    const system =
`You are an assistant that writes pull-request descriptions in Markdown.
You MUST follow the user-supplied template's section headings, ordering and tone exactly.
Fill each section using only information you can infer from the supplied diff.
If a section cannot be filled from the diff, write "_n/a_" — do NOT invent details.
Output ONLY the final Markdown — no preamble, no code fences, no commentary.`;

    const user =
`Branch: ${branch}
Scope: ${scopeLabel}

=== TEMPLATE (follow exactly) ===
${template.body}

=== DIFF ===
\`\`\`diff
${diff}
\`\`\``;

    return [
        vscode.LanguageModelChatMessage.User(system),
        vscode.LanguageModelChatMessage.User(user)
    ];
}

// ─── main ──────────────────────────────────────────────────────────────────

export async function executePrSummary(): Promise<void> {
    const dir = findCloakedDirectory();
    if (!dir) {
        vscode.window.showErrorMessage('Open a cloaked workspace first (a folder with a .repo-cloak-map.json).');
        return;
    }
    if (!isGitRepo(dir)) {
        vscode.window.showErrorMessage('The cloaked workspace is not a Git repository — cannot diff.');
        return;
    }

    const scope = await pickDiffScope(dir);
    if (!scope) { return; }

    const template = await pickTemplate();
    if (!template) { return; }

    const model = await pickModel();
    if (!model) { return; }

    const messages = buildPrompt(template, scope.branch, scope.scopeLabel, scope.diff);

    let result = '';
    try {
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Drafting PR summary with ${model.name}…`, cancellable: true },
            async (_progress, token) => {
                const response = await model.sendRequest(messages, {}, token);
                for await (const chunk of response.text) { result += chunk; }
            }
        );
    } catch (err: any) {
        if (err instanceof vscode.LanguageModelError) {
            vscode.window.showErrorMessage(`Copilot error: ${err.message}`);
        } else {
            vscode.window.showErrorMessage(`Failed to draft PR summary: ${err?.message || err}`);
        }
        return;
    }

    if (!result.trim()) {
        vscode.window.showWarningMessage('Copilot returned an empty response.');
        return;
    }

    // Show in a new editor in a Markdown code block (per user request — easy to copy)
    const presented =
`<!-- PR summary generated by Repo Cloak -->
<!-- Branch: ${scope.branch} · Scope: ${scope.scopeLabel} · Template: ${template.name} · Model: ${model.name} -->

\`\`\`markdown
${result.trim()}
\`\`\`
`;
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: presented });
    await vscode.window.showTextDocument(doc, { preview: false });

    const action = await vscode.window.showInformationMessage(
        'PR summary ready.', 'Copy to clipboard'
    );
    if (action === 'Copy to clipboard') {
        await vscode.env.clipboard.writeText(result.trim());
        vscode.window.setStatusBarMessage('$(check) PR summary copied', 2500);
    }
}

// ─── template management ───────────────────────────────────────────────────

export async function executeManagePrTemplates(): Promise<void> {
    while (true) {
        const templates = getTemplates();
        const active = getActiveTemplateName();
        const items: (vscode.QuickPickItem & { action: string; name?: string })[] = [];
        items.push({ label: '$(add) Create new template…', action: 'create' });
        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, action: '' } as any);
        for (const t of templates) {
            items.push({
                label: t.name === active ? `$(check) ${t.name}` : `   ${t.name}`,
                description: t.isDefault ? 'built-in' : 'edit / delete',
                action: 'open',
                name: t.name
            });
        }
        const pick = await vscode.window.showQuickPick(items, {
            title: 'PR Summary — Templates',
            placeHolder: `Active template: ${active}`
        });
        if (!pick) { return; }

        if (pick.action === 'create') {
            await createTemplateFlow();
            continue;
        }

        if (pick.action === 'open' && pick.name) {
            const t = getTemplateByName(pick.name);
            if (!t) { continue; }

            const sub: (vscode.QuickPickItem & { action: string })[] = [
                { label: '$(check) Set as active', action: 'activate' },
                { label: '$(eye) Preview', action: 'preview' }
            ];
            if (!t.isDefault) {
                sub.push(
                    { label: '$(edit) Edit body', action: 'edit' },
                    { label: '$(trash) Delete',   action: 'delete' }
                );
            }
            const sp = await vscode.window.showQuickPick(sub, { title: `Template: ${t.name}` });
            if (!sp) { continue; }
            if (sp.action === 'activate') {
                setActiveTemplateName(t.name);
                vscode.window.setStatusBarMessage(`$(check) Active template: ${t.name}`, 2500);
            } else if (sp.action === 'preview') {
                const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: t.body });
                await vscode.window.showTextDocument(doc, { preview: true });
            } else if (sp.action === 'edit' && !t.isDefault) {
                const newBody = await editBody(t.body);
                if (newBody !== undefined) {
                    saveTemplate({ name: t.name, body: newBody });
                    vscode.window.setStatusBarMessage(`$(check) Saved "${t.name}"`, 2500);
                }
            } else if (sp.action === 'delete' && !t.isDefault) {
                const ok = await vscode.window.showWarningMessage(
                    `Delete template "${t.name}"?`, { modal: true }, 'Delete'
                );
                if (ok === 'Delete') { deleteTemplate(t.name); }
            }
        }
    }
}

async function createTemplateFlow(): Promise<void> {
    const name = await vscode.window.showInputBox({
        title: 'New PR template — name',
        placeHolder: 'e.g. team-pr, bugfix, release-notes',
        validateInput: v => {
            if (!v?.trim()) { return 'Required'; }
            if (v.trim() === DEFAULT_TEMPLATE.name) { return `"${DEFAULT_TEMPLATE.name}" is reserved`; }
            return null;
        }
    });
    if (!name) { return; }

    const seed = await vscode.window.showQuickPick(
        [
            { label: '$(file) Start from default template', value: 'default' },
            { label: '$(file-add) Start blank',              value: 'blank' }
        ],
        { title: `Body for "${name.trim()}"` }
    );
    if (!seed) { return; }

    const initial = seed.value === 'default' ? DEFAULT_TEMPLATE.body : '## Summary\n';
    const body = await editBody(initial);
    if (body === undefined) { return; }

    saveTemplate({ name: name.trim(), body });
    vscode.window.showInformationMessage(`Saved template "${name.trim()}".`);
}

/** Open an editor with the body, then read it back when the user closes/saves it. */
async function editBody(initial: string): Promise<string | undefined> {
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: initial });
    const editor = await vscode.window.showTextDocument(doc, { preview: false });

    const action = await vscode.window.showInformationMessage(
        'Edit your template, then click Save when done.',
        { modal: false },
        'Save', 'Cancel'
    );
    if (action !== 'Save') { return undefined; }
    return editor.document.getText();
}
