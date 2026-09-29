// termux.js
// Интеграция с Android/Termux: wake lock (чтобы система не убила долгий
// рендер), уведомления, вибрация, индексация файла в галерее, буфер обмена.
// Всё "по возможности": если termux-api не установлен, функции молча
// возвращают false и рендер продолжается как обычно.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';

import { expandHome } from './animation-loader.js';

const commandCache = new Map();

export function hasCommand(name) {
    if (commandCache.has(name)) return commandCache.get(name);
    const result = spawnSync('sh', ['-c', `command -v ${name}`], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000
    });
    const found = result.status === 0;
    commandCache.set(name, found);
    return found;
}

function run(cmd, args, extra = {}) {
    try {
        return spawnSync(cmd, args, { stdio: ['ignore', 'ignore', 'ignore'], timeout: 4000, ...extra });
    } catch {
        return null;
    }
}

export function isTermux() {
    return (process.env.PREFIX || '').includes('com.termux');
}

let wakeLockHeld = false;

/** Не даёт Android усыпить/убить Termux во время долгого рендера. */
export function acquireWakeLock() {
    if (wakeLockHeld) return true;
    if (!hasCommand('termux-wake-lock')) return false;
    const result = run('termux-wake-lock', []);
    wakeLockHeld = Boolean(result && result.status === 0);
    return wakeLockHeld;
}

export function releaseWakeLock() {
    if (!wakeLockHeld) return;
    run('termux-wake-unlock', []);
    wakeLockHeld = false;
}

export function notify(title, content) {
    if (!hasCommand('termux-notification')) return false;
    const result = run('termux-notification', ['--title', title, '--content', content]);
    return Boolean(result && result.status === 0);
}

export function vibrate(ms = 250) {
    if (!hasCommand('termux-vibrate')) return false;
    const result = run('termux-vibrate', ['-d', String(ms)]);
    return Boolean(result && result.status === 0);
}

/** Сообщает Android о новом файле, чтобы видео сразу появилось в галерее. */
export function mediaScan(path) {
    if (hasCommand('termux-media-scan')) {
        run('termux-media-scan', [path]);
    } else if (hasCommand('am')) {
        run('am', ['broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', `file://${path}`]);
    }
}

export function copyToClipboard(text) {
    if (!hasCommand('termux-clipboard-set')) return false;
    const result = run('termux-clipboard-set', [], { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
    return Boolean(result && result.status === 0);
}

export function storageReady() {
    return existsSync(join(os.homedir(), 'storage'));
}

/**
 * Разворачивает папку сохранения. Если она в ~/storage/..., а общее
 * хранилище не подключено (не выполнен termux-setup-storage), то вместо
 * тихого создания "ненастоящей" папки используем ~/TermuxRenderer и
 * возвращаем предупреждение.
 */
export function resolveOutputDir(configured) {
    const dir = resolve(expandHome(configured));
    const storageDir = join(os.homedir(), 'storage');

    if (dir.startsWith(storageDir + '/') && !existsSync(storageDir)) {
        return {
            dir: join(os.homedir(), 'TermuxRenderer'),
            warning:
                'Общее хранилище не подключено (не выполнен termux-setup-storage), поэтому видео\n' +
                '  сохранится в ~/TermuxRenderer и не появится в галерее. Выполните один раз:\n' +
                '  termux-setup-storage'
        };
    }
    return { dir, warning: null };
}
