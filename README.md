<div align="center">

# 🛡️ Repo Cloak

**The privacy layer between your proprietary code and AI assistants.**

*Selectively extract • Anonymize on the fly • Scan for secrets • Collaborate with AI • Push back cleanly.*

[![Version](https://img.shields.io/badge/version-1.1.0-blue)](#)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.95.0-007ACC?logo=visualstudiocode)](#)
[![License](https://img.shields.io/badge/license-MIT-green)](#)
[![Encryption](https://img.shields.io/badge/AES--256--GCM-encrypted-critical)](#)

</div>

---

## What is Repo Cloak?

Repo Cloak lets you bring AI coding assistants (GitHub Copilot, Cursor, ChatGPT, Claude, etc.) into proprietary or NDA-bound codebases **without ever exposing the real source repos**. You pick the files you need, Repo Cloak anonymizes and aggregates them into a sandboxed "cloaked" workspace, you collaborate with AI freely, then push the results back to the originals — fully de-anonymized — when you're done.

**Your source code never leaves your machine. The mapping is AES-256-GCM encrypted. The AI only ever sees the cloaked alias.**

---

## Why Repo Cloak?

| Problem | Repo Cloak |
|---|---|
| AI assistants need context, but your repo is under NDA | Anonymized, sandboxed workspace AI can read freely |
| Multiple repos (frontend / backend / microservices) need cross-cutting changes | Pull from many sources into one cloaked workspace |
| Manual find/replace before sharing code is error-prone | Casing-aware anonymization with reversible mappings |
| Risk of leaking secrets to AI | Built-in 20+ pattern secret scanner blocks pulls |
| Translating AI output back to original names is tedious | One-click **Push** restores original names everywhere |
| Copilot Chat needs more files mid-task | LM Tools let Copilot **probe** and **request** files — you confirm |

---

## ✨ Feature Catalogue

### 🗂️ Multi-Source Aggregation
- Pull selected files from **any number of source repositories** into a single cloaked workspace.
- Each source is tracked under a **label** (e.g. `frontend`, `auth-service`, `payments-api`).
- Sources can be added, removed, and re-pulled independently.

### 🎭 Casing-Aware Anonymization Engine
- Define keyword replacements once (e.g. `AcmeCorp → ClientA`, `myCompanyName → projectName`).
- Engine respects and rewrites every casing variant automatically:
  - `camelCase`, `PascalCase`, `kebab-case`, `snake_case`, `SCREAMING_SNAKE`, `Title Case`, raw lowercase/uppercase.
- Applied to **file contents AND file paths** — directories, filenames, and code identifiers are all cloaked.
- **Fully reversible** on push: cloaked names → original names everywhere.

### 🔐 Encrypted Mapping (`.repo-cloak-map.json`)
- All source paths, replacements, and per-file translation tables are stored **AES-256-GCM encrypted** at rest.
- Encryption secret managed via VS Code SecretStorage (OS keychain) — never hits disk in plain text.
- Mapping is the only file shared between source and cloak; without the secret it's opaque.

### 🛡️ Secret Scanner (Pre-Pull Guard)
- Every file is scanned **before** entering the cloaked workspace.
- Detects 20+ patterns: AWS keys, GitHub/GitLab tokens, Stripe keys, Slack tokens, JWTs, private keys (RSA/EC/PGP/OpenSSH), passwords, connection strings, Bearer tokens, API keys, and more.
- Files containing secrets are **blocked from being copied** with a detailed report (file + line + type).
- Forces you to remediate at the source — secrets never enter the cloak, never reach the AI.

### 🚫 Ban List
- Right-click any file → **Ban from Cloak** to permanently exclude it from all future pulls.
- Per-source ban list, encrypted alongside the mapping.
- Banned files are flagged in probe results so AI tools don't keep asking for them.

### 📥 Smart Pulling
Multiple ways to bring code in:

| Mode | When to use |
|---|---|
| **Pull (Tree View)** | Visual file picker with search, select-all/none, and a confirm bar. |
| **Pull from Git Changes** | Pull only what's uncommitted or recently modified — perfect for resuming work. |
| **Force Pull (per source)** | Silent re-sync of every previously-pulled file from one source. |
| **Force Pull All Sources** | One-shot refresh across every source after a `git pull` upstream. |
| **Pull Source (programmatic)** | Pull a known file list without prompts (used by AI tools). |

Orphan policy is configurable: when a previously-pulled file vanishes upstream, choose to **prompt**, **delete**, or **keep**.

### 📤 Smart Pushing
- **Push** — restore selected modified files back to their source repos with full de-anonymization.
- **Push All Sources** — push everything that's changed across every source in one click.
- **Force Push (per source)** — overwrite the source with everything currently in the cloak for that source.

### 🔁 Cloaked Git (Auto-Commit)
- Cloaked workspace can be **automatically initialized as a git repo**.
- Every pull/push is recorded as a clean, descriptive commit (`Repo Cloak: pulled 4 files from frontend`).
- Three modes: `full` (init + commit), `commit-only` (commit if repo exists), `off` (don't touch git).
- Gives you a clean, auditable history of every cloaked operation.

### 🧹 Orphan Resolver
- Detects files in the cloak that no longer exist in the source.
- Interactive resolver lets you delete, keep, or re-map them.
- Keeps the mapping consistent and prevents push-time surprises.

### 📋 Replacement Presets
- Save your anonymization rule sets (e.g. `acme-presets`, `internal-tools`) and reapply them across new sources.
- Manage via **Manage Replacement Presets** command.
- Share presets with teammates without sharing the actual code.

### 📝 PR Summary Generator
- **Generate PR Summary** — produces a polished pull-request description from the current cloaked diff.
- Restores original names so the summary is ready to paste into your real PR.
- Multiple **PR templates** (concise, detailed, conventional) — manage via **Manage PR Summary Templates**.

### 📦 AI Bundle / Copy for AI
- **Copy for AI** — bundles selected files into a single, neatly-formatted block ready to paste into ChatGPT, Claude, etc.
- Includes file path headers and language fences automatically.
- All anonymized — safe to paste anywhere.

### 🤖 AGENTS.md Auto-Generation
- On first pull, Repo Cloak writes a contextual `AGENTS.md` into the cloaked workspace.
- Tells the AI: this is a sandboxed cloak, here are the source labels, here's what to keep in mind.
- Compatible with Copilot's `AGENTS.md` convention and Cursor rules.

### 💬 Chat Participant — `@repo-cloak`
A first-class VS Code Chat participant. Commands:
- `/sources` — list configured sources (labels + file counts only, no paths).
- `/pull` — start a pull flow inside chat.
- `/presets` — list available replacement presets.
- `/pr-summary` — draft a PR summary right in chat.
- `/help` — what can I do here?

### 🛠️ Language Model Tools (Copilot Auto-Discovery) — **NEW in 1.1.0**
Two tools Copilot Chat will discover and use **automatically**:

#### `repo_cloak_probe_file` 🔍 *(read-only, no confirmation)*
Copilot guesses a path or filename → tool reports whether it exists in any cloaked source.
- Returns `matchType`: `exact` / `basename` / `substring`
- Returns `status`: `available` / `already-pulled` / `banned`
- **Privacy guard:** never returns directory listings — only matches for what was guessed.

#### `repo_cloak_request_pull` 📥 *(always shows confirmation modal)*
Copilot submits `{sourceLabel, relativePaths[], reason}`.
- VS Code shows a native modal listing the files + reason.
- On approval, files run through the full anonymize → secret-scan → mapping → commit pipeline.
- **You are always the gatekeeper.** Copilot can ask, you decide.

### 🔍 File Tree UX
- Dedicated tree view with **search**, **select-all**, **deselect-all**, and a sticky **Confirm** bar.
- Inline **Ban** action on every file row.
- Title-bar buttons for every common action.

### 📊 Sidebar Dashboard
- Webview dashboard in the Activity Bar (shield icon).
- Live source list with file counts.
- Quick-access buttons for pull, push, force operations, presets, AI bundle, PR summary.

---

## 🏗️ Architecture

```text
  ┌──────────────────────┐                     ┌──────────────────────┐
  │                      │   [1] Extract,      │                      │
  │  Source Repos        ├─────────────────────►  Cloaked Workspace   │
  │  (NDA / proprietary) │   anonymize,        │  (safe for AI)       │
  │                      │   secret-scan       │                      │
  │                      │◄─────────────────────┤                      │
  └───────┬──────────────┘   [3] De-anonymize  └──────────┬───────────┘
          │                  & push back                  │
          │                                               │
          │                                               │ [2] AI works
          │ [0] Configure sources,                        │ on cloaked code
          │     replacements, ban list                    │ (Copilot / Cursor /
          │                                               │  ChatGPT / Claude)
  ┌───────▼──────────────┐                     ┌──────────▼───────────┐
  │  Repo Cloak Engine   │◄────── LM Tools ────┤  Copilot Chat        │
  │  AES-256-GCM mapping │  probe + request    │  (auto-discovers     │
  │  + secret scanner    │  (user confirms)    │   tools)             │
  └──────────────────────┘                     └──────────────────────┘
```

---

## 🚀 Quick Start

### 1. Install
Install **Repo Cloak** from the VS Code Marketplace, or sideload:
```bash
code --install-extension repo-cloak-1.1.0.vsix
```

### 2. Create a Cloaked Workspace
Open a **brand new empty folder** in VS Code. This becomes your cloak. *Do not use one of your real repos.*

### 3. Open the Dashboard
Click the **🛡️ shield icon** in the Activity Bar → **Repo Cloak** → **Dashboard**.

### 4. Add a Source
Run **`Repo Cloak: Add Source Repository`** → pick a label (e.g. `frontend`) → select the source repo folder.

### 5. Add Replacement Rules *(optional but recommended)*
Run **`Repo Cloak: Add Keyword Replacement`** → add pairs like `AcmeCorp → ClientA`, `internalProductName → genericProduct`. Casing variants handled automatically.

### 6. Pull Files
Run **`Repo Cloak: Pull — Extract & Anonymize Files`** → tree view opens → search/select files → click the ✅ in the title bar.

Or use **`Pull from Git Changes`** to grab only what's modified.

### 7. Collaborate with AI
Open Copilot Chat / Cursor / paste into ChatGPT. The AI sees only the cloaked code. With Copilot, the LM Tools mean it can ask for more files mid-conversation — **you confirm each pull**.

### 8. Push Back
Run **`Repo Cloak: Push — Restore Files`** → select the cloaked files you want to push → Repo Cloak rewrites them back to original names and writes them to the source repos.

### 9. Generate a PR Summary
Run **`Repo Cloak: Generate PR Summary`** → get a polished, de-anonymized markdown summary ready for your PR.

---

## 📖 Command Reference

### Pull / Extract
| Command | Purpose |
|---|---|
| `Repo Cloak: Pull — Extract & Anonymize Files` | Visual tree-picker pull |
| `Repo Cloak: Pull from Git Changes` | Pull only uncommitted / recently-changed files |
| `Repo Cloak: Force Pull Source` | Silent re-sync of all previously-pulled files for one source |
| `Repo Cloak: Force Pull All Sources` | Re-sync every source in one shot |
| `Repo Cloak: Pull Files for Source` | Pull a known set of files (programmatic) |

### Push / Restore
| Command | Purpose |
|---|---|
| `Repo Cloak: Push — Restore Files` | Push selected cloaked files back, de-anonymized |
| `Repo Cloak: Push All Sources` | Push everything changed across every source |
| `Repo Cloak: Force Push Source` | Overwrite a source with everything currently in the cloak for it |

### Sources & Replacements
| Command | Purpose |
|---|---|
| `Repo Cloak: Add Source Repository` | Register a new source under a label |
| `Repo Cloak: Remove Source` | Unregister a source |
| `Repo Cloak: Add Keyword Replacement` | Add an anonymization rule |
| `Repo Cloak: Remove Keyword Replacement` | Remove an anonymization rule |
| `Repo Cloak: Manage Replacement Presets` | Save/load preset rule packs |

### AI & Workflow
| Command | Purpose |
|---|---|
| `Repo Cloak: Copy for AI` | Bundle selected files into a paste-ready block |
| `Repo Cloak: Generate PR Summary` | Auto-draft a PR description from your diff |
| `Repo Cloak: Manage PR Summary Templates` | Configure summary templates |
| `Repo Cloak: Resolve Orphaned Files` | Reconcile stale mapping entries |
| `Ban from Cloak` *(right-click in Explorer)* | Permanently exclude a file from pulls |

---

## ⚙️ Configuration

Configure in `settings.json` under the **Repo Cloak** section:

```jsonc
{
  // What to do when Force Pull finds files missing from the source.
  // "prompt" (default) | "delete" | "keep"
  "repo-cloak.forcePull.orphanPolicy": "prompt",

  // Auto-commit every pull/push to the cloaked workspace's git repo.
  // "full" (default) — init + commit | "commit-only" — only if repo exists | "off" — never touch git
  "repo-cloak.git": "full"
}
```

---

## 🔒 Security Model

| Layer | Protection |
|---|---|
| **Local-first** | Nothing ever leaves your machine. No telemetry. No network calls. |
| **Encrypted mapping** | `.repo-cloak-map.json` is AES-256-GCM encrypted. The key lives in VS Code SecretStorage (OS keychain). |
| **Secret scanning** | 20+ pattern scanner runs **before** any file enters the cloak. Hits = blocked + reported. |
| **Anonymization** | Source identifiers replaced everywhere (paths + contents) before AI ever sees the code. |
| **Ban list** | Per-source persistent denylist for files you never want exposed. |
| **LM Tool boundary** | Copilot can probe/request, but **every write requires user confirmation**. No directory listings ever exposed. |
| **Audit trail** | Optional auto-commits in the cloaked workspace give you a verifiable history of every pull/push. |

---

## 💡 Use Cases

- **Enterprise AI adoption** — let your dev team use Copilot/Cursor on NDA codebases without legal panic.
- **Cross-repo refactors** — pull the relevant slice from frontend, backend, and infra into one workspace; refactor with AI; push back.
- **Bug reproductions** — ship a cloaked, sanitized repro to a vendor or open-source maintainer.
- **AI-assisted code review** — paste the cloaked diff into ChatGPT/Claude for a second opinion.
- **Onboarding** — generate a cloaked, focused slice for new hires to learn from without dropping the whole org's IP in their lap.
- **Security audits** — extract just the auth/payments modules into a sandbox for an external auditor.

---

## 🧱 Tech Stack

- **TypeScript** (strict) targeting VS Code `^1.95.0`
- **Node crypto** — AES-256-GCM, scrypt key derivation, VS Code SecretStorage
- **VS Code APIs** — TreeDataProvider, Webview, Chat Participant, Language Model Tools, FileSystemWatcher
- **Zero runtime dependencies** beyond Node + VS Code
- **MIT licensed** — fork it, ship it, audit it

---

## 🗺️ Capability Snapshot *(everything currently shipped)*

- ✅ Multi-source aggregation with per-source labels
- ✅ Casing-aware reversible anonymization (7+ casing variants)
- ✅ AES-256-GCM encrypted mapping with OS-keychain-backed secret
- ✅ 20+ pattern secret scanner (pre-pull blocking)
- ✅ Per-source ban list
- ✅ Pull (tree picker) + Pull from Git Changes
- ✅ Force Pull (per source + all sources)
- ✅ Push + Push All + Force Push
- ✅ Cloaked-workspace auto-git with descriptive commits (`full` / `commit-only` / `off`)
- ✅ Orphan resolver with configurable policy (`prompt` / `delete` / `keep`)
- ✅ Replacement presets (save / load / share)
- ✅ PR Summary generator with templates (de-anonymized output)
- ✅ Copy-for-AI bundler
- ✅ AGENTS.md auto-generation for Copilot/Cursor context
- ✅ `@repo-cloak` chat participant (`/sources`, `/pull`, `/presets`, `/pr-summary`, `/help`)
- ✅ **Language Model Tools** for Copilot auto-discovery — `repo_cloak_probe_file` + `repo_cloak_request_pull` *(v1.1.0)*
- ✅ Sidebar webview dashboard + dedicated file tree view with search & bulk-select

---

## 🤝 Contributing

Issues and PRs welcome at **[github.com/iamshz97/repo-cloak-vs-code](https://github.com/iamshz97/repo-cloak-vs-code)**.

See [development-guide.md](development-guide.md) for local dev setup and [PUBLISH.md](PUBLISH.md) for the release flow.

---

<div align="center">

**Built by [Shazni Shiraz](https://github.com/iamshz97)** &nbsp;•&nbsp; **MIT Licensed** &nbsp;•&nbsp; **v1.1.0**

*Bring AI into every codebase. Leave the secrets behind.*

</div>
