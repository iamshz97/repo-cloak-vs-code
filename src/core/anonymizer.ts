/**
 * Anonymizer
 * Handles keyword replacement for anonymizing content with case preservation
 */

export interface Replacement {
    original: string;
    replacement: string;
}

export interface AnonymizerOptions {
    caseSensitive?: boolean;
}

/**
 * Create a replacement function for a list of replacements
 */
export function createAnonymizer(replacements: Replacement[], options: AnonymizerOptions = {}): (content: string) => string {
    const { caseSensitive = false } = options;

    if (!replacements || replacements.length === 0) {
        return (content: string) => content;
    }

    return (content: string) => {
        let result = content;

        for (const { original, replacement } of replacements) {
            if (caseSensitive) {
                result = result.split(original).join(replacement);
            } else {
                const regex = new RegExp(escapeRegex(original), 'gi');
                result = result.replace(regex, (match) => matchCase(match, replacement));
            }
        }

        return result;
    };
}

/**
 * Create reverse anonymizer (for push operation)
 */
export function createDeanonymizer(replacements: Replacement[], options: AnonymizerOptions = {}): (content: string) => string {
    if (!replacements || replacements.length === 0) {
        return (content: string) => content;
    }

    const reversed = replacements.map(r => ({
        original: r.replacement,
        replacement: r.original
    }));

    return createAnonymizer(reversed, options);
}

/**
 * Escape special regex characters
 */
function escapeRegex(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Match the case pattern of the original to the replacement
 */
function matchCase(original: string, replacement: string): string {
    const hasLetters = /[a-zA-Z]/.test(original);

    if (!hasLetters) {
        return replacement;
    }

    if (original === original.toUpperCase()) {
        return replacement.toUpperCase();
    }

    if (original === original.toLowerCase()) {
        return replacement.toLowerCase();
    }

    const firstLetter = original.charAt(0);
    const restOfStr = original.slice(1);

    if (firstLetter === firstLetter.toUpperCase() && restOfStr === restOfStr.toLowerCase()) {
        return replacement.charAt(0).toUpperCase() + replacement.slice(1).toLowerCase();
    }

    return replacement;
}

/**
 * Apply replacements to a file path (for renaming files/folders)
 */
export function anonymizePath(filePath: string, replacements: Replacement[]): string {
    if (!replacements || replacements.length === 0) {
        return filePath;
    }

    let result = filePath;

    for (const { original, replacement } of replacements) {
        const regex = new RegExp(escapeRegex(original), 'gi');
        result = result.replace(regex, (match) => matchCase(match, replacement));
    }

    return result;
}

/**
 * Count replacements in content
 */
export function countReplacements(content: string, replacements: Replacement[]): number {
    if (!replacements || replacements.length === 0) {
        return 0;
    }

    let count = 0;

    for (const { original } of replacements) {
        const regex = new RegExp(escapeRegex(original), 'gi');
        const matches = content.match(regex);
        if (matches) {
            count += matches.length;
        }
    }

    return count;
}
