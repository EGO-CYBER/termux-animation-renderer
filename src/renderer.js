// renderer.js
// Оркестрация рендера: проверка animation.html (preflight), параллельный
// захват кадров в нескольких вкладках Chromium и передача кадров ПРЯМО в
// stdin FFmpeg (image2pipe). PNG на диск не пишутся: не расходуется
// память накопителя и нет "хвостов" после прерывания.
//
// Кадры готовятся вразнобой (разные вкладки), поэтому перед отправкой в
// FFmpeg они выстраиваются по порядку. Окно опережения ограничено
// (maxAhead), чтобы буфер в памяти не рос.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { CDPBrowser } from './cdp.js';
import {
    validateVideoConfig,
    computeRenderPlan,
    expandHome,
    resolveAudioPath,
    uniqueOutputPath,
    withSuffix
} from './animation-loader.js';
import { AnimationError, PageError } from './errors.js';
import { staticLint } from './lint.js';
import { onCleanup } from './cleanup.js';
import { autoThreadInfo } from './system.js';
import { debugLog } from './debug.js';

/**
 * Число параллельных вкладок:
 *  - "auto": по ядрам CPU и свободной памяти (если известно разрешение);
 *  - число: как задано, но не больше числа кадров и не меньше 1.
 */
export function resolveThreadCount(configuredThreads, frameCount, dims = {}) {
    let threads;
    // "auto" (и пустое значение) — подобрать по ядрам и памяти.
    // Всё остальное считаем числом: опечатка вроде 0 даёт 1 вкладку, а не авто.
    if (configuredThreads === 'auto' || configuredThreads == null) {
        threads = autoThreadInfo({ width: dims.width, height: dims.height, frameCount }).threads;
    } else {
        threads = Number(configuredThreads);
        if (!Number.isFinite(threads) || threads < 1) threads = 1;
    }
    return Math.max(1, Math.min(Math.floor(threads), frameCount));
}

const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Проверка детерминизма: один и тот же кадр должен получаться одинаковым
 * и после отрисовки другого момента времени. Возвращает предупреждение
 * или null. Ошибки JS внутри renderFrame пробрасываются как PageError.
 */
async function checkDeterminism(page, { duration }) {
    const t1 = round3(duration * 0.37);
    const t2 = round3(duration * 0.83);

    await page.renderFrame(t1);
    const first = await page.captureScreenshot({ format: 'png' });
    await page.renderFrame(t2);
    await page.captureScreenshot({ format: 'png' });
    await page.renderFrame(t1);
    const again = await page.captureScreenshot({ format: 'png' });

    if (!first.equals(again)) {
        return {
            level: 'warn',
            code: 'nondeterministic',
            line: null,
            message:
                `renderFrame(${t1}) даёт разный кадр при повторном вызове: результат зависит от порядка ` +
                'вызовов или от реального времени. При параллельном рендере видео будет дёргаться. ' +
                'Частые причины: накопление состояния (x += ...), Math.random, CSS-анимации, таймеры.'
        };
    }
    return null;
}

/**
 * Preflight: статический анализ файла, запуск Chromium, проверка
 * window.VIDEO / window.renderFrame, пробный кадр и проверка детерминизма.
 * Возвращает { browser, plan, fileUrl, warnings }. Браузер остаётся
 * запущенным (его закроет renderAnimation). При ошибке закрывается сам.
 *
 * onStep(text, status): status = true (успех), false (ошибка) или 'warn'.
 */
