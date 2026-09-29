// system.js
// Сведения об устройстве: ядра, свободная память, свободное место на диске.
// На их основе выбирается число параллельных вкладок и выдаются
// предупреждения до начала рендера.

import { readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

export function cpuCount() {
    return os.cpus()?.length || 1;
}

/** Доступная оперативная память в МБ (MemAvailable из /proc/meminfo). */
export function availableMemoryMB() {
    try {
        const match = /MemAvailable:\s+(\d+)\s+kB/.exec(readFileSync('/proc/meminfo', 'utf8'));
        if (match) return Math.floor(Number(match[1]) / 1024);
    } catch {
        // /proc может быть недоступен - используем запасной вариант
    }
    return Math.floor(os.freemem() / 1048576);
}

/** Свободное место (МБ) на разделе, где лежит указанный путь. null, если не удалось узнать. */
export function freeDiskMB(path) {
    let dir = path;
    while (dir && !existsSync(dir) && dirname(dir) !== dir) {
        dir = dirname(dir);
    }
    try {
        const result = spawnSync('df', ['-Pk', dir], { encoding: 'utf8', timeout: 4000 });
        if (result.status !== 0) return null;
        const lines = String(result.stdout).trim().split('\n');
        const cols = lines[lines.length - 1].trim().split(/\s+/);
        const availKb = Number(cols[3]);
        return Number.isFinite(availKb) ? Math.floor(availKb / 1024) : null;
    } catch {
        return null;
    }
}

/** Грубая оценка памяти, которую занимает одна вкладка Chromium при данном разрешении. */
export function estimateTabMemoryMB(width, height) {
    return Math.round(220 + (width * height * 4 * 5) / 1048576);
}

export const MAX_AUTO_THREADS = 6;

/**
 * Подбирает число вкладок: ограничено ядрами CPU, свободной памятью и
 * числом кадров. Возвращает подробности, чтобы диагностика могла их показать.
 */
export function autoThreadInfo({ width, height, frameCount = Infinity } = {}) {
    const byCpu = Math.min(cpuCount(), MAX_AUTO_THREADS);
    const availMB = availableMemoryMB();
    let byMem = Infinity;
    if (width && height) {
        const perTab = estimateTabMemoryMB(width, height);
        byMem = Math.max(1, Math.floor((availMB * 0.7 - 400) / perTab));
    }
    const threads = Math.max(1, Math.min(byCpu, byMem, frameCount));
    return { threads, byCpu, byMem, availMB };
}
