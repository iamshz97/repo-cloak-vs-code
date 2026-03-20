/**
 * Secret Data Scanner
 * Scans files for common sensitive data patterns
 */

import { readFileSync, statSync } from 'fs';
import { isBinaryFile } from './scanner';

const MAX_SCAN_SIZE = 2 * 1024 * 1024;

interface SecretPattern {
    name: string;
    regex: RegExp;
}

export interface SecretFinding {
    type: string;
    file: string;
    line: number;
}

export const SECRET_PATTERNS: SecretPattern[] = [
    { name: 'AWS Access Key ID', regex: /(A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/g },
    { name: 'AWS Secret Access Key', regex: /aws_(?:secret_)?(?:access_)?key(?:\s*=?\s*["']?)(?!<)[a-zA-Z0-9/+=]{40}(?!>)/gi },
    { name: 'RSA Private Key', regex: /-----BEGIN RSA PRIVATE KEY-----/g },
    { name: 'Generic Private Key', regex: /-----BEGIN PRIVATE KEY-----/g },
    { name: 'DSA Private Key', regex: /-----BEGIN DSA PRIVATE KEY-----/g },
    { name: 'OpenSSH Private Key', regex: /-----BEGIN OPENSSH PRIVATE KEY-----/g },
    { name: 'Generic API Key / Token', regex: /(?:api_?key|auth_?token|access_?token|secret_?key|bearer_?token)(?:\s*[:=]\s*["']?)(?!<)[a-zA-Z0-9\-_]{20,}(?!>)/gi },
    { name: 'Generic Password / Secret', regex: /(?:password|passwd|pwd|secret|pass)(?:\s*[:=]\s*["']?)(?!<)[a-zA-Z0-9\-_@!#$%^&*]{8,}(?!>)/gi },
    { name: 'JSON Web Token (JWT)', regex: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g },
    { name: 'GitHub Token', regex: /(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36}/g },
    { name: 'GitHub OAuth App Token', regex: /gho_[a-zA-Z0-9]{36}/g },
    { name: 'Slack Token', regex: /(xox[pboar]-[0-9]{12}-[0-9]{12}-[0-9]{12}-[a-z0-9]{32})/g },
    { name: 'Slack Webhook', regex: /https:\/\/hooks\.slack\.com\/services\/T[a-zA-Z0-9_]{8,}\/B[a-zA-Z0-9_]{8,}\/[a-zA-Z0-9_]{24}/g },
    { name: 'Stripe API Key', regex: /(?:sk_live|rk_live|sk_test|rk_test)_[0-9a-zA-Z]{24}/g },
    { name: 'Google API Key', regex: /AIza[0-9A-Za-z\-_]{35}/g },
    { name: 'Google OAuth Access Token', regex: /ya29\.[0-9A-Za-z\-_]+/g },
    { name: 'Discord Bot Token', regex: /[M|N][a-zA-Z0-9_-]{23,}\.[a-zA-Z0-9_-]{6,}\.[a-zA-Z0-9_-]{27,}/g },
    { name: 'Discord Webhook', regex: /https:\/\/discord\.com\/api\/webhooks\/[0-9]{18,19}\/[a-zA-Z0-9_-]{68}/g },
    { name: 'Database Connection String', regex: /(?:mysql|postgresql|mongodb|mssql|sqlite|redis|amqp):\/\/[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+@[a-zA-Z0-9_.-]+:[0-9]{1,5}\/[a-zA-Z0-9_-]+/gi },
    { name: 'Heroku API Key', regex: /[h|H]eroku[0-9a-zA-Z_-]{8}-[0-9a-zA-Z_-]{4}-[0-9a-zA-Z_-]{4}-[0-9a-zA-Z_-]{4}-[0-9a-zA-Z_-]{12}/g },
    { name: 'Mailgun API Key', regex: /key-[0-9a-zA-Z]{32}/g }
];

/**
 * Scan a single file for secrets
 */
export function scanFileForSecrets(filePath: string): SecretFinding[] {
    const findings: SecretFinding[] = [];

    try {
        if (isBinaryFile(filePath)) {
            return findings;
        }

        const stats = statSync(filePath);
        if (stats.size > MAX_SCAN_SIZE) {
            return findings;
        }

        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split(/\r?\n/);

        const seenOnLine = new Set<string>();

        for (let i = 0; i < lines.length; i++) {
            const lineContent = lines[i];

            for (const pattern of SECRET_PATTERNS) {
                pattern.regex.lastIndex = 0;

                if (pattern.regex.test(lineContent)) {
                    const uniqueKey = `${i}-${pattern.name}`;
                    if (!seenOnLine.has(uniqueKey)) {
                        findings.push({
                            type: pattern.name,
                            file: filePath,
                            line: i + 1
                        });
                        seenOnLine.add(uniqueKey);
                    }
                }
            }
        }
    } catch (error) {
        // Ignore read errors
    }

    return findings;
}

/**
 * Scan multiple files for secrets
 */
export async function scanFilesForSecrets(filePaths: string[]): Promise<SecretFinding[]> {
    if (!filePaths || filePaths.length === 0) { return []; }

    let allFindings: SecretFinding[] = [];

    for (const filePath of filePaths) {
        const fileFindings = scanFileForSecrets(filePath);
        if (fileFindings.length > 0) {
            allFindings = allFindings.concat(fileFindings);
        }
    }

    return allFindings;
}
