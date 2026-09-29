// job.js
// Сценарии верхнего уровня: "отрендерить файл" и "предпросмотр кадра".
// Один и тот же код обслуживает меню, командную строку и очередь: отличия
// только в объекте ui (задаёт ли он вопросы) и в переданных options.

import { existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';

import { validateAnimationPath, sanitizeOutputName } from './animation-loader.js';
import { preflightCheck, renderAnimation, previewFrame, resolveThreadCount } from './renderer.js';
import { AnimationError } from './errors.js';
import { formatAiReport, formatIssuesReport } from './report.js';
import { resolveOutputDir, acquireWakeLock, releaseWakeLock, notify, vibrate, mediaScan, copyToClipboard } from './termux.js';
import { freeDiskMB } from './system.js';
import { onCleanup } from './cleanup.js';

function reportFailure(ui, err, htmlPath, stage) {
    ui.error(err.message);
    // Готовый текст для нейросети имеет смысл только для проблем самого animation.html.
    if (err instanceof AnimationError) {
        const report = formatAiReport({ error: err, htmlPath, stage });
        ui.aiReport(report, copyToClipboard(report));
    }
}

/**
 * Полный рендер одного файла.
 * options: name, draft, format, blur, audio, threads, outputDir
 * (undefined = взять из настроек или спросить у пользователя в меню).
 * Возвращает { ok, result? , cancelled?, error? }.
 */
export async function runJob({ htmlPath, deps, config, options = {}, ui }) {
    let absolutePath;
    try {
        absolutePath = validateAnimationPath(htmlPath);
    } catch (err) {
        ui.error(err.message);
        return { ok: false, error: err };
    }

    ui.section('Проверка перед рендером...');

    let pre;
    try {
        pre = await preflightCheck(deps.chromium.path, absolutePath, (text, status) => ui.step(text, status));
    } catch (err) {
        reportFailure(ui, err, absolutePath, 'проверка перед рендером');
        return { ok: false, error: err };
    }

    const { browser, plan, fileUrl, warnings } = pre;
    let handedOff = false;

    try {
        if (warnings.length > 0) {
            ui.warnings(warnings);
            if (!(await ui.confirm('Продолжить рендер несмотря на предупреждения?'))) {
                const report = formatIssuesReport({ issues: warnings, htmlPath: absolutePath });
                ui.aiReport(report, copyToClipboard(report));
                return { ok: false, cancelled: true };
            }
        }

        const out = resolveOutputDir(options.outputDir ?? config.outputDir);
        if (out.warning) ui.warn(out.warning);

        const freeMB = freeDiskMB(out.dir);
        if (freeMB !== null && freeMB < 300) {
            ui.warn(`Мало свободного места в папке вывода: ${freeMB} МБ.`);
        }

        const blur = options.blur ?? config.motionBlur ?? 1;
        const format = options.format ?? config.frameFormat ?? 'png';
        const previewThreads = resolveThreadCount(options.threads ?? config.threads, plan.frameCount * blur, plan);

        ui.info([
            `Разрешение:   ${plan.width}x${plan.height}`,
            `FPS:          ${plan.fps}`,
            `Длительность: ${plan.duration} сек`,
            `Кадров:       ${plan.frameCount}${blur > 1 ? ` (×${blur} подкадров для motion blur)` : ''}`,
            `Потоков:      ${previewThreads}`,
            `Кадры:        ${format === 'jpeg' ? 'JPEG (быстрее, с малыми потерями)' : 'PNG (без потерь)'}`,
            ...(plan.audioPath ? [`Звук:         ${plan.audioPath}`] : [])
        ]);

        const rawName = options.name !== undefined ? options.name : await ui.askName('animation');
        const outputFileName = sanitizeOutputName(rawName);

        const draft = options.draft !== undefined ? options.draft : await ui.askMode();

        let audioPath = options.audio ?? plan.audioPath ?? null;
        if (!audioPath && options.audio === undefined) audioPath = await ui.askAudio();
        if (audioPath && !existsSync(audioPath)) {
            ui.error(`Аудиофайл не найден:\n${audioPath}`);
            return { ok: false, cancelled: true };
        }

        const locked = acquireWakeLock();
        const unregister = onCleanup(releaseWakeLock);
        if (locked) ui.message('Wake lock включён: Android не усыпит рендер.');

        ui.section('Рендер кадров:');
        ui.beginProgress();

        handedOff = true;
        try {
            const result = await renderAnimation({
                browser,
                fileUrl,
                plan,
                ffmpegPath: deps.ffmpeg.path,
                outputDir: out.dir,
                outputFileName,
                ffmpegPreset: config.ffmpegPreset,
                crf: config.crf,
                threads: options.threads ?? config.threads,
                format,
                draft,
                motionBlur: blur,
                audioPath,
                callbacks: ui
            });

            result.sizeBytes = statSync(result.outputPath).size;
            mediaScan(result.outputPath);
            if (config.notify !== false) {
                notify('Рендер готов', basename(result.outputPath));
                vibrate(250);
            }
            ui.done(result);
            return { ok: true, result };
        } catch (err) {
            reportFailure(ui, err, absolutePath, 'рендер кадров');
            return { ok: false, error: err };
        } finally {
            releaseWakeLock();
            unregister();
        }
    } finally {
        if (!handedOff) await browser.close();
    }
}

/** Предпросмотр одного кадра (PNG). */
export async function runPreview({ htmlPath, deps, config, options = {}, ui }) {
    let absolutePath;
    try {
        absolutePath = validateAnimationPath(htmlPath);
    } catch (err) {
        ui.error(err.message);
        return { ok: false, error: err };
    }

    ui.section('Предпросмотр кадра...');
    const out = resolveOutputDir(options.outputDir ?? config.outputDir);
    if (out.warning) ui.warn(out.warning);

    try {
        const base = basename(absolutePath, '.html');
        const result = await previewFrame({
            chromiumPath: deps.chromium.path,
            animationAbsolutePath: absolutePath,
            time: options.time,
            outputDir: out.dir,
            outputFileName: `preview_${base}.png`,
            onStep: (text, status) => ui.step(text, status)
        });

        mediaScan(result.outputPath);
        if (result.warnings.length > 0) ui.warnings(result.warnings);
        ui.info([
            `✓ Кадр для time = ${result.time} с сохранён:`,
            result.outputPath,
            `(${result.plan.width}x${result.plan.height}, откройте в галерее)`
        ]);
        return { ok: true, result };
    } catch (err) {
        reportFailure(ui, err, absolutePath, 'предпросмотр кадра');
        return { ok: false, error: err };
    }
}
