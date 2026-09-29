// cdp.js
// Минимальный клиент Chrome DevTools Protocol.
//
// Запускает ОДИН процесс Chromium с включённым remote debugging и позволяет
// открывать в нём НЕСКОЛЬКО независимых вкладок (CDPPage), каждая со своим
// WebSocket-соединением. Это даёт параллельный покадровый рендер без
// Playwright и Puppeteer: только node:http для управления целями (targets)
// и стандартный WebSocket (глобальный, доступен в Node.js >= 18).

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PageError } from './errors.js';
import { onCleanup } from './cleanup.js';

const CONNECT_RETRY_MS = 250;
const CONNECT_TIMEOUT_MS = 20000;
const COMMAND_TIMEOUT_MS = 45000;
const PAGE_LOAD_TIMEOUT_MS = 30000;
const HTTP_TIMEOUT_MS = 10000;

/** Свободный TCP-порт: так два запуска (или зависший старый Chromium) не конфликтуют. */
export function getFreePort() {
    return new Promise((resolvePort, rejectPort) => {
        const server = net.createServer();
        server.unref();
        server.on('error', rejectPort);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolvePort(port));
        });
    });
}

/**
 * HTTP-запрос к отладочному эндпоинту Chromium с разбором JSON.
 *
 * ВАЖНО: начиная с Chromium 111 эндпоинт /json/new требует метод PUT
 * (на GET он отвечает текстом, а не JSON).
 */
function httpRequestJson(url, method = 'GET') {
    return new Promise((resolveReq, rejectReq) => {
        const req = http.request(url, { method }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolveReq(JSON.parse(data));
                } catch {
                    rejectReq(new Error(
                        `Chromium вернул не-JSON ответ на ${method} ${url} ` +
                        `(HTTP ${res.statusCode}): ${data.slice(0, 200)}`
                    ));
                }
            });
        });
        req.setTimeout(HTTP_TIMEOUT_MS, () => req.destroy(new Error('Таймаут HTTP-запроса к Chromium.')));
        req.on('error', rejectReq);
        req.end();
    });
}

function openWebSocket(wsUrl) {
    return new Promise((resolveOpen, rejectOpen) => {
        const ws = new WebSocket(wsUrl);
        const timer = setTimeout(() => {
            rejectOpen(new Error('Таймаут подключения к Chromium через WebSocket.'));
        }, CONNECT_TIMEOUT_MS);

        ws.addEventListener('open', () => {
            clearTimeout(timer);
            resolveOpen(ws);
        });
        ws.addEventListener('error', () => {
            clearTimeout(timer);
            rejectOpen(new Error('Ошибка WebSocket-соединения с Chromium.'));
        });
    });
}

/**
 * Превращает exceptionDetails из CDP в PageError с номером строки.
 * Для исключений внутри renderFrame место берётся из стека
 * ("...animation.html:LINE:COL"), для ошибок загрузки страницы - из
 * lineNumber (если скрипт принадлежит .html-файлу).
 */
function toPageError(details) {
    const description =
        details.exception?.description || details.exception?.value || details.text || 'Неизвестная ошибка JavaScript.';
    const text = String(description);
    const message = text.split('\n')[0];

    let line = null;
    let column = null;
    const fromStack = /\.html:(\d+):(\d+)/.exec(text);
    if (fromStack) {
        line = Number(fromStack[1]);
        column = Number(fromStack[2]);
    } else if (details.url && /\.html$/i.test(details.url) && Number.isInteger(details.lineNumber)) {
        line = details.lineNumber + 1;
        column = Number.isInteger(details.columnNumber) ? details.columnNumber + 1 : null;
    }

    return new PageError(message, { description: text, line, column });
}

/**
 * Один CDP-канал поверх WebSocket: команды с ожиданием ответа по id и
 * подписка на события. Каждая команда имеет таймаут, а закрытие сокета и
 * Inspector.targetCrashed немедленно отклоняют все ожидающие команды -
 * иначе упавшая вкладка вешала бы весь рендер без единой ошибки.
 */
