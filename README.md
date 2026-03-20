<div align="center">
  <h1>🎭 Repo Cloak (VS Code)</h1>
  <p><b>Selectively extract, anonymize, and collaborate on enterprise codebases securely with AI.</b></p>
</div>

---

**Repo Cloak** is a VS Code extension that allows you to safely provide your proprietary codebase to AI coding assistants (like Copilot, Cursor, or ChatGPT) by taking only what you need, scrubbing sensitive data, and creating a unified "cloaked" workspace. When the AI is done generating or modifying the code, you can easily "push" the changes back to your original repositories.

## 🌟 Key Features

- **Multi-Source Extraction**: Pull files from multiple different repositories (e.g., frontend, backend, shared libraries) into a single unified cloaked workspace.
- **Security First**: Built-in secret scanning (over 20+ patterns) warns you inside the Output panel if you try to extract passwords, AWS keys, or tokens, allowing you to filter them out instantly.
- **Intelligent Keyword Anonymization**: Automatically replace sensitive company names, client names, or product codenames (e.g., `AcmeCorp` → `ClientA`) while strictly preserving `camelCase`, `PascalCase`, and `kebab-case`. Reverses seamlessly on Push.
- **Git Integration**: Don't want to hunt manually for files? Use **Pull from Git Changes** to automatically extract uncommitted files or files touched in recent commits.
- **Quiet Macros ("Force" Actions)**: Use the **Force Pull** and **Force Push** actions to silently sync your mapped files between the source repositories and the cloak without any interactive prompts.
- **`AGENTS.md` Context Generation**: Automatically generates system prompt context inside the cloaked workspace to instruct LLMs on how to interact with your codebase.

## 🚀 How it Works (The Workflow)

1.  **Open an Empty Folder:** Open a blank folder in VS Code to act as your "cloak".
2.  **Pull Files:** Click **Pull** in the Repo Cloak sidebar. Select a source repository, check the files you want to extract using the native Tree View, and enter any keywords to anonymize.
3.  **Collaborate with AI:** Work with your AI pair programmer inside the cloaked workspace.
4.  **Push Files:** When the AI has successfully modified your code, click **Push** to seamlessly restore the anonymized files back to their original source repositories.

## 🖱️ User Interface

The extension adds a sleek **Dashboard** to your VS Code Activity Bar (shield icon `$(shield)`).

From the Dashboard, you have:

- **Top Action Bar**: QuickPick routers for `Pull` (Interactive or Force Pull All) and `Push` (Interactive or Force Push All).
- **Sources List**: View all your cloaked repositories, file counts, and replacements. Hover over any source to access granular, per-source actions (Git Pull, Pull, Force Pull, Force Push, Remove).

## 🔒 Encryption & Privacy

Repo Cloak never sends your code anywhere. Everything runs locally natively inside your VS Code instance. Mappings (`.repo-cloak-map.json`) containing original file paths and keywords are heavily encrypted using `AES-256-GCM` before being saved to disk.

---

**License**: MIT
**Author**: Shazni Shiraz
