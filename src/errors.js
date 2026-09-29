// errors.js
// Типы ошибок, по которым интерфейс понимает, что проблема в самом
// animation.html (а не в Chromium/FFmpeg/устройстве). Для таких ошибок
// программа формирует готовый текст, который можно отправить нейросети.

export class AnimationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AnimationError';
    }
}

export class PageError extends AnimationError {
    constructor(message, { description = '', line = null, column = null } = {}) {
        super(message);
        this.name = 'PageError';
        this.description = description;
        this.line = line;
        this.column = column;
        this.frameTime = null;
    }
}
