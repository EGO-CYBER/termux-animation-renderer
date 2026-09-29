// lint.js
// Быстрая статическая проверка animation.html ДО запуска браузера.
// Ищет приёмы, из-за которых анимация зависит не только от time
// (то есть даёт разные кадры при параллельном рендере), и внешние
// ресурсы (рендер должен работать офлайн). Это предупреждения, а не
// запрет: окончательный вердикт даёт динамическая проверка детерминизма.

/** Убирает комментарии, сохраняя номера строк (пробелы вместо символов). */
export function stripComments(source) {
    const blank = (m) => m.replace(/[^\n]/g, ' ');
    return source
        .replace(/<!--[\s\S]*?-->/g, blank)
        .replace(/\/\*[\s\S]*?\*\//g, blank)
        // однострочные // комментарии; двоеточие перед // защищает URL вида https://
        .replace(/(^|[^:\\'"`])\/\/[^\n]*/g, (m, prefix) => prefix + ' '.repeat(m.length - prefix.length));
}

const RULES = [
    { code: 'date-now', re: /\bDate\.now\s*\(/, message: 'Date.now(): реальное время. Используйте только аргумент time.' },
    { code: 'new-date', re: /\bnew\s+Date\s*\(/, message: 'new Date(): реальное время. Используйте только аргумент time.' },
    { code: 'perf-now', re: /\bperformance\.now\s*\(/, message: 'performance.now(): реальное время. Используйте только аргумент time.' },
    { code: 'math-random', re: /\bMath\.random\s*\(/, message: 'Math.random() без seed: кадры будут отличаться. Нужен генератор с фиксированным seed.' },
    { code: 'raf', re: /\brequestAnimationFrame\s*\(/, message: 'requestAnimationFrame: время не контролируется. Рисуйте только внутри renderFrame(time).' },
    { code: 'timers', re: /\b(setTimeout|setInterval)\s*\(/, message: 'setTimeout/setInterval: асинхронное время, кадр может не успеть отрисоваться.' },
    { code: 'css-keyframes', re: /@keyframes\b/, message: 'CSS @keyframes: анимация идёт в реальном времени, а не по time.' },
    { code: 'css-animation', re: /(^|[\s;{"'])animation(-name)?\s*:/, message: 'CSS animation: идёт в реальном времени, а не по time.' },
    { code: 'css-transition', re: /(^|[\s;{"'])transition\s*:/, message: 'CSS transition: идёт в реальном времени, а не по time.' },
    { code: 'media-tag', re: /<(video|audio)\b/i, message: '<video>/<audio>: воспроизведение в реальном времени. Звук добавляйте через window.VIDEO.audio.' },
    { code: 'ext-script', re: /<script[^>]+src\s*=\s*["']?\s*https?:/i, message: 'Внешний <script src="https://...">: рендер должен работать офлайн.' },
    { code: 'ext-link', re: /<link[^>]+href\s*=\s*["']?\s*https?:/i, message: 'Внешний <link href="https://...">: рендер должен работать офлайн.' },
    { code: 'ext-img', re: /<(img|source|iframe)[^>]+src\s*=\s*["']?\s*https?:/i, message: 'Внешнее изображение/фрейм по https: рендер должен работать офлайн.' },
    { code: 'ext-css-url', re: /url\(\s*["']?\s*https?:/i, message: 'Внешний url(https://...) в CSS: рендер должен работать офлайн.' },
    { code: 'ext-import', re: /@import\s+(url\()?\s*["']?\s*https?:/i, message: 'Внешний @import: рендер должен работать офлайн.' },
    { code: 'ext-fetch', re: /\b(fetch|import)\s*\(\s*["'`]\s*https?:/, message: 'Сетевой запрос (fetch/import) по https: рендер должен работать офлайн.' },
    { code: 'ext-xhr', re: /\.open\(\s*["'][A-Z]+["']\s*,\s*["'`]\s*https?:/, message: 'Сетевой запрос (XMLHttpRequest) по https: рендер должен работать офлайн.' }
];

/**
 * Возвращает список замечаний: { level: 'warn', code, message, line }.
 */
export function staticLint(html) {
    const cleaned = stripComments(html);
    const issues = [];

    for (const rule of RULES) {
        const flags = rule.re.flags.includes('g') ? rule.re.flags : rule.re.flags + 'g';
        const re = new RegExp(rule.re.source, flags);
        let match;
        let count = 0;
        while ((match = re.exec(cleaned)) !== null) {
            const line = cleaned.slice(0, match.index).split('\n').length;
            issues.push({ level: 'warn', code: rule.code, message: rule.message, line });
            count += 1;
            if (count >= 3) break; // не засоряем вывод одинаковыми замечаниями
            if (match.index === re.lastIndex) re.lastIndex += 1;
        }
    }

    return issues.sort((a, b) => a.line - b.line);
}
