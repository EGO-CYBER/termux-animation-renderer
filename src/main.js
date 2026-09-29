#!/usr/bin/env node
// main.js
// Точка входа. Без аргументов открывает интерактивное меню на русском,
// с аргументами выполняет команду (anim render файл.html и т.д.).

import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { loadConfig, saveConfig } from './config.js';
import { checkAllDeps } from './deps.js';
import { createConsoleUI } from './ui.js';
import { runJob, runPreview } from './job.js';
import { runCli, printSelfTest, printCleanup } from './cli.js';
import { cleanStaleTempDirs, killOrphanChromium } from './cleanup.js';
import { autoThreadInfo } from './system.js';

function printHeader() {
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║        TERMUX ANIMATION RENDERER             ║');
    console.log('║        HTML / CANVAS / SVG / WEBGL           ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');
}

async function settingsMenu(ask) {
    for (;;) {
        const c = loadConfig();
        console.log('\n⚙ НАСТРОЙКИ\n');
        console.log(`1. Папка сохранения видео: ${c.outputDir}`);
        console.log(`2. FFmpeg preset:          ${c.ffmpegPreset}`);
        console.log(`3. CRF:                    ${c.crf}`);
        console.log(`4. Потоков рендера:        ${c.threads}  (auto = по ядрам и памяти)`);
        console.log(`5. Motion blur (подкадров): ${c.motionBlur}  (1 = выкл; больше = плавнее, но дольше)`);
        console.log(`6. Формат кадров:          ${c.frameFormat}  (png = без потерь, jpeg = быстрее)`);
        console.log(`7. Уведомление по готовности: ${c.notify ? 'да' : 'нет'}`);
        console.log('8. ← Назад\n');

        const choice = await ask('Что изменить: ');
        if (choice === '8') return;

        if (choice === '1') {
            const v = await ask(`Папка [${c.outputDir}]: `);
            if (v) c.outputDir = v;
        } else if (choice === '2') {
            const v = await ask('Preset (ultrafast/superfast/veryfast/faster/fast/medium/slow): ');
            if (['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow'].includes(v)) c.ffmpegPreset = v;
            else if (v) { console.log('✗ Неизвестный preset.'); continue; }
        } else if (choice === '3') {
            const n = Number(await ask('CRF 0-51 (меньше = лучше качество): '));
            if (Number.isFinite(n) && n >= 0 && n <= 51) c.crf = n;
            else { console.log('✗ CRF должен быть от 0 до 51.'); continue; }
        } else if (choice === '4') {
            const v = await ask('Потоков ("auto" или число 1-8): ');
            if (v === 'auto') c.threads = 'auto';
            else if (Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 8) c.threads = Number(v);
            else { console.log('✗ Нужно "auto" или число от 1 до 8.'); continue; }
        } else if (choice === '5') {
            const n = Number(await ask('Подкадров 1-16: '));
            if (Number.isInteger(n) && n >= 1 && n <= 16) c.motionBlur = n;
            else { console.log('✗ Нужно целое число от 1 до 16.'); continue; }
        } else if (choice === '6') {
            const v = await ask('Формат (png/jpeg): ');
            if (v === 'png' || v === 'jpeg') c.frameFormat = v;
            else { console.log('✗ Нужно png или jpeg.'); continue; }
        } else if (choice === '7') {
            c.notify = !c.notify;
        } else continue;

        saveConfig(c);
        console.log('✓ Сохранено.');
    }
}

async function interactive() {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    const ask = async (q) => (await rl.question(q)).trim().replace(/^["']|["']$/g, '');
    const ui = createConsoleUI({ interactive: true, ask });

    // Убираем остатки прошлых аварийных запусков.
    killOrphanChromium();
    cleanStaleTempDirs();

    try {
        for (;;) {
            printHeader();
            console.log('1. 🎬 Рендер анимации');
            console.log('2. 🖼 Предпросмотр кадра');
            console.log('3. ⚙ Настройки');
            console.log('4. 🔧 Диагностика');
            console.log('5. 🧹 Очистка временных файлов');
            console.log('6. 🚪 Выход\n');

            const choice = await ask('Выберите пункт меню: ');
            const config = loadConfig();

            if (choice === '1' || choice === '2') {
                const deps = checkAllDeps();
                if (!deps.chromium.available) { ui.error('Chromium не найден.\nУстановите: pkg install chromium'); continue; }
                if (!deps.ffmpeg.available) { ui.error('FFmpeg не найден.\nУстановите: pkg install ffmpeg'); continue; }

                const file = await ask('Путь к animation.html: ');
                if (choice === '1') {
                    await runJob({ htmlPath: file, deps, config, ui });
                } else {
                    const t = await ask('Момент времени в секундах (Enter - середина): ');
                    await runPreview({ htmlPath: file, deps, config, ui, options: { time: t === '' ? undefined : Number(t) } });
                }
            } else if (choice === '3') {
                await settingsMenu(ask);
            } else if (choice === '4') {
                await printSelfTest(config);
                const info = autoThreadInfo({ width: 1920, height: 1080 });
                console.log(`Подсказка: для 1080p подходит потоков: ${info.threads} (по ядрам ${info.byCpu}, по памяти ${info.byMem === Infinity ? '—' : info.byMem}).`);
                await ask('Нажмите Enter, чтобы вернуться в меню...');
            } else if (choice === '5') {
                printCleanup();
            } else if (choice === '6') {
                break;
            } else {
                console.log('Неизвестный пункт меню.');
            }
        }
    } finally {
        rl.close();
    }
    console.log('До встречи!');
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        await interactive();
        return 0;
    }
    return runCli(args);
}

main().then(
    (code) => process.exit(code || 0),
    (err) => { console.error('\n✗ Непредвиденная ошибка:', err.message); process.exit(1); }
);
