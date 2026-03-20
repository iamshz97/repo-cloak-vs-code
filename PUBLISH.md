# Publishing to the VS Code Marketplace

This guide will walk you through the process of publishing the `repo-cloak` extension to the official Visual Studio Code Marketplace.

## Prerequisites

Before publishing, ensure you have:
1. `npm` and `Node.js` installed.
2. A Microsoft account.

## Step 1: Install `vsce`

`vsce` (Visual Studio Code Extensions) is the official command-line tool for packaging, publishing, and managing VS Code extensions.

```bash
npm install -g @vscode/vsce
```

## Step 2: Get a Personal Access Token (PAT)

You need an Azure DevOps account to publish extensions, which provides the authentication token.

1. Go to [Azure DevOps](https://dev.azure.com/) and sign in with your Microsoft account.
2. Create an organization if you don't have one (the name doesn't matter).
3. In the top right corner, click on the **User Settings** icon (next to your avatar) and select **Personal Access Tokens**.
4. Click **New Token** and configure it as follows:
   *   **Name**: `VS Code Publisher Token` (or similar)
   *   **Organization**: Choose `All accessible organizations`.
   *   **Expiration**: Set this to a duration you are comfortable with (e.g., 1 year).
   *   **Scopes**: Click **Show all scopes**, scroll down to find **Marketplace**, and select **Acquire** and **Manage**.
5. Click **Create**.
6. **⚠️ IMPORTANT**: Copy the generated token immediately. You will not be able to see it again.

## Step 3: Create a Publisher

A publisher is an identity who can publish extensions to the Marketplace.

1. Go to the [Visual Studio Code Marketplace Management Page](https://marketplace.visualstudio.com/manage).
2. Sign in with your Microsoft account.
3. Click **Create Publisher**.
4. Enter `iamshz97` as the ID (or your preferred publisher name). This ID **must match** the `"publisher"` field in your `package.json`.

## Step 4: Login via `vsce`

Now, authenticate your CLI with the publisher ID and your new PAT.

```bash
vsce login iamshz97
```
When prompted, paste the **Personal Access Token (PAT)** you copied in Step 2.

## Step 5: Package & Publish

Ensure your `package.json` is ready. Verify that `name`, `displayName`, `description`, `version`, `publisher`, and `repository` fields are accurate.

### To securely package it locally (Optional)
If you just want to generate a `.vsix` file to install manually or distribute to your team internally:
```bash
vsce package
```

### To publish directly to the Marketplace
To release it to the global public VS Code extension store:
```bash
vsce publish
```

*Note: If this is your first time publishing, it may take a few minutes for the extension to become visible and searchable on the Marketplace.*

## Updating Your Extension

When you make changes to the code and want to release a new version:

1. Update the `"version"` field in `package.json` (e.g., from `"0.1.0"` to `"0.1.1"`).
2. Re-compile your code if necessary (`npm run compile`).
3. Run `vsce publish`. You can also use semantic versioning flags directly from the CLI to bump the version for you:
   ```bash
   vsce publish minor  # Bumps 0.1.0 to 0.2.0
   vsce publish patch  # Bumps 0.1.0 to 0.1.1
   ```

## More Information
For detailed, up-to-date instructions, visit the official [VS Code Publishing Extension Guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).
