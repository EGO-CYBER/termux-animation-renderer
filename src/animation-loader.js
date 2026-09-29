// animation-loader.js
// Проверка пути к animation.html, валидация window.VIDEO (после того как
// CDP-слой прочитал его из живой страницы) и вычисление плана рендера.

import { existsSync, statSync } from 'node:fs';
import { resolve, dirname, basename, extname, join, isAbsolute } from 'node:path';
import os from 'node:os';

import { AnimationError } from './errors.js';

const MAX_FPS = 240;
const MAX_DURATION_SEC = 3600;
const MAX_FRAMES = 216000;

/** Разворачивает "~" в домашнюю директорию, как это делает shell. */
export function expandHome(inputPath) {
    if (!inputPath) return inputPath;
    if (inputPath === '~') return os.homedir();
    if (inputPath.startsWith('~/')) {
        return resolve(os.homedir(), inputPath.slice(2));
    }
    return inputPath;
}

/**
 * Проверяет, что путь указывает на существующий .html-файл.
 * Бросает Error с понятным русским текстом при проблеме.
 */
export function validateAnimationPath(rawPath) {
    if (!rawPath || rawPath.trim().length === 0) {
        throw new Error('Путь к animation.html не указан.');
    }

    // Пользователи часто вставляют путь в кавычках.
    const cleaned = rawPath.trim().replace(/^["']|["']$/g, '');
    const absolute = resolve(expandHome(cleaned));

    if (!existsSync(absolute)) {
        throw new Error(`Файл не найден:\n${absolute}`);
    }
    if (!statSync(absolute).isFile()) {
        throw new Error(`Указанный путь не является файлом:\n${absolute}`);
    }
    if (!absolute.toLowerCase().endsWith('.html')) {
        throw new Error('Файл анимации должен иметь расширение .html');
    }
    return absolute;
}

/**
 * Проверяет и нормализует объект window.VIDEO, полученный из браузера.
 * Необязательное поле audio - путь к звуковому файлу (относительно html).
 */
export function validateVideoConfig(video) {
    if (!video || typeof video !== 'object') {
        throw new AnimationError(
            'В animation.html отсутствует:\nwindow.VIDEO\n\n' +
            'Добавьте в начало файла:\n' +
            'window.VIDEO = { width: 1920, height: 1080, fps: 30, duration: 15 };'
        );
    }

    const { width, height, fps, duration, audio } = video;

    if (!Number.isFinite(width) || width <= 0 || !Number.isInteger(width)) {
        throw new AnimationError(`Некорректный width в window.VIDEO: ${width}`);
    }
    if (!Number.isFinite(height) || height <= 0 || !Number.isInteger(height)) {
        throw new AnimationError(`Некорректный height в window.VIDEO: ${height}`);
    }
    if (!Number.isFinite(fps) || fps <= 0 || fps > MAX_FPS) {
        throw new AnimationError(`Некорректный fps в window.VIDEO: ${fps} (допустимо от 1 до ${MAX_FPS})`);
    }
    if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_DURATION_SEC) {
        throw new AnimationError(`Некорректный duration в window.VIDEO: ${duration} (допустимо до ${MAX_DURATION_SEC} с)`);
    }
    if (Math.round(fps * duration) > MAX_FRAMES) {
        throw new AnimationError(`Слишком много кадров (${Math.round(fps * duration)}). Максимум: ${MAX_FRAMES}.`);
    }
    if (audio !== undefined && audio !== null && typeof audio !== 'string') {
        throw new AnimationError('window.VIDEO.audio должен быть строкой - путём к звуковому файлу.');
    }

    const result = { width, height, fps, duration };
    if (typeof audio === 'string' && audio.trim().length > 0) {
        result.audio = audio.trim();
    }
    return result;
}

/** Вычисляет число кадров: frameCount = round(fps * duration). */
export function computeRenderPlan(videoConfig) {
    const { fps, duration } = videoConfig;
    const frameCount = Math.max(1, Math.round(fps * duration));
    return { ...videoConfig, frameCount };
}

/** Абсолютный путь к аудиофайлу из window.VIDEO.audio (относительно animation.html). */
export function resolveAudioPath(audio, htmlPath) {
    if (!audio) return null;
    const expanded = expandHome(audio);
    return isAbsolute(expanded) ? expanded : resolve(dirname(htmlPath), expanded);
}

/** Имя выходного файла: убирает опасные символы, добавляет .mp4. */
export function sanitizeOutputName(name) {
    const fallback = 'animation';
    let clean = (name || '').trim();
    if (clean.length === 0) clean = fallback;

    clean = clean.replace(/\.mp4$/i, '');
    clean = clean.replace(/[/\\?%*:|"<>]/g, '_');

    if (clean.length === 0) clean = fallback;
    return `${clean}.mp4`;
}

/** Добавляет суффикс перед расширением: video.mp4 + _draft -> video_draft.mp4 */
export function withSuffix(fileName, suffix) {
    const ext = extname(fileName);
    return `${basename(fileName, ext)}${suffix}${ext}`;
}

/**
 * Возвращает путь, который не перезапишет существующий файл:
 * video.mp4, video_2.mp4, video_3.mp4 ...
 */
export function uniqueOutputPath(dir, fileName) {
    const ext = extname(fileName);
    const base = basename(fileName, ext);
    let candidate = join(dir, fileName);
    let n = 2;
    while (existsSync(candidate)) {
        candidate = join(dir, `${base}_${n}${ext}`);
        n += 1;
    }
    return candidate;
}