class CDPChannel {
    constructor(ws) {
        this.ws = ws;
        this.nextId = 1;
        this.pending = new Map();
        this.eventHandlers = new Map();
        this.crashReason = null;

        this.ws.addEventListener('message', (event) => this._handleMessage(event.data));
        this.ws.addEventListener('close', () => {
            this._failAllPending(this.crashReason || 'Соединение с вкладкой Chromium неожиданно закрылось.');
        });
        this.ws.addEventListener('error', () => {
            this._failAllPending(this.crashReason || 'Ошибка WebSocket-соединения с вкладкой Chromium.');
        });

        this.on('Inspector.targetCrashed', () => {
            this.crashReason =
                'Вкладка Chromium аварийно завершилась (Inspector.targetCrashed).\n' +
                'Обычно это нехватка оперативной памяти. Уменьшите число потоков\n' +
                'в настройках, снизите разрешение или закройте другие приложения.';
            this._failAllPending(this.crashReason);
        });
    }

    _failAllPending(message) {
        if (this.pending.size === 0) return;
        const err = new Error(message);
        for (const { reject, timer } of this.pending.values()) {
            clearTimeout(timer);
            reject(err);
        }
        this.pending.clear();
    }

    _handleMessage(raw) {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch {
            return;
        }

        if (msg.id !== undefined && this.pending.has(msg.id)) {
            const { resolve, reject, timer } = this.pending.get(msg.id);
            clearTimeout(timer);
            this.pending.delete(msg.id);
            if (msg.error) {
                reject(new Error(msg.error.message || 'Ошибка CDP-команды.'));
            } else {
                resolve(msg.result);
            }
            return;
        }

        if (msg.method && this.eventHandlers.has(msg.method)) {
            for (const handler of [...this.eventHandlers.get(msg.method)]) {
                handler(msg.params);
            }
        }
    }

    send(method, params = {}) {
        const id = this.nextId++;
        const payload = JSON.stringify({ id, method, params });

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(
                    `Таймаут ${COMMAND_TIMEOUT_MS / 1000}с при ожидании ответа на команду ${method}.\n` +
                    'Вкладка Chromium, вероятно, зависла (нехватка памяти/CPU).'
                ));
            }, COMMAND_TIMEOUT_MS);

            this.pending.set(id, { resolve, reject, timer });
            try {
                this.ws.send(payload);
            } catch (err) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(err);
            }
        });
    }

    on(method, handler) {
        if (!this.eventHandlers.has(method)) {
            this.eventHandlers.set(method, new Set());
        }
        this.eventHandlers.get(method).add(handler);
    }

    /** Ждёт ближайшее событие method, но не дольше timeoutMs. */
    waitFor(method, timeoutMs) {
        return new Promise((resolve, reject) => {
            const off = () => this.eventHandlers.get(method)?.delete(handler);
            const timer = setTimeout(() => {
                off();
                reject(new Error(`Таймаут ожидания события ${method} (${timeoutMs / 1000}с).`));
            }, timeoutMs);
            const handler = (params) => {
                clearTimeout(timer);
                off();
                resolve(params);
            };
            this.on(method, handler);
        });
    }

    close() {
        try {
            if (this.ws.readyState === WebSocket.OPEN) {
                this.ws.close();
            }
        } catch {
            // игнорируем
        }
    }
}

// Параметр optimizeForSpeed (быстрее кодирование скриншота) есть не во всех
// версиях Chromium: один раз убеждаемся и запоминаем для всех вкладок.
let optimizeForSpeedSupported = true;

/**
 * Одна вкладка Chromium со своим WebSocket и JS-контекстом. Собирает
 * ошибки страницы (исключения, console.error, ошибки загрузки ресурсов).
 */
export class CDPPage {
    constructor(channel, targetId) {
        this.channel = channel;
        this.targetId = targetId;
        this.errors = [];      // PageError: необработанные исключения
        this.logErrors = [];   // строки: console.error и ошибки загрузки ресурсов
    }