export async function preflightCheck(chromiumPath, animationAbsolutePath, onStep) {
    const step = (text, status = true) => {
        if (onStep) onStep(text, status);
    };

    const html = readFileSync(animationAbsolutePath, 'utf8');
    step('animation.html существует', true);

    const warnings = [...staticLint(html)];
    const browser = new CDPBrowser();

    try {
        await browser.launch(chromiumPath);
        step('Chromium доступен', true);

        const page = await browser.newPage();
        const fileUrl = pathToFileURL(animationAbsolutePath).href;
        await page.navigate(fileUrl);

        const rawVideo = await page.evaluate('window.VIDEO || null');
        if (!rawVideo) {
            // Причина часто в ошибке скрипта (например, синтаксической).
            if (page.errors.length > 0) throw page.errors[0];
            throw new AnimationError(
                'В animation.html отсутствует:\nwindow.VIDEO\n\n' +
                'Добавьте в начало файла:\n' +
                'window.VIDEO = { width: 1920, height: 1080, fps: 30, duration: 15 };'
            );
        }

        const videoConfig = validateVideoConfig(rawVideo);
        step(`width корректный (${videoConfig.width})`, true);
        step(`height корректный (${videoConfig.height})`, true);
        step(`fps корректный (${videoConfig.fps})`, true);
        step(`duration корректный (${videoConfig.duration})`, true);

        const hasRenderFrame = await page.evaluate("typeof window.renderFrame === 'function'");
        if (!hasRenderFrame) {
            if (page.errors.length > 0) throw page.errors[0];
            throw new AnimationError(
                'В animation.html отсутствует:\nwindow.renderFrame\n\n' +
                'Добавьте функцию:\n' +
                'window.renderFrame = function(time) { /* отрисовка кадра */ };'
            );
        }
        step('renderFrame найден', true);

        await page.setViewport(videoConfig.width, videoConfig.height);
        await page.renderFrame(0);
        step('тестовый кадр отрисован', true);

        const determinism = await checkDeterminism(page, videoConfig);
        if (determinism) {
            warnings.push(determinism);
            step('проверка детерминизма: кадры отличаются', 'warn');
        } else {
            step('кадры детерминированы', true);
        }

        // Ошибки, о которых страница сообщила, но которые не остановили рендер.
        for (const err of page.errors.slice(0, 3)) {
            warnings.push({ level: 'warn', code: 'page-error', line: err.line, message: `Ошибка на странице: ${err.message}` });
        }
        for (const text of page.logErrors.slice(0, 3)) {
            warnings.push({ level: 'warn', code: 'console-error', line: null, message: `Сообщение об ошибке в консоли страницы: ${text}` });
        }

        const plan = computeRenderPlan(videoConfig);
        plan.audioPath = resolveAudioPath(videoConfig.audio, animationAbsolutePath);
        if (plan.audioPath && !existsSync(plan.audioPath)) {
            warnings.push({
                level: 'warn',
                code: 'audio-missing',
                line: null,
                message: `Аудиофайл из window.VIDEO.audio не найден: ${plan.audioPath}. Видео будет без звука.`
            });
            plan.audioPath = null;
        }

        await browser.closePage(page);
        return { browser, plan, fileUrl, warnings };
    } catch (err) {
        await browser.close();
        throw err;
    }
}

/**
 * Момент времени для "юнита" номер i. Без motion blur это i / fps.
 * С motion blur каждый кадр видео собирается из `blur` подкадров,
 * равномерно распределённых вокруг его момента времени.
 */
export function unitTime(i, fps, blur = 1) {
    if (blur <= 1) return i / fps;
    const frame = Math.floor(i / blur);
    const sub = i % blur;
    return Math.max(0, (frame + (sub + 0.5) / blur - 0.5) / fps);
}

/**
 * Параллельный конвейер: `workers` исполнителей берут кадры по очереди,
 * а результат уходит в sink СТРОГО по порядку номеров. maxAhead ограничивает,
 * насколько далеко исполнители могут уйти вперёд от последнего записанного
 * кадра (ограничение памяти + естественное противодавление от FFmpeg).
 *
 * Защита от "хвоста" (зависание на 97-98%): когда очередь кадров закончилась,
 * свободные исполнители дублируют кадры, которые отстающая вкладка
 * рендерит слишком долго (дольше stragglerMs()). Побеждает тот, кто
 * закончит первым, поэтому одна зависшая вкладка больше не задерживает финиш.
 *
 * limit: { value } - текущее допустимое число исполнителей; его можно
 * уменьшать на лету (исполнители с индексом >= value завершаются).
 */
