// deps.js
// Обнаружение и проверка внешних зависимостей: Node.js, Chromium, FFmpeg.
// Используется диагностикой, установщиком (косвенно) и рендерером.

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// Возможные имена/пути бинарника Chromium в Termux и на "обычном" Linux.
const CHROMIUM_CANDIDATES = [
    'chromium-browser',
    'chromium',
    'chromium-browser-beta',
    '/data/data/com.termux/files/usr/bin/chromium-browser',
    '/data/data/com.termux/files/usr/bin/chromium'
];

const FFMPEG_CANDIDATES = [
    'ffmpeg',
    '/data/data/com.termux/files/usr/bin/ffmpeg'
];

/**
 * Пытается найти полный путь к исполняемому файлу через `command -v`.
 * Возвращает null, если не найден.
 */
function which(bin) {
    try {
        const out = execSync(`command -v ${bin} 2>/dev/null`, { encoding: 'utf8' }).trim();
        return out.length > 0 ? out : null;
    } catch {
        return null;
    }
}

/**
 * Находит первый доступный бинарник из списка кандидатов.
 * Каждый кандидат может быть именем команды или абсолютным путём.
 */
function findFirstAvailable(candidates) {
    for (const candidate of candidates) {
        if (candidate.startsWith('/')) {
            if (existsSync(candidate)) {
                return candidate;
            }
            continue;
        }
        const resolved = which(candidate);
        if (resolved) {
            return resolved;
        }
    }
    return null;
}

/**
 * Возвращает версию Node.js (текущий процесс всегда на Node, поэтому
 * просто читаем process.version).
 */
export function getNodeInfo() {
    return {
        available: true,
        path: process.execPath,
        version: process.version
    };
}

/**
 * Ищет Chromium и возвращает информацию о нём.
 */
export function getChromiumInfo() {
    const path = findFirstAvailable(CHROMIUM_CANDIDATES);
    if (!path) {
        return { available: false, path: null, version: null };
    }
    let version = null;
    try {
        version = execSync(`"${path}" --version 2>/dev/null`, { encoding: 'utf8' }).trim();
    } catch {
        // Версию узнать не удалось, но бинарник есть - не критично.
    }
    return { available: true, path, version };
}

/**
 * Ищет FFmpeg и возвращает информацию о нём.
 */
export function getFfmpegInfo() {
    const path = findFirstAvailable(FFMPEG_CANDIDATES);
    if (!path) {
        return { available: false, path: null, version: null };
    }
    let version = null;
    try {
        const raw = execSync(`"${path}" -version 2>/dev/null`, { encoding: 'utf8' });
        version = raw.split('\n')[0].trim();
    } catch {
        // не критично
    }
    return { available: true, path, version };
}

/**
 * Полная проверка всех зависимостей разом. Используется перед рендером
 * и в разделе диагностики.
 */
export function checkAllDeps() {
    return {
        node: getNodeInfo(),
        chromium: getChromiumInfo(),
        ffmpeg: getFfmpegInfo()
    };
}