    async _init() {
        this.channel.on('Runtime.exceptionThrown', (params) => {
            if (params?.exceptionDetails) this.errors.push(toPageError(params.exceptionDetails));
        });
        this.channel.on('Runtime.consoleAPICalled', (params) => {
            if (params?.type !== 'error') return;
            const text = (params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').trim();
            if (text) this._pushLog(text);
        });
        this.channel.on('Log.entryAdded', (params) => {
            const entry = params?.entry;
            if (entry?.level === 'error') {
                this._pushLog(`${entry.text}${entry.url ? ` (${entry.url})` : ''}`);
            }
        });

        await this.channel.send('Page.enable');
        await this.channel.send('Runtime.enable');
        await this.channel.send('Inspector.enable');
        try {
            await this.channel.send('Log.enable');
        } catch {
            // не критично: просто не увидим ошибки загрузки ресурсов
        }
    }

    _pushLog(text) {
        if (this.logErrors.length < 20) this.logErrors.push(text);
    }

    async navigate(url) {
        const loaded = this.channel.waitFor('Page.loadEventFired', PAGE_LOAD_TIMEOUT_MS);
        loaded.catch(() => {}); // если navigate упадёт раньше, не оставляем необработанный reject

        const nav = await this.channel.send('Page.navigate', { url });
        if (nav?.errorText) {
            throw new Error(`Не удалось открыть страницу: ${nav.errorText}`);
        }
        await loaded;

        // Небольшая пауза: синхронные скрипты страницы (window.VIDEO,
        // window.renderFrame) точно выполнились.
        await delay(100);
    }

    /** scale < 1 даёт уменьшенный скриншот (режим "черновик"). */
    async setViewport(width, height, scale = 1) {
        await this.channel.send('Emulation.setDeviceMetricsOverride', {
            width,
            height,
            deviceScaleFactor: scale,
            mobile: false
        });
    }

    async evaluate(expression) {
        const result = await this.channel.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true
        });

        if (result.exceptionDetails) {
            throw toPageError(result.exceptionDetails);
        }
        return result.result?.value;
    }

    async renderFrame(time) {
        await this.evaluate(
            `(async () => { await window.renderFrame(${JSON.stringify(time)}); })()`
        );
    }

    /**
     * Скриншот страницы. format: 'png' (без потерь) или 'jpeg' (быстрее,
     * с потерями качества). Возвращает Buffer.
     */
    async captureScreenshot({ format = 'png', quality = 92 } = {}) {
        const params = { format, fromSurface: true, captureBeyondViewport: false };
        if (format === 'jpeg') params.quality = quality;
        if (optimizeForSpeedSupported) params.optimizeForSpeed = true;

        let result;
        try {
            result = await this.channel.send('Page.captureScreenshot', params);
        } catch (err) {
            if (params.optimizeForSpeed && /invalid|unknown|optimizeForSpeed|not found/i.test(err.message)) {
                optimizeForSpeedSupported = false;
                delete params.optimizeForSpeed;
                result = await this.channel.send('Page.captureScreenshot', params);
            } else {
                throw err;
            }
        }
        return Buffer.from(result.data, 'base64');
    }

    close() {
        this.channel.close();
    }
}

/**
 * Управляет одним процессом Chromium и произвольным числом вкладок.
 */
export class CDPBrowser {
    constructor() {
        this.chromeProcess = null;
        this.userDataDir = null;
        this.port = null;
        this.chromeStderr = '';
        this.chromeExitInfo = null;
        this.spawnError = null;
        this.pages = new Set();
        this.closed = false;
        this._unregisterCleanup = null;
    }

    get httpBase() {
        return `http://127.0.0.1:${this.port}`;
    }

    async launch(chromiumPath) {
        this.port = await getFreePort();
        this.userDataDir = mkdtempSync(join(tmpdir(), 'tr-chromium-'));

        const args = [
            `--remote-debugging-port=${this.port}`,
            '--remote-debugging-address=127.0.0.1',
            '--headless=new',
            '--disable-gpu',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-sync',
            '--disable-default-apps',
            '--disable-renderer-backgrounding',
            '--disable-backgrounding-occluded-windows',
            '--disable-background-timer-throttling',
            '--mute-audio',
            '--no-first-run',
            '--hide-scrollbars',
            '--force-color-profile=srgb',
            // Программный WebGL (SwiftShader): работает без GPU-драйвера.
            '--enable-unsafe-swiftshader',
            '--use-gl=angle',
            '--use-angle=swiftshader',
            '--ignore-gpu-blocklist',
            `--user-data-dir=${this.userDataDir}`,
            'about:blank'
        ];

        // detached: Chromium получает свою группу процессов, и мы можем
        // завершить его вместе со всеми дочерними процессами одним сигналом.
        this.chromeProcess = spawn(chromiumPath, args, {
            stdio: ['ignore', 'ignore', 'pipe'],
            detached: true
        });

        this.chromeProcess.stderr.on('data', (chunk) => {
            this.chromeStderr += chunk.toString();
            if (this.chromeStderr.length > 4000) {
                this.chromeStderr = this.chromeStderr.slice(-4000);
            }
        });
        this.chromeProcess.on('exit', (code, signal) => {
            this.chromeExitInfo = { code, signal };
        });
        this.chromeProcess.on('error', (err) => {
            this.spawnError = err;
        });

        this._unregisterCleanup = onCleanup(() => this.killNow());

        await this._waitForDebuggerReady();
    }