export async function runFramePipeline({
    total, workers, renderFrame, sink, maxAhead, onFrame,
    stragglerMs = () => Infinity, limit = null, onWorkerExit = null, now = Date.now
}) {
    const maxWindow = Math.max(1, maxAhead ?? workers * 3 + 2);
    const active = limit || { value: workers };

    let nextToAssign = 0;
    let nextToWrite = 0;
    let failure = null;
    let finished = false;
    const ready = new Map();
    const inflight = new Map(); // номер кадра -> { start, dup, origFailed }
    let waiters = [];

    let resolveDone;
    const donePromise = new Promise((resolve) => { resolveDone = resolve; });

    const wake = () => {
        const list = waiters;
        waiters = [];
        for (const resolve of list) resolve();
    };
    const fail = (err) => {
        if (finished) return;
        if (!failure) failure = err;
        wake();
        resolveDone();
    };
    const idleWait = (ms) => new Promise((resolve) => {
        const done = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(done, ms);
        waiters.push(done);
    });

    const drain = async () => {
        while (!failure && ready.has(nextToWrite)) {
            const buffer = ready.get(nextToWrite);
            await sink(buffer);
            ready.delete(nextToWrite);
            nextToWrite += 1;
            if (onFrame) onFrame(nextToWrite);
            if (nextToWrite >= total) {
                finished = true;
                resolveDone();
            }
            wake();
        }
    };

    let flushChain = Promise.resolve();
    const scheduleDrain = () => {
        flushChain = flushChain.then(drain).catch(fail);
    };

    const pickStraggler = () => {
        const limitMs = stragglerMs();
        if (!Number.isFinite(limitMs)) return null;
        const t = now();
        let best = null;
        for (const [i, entry] of inflight) {
            if (entry.dup || entry.start === null || ready.has(i) || i < nextToWrite) continue;
            if (t - entry.start >= limitMs && (best === null || i < best)) best = i;
        }
        return best;
    };

    const worker = async (w) => {
        while (!failure && !finished) {
            if (w >= active.value) {
                if (onWorkerExit) onWorkerExit(w);
                return;
            }

            let i;
            let duplicate = false;
            if (nextToAssign < total) {
                i = nextToAssign;
                nextToAssign += 1;
                inflight.set(i, { start: null, dup: false, origFailed: false });
                while (!failure && !finished && i - nextToWrite >= maxWindow) {
                    await new Promise((resolve) => waiters.push(resolve));
                }
                if (failure || finished) return;
                inflight.get(i).start = now();
            } else {
                const candidate = pickStraggler();
                if (candidate === null) {
                    await idleWait(300);
                    continue;
                }
                i = candidate;
                duplicate = true;
                inflight.get(i).dup = true;
            }

            let buffer;
            try {
                buffer = await renderFrame(w, i);
            } catch (err) {
                if (finished || failure) return;
                if (i < nextToWrite || ready.has(i)) continue; // кадр уже доставлен другим исполнителем
                const entry = inflight.get(i);
                if (duplicate) {
                    if (entry?.origFailed) fail(err);
                    continue; // оригинал ещё в работе
                }
                if (entry?.dup) {
                    entry.origFailed = true; // ждём результата дубликата
                    continue;
                }
                fail(err);
                return;
            }

            if (finished || failure) return;
            if (i < nextToWrite || ready.has(i)) continue; // соперник успел раньше
            inflight.delete(i);
            ready.set(i, buffer);
            scheduleDrain();
        }
    };

    const count = Math.max(1, Math.min(workers, total));
    for (let w = 0; w < count; w++) {
        // Не ждём исполнителей: зависший не должен задерживать завершение.
        worker(w).catch(fail);
    }

    await donePromise;
    if (failure) throw failure;
}

const FRAME_MIN_TIMEOUT_MS = 20000;
const DEFAULT_RECYCLE_EVERY = 120;

