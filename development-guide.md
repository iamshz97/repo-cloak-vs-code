# Repo Cloak VS Code Extension — Development & Publishing Guide

## Part 1: Local Development

### Prerequisites

```bash
# Ensure you have these installed
node --version   # >= 18.x
npm --version    # >= 9.x
code --version   # VS Code >= 1.85.0
```

### Step 1: Install Dependencies

```bash
cd /Users/shaznishiraz/Projects/Personal/repo-cloak-vs-code
npm install
```

### Step 2: Compile

```bash
npm run compile     # one-time build
# or
npm run watch       # auto-recompile on save (recommended during development)
```

### Step 3: Launch Extension Development Host

1. Open `repo-cloak-vs-code` folder in VS Code
2. Press **F5** (or Run → Start Debugging)
3. A new VS Code window titled **"Extension Development Host"** opens
4. Look for the 🎭 **shield icon** in the activity bar (left side)
5. Click it to see the **Repo Cloak** sidebar

> [!TIP]
> Open the **Debug Console** (Ctrl+Shift+Y) in the original window to see `console.log` output from your extension.

### Step 4: Test the Extension

| Action | How |
|--------|-----|
| **Pull** | Command Palette (Cmd+Shift+P) → "Repo Cloak: Pull" |
| **Push** | Command Palette → "Repo Cloak: Push" |
| **Sync** | Click ⟳ Sync in sidebar, or Command Palette → "Repo Cloak: Sync" |
| **Add replacement** | Click "+ Add replacement" in sidebar |

### Step 5: Iterate

1. Make changes to any [.ts](file:///Users/shaznishiraz/Projects/Personal/repo-cloak-vs-code/src/core/git.ts) file in `src/`
2. If running `npm run watch`, it auto-compiles
3. In the Extension Dev Host, press **Ctrl+Shift+F5** (Restart Extension Host) to reload
4. No need to close and reopen — just restart

---

## Part 2: Debugging

### launch.json (auto-created by VS Code)

If it wasn't created, add this to `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}"],
      "outFiles": ["${workspaceFolder}/out/**/*.js"],
      "preLaunchTask": "${defaultBuildTask}"
    }
  ]
}
```

### Common Issues

| Issue | Fix |
|-------|-----|
| Sidebar not showing | Check [package.json](file:///Users/shaznishiraz/Projects/Personal/repo-cloak/package.json) → `contributes.views` |
| Command not found | Ensure command is in [package.json](file:///Users/shaznishiraz/Projects/Personal/repo-cloak/package.json) → `contributes.commands` AND registered in [extension.ts](file:///Users/shaznishiraz/Projects/Personal/repo-cloak-vs-code/src/extension.ts) |
| Changes not reflecting | Restart Extension Host (Ctrl+Shift+F5) |
| TypeScript errors | Run `npm run compile` and fix errors |

---

## Part 3: Publishing to VS Code Marketplace

### Step 1: Install vsce (VS Code Extension CLI)

```bash
npm install -g @vscode/vsce
```

### Step 2: Create a Publisher Account

1. Go to [Azure DevOps](https://dev.azure.com) → sign in with Microsoft account
2. Go to [VS Code Marketplace Publisher Management](https://marketplace.visualstudio.com/manage)
3. Click **"Create publisher"**
4. Choose a publisher ID (e.g., `iamshz97`)
5. This must match `"publisher"` in your [package.json](file:///Users/shaznishiraz/Projects/Personal/repo-cloak/package.json)

### Step 3: Create a Personal Access Token (PAT)

1. In Azure DevOps → **User Settings** (top-right gear) → **Personal Access Tokens**
2. Click **"New Token"**
3. Set:
   - **Name**: `vsce` (or anything)
   - **Organization**: Select **All accessible organizations**
   - **Scopes**: Click "Show all scopes" → check **Marketplace → Manage**
   - **Expiration**: Pick a duration
4. Click **Create** and **copy the token** (you won't see it again!)

### Step 4: Login with vsce

```bash
vsce login iamshz97
# Paste your PAT when prompted
```

### Step 5: Prepare for Publishing

Add these to [package.json](file:///Users/shaznishiraz/Projects/Personal/repo-cloak/package.json) if not already present:

```json
{
  "repository": {
    "type": "git",
    "url": "https://github.com/iamshz97/repo-cloak-vs-code"
  },
  "icon": "icon.png",
  "galleryBanner": {
    "color": "#1e1e1e",
    "theme": "dark"
  }
}
```

> [!IMPORTANT]
> You need an `icon.png` (128×128 minimum, 256×256 recommended) in the project root. This is displayed on the Marketplace.

Create a [README.md](file:///Users/shaznishiraz/Projects/Personal/repo-cloak/README.md) in the project root — this is what shows on the Marketplace page.

### Step 6: Package the Extension

```bash
vsce package
# Creates repo-cloak-0.1.0.vsix
```

> [!TIP]
> Test the VSIX locally first:
> ```bash
> code --install-extension repo-cloak-0.1.0.vsix
> ```

### Step 7: Publish!

```bash
vsce publish
```

Or publish with a version bump:

```bash
vsce publish minor   # 0.1.0 → 0.2.0
vsce publish patch   # 0.1.0 → 0.1.1
```

### Step 8: Verify

1. Go to [marketplace.visualstudio.com](https://marketplace.visualstudio.com/vscode)
2. Search for "Repo Cloak"
3. It may take a few minutes to appear

---

## Part 4: Updating the Extension

```bash
# 1. Make changes
# 2. Bump version
npm version patch   # or minor/major

# 3. Compile
npm run compile

# 4. Publish
vsce publish
```

---

## Quick Reference

| Command | What it does |
|---------|--------------|
| `npm run compile` | Build the extension |
| `npm run watch` | Auto-rebuild on save |
| **F5** | Launch Extension Dev Host |
| **Ctrl+Shift+F5** | Restart Extension Host |
| `vsce package` | Create .vsix file |
| `vsce publish` | Publish to Marketplace |
| `code --install-extension *.vsix` | Install locally from .vsix |
