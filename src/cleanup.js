// cleanup.js
// Гарантированная очистка при завершении и прерывании (Ctrl+C, закрытие
// Termux, kill): останавливает Chromium и FFmpeg, удаляет временные
// профили и недописанные файлы. Обработчики СИНХРОННЫЕ, потому что при
// событии process.on('exit') асинхронный код уже не выполняется.
//
// Также умеет находить и удалять остатки прошлых аварийных запусков
// (временные папки tr-chromium-* / tr-frames-* и зависшие процессы Chromium).

import { readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const handlers = new Set();
let installed = false;
let exiting = false;

function runAll() {
    for (const fn of [...handlers]) {
        try { fn(); } catch { /* игнорируем */ }
    }
}

function install() {
    if (installed) return;
    installed = true;

    const bye = (code, message) => () => {
        if (exiting) return;
        exiting = true;
        if (message) process.stderr.write(message);
        runAll();
        process.exit(code);
    };

    process.on('SIGINT', bye(130, '\nПрервано (Ctrl+C). Очищаю временные файлы...\n'));
    process.on('SIGTERM', bye(143, ''));
    process.on('SIGHUP', bye(129, ''));
    process.on('exit', runAll);
}

/**
 * Регистрирует синхронную функцию очистки. Возвращает функцию отмены
 * регистрации (вызывайте её, когда ресурс уже освобождён штатно).
 */
export function onCleanup(fn) {
    handlers.add(fn);
    install();
    return () => handlers.delete(fn);
}

function dirSizeBytes(dir) {
    const result = spawnSync('du', ['-sk', dir], { encoding: 'utf8', timeout: 5000 });
    if (result.status === 0) {
        const kb = Number(String(result.stdout).split(/\s+/)[0]);
        if (Number.isFinite(kb)) return kb * 1024;
    }
    return 0;
}

/**
 * Удаляет временные папки программы старше maxAgeMs (по умолчанию 2 часа,
 * чтобы не задеть параллельно идущий рендер). Возвращает { removed, bytes }.
 */
export function cleanStaleTempDirs({ maxAgeMs = 2 * 60 * 60 * 1000, baseDir = tmpdir() } = {}) {
    let removed = 0;
    let bytes = 0;
    let entries = [];
    try {
        entries = readdirSync(baseDir);
    } catch {
        return { removed, bytes };
    }

    for (const name of entries) {
        if (!name.startsWith('tr-chromium-') && !name.startsWith('tr-frames-')) continue;
        const full = join(baseDir, name);
        try {
            const age = Date.now() - statSync(full).mtimeMs;
            if (age < maxAgeMs) continue;
            bytes += dirSizeBytes(full);
            rmSync(full, { recursive: true, force: true });
            removed += 1;
        } catch {
            // недоступно или уже удалено
        }
    }
    return { removed, bytes };
}

/**
 * Находит процессы Chromium, оставшиеся от прошлых аварийно завершённых
 * запусков (по имени временного профиля tr-chromium-).
 */
export function findOrphanChromium() {
    const result = spawnSync('pgrep', ['-f', 'tr-chromium-'], { encoding: 'utf8', timeout: 3000 });
    if (result.status !== 0) return [];
    return String(result.stdout)
        .split('\n')
        .map((s) => Number(s.trim()))
        .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid && pid !== process.ppid);
}

export function killOrphanChromium() {
    let killed = 0;
    for (const pid of findOrphanChromium()) {
        try {
            process.kill(pid, 'SIGKILL');
            killed += 1;
        } catch {
            // уже завершён
        }
    }
    return killed;
}