function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Кадр не отрисован за ${Math.round(ms / 1000)} с.`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Создаёт функцию рендера одного кадра с защитой от зависаний:
 *  - вкладка обновляется каждые recycleEvery кадров (не копится память);
 *  - если кадр не готов за таймаут, вкладка пересоздаётся, кадр повторяется;
 *  - после каждых двух таких сбоев число потоков снижается на 1.
 * Ошибки JS в renderFrame не повторяются: они детерминированы.
 */
function createUnitRenderer({ browser, fileUrl, plan, scale, shotOptions, pageRefs, recycleEvery, stats, limit, notice }) {
    const timeoutMs = () => Math.max(FRAME_MIN_TIMEOUT_MS, (stats.ema ?? 0) * 12);

    const openPage = async () => {
        const page = await browser.newPage();
        await page.navigate(fileUrl);
        await page.setViewport(plan.width, plan.height, scale);
        return page;
    };

    const attempt = (page, time) =>
        withTimeout(
            (async () => {
                await page.renderFrame(time);
                return page.captureScreenshot(shotOptions);
            })(),
            timeoutMs()
        );

    return async (worker, time) => {
        const ref = pageRefs[worker];

        if (recycleEvery > 0 && ref.frames >= recycleEvery) {
            debugLog(`вкладка ${worker + 1}: плановое обновление после ${ref.frames} кадров`);
            const old = ref.page;
            ref.page = await openPage();
            ref.frames = 0;
            try { await browser.closePage(old); } catch { /* уже закрыта */ }
        }

        const started = Date.now();
        try {
            const buffer = await attempt(ref.page, time);
            ref.frames += 1;
            const took = Date.now() - started;
            stats.ema = stats.ema === null ? took : stats.ema * 0.8 + took * 0.2;
            if (took > 5000) debugLog(`медленный кадр: вкладка ${worker + 1}, time=${time.toFixed(3)}, ${took} мс`);
            return buffer;
        } catch (err) {
            if (err instanceof PageError) {
                err.frameTime = time;
                throw err;
            }

            stats.trips += 1;
            const reason = String(err.message).split('\n')[0];
            notice(`Вкладка ${worker + 1} не ответила (time = ${time.toFixed(2)} с): ${reason} Перезапускаю её.`);
            debugLog(`сбой вкладки ${worker + 1}, time=${time.toFixed(3)}: ${reason}; свободно ОЗУ: ${autoThreadInfo({}).availMB} МБ`);

            if (stats.trips % 2 === 0 && limit.value > 1) {
                limit.value -= 1;
                notice(`Снижаю число потоков до ${limit.value}, чтобы разгрузить память.`);
            }

            try { await browser.closePage(ref.page); } catch { /* уже недоступна */ }

            try {
                ref.page = await openPage();
                ref.frames = 0;
                return await attempt(ref.page, time);
            } catch (retryErr) {
                if (retryErr instanceof PageError) retryErr.frameTime = time;
                throw new Error(
                    `Не удалось отрисовать кадр (time = ${time.toFixed(3)} с) даже после перезапуска вкладки.\n` +
                    `Причина: ${retryErr.message}\n\nПервая ошибка была:\n${err.message}`
                );
            }
        }
    };
}

/**
 * Аргументы FFmpeg для приёма кадров из stdin.
 * blur > 1: кадры приходят с частотой fps*blur, усредняются по blur штук
 * (tmix), затем оставляется каждый blur-й. crop делает размер чётным
 * (требование yuv420p).
 */
export function buildFfmpegArgs({ fps, blur = 1, format = 'png', preset, crf, outputPath, audioPath = null }) {
    const args = [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'image2pipe',
        '-framerate', String(fps * blur),
        '-c:v', format === 'jpeg' ? 'mjpeg' : 'png',
        '-i', 'pipe:0'
    ];
    if (audioPath) args.push('-i', audioPath);

    const filters = [];
    if (blur > 1) {
        filters.push(`tmix=frames=${blur}`, `select='not(mod(n+1,${blur}))'`, 'setpts=PTS-STARTPTS');
    }
    filters.push('crop=trunc(iw/2)*2:trunc(ih/2)*2');
    args.push('-vf', filters.join(','));

    if (audioPath) {
        args.push('-map', '0:v:0', '-map', '1:a:0', '-af', 'apad', '-c:a', 'aac', '-b:a', '192k', '-shortest');
    }

    args.push(
        '-r', String(fps),
        '-c:v', 'libx264',
        '-preset', preset,
        '-crf', String(crf),
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        outputPath
    );
    return args;
}

/** Проверяет, что FFmpeg может прочитать звуковой файл. Бросает Error при проблеме. */
export function probeAudio(ffmpegPath, audioPath) {
    if (!existsSync(audioPath)) {
        throw new Error(`Аудиофайл не найден:\n${audioPath}`);
    }
    const result = spawnSync(
        ffmpegPath,
        ['-v', 'error', '-i', audioPath, '-t', '0.2', '-vn', '-f', 'null', '-'],
        { encoding: 'utf8', timeout: 15000 }
    );
    if (result.status !== 0) {
        throw new Error(`FFmpeg не смог прочитать аудиофайл:\n${audioPath}\n${String(result.stderr).slice(-400)}`);
    }
}

/**
 * Запускает FFmpeg с приёмом кадров через stdin.
 * write(buffer) ждёт, пока кадр принят (естественное противодавление).
 */
function startFfmpeg(ffmpegPath, args, outputPath) {
    const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
        if (stderr.length > 6000) stderr = stderr.slice(-6000);
    });

    let exitInfo = null;
    let resolveClosed;
    const closed = new Promise((resolve) => { resolveClosed = resolve; });
    const settle = (info) => {
        if (!exitInfo) exitInfo = info;
        resolveClosed(exitInfo);
    };

    proc.on('close', (code, signal) => settle({ code, signal }));
    proc.on('error', (err) => settle({ code: -1, signal: null, error: err }));
    proc.stdin.on('error', () => { /* причина придёт через write() / finish() */ });

    const describeFailure = (extra) =>
        (exitInfo?.error ? `Не удалось запустить FFmpeg: ${exitInfo.error.message}\n` : '') +
        `FFmpeg остановился${exitInfo ? ` (код ${exitInfo.code})` : ''}:\n${stderr.slice(-1500)}` +
        (extra ? `\n${extra}` : '');

    const write = (buffer) => new Promise((resolve, reject) => {
        if (exitInfo) {
            reject(new Error(describeFailure()));
            return;
        }
        proc.stdin.write(buffer, (err) => {
            if (err) reject(new Error(describeFailure(err.message)));
            else resolve();
        });
    });

    const finish = async () => {
        proc.stdin.end();
        const info = await closed;
        if (info.code !== 0) {
            throw new Error(`FFmpeg завершился с ошибкой (код ${info.code}):\n${stderr.slice(-1500)}`);
        }
    };

    const kill = () => {
        try { proc.kill('SIGKILL'); } catch { /* уже завершён */ }
    };

    return { write, finish, kill, outputPath };
}

/**
 * Полный рендер по уже открытому браузеру (из preflightCheck): открывает
 * вкладки, гонит кадры через конвейер в FFmpeg, закрывает браузер.
 *
 * options:
 *   browser, fileUrl, plan            - результат preflightCheck
 *   ffmpegPath, outputDir, outputFileName
 *   ffmpegPreset, crf                 - параметры кодирования
 *   threads                           - "auto" или число вкладок
 *   format                            - 'png' (без потерь) | 'jpeg' (быстрее)
 *   jpegQuality                       - 1..100 для jpeg
 *   draft                             - черновик: половина разрешения, быстро
 *   motionBlur                        - подкадров на кадр (1 = выключено)
 *   audioPath                         - звуковая дорожка или null
 *   recycleEvery                      - обновлять вкладку каждые N кадров (0 = не обновлять)
 *   callbacks                         - onThreadsResolved, onFrameProgress, onEncodeStart, onNotice
 */
export async function renderAnimation(options) {
    const {
        browser, fileUrl, plan, ffmpegPath, outputDir, outputFileName,
        ffmpegPreset = 'veryfast', crf = 18, threads = 'auto',
        format = 'png', jpegQuality = 92, draft = false,
        motionBlur = 1, audioPath = null, recycleEvery = DEFAULT_RECYCLE_EVERY, callbacks = {}
    } = options;

    const blur = Math.max(1, Math.min(16, Math.floor(Number(motionBlur)) || 1));
    const scale = draft ? 0.5 : 1;
    const effectiveFormat = draft || format === 'jpeg' ? 'jpeg' : 'png';
    const preset = draft ? 'ultrafast' : ffmpegPreset;
    const effectiveCrf = draft ? 28 : crf;
    const totalUnits = plan.frameCount * blur;

    let ffmpeg = null;
    let unregister = null;

    try {
        if (audioPath) probeAudio(ffmpegPath, audioPath);

        const resolvedThreads = resolveThreadCount(threads, totalUnits, { width: plan.width, height: plan.height });
        if (callbacks.onThreadsResolved) callbacks.onThreadsResolved(resolvedThreads);

        const dir = expandHome(outputDir);
        mkdirSync(dir, { recursive: true });
        const outputPath = uniqueOutputPath(dir, draft ? withSuffix(outputFileName, '_draft') : outputFileName);

        const pageRefs = [];
        for (let t = 0; t < resolvedThreads; t++) {
            const page = await browser.newPage();
            await page.navigate(fileUrl);
            await page.setViewport(plan.width, plan.height, scale);
            pageRefs.push({ page, frames: 0 });
        }

        ffmpeg = startFfmpeg(
            ffmpegPath,
            buildFfmpegArgs({ fps: plan.fps, blur, format: effectiveFormat, preset, crf: effectiveCrf, outputPath, audioPath }),
            outputPath
        );
        unregister = onCleanup(() => {
            ffmpeg.kill();
            try { rmSync(outputPath, { force: true }); } catch { /* нечего удалять */ }
        });

        const shotOptions = { format: effectiveFormat, quality: jpegQuality };
        const stats = { ema: null, trips: 0 };
        const limit = { value: resolvedThreads };
        const notice = (text) => {
            if (callbacks.onNotice) callbacks.onNotice(text);
        };
        const renderOne = createUnitRenderer({
            browser, fileUrl, plan, scale, shotOptions, pageRefs, recycleEvery, stats, limit, notice
        });

        debugLog(`старт: ${plan.width}x${plan.height}, ${plan.frameCount} кадров, blur ${blur}, потоков ${resolvedThreads}, формат ${effectiveFormat}`);
        const started = Date.now();
        let lastReported = 0;

        await runFramePipeline({
            total: totalUnits,
            workers: resolvedThreads,
            limit,
            renderFrame: (worker, i) => renderOne(worker, unitTime(i, plan.fps, blur)),
            sink: ffmpeg.write,
            stragglerMs: () => (stats.ema === null ? Infinity : Math.max(4000, stats.ema * 4)),
            onWorkerExit: (worker) => {
                browser.closePage(pageRefs[worker].page).catch(() => {});
            },
            onFrame: (written) => {
                const done = Math.floor(written / blur);
                if (done !== lastReported) {
                    lastReported = done;
                    if (callbacks.onFrameProgress) callbacks.onFrameProgress(done, plan.frameCount);
                }
            }
        });

        const elapsedMs = Date.now() - started;

        // Браузер больше не нужен: освобождаем память, пока FFmpeg дописывает файл.
        await browser.close();
        if (callbacks.onEncodeStart) callbacks.onEncodeStart();
        await ffmpeg.finish();
        unregister();
        unregister = null;

        return {
            outputPath,
            frameCount: plan.frameCount,
            width: plan.width,
            height: plan.height,
            threads: resolvedThreads,
            motionBlur: blur,
            draft,
            renderElapsedMs: elapsedMs,
            framesPerSecond: elapsedMs > 0 ? plan.frameCount / (elapsedMs / 1000) : plan.frameCount
        };
    } catch (err) {
        if (ffmpeg) ffmpeg.kill();
        if (ffmpeg?.outputPath) {
            try { rmSync(ffmpeg.outputPath, { force: true }); } catch { /* нечего удалять */ }
        }
        if (unregister) unregister();
        throw err;
    } finally {
        await browser.close();
    }
}

/**
 * Предпросмотр: один кадр по указанному времени в PNG. Быстрый способ
 * проверить композицию, не запуская полный рендер.
 */
export async function previewFrame({ chromiumPath, animationAbsolutePath, time, outputDir, outputFileName, onStep }) {
    const { browser, plan, fileUrl, warnings } = await preflightCheck(chromiumPath, animationAbsolutePath, onStep);

    try {
        const t = round3(Math.min(Math.max(time ?? plan.duration / 2, 0), plan.duration));
        const page = await browser.newPage();
        await page.navigate(fileUrl);
        await page.setViewport(plan.width, plan.height);
        await page.renderFrame(t);
        const png = await page.captureScreenshot({ format: 'png' });

        const dir = expandHome(outputDir);
        mkdirSync(dir, { recursive: true });
        const outputPath = uniqueOutputPath(dir, outputFileName);
        writeFileSync(outputPath, png);

        return { outputPath, time: t, plan, warnings };
    } finally {
        await browser.close();
    }
}
