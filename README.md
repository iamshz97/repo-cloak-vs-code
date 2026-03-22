<div align="center">
  <h1>Repo Cloak</h1>
  <p><i>Enterprise-Grade Code Anonymization & Extraction for VS Code</i></p>
</div>

---

**Repo Cloak** is a sophisticated VS Code extension engineered to safely bridge the gap between proprietary enterprise codebases and AI coding assistants. By selectively extracting, anonymizing, and creating a unified "cloaked" workspace, Repo Cloak allows you to leverage powerful AI tools (like Copilot, Cursor, or ChatGPT) while maintaining strict data privacy and security.

## Architecture & Workflow

```text
  ┌──────────────────────┐                     ┌──────────────────────┐
  │                      │   [1] Extract &     │                      │
  │  Enterprise          ├────────────────────►│  Cloaked             │
  │  Repositories        │   Anonymize         │  Workspace           │
  │  (Source Code)       │                     │  (Safe for AI)       │
  │                      │◄────────────────────┤                      │
  └───────┬──────────────┘   [3] Restore &     └──────────┬───────────┘
          │                  De-anonymize                 │
          │                                               │
          │                                               │ [2] AI
          │ [0] Configure                                 │ Collaboration
          │ Mappings &                                    │
          │ Replacements                                  ▼
  ┌───────▼──────────────┐                     ┌──────────────────────┐
  │                      │                     │                      │
  │  Repo Cloak Engine   │                     │  AI Assistants       │
  │  (AES-256 Encrypted) │                     │  (Copilot / Cursor)  │
  │                      │                     │                      │
  └──────────────────────┘                     └──────────────────────┘
```

The diagram illustrates the core lifecycle:
1. **Extraction**: Code is selectively pulled from one or more source repositories. Sensitive terminology and secrets are intercepted and anonymized.
2. **Collaboration**: You and your AI assistant work freely within the secure, cloaked workspace, shielded from proprietary specifics.
3. **Restoration**: Once the work is complete, Repo Cloak seamlessly translates the anonymized code back to its original state and pushes it to the source repositories.

## Key Capabilities

- **Multi-Source Aggregation**: Seamlessly pull components from disparate repositories (e.g., frontend, backend, microservices) into a single, cohesive cloaked environment.
- **Intelligent Anonymization**: Automatically redact and replace sensitive nomenclature (e.g., transforming `AcmeCorp` to `ClientA`). The engine natively respects and preserves casing variants (`camelCase`, `PascalCase`, `kebab-case`) and flawlessly reverses them upon restoration.
- **Proactive Security Scanning**: Built-in secret detection (evaluating 20+ patterns) intercepts attempts to extract sensitive credentials (AWS keys, tokens, passwords), alerting you instantly.
- **Git-Aware Extraction**: Bypass manual file selection by utilizing **Pull from Git Changes**, which intelligently targets uncommitted files or those modified in recent commits.
- **Frictionless Synchronization**: Execute silent, automated syncs between your source repositories and the cloak using the **Force Pull** and **Force Push** macros.
- **Context Generation**: Automatically compile essential system prompts (`AGENTS.md`) within the cloaked workspace, providing AI assistants with the precise context needed to navigate your architecture.

## Getting Started

1. **Initialize**: Open a pristine, empty folder in VS Code to serve as your "cloak".
2. **Extract**: Access the Repo Cloak Dashboard via the Activity Bar (shield icon `$(shield)`). Select a source repository, utilize the native Tree View to pinpoint required files, and configure any necessary keyword anonymizations.
3. **Collaborate**: Engage your preferred AI assistant within the secure confines of the cloaked workspace.
4. **Restore**: Upon completion, execute a **Push** to seamlessly reintegrate the modified, de-anonymized files back into their native repositories.

## Uncompromising Security

Privacy is foundational to Repo Cloak. Your code never leaves your local environment or organization boundaries. All operations run natively within your VS Code instance. Crucially, mapping configurations (`.repo-cloak-map.json`)—which contain the blueprint of your original file paths and semantic replacements—are heavily encrypted via `AES-256-GCM` before persisting to disk.

---

<div align="center">
  <p><b>License:</b> MIT &nbsp;&nbsp;•&nbsp;&nbsp; <b>Author:</b> Shazni Shiraz</p>
</div>
