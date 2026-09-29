// report.js
// Формирует текст "для нейросети": при ошибке в animation.html программа
// выводит готовое сообщение с номером строки и фрагментом кода, которое
// можно целиком вставить в тот же чат, чтобы модель исправила файл.

import { readFileSync } from 'node:fs';

const CONTRACT =
    'Исправь файл и пришли ПОЛНЫЙ исправленный animation.html одним блоком кода, без пояснений.\n' +
    'Не меняй контракт рендерера: window.VIDEO = {width, height, fps, duration} и\n' +
    'window.renderFrame(time) - чистая функция времени (без Date.now, performance.now,\n' +
    'Math.random без seed, requestAnimationFrame, таймеров, CSS-анимаций и внешних ресурсов).';

function snippet(htmlPath, line, radius = 2) {
    if (!htmlPath || !line) return '';
    let lines;
    try {
        lines = readFileSync(htmlPath, 'utf8').split('\n');
    } catch {
        return '';
    }
    const from = Math.max(1, line - radius);
    const to = Math.min(lines.length, line + radius);
    const out = [];
    for (let n = from; n <= to; n++) {
        const marker = n === line ? '>' : ' ';
        out.push(`${marker} ${String(n).padStart(4)} | ${lines[n - 1].slice(0, 160)}`);
    }
    return out.join('\n');
}

/** Отчёт по ошибке выполнения (исключение JS, отсутствие window.VIDEO и т.п.). */
export function formatAiReport({ error, htmlPath, stage = 'рендер' }) {
    const parts = [];
    parts.push('Мой animation.html не проходит рендер в Termux Animation Renderer.');
    parts.push(`Этап: ${stage}`);
    parts.push(`Ошибка: ${String(error.message).split('\n')[0]}`);

    if (error.line) {
        parts.push(`Место: строка ${error.line}${error.column ? `, колонка ${error.column}` : ''}`);
    }
    if (typeof error.frameTime === 'number') {
        parts.push(`Момент времени: time = ${error.frameTime.toFixed(3)} с`);
    }

    const code = snippet(htmlPath, error.line);
    if (code) parts.push(`Фрагмент кода:\n${code}`);

    const stack = (error.description || '').split('\n').slice(0, 6).join('\n').trim();
    if (stack && stack !== String(error.message).trim()) {
        parts.push(`Стек:\n${stack}`);
    }

    parts.push(CONTRACT);
    return parts.join('\n\n');
}

/** Отчёт по предупреждениям проверки (недетерминированность, запрещённые приёмы). */
export function formatIssuesReport({ issues, htmlPath }) {
    const parts = [];
    parts.push('В моём animation.html найдены проблемы, из-за которых рендер по кадрам даст неверное видео.');

    const lines = issues.map((issue) => {
        const where = issue.line ? ` (строка ${issue.line})` : '';
        return `- ${issue.message}${where}`;
    });
    parts.push(`Проблемы:\n${lines.join('\n')}`);

    const firstWithLine = issues.find((i) => i.line);
    const code = firstWithLine ? snippet(htmlPath, firstWithLine.line) : '';
    if (code) parts.push(`Пример места в коде:\n${code}`);

    parts.push(CONTRACT);
    return parts.join('\n\n');
}
