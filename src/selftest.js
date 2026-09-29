// selftest.js
// Настоящая диагностика: не просто "нашли файл", а реальный запуск всей
// цепочки Chromium -> CDP -> скриншот -> FFmpeg -> MP4 на крошечной
// тестовой анимации. Если самопроверка прошла, рендер ваших роликов
// будет работать так же.

import { mkdtempSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { CDPBrowser } from './cdp.js';
import { preflightCheck, renderAnimation } from './renderer.js';
import { getNodeInfo, getChromiumInfo, getFfmpegInfo } from './deps.js';
import { availableMemoryMB, cpuCount, freeDiskMB, autoThreadInfo } from './system.js';
import { hasCommand, isTermux, storageReady, resolveOutputDir } from './termux.js';
import { formatBytes } from './ui.js';

const TEST_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;background:#000">
<canvas id="c" width="320" height="180"></canvas>
<script>
window.VIDEO = { width: 320, height: 180, fps: 10, duration: 1 };
const ctx = document.getElementById('c').getContext('2d');
window.renderFrame = function (time) {
    ctx.fillStyle = '#102040';
    ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = '#ffd23f';
    ctx.beginPath();
    ctx.arc(40 + 240 * time, 90, 20, 0, Math.PI * 2);
    ctx.fill();
};
</script></body></html>`;

/**
 * Запускает самопроверку. report(status, text): status = 'ok' | 'warn' | 'fail' | 'info'.
 * Возвращает { ok, failures, warnings }.
 */
export async function runSelfTest({ config, report }) {
    let failures = 0;
    let warnings = 0;
    const say = (status, text) => {
        if (status === 'fail') failures += 1;
        if (status === 'warn') warnings += 1;
        report(status, text);
    };

    // 1. Окружение
    const node = getNodeInfo();
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    say(nodeMajor >= 18 ? 'ok' : 'fail', `Node.js ${node.version}${nodeMajor >= 18 ? '' : ' (нужна версия 18 или новее)'}`);

    const chromium = getChromiumInfo();
    const ffmpeg = getFfmpegInfo();
    if (!chromium.available) {
        say('fail', 'Chromium не найден. Установите: pkg install chromium');
    } else {
        say('ok', `Chromium: ${chromium.path}${chromium.version ? ` (${chromium.version})` : ''}`);
    }
    if (!ffmpeg.available) {
        say('fail', 'FFmpeg не найден. Установите: pkg install ffmpeg');
    } else {
        say('ok', `FFmpeg: ${ffmpeg.path}`);
        const encoders = spawnSync(ffmpeg.path, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10000 });
        if (encoders.status === 0 && /libx264/.test(String(encoders.stdout))) {
            say('ok', 'FFmpeg умеет H.264 (libx264)');
        } else {
            say('fail', 'В этом FFmpeg нет кодека libx264. Переустановите: pkg reinstall ffmpeg');
        }
    }
    if (failures > 0) return { ok: false, failures, warnings };

    // 2. Chromium + CDP: реальный запуск, JS, скриншот, WebGL
    const browser = new CDPBrowser();
    try {
        await browser.launch(chromium.path);
        say('ok', 'Chromium запускается');

        const page = await browser.newPage();
        say('ok', 'CDP: подключение к вкладке работает');

        await page.navigate('data:text/html,<html><body style="margin:0;background:%23336699"></body></html>');
        const sum = await page.evaluate('1 + 1');
        say(sum === 2 ? 'ok' : 'fail', 'CDP: выполнение JavaScript');

        await page.setViewport(64, 48);
        const png = await page.captureScreenshot({ format: 'png' });
        const isPng = png.length > 8 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47;
        say(isPng ? 'ok' : 'fail', `CDP: скриншот PNG (${png.length} байт)`);

        const webgl = await page.evaluate(
            "(() => { try { return !!document.createElement('canvas').getContext('webgl'); } catch (e) { return false; } })()"
        );
        say(webgl ? 'ok' : 'warn', webgl ? 'WebGL доступен (SwiftShader)' : 'WebGL недоступен: 3D-анимации на WebGL не будут работать');
    } catch (err) {
        say('fail', `Chromium/CDP не работает:\n${err.message}`);
        await browser.close();
        return { ok: false, failures, warnings };
    }
    await browser.close();

    // 3. Полный мини-рендер: Chromium -> кадры -> FFmpeg -> MP4
    const tmp = mkdtempSync(join(tmpdir(), 'tr-selftest-'));
    try {
        const htmlPath = join(tmp, 'selftest.html');
        writeFileSync(htmlPath, TEST_HTML, 'utf8');

        const started = Date.now();
        const pre = await preflightCheck(chromium.path, htmlPath, null);
        const result = await renderAnimation({
            browser: pre.browser,
            fileUrl: pre.fileUrl,
            plan: pre.plan,
            ffmpegPath: ffmpeg.path,
            outputDir: tmp,
            outputFileName: 'selftest.mp4',
            ffmpegPreset: 'ultrafast',
            crf: 28,
            threads: 2
        });
        const size = existsSync(result.outputPath) ? statSync(result.outputPath).size : 0;
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        say(size > 0 ? 'ok' : 'fail', `Мини-рендер 320x180, 10 кадров -> MP4 (${formatBytes(size)}, ${seconds} с)`);
    } catch (err) {
        say('fail', `Мини-рендер не удался:\n${err.message}`);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }

    // 4. Ресурсы устройства и хранилище
    const info = autoThreadInfo({ width: 1920, height: 1080 });
    say('info', `Ядер CPU: ${cpuCount()}, свободно ОЗУ: ${availableMemoryMB()} МБ, потоков в режиме auto (1080p): ${info.threads}`);

    const out = resolveOutputDir(config.outputDir);
    if (out.warning) say('warn', out.warning);
    else say('ok', `Папка вывода: ${out.dir}`);

    const free = freeDiskMB(out.dir);
    if (free !== null) say(free < 500 ? 'warn' : 'info', `Свободно на диске: ${free} МБ`);

    if (isTermux()) {
        say(storageReady() ? 'ok' : 'warn', storageReady() ? 'Общее хранилище подключено' : 'Общее хранилище не подключено: termux-setup-storage');
        say(
            hasCommand('termux-wake-lock') ? 'ok' : 'warn',
            hasCommand('termux-wake-lock') ? 'Wake lock доступен (рендер не будет усыплён)' : 'Wake lock недоступен: долгий рендер может быть остановлен системой'
        );
        say(
            hasCommand('termux-notification') ? 'ok' : 'info',
            hasCommand('termux-notification')
                ? 'termux-api установлен: будут уведомления и вибрация'
                : 'termux-api не установлен (необязательно): pkg install termux-api и приложение Termux:API'
        );
    }

    return { ok: failures === 0, failures, warnings };
}
