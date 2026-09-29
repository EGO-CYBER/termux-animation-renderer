// config.js
// Загрузка и сохранение глобальных настроек (config.json в корне проекта).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(__dirname, '..');
export const CONFIG_PATH = join(PROJECT_ROOT, 'config.json');

export const DEFAULT_CONFIG = {
    outputDir: '~/storage/movies/TermuxRenderer',
    ffmpegPreset: 'veryfast',
    crf: 18,
    threads: 'auto',
    motionBlur: 1,
    frameFormat: 'png',
    notify: true
};

export function loadConfig() {
    if (!existsSync(CONFIG_PATH)) {
        return { ...DEFAULT_CONFIG };
    }
    try {
        const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
        return { ...DEFAULT_CONFIG, ...parsed };
    } catch {
        console.log('⚠ Не удалось прочитать config.json, используются значения по умолчанию.');
        return { ...DEFAULT_CONFIG };
    }
}

export function saveConfig(config) {
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
}
