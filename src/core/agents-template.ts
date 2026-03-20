/**
 * AGENTS.md Template
 * Auto-generated file placed inside cloaked workspaces to instruct AI agents
 */

export function getAgentsMarkdown(): string {
    return `# AI Agent Guidelines for This Repository

## Important Context

This is an **isolated, partially cloned repository** created using [Repo-Cloak](https://www.npmjs.com/package/repo-cloak-cli). It contains only a subset of files selectively pulled from a larger enterprise codebase for the purpose of working with AI coding tools in a safe, anonymized environment.

## What You Need to Know

- **Partial repository.** This workspace does NOT contain the full codebase. Only specific files were selected and pulled by the developer. Missing files, references, or imports pointing to modules not present in this workspace are expected.
- **Anonymized identifiers.** Company names, project names, and other proprietary identifiers have been systematically replaced with anonymized alternatives. Do not attempt to guess or restore the original names.
- **Preserve the existing structure.** All file paths, folder hierarchies, and naming conventions in this workspace mirror the original repository structure. Maintain this structure in any changes you make.
- **Only modify files present in this workspace.** Do not create files outside the directories already present unless explicitly asked to by the user. Your changes will be pushed back into the original repository, so they must align with the existing structure.

## If You Need More Context

If you encounter a situation where:
- A referenced file, module, or dependency is missing
- You cannot determine the correct interface, type, or contract
- The available code is insufficient to complete the task confidently

**Ask the user to pull additional files** using Repo-Cloak. They can selectively add more files to this workspace without starting over. Do not guess or fabricate missing implementations.

## Working With This Repository

1. Treat this workspace as a real project. The structure and patterns are genuine.
2. Write code that follows the conventions and patterns you observe in the existing files.
3. Your changes will be de-anonymized and merged back into the original codebase automatically.
4. Focus on the task the user has given you. The files present are the files they have chosen to expose for this purpose.
`;
}
