// cli.js
// Запуск одной командой, без меню:
//   anim render файл.html -o имя [--draft] [--fast] [--blur N] [--audio файл] [--threads N|auto] [--dir папка]
//   anim preview файл.html [--time СЕК]
//   anim queue файл1.html файл2.html ...
//   anim selftest | clean | update | help | version

import { basename, dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { checkAllDeps } from './deps.js';
import { loadConfig, PROJECT_ROOT } from './config.js';
import { createConsoleUI } from './ui.js';
import { runJob, runPreview } from './job.js';
import { runSelfTest } from './selftest.js';
import { cleanStaleTempDirs, findOrphanChromium, killOrphanChromium } from './cleanup.js';
import { formatBytes } from './ui.js';
import { validateAnimationPath } from './animation-loader.js';

const VALUE_FLAGS = new Set(['o', 'output', 'dir', 'out', 't', 'time', 'blur', 'audio', 'threads', 'format']);
const COMMANDS = new Set(['render', 'preview', 'queue', 'selftest', 'doctor', 'clean', 'update', 'help', 'version']);

export const HELP_TEXT = `Termux Animation Renderer

Использование:
  anim                                  открыть меню
  anim render файл.html [параметры]     отрендерить видео
  anim preview файл.html [--time СЕК]   сохранить один кадр в PNG
  anim queue файл1.html файл2.html ...  отрендерить несколько файлов подряд
  anim selftest                         проверить всю цепочку (Chromium, CDP, FFmpeg)
  anim clean                            удалить временные файлы и зависшие процессы
  anim update                           обновить программу (git pull)

Параметры render/queue:
  -o, --output ИМЯ     имя видео (по умолчанию - имя html-файла)
  --dir ПАПКА          папка сохранения (иначе из настроек)
  --draft              черновик: половина разрешения, быстро
  --fast               кадры в JPEG (быстрее, малые потери качества)
  --blur N             motion blur: N подкадров на кадр (1-16)
  --audio ФАЙЛ         звуковая дорожка (mp3, m4a, wav ...)
  --threads N|auto     число параллельных вкладок Chromium

Параметры preview:
  -t, --time СЕК       момент времени (по умолчанию - середина ролика)
`;

/** Разбор аргументов: { command, positional, flags }. */
export function parseArgs(argv) {
    const args = [...argv];
    let command = null;

    if (args.length > 0 && !args[0].startsWith('-')) {
        if (COMMANDS.has(args[0])) {
            command = args.shift();
        } else if (args[0].toLowerCase().endsWith('.html')) {
            command = 'render'; // сокращение: anim файл.html
        } else {
            command = args.shift(); // неизвестная команда - сообщим об этом позже
        }
    }

    const positional = [];
    const flags = {};
    for (let i = 0; i < args.length; i++) {
        const token = args[i];
        if (token.startsWith('--') || (token.startsWith('-') && token.length === 2)) {
            const key = token.replace(/^-+/, '');
            const eq = key.indexOf('=');
            if (eq !== -1) {
                flags[key.slice(0, eq)] = key.slice(eq + 1);
            } else if (VALUE_FLAGS.has(key)) {
                flags[key] = args[i + 1];
                i += 1;
            } else {
                flags[key] = true;
            }
        } else {
            positional.push(token);
        }
    }
    return { command, positional, flags };
}

function jobOptions(flags, htmlPath, forceName = null) {
    const name = forceName ?? flags.o ?? flags.output ?? basename(htmlPath).replace(/\.html$/i, '');
    const options = { name };
    if (flags.draft) options.draft = true; else options.draft = false;
    if (flags.fast || flags.format === 'jpeg') options.format = 'jpeg';
    if (flags.blur !== undefined) options.blur = Math.max(1, Math.min(16, parseInt(flags.blur, 10) || 1));
    if (flags.audio) options.audio = flags.audio;
    if (flags.threads !== undefined) options.threads = flags.threads === 'auto' ? 'auto' : Number(flags.threads);
    if (flags.dir || flags.out) options.outputDir = flags.dir || flags.out;
    return options;
}

function requireDeps(ui) {
    const deps = checkAllDeps();
    if (!deps.chromium.available) {
        ui.error('Chromium не найден.\nУстановите его: pkg install chromium');
        return null;
    }
    if (!deps.ffmpeg.available) {
        ui.error('FFmpeg не найден.\nУстановите: pkg install ffmpeg');
        return null;
    }
    return deps;
}

/** Выводит результат самопроверки; возвращает { ok }. */
export async function printSelfTest(config) {
    const marks = { ok: '✓', warn: '⚠', fail: '✗', info: '•' };
    console.log('');
    console.log('🔧 ДИАГНОСТИКА (реальная проверка всей цепочки)');
    console.log('');
    const result = await runSelfTest({
        config,
        report: (status, text) => console.log(`${marks[status] || '•'} ${text}`)
    });
    console.log('');
    console.log(
        result.ok
            ? `✓ Всё работает.${result.warnings ? ` Предупреждений: ${result.warnings}.` : ''}`
            : `✗ Найдено проблем: ${result.failures}. Исправьте их и запустите проверку снова.`
    );
    console.log('');
    return result;
}

export function printCleanup() {
    const orphans = findOrphanChromium();
    if (orphans.length > 0) {
        const killed = killOrphanChromium();
        console.log(`✓ Остановлено зависших процессов Chromium: ${killed}`);
    } else {
        console.log('• Зависших процессов Chromium нет.');
    }
    const { removed, bytes } = cleanStaleTempDirs({ maxAgeMs: 0 });
    console.log(
        removed > 0
            ? `✓ Удалено временных папок: ${removed} (освобождено ${formatBytes(bytes)})`
            : '• Временных папок для удаления нет.'
    );
}

function readVersion() {
    try {
        return JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')).version;
    } catch {
        return 'неизвестна';
    }
}

/** Выполняет команду. Возвращает код завершения процесса. */
export async function runCli(argv) {
    const { command, positional, flags } = parseArgs(argv);

    if (flags.h || flags.help || command === 'help') {
        console.log(HELP_TEXT);
        return 0;
    }
    if (flags.v || flags.version || command === 'version') {
        console.log(readVersion());
        return 0;
    }

    const config = loadConfig();
    const ui = createConsoleUI({ interactive: false });

    switch (command) {
        case 'render': {
            if (positional.length === 0) {
                ui.error('Укажите файл: anim render файл.html');
                return 2;
            }
            const deps = requireDeps(ui);
            if (!deps) return 1;
            const res = await runJob({ htmlPath: positional[0], deps, config, options: jobOptions(flags, positional[0]), ui });
            return res.ok ? 0 : 1;
        }

        case 'preview': {
            if (positional.length === 0) {
                ui.error('Укажите файл: anim preview файл.html');
                return 2;
            }
            const deps = requireDeps(ui);
            if (!deps) return 1;
            const time = flags.t ?? flags.time;
            const options = { time: time !== undefined ? Number(time) : undefined };
            if (flags.dir || flags.out) options.outputDir = flags.dir || flags.out;
            const res = await runPreview({ htmlPath: positional[0], deps, config, options, ui });
            return res.ok ? 0 : 1;
        }

        case 'queue': {
            if (positional.length === 0) {
                ui.error('Укажите файлы: anim queue a.html b.html');
                return 2;
            }
            const deps = requireDeps(ui);
            if (!deps) return 1;
            return runQueue({ files: positional, deps, config, flags, ui });
        }

        case 'selftest':
        case 'doctor': {
            const result = await printSelfTest(config);
            return result.ok ? 0 : 1;
        }

        case 'clean':
            printCleanup();
            return 0;

        case 'update': {
            const script = join(PROJECT_ROOT, 'install.sh');
            const res = spawnSync('bash', [script, '--update'], { stdio: 'inherit' });
            return res.status ?? 1;
        }

        default:
            console.log(`Неизвестная команда: ${command}\n`);
            console.log(HELP_TEXT);
            return 2;
    }
}

/** Рендерит файлы по очереди; одна неудача не останавливает остальные. */
export async function runQueue({ files, deps, config, flags = {}, ui }) {
    const summary = [];
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        console.log('');
        console.log(`═══ Файл ${i + 1} из ${files.length}: ${file} ═══`);

        try {
            validateAnimationPath(file);
        } catch (err) {
            ui.error(err.message);
            summary.push({ file, ok: false });
            continue;
        }

        const options = jobOptions({ ...flags, o: undefined, output: undefined }, file);
        const res = await runJob({ htmlPath: file, deps, config, options, ui });
        summary.push({ file, ok: res.ok, path: res.result?.outputPath });
    }

    console.log('');
    console.log('Итоги очереди:');
    for (const item of summary) {
        console.log(`${item.ok ? '✓' : '✗'} ${basename(item.file)}${item.path ? ` -> ${item.path}` : ''}`);
    }
    console.log('');
    return summary.every((s) => s.ok) ? 0 : 1;
}

// Чтобы файл можно было запускать напрямую для отладки.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
