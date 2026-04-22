/**
 * Notify Helper
 * Centralised, low-noise notifications.
 *
 * Rule of thumb:
 *   - notifySuccess / notifyWarn / notifyInfo → status bar (peripheral, auto-clears)
 *   - notifyError                              → toast (loud, intentional)
 *   - For modal confirms or button choices, call vscode.window.show*Message directly.
 */

import * as vscode from 'vscode';

const SUCCESS_TIMEOUT = 3500;
const WARN_TIMEOUT = 4000;
const INFO_TIMEOUT = 3000;

export function notifySuccess(text: string): void {
    vscode.window.setStatusBarMessage(`$(check) ${text}`, SUCCESS_TIMEOUT);
}

export function notifyWarn(text: string): void {
    vscode.window.setStatusBarMessage(`$(warning) ${text}`, WARN_TIMEOUT);
}

export function notifyInfo(text: string): void {
    vscode.window.setStatusBarMessage(`$(info) ${text}`, INFO_TIMEOUT);
}

export function notifyError(text: string): void {
    vscode.window.showErrorMessage(text);
}
