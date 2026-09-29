// ui.js
// Консольный интерфейс без ANSI-цветов (только текст и эмодзи-заголовки):
// прогресс-бар с оставшимся временем, вывод шагов проверки, диалоги.
// Один и тот же объект ui используется меню (interactive) и командной
// строкой (неинтерактивно, без вопросов).

export function formatDuration(totalSeconds) {
    const s = Math.max(0, Math.round(totalSeconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}ч ${String(m).padStart(2, '0')}м`;
    if (m > 0) return `${m}м ${String(sec).padStart(2, '0')}с`;
    return `${sec}с`;
}

export function formatBytes(bytes) {
    if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} ГБ`;
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} МБ`;
    return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

/** Строка прогресса: полоса, проценты, кадры и оставшееся время. */
export function progressLine(current, total, startedAt, now = Date.now()) {
    const width = 24;
    const ratio = total > 0 ? Math.min(1, current / total) : 0;
    const filled = Math.round(width * ratio);
    const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
    const percent = Math.round(ratio * 100);

    let eta = '';
    const elapsed = (now - startedAt) / 1000;
    if (current > 0 && current < total && elapsed > 1) {
        eta = `  осталось ~${formatDuration(((total - current) / current) * elapsed)}`;
    }
    return `[${bar}] ${percent}%  ${current}/${total}${eta}`;
}

/**
 * @param {object} opts
 * @param {boolean} opts.interactive  задавать ли вопросы (меню) или нет (CLI/очередь)
 * @param {(q: string) => Promise<string>} [opts.ask]  функция ввода строки
 */
export function createConsoleUI({ interactive = false, ask = null } = {}) {
    const isTTY = Boolean(process.stdout.isTTY);
    let startedAt = Date.now();
    let lastPercentPrinted = -1;

    const ui = {
        interactive,

        section(text) {
            console.log('');
            console.log(text);
            console.log('');
        },

        step(text, status = true) {
            const mark = status === 'warn' ? '⚠' : status ? '✓' : '✗';
            console.log(`${mark} ${text}`);
        },

        message(text) { console.log(text); },
        warn(text) { console.log(`⚠ ${text}`); },
        error(text) { console.log(`\n✗ ${text}\n`); },

        info(lines) {
            console.log('');
            for (const line of lines) console.log(line);
            console.log('');
        },

        warnings(list) {
            console.log('');
            console.log('Найдены предупреждения:');
            for (const issue of list) {
                const where = issue.line ? ` [строка ${issue.line}]` : '';
                console.log(`⚠ ${issue.message}${where}`);
            }
            console.log('');
        },

        async confirm(question) {
            if (!interactive || !ask) return true;
            const answer = (await ask(`${question} [Y/n]: `)).toLowerCase();
            return answer === '' || answer === 'y' || answer === 'yes' || answer === 'д' || answer === 'да';
        },

        async askName(defaultName = 'animation') {
            if (!interactive || !ask) return defaultName;
            const answer = await ask(`Как назвать видео [${defaultName}]: `);
            return answer || defaultName;
        },

        async askMode() {
            if (!interactive || !ask) return false;
            const answer = await ask('Качество: 1 - полное, 2 - черновик (быстро, половина разрешения) [1]: ');
            return answer === '2';
        },

        async askAudio() {
            if (!interactive || !ask) return null;
            const answer = await ask('Путь к аудиофайлу (Enter - без звука): ');
            return answer || null;
        },

        aiReport(report, copied) {
            console.log('Текст для нейросети (вставьте в тот же чат, чтобы она исправила файл):');
            console.log('------------------------------------------------------------');
            console.log(report);
            console.log('------------------------------------------------------------');
            if (copied) console.log('✓ Текст скопирован в буфер обмена.');
            console.log('');
        },

        beginProgress() {
            startedAt = Date.now();
            lastPercentPrinted = -1;
        },

        onThreadsResolved(count) {
            console.log(`Параллельных вкладок: ${count}`);
            console.log('');
        },

        onFrameProgress(current, total) {
            const percent = Math.floor((current / total) * 100);
            if (isTTY) {
                process.stdout.write(`\r${progressLine(current, total, startedAt)}    `);
            } else if (percent >= lastPercentPrinted + 10 || current === total) {
                lastPercentPrinted = percent;
                console.log(progressLine(current, total, startedAt));
            }
        },

        onNotice(text) {
            if (isTTY) process.stdout.write('\n');
            console.log(`⚠ ${text}`);
        },

        onEncodeStart() {
            if (isTTY) process.stdout.write('\n');
            console.log('');
            console.log('Завершение сборки видео...');
        },

        done(result) {
            const seconds = (result.renderElapsedMs / 1000).toFixed(1);
            console.log('');
            console.log('✓ Готово!');
            console.log('');
            console.log(`Файл сохранён:\n${result.outputPath}`);
            if (result.sizeBytes) console.log(`Размер: ${formatBytes(result.sizeBytes)}`);
            console.log(
                `Рендер: ${seconds} с, ${result.framesPerSecond.toFixed(1)} кадр/с, потоков: ${result.threads}` +
                (result.motionBlur > 1 ? `, motion blur: ×${result.motionBlur}` : '') +
                (result.draft ? ', режим: черновик' : '')
            );
            console.log('');
        }
    };

    return ui;
}