    _launchFailureMessage(prefix) {
        return (
            `${prefix}\n` +
            (this.spawnError ? `Не удалось запустить Chromium: ${this.spawnError.message}\n` : '') +
            (this.chromeExitInfo
                ? `Процесс Chromium завершился (код: ${this.chromeExitInfo.code}, сигнал: ${this.chromeExitInfo.signal}).\n`
                : '') +
            (this.chromeStderr ? `\nВывод Chromium:\n${this.chromeStderr.trim()}\n` : '') +
            '\nЕсли видите "CANNOT LINK EXECUTABLE" или сегфолт, обновите систему целиком:\n' +
            'pkg update -y && pkg upgrade -y && pkg reinstall -y chromium\n' +
            'Проверьте также свободное место: df -h $PREFIX'
        );
    }

    async _waitForDebuggerReady() {
        const deadline = Date.now() + CONNECT_TIMEOUT_MS;

        while (Date.now() < deadline) {
            // Chromium уже упал - нет смысла ждать весь таймаут.
            if (this.spawnError || this.chromeExitInfo) break;
            try {
                const json = await httpRequestJson(`${this.httpBase}/json/list`);
                if (Array.isArray(json)) return;
            } catch {
                // Chromium ещё не готов - подождём и попробуем снова.
            }
            await delay(CONNECT_RETRY_MS);
        }

        const message = this._launchFailureMessage('Chromium не ответил на отладочном порту.');
        await this.close();
        throw new Error(message);
    }

    /**
     * Создаёт новую вкладку (PUT /json/new), подключается к ней по WebSocket
     * и включает нужные домены протокола.
     */
    async newPage() {
        if (this.closed || this.chromeExitInfo) {
            throw new Error(this._launchFailureMessage('Chromium уже завершился, открыть вкладку нельзя.'));
        }

        const target = await httpRequestJson(`${this.httpBase}/json/new?about:blank`, 'PUT');
        if (!target.webSocketDebuggerUrl) {
            throw new Error('Chromium не вернул адрес WebSocket для новой вкладки.');
        }

        const ws = await openWebSocket(target.webSocketDebuggerUrl);
        const page = new CDPPage(new CDPChannel(ws), target.id);
        await page._init();

        this.pages.add(page);
        return page;
    }

    async closePage(page) {
        this.pages.delete(page);
        page.close();
        try {
            await httpRequestJson(`${this.httpBase}/json/close/${page.targetId}`);
        } catch {
            // не критично - вкладка исчезнет при закрытии браузера
        }
    }

    _killTree(signal) {
        const proc = this.chromeProcess;
        if (!proc || !proc.pid) return;
        try {
            process.kill(-proc.pid, signal); // вся группа процессов Chromium
        } catch {
            try { proc.kill(signal); } catch { /* уже завершён */ }
        }
    }

    _isRunning() {
        const proc = this.chromeProcess;
        return Boolean(proc && proc.exitCode === null && proc.signalCode === null);
    }

    _removeProfile() {
        if (!this.userDataDir) return;
        try {
            rmSync(this.userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch {
            // не критично: остаток уберёт очистка при следующем запуске
        }
    }

    /** Синхронное аварийное завершение (для обработчиков выхода). */
    killNow() {
        this._killTree('SIGKILL');
        this._removeProfile();
    }

    /** Штатное завершение: закрывает вкладки, останавливает Chromium, удаляет профиль. */
    async close() {
        if (this.closed) return;
        this.closed = true;

        for (const page of this.pages) page.close();
        this.pages.clear();

        if (this._isRunning()) {
            const exited = new Promise((res) => this.chromeProcess.once('exit', res));
            this._killTree('SIGTERM');
            await Promise.race([exited, delay(1500)]);
            if (this._isRunning()) {
                this._killTree('SIGKILL');
                await Promise.race([exited, delay(1000)]);
            }
        }

        this._removeProfile();
        if (this._unregisterCleanup) this._unregisterCleanup();
    }
}
