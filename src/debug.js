// debug.js
// Необязательный журнал для разбора проблем: TR_DEBUG=1 anim ...
// Пишет медленные кадры, перезапуски вкладок и остановки в ~/tr-debug.log.

import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEBUG_FILE = join(homedir(), 'tr-debug.log');

export function debugEnabled() {
    return process.env.TR_DEBUG === '1';
}

export function debugLog(message) {
    if (!debugEnabled()) return;
    try {
        appendFileSync(DEBUG_FILE, `${new Date().toISOString()} ${message}\n`);
    } catch {
        // журнал не критичен
    }
}
