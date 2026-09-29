<div align="center">

# 🎬 Termux Animation Renderer

**Превращает HTML/Canvas/SVG/WebGL-анимацию в MP4 прямо на телефоне.**

Без ПК, без root, без Puppeteer и Playwright — только Chromium (через Chrome DevTools Protocol) и FFmpeg.

[![CI](https://github.com/EGO-CYBER/termux-animation-renderer/actions/workflows/ci.yml/badge.svg)](https://github.com/EGO-CYBER/termux-animation-renderer/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-2.0.0-6c5ce7)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Android%20%2F%20Termux-3DDC84)](https://termux.dev/)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![FFmpeg](https://img.shields.io/badge/encoder-libx264-ff5f00?logo=ffmpeg&logoColor=white)](#-как-это-устроено)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[**📥 Установка**](#-как-запустить-после-скачивания) ·
[**🎞 Демо**](#-демо) ·
[**🖥 Меню**](#-меню-и-настройки) ·
[**📄 Формат**](#-формат-animationhtml) ·
[**🧠 Как работает**](#-как-это-устроено) ·
[**🤝 Contributing**](CONTRIBUTING.md)

</div>

---

```text
animation.html  →  Chromium (CDP)  →  кадры  →  FFmpeg  →  video.mp4
```

Вы описываете видео нейросети — [готовый промт](PROMPT_RU.txt) — получаете один файл `animation.html`. Программа сама прочитает из него разрешение, FPS и длительность и соберёт ролик.

---

## 📥 Как запустить после скачивания

### Если скачали командой в Termux

```bash
pkg install -y git curl
curl -fsSL https://raw.githubusercontent.com/EGO-CYBER/termux-animation-renderer/main/install.sh | bash
```

Потом просто:

```bash
anim
```

### Если скачали файл (ZIP) на телефон

```bash
termux-setup-storage
cd ~/storage/downloads
unzip termux-animation-renderer-main.zip
cd termux-animation-renderer-main
bash install.sh
cd ~/termux-animation-renderer
anim
```

### Если скачали через git

```bash
git clone https://github.com/EGO-CYBER/termux-animation-renderer.git
cd termux-animation-renderer
bash install.sh
cd ~/termux-animation-renderer
anim
```

> [!WARNING]
> Запускать из «Загрузок» нельзя — установщик сам переносит проект в `~/termux-animation-renderer`.

> [!TIP]
> Установщик ставит только недостающее, проверяет, что Chromium **реально запускается**, создаёт команду `anim` и делает самопроверку. Его безопасно запускать повторно.
> Чтобы видео попадало в галерею, один раз выполните `termux-setup-storage`.

**Требования:** Android с Termux · Node.js 18+ · Chromium · FFmpeg · ~1 ГБ свободного места.

---

## 🎞 Демо

<p align="center">
  <img src="assets/demo.gif" width="820" alt="Termux Animation Renderer — демо-ролик 1920×1080">
</p>

<p align="center">
  <a href="assets/demo.mp4"><b>▶ Открыть MP4 в полном качестве</b> · 1920×1080 · 30 fps · 30 с</a>
</p>

> Демо-ролик: анимацию написал **Claude Sonnet 5.5**, видео собрал этот рендерер на Android.
> Исходник — [`examples/demo_2.0.html`](examples/demo_2.0.html).

---

## ✨ Возможности

<table>
<tr><td width="50%">

- ⚡ **Параллельный рендер** — несколько вкладок Chromium, число потоков подбирается по ядрам и свободной памяти
- 💾 **Кадры без диска** — кадры идут сразу в FFmpeg, PNG не копятся (1080p больше не занимает ~1 ГБ временно)
- 🛡 **Защита от зависаний** — вкладки обновляются, зависшие кадры перезапускаются, «хвост» на 97–99 % больше не тормозит финиш
- 🔍 **Проверка до рендера** — ищет `Date.now`, `Math.random`, CDN и CSS-анимации, сравнивает кадры на детерминизм

</td><td width="50%">

- 🤖 **Ошибка «для нейросети»** — при сбое печатает готовый текст с номером строки: вставьте в чат, модель починит код
- 📊 **Прогресс с ETA** — окно с оставшимся временем, уведомление и вибрация по готовности
- 🎚 **Гибкость рендера** — предпросмотр кадра, черновик, motion blur, звук в MP4, очередь из файлов
- 🖥 **Графика** — WebGL (программный SwiftShader), Canvas 2D, SVG · 🔋 wake lock, видео сразу в галерее

</td></tr>
</table>

---

## ▶️ Использование

```bash
anim                                   # интерактивное меню
anim render animation.html -o my_video # рендер одной командой
anim preview animation.html -t 5       # один кадр на 5-й секунде
anim render animation.html --draft     # черновик: быстро, половина разрешения
anim render animation.html --blur 4    # motion blur (в 4 раза дольше)
anim render animation.html --audio music.mp3
anim queue a.html b.html c.html        # несколько файлов подряд
anim selftest                          # проверка всей цепочки
anim clean                             # убрать временные файлы и зависший Chromium
anim update                            # обновить программу
```

| Параметр | Значение |
|---|---|
| `-o, --output` | имя видео (по умолчанию имя html-файла) |
| `--dir` | папка сохранения |
| `--draft` | черновик |
| `--fast` | кадры в JPEG: быстрее, малые потери |
| `--blur N` | motion blur, 1–16 подкадров |
| `--audio` | звуковая дорожка |
| `--threads N\|auto` | число вкладок |

Попробуйте на примере: `anim render ~/termux-animation-renderer/examples/demo.html`

---

## 🖥 Меню и настройки

Запуск **без аргументов** открывает интерактивное меню:

```bash
anim
```

То же самое, если работаете с исходниками через npm:

```bash
npm start
```

| Пункт | Что делает |
|:--:|---|
| `1` | 🎬 **Рендер анимации** — спрашивает путь к `animation.html` и рендерит ролик |
| `2` | 🖼 **Предпросмотр кадра** — сохраняет один кадр в PNG, быстро проверить композицию |
| `3` | ⚙ **Настройки** — меняет параметры рендера (таблица ниже) |
| `4` | 🔧 **Диагностика** — проверяет Chromium, CDP и FFmpeg, подсказывает число потоков |
| `5` | 🧹 **Очистка временных файлов** — убирает незаконченные кадры и зависшие процессы Chromium |
| `6` | 🚪 **Выход** |

### Настройки (`anim` → `3`)

Все параметры хранятся в файле [`config.json`](config.json) в корне проекта и меняются прямо в меню — руками править не обязательно.

| Параметр | По умолчанию | Что значит |
|---|---|---|
| `outputDir` | `~/storage/movies/TermuxRenderer` | Куда сохранять видео. Из этой папки оно попадает в галерею |
| `ffmpegPreset` | `veryfast` | Скорость кодирования: `ultrafast` … `slow`. Ниже — быстрее |
| `crf` | `18` | Качество: 0–51, меньше — лучше и файл больше |
| `threads` | `auto` | Число вкладок Chromium. `auto` — по ядрам и памяти, иначе 1–8 |
| `motionBlur` | `1` | Подкадров на кадр, 1–16. `1` — выключено, больше — плавнее и дольше |
| `frameFormat` | `png` | `png` — без потерь, `jpeg` — быстрее с малыми потерями |
| `notify` | `да` | Уведомление и вибрация по готовности (нужен `termux-api`) |

> [!IMPORTANT]
> **Разрешение, FPS и длительность здесь не задаются** — они читаются из самого `animation.html` (см. [Формат animation.html](#-формат-animationhtml)).

Проверка окружения одной командой:

```bash
anim selftest
```

Покажет версии Node, Chromium и FFmpeg и подскажет, сколько вкладок потянет ваш телефон.

---

## 📄 Формат animation.html

```html
<script>
window.VIDEO = { width: 1920, height: 1080, fps: 30, duration: 15 };  // audio: "music.mp3" — по желанию
window.renderFrame = function (time) {
    // time в секундах; полностью нарисуйте кадр
};
</script>
```

Кадры рендерятся **параллельно и вразнобой**, поэтому кадр должен зависеть только от `time`:

| ✅ Можно | ❌ Нельзя |
|---|---|
| считать от `time` | `Date.now()`, `performance.now()`, `requestAnimationFrame` |
| рисовать кадр с нуля | таймеры и CSS-анимации |
| работать без сети | `Math.random()` без seed, CDN-библиотеки |

Готовый промт для нейросети: **[PROMPT_RU.txt](PROMPT_RU.txt)**.

### Примеры анимаций

| Файл | Разрешение | Длительность | Что показывает |
|---|:--:|:--:|---|
| [`examples/demo.html`](examples/demo.html) | 1280×720 | 20 с | базовые возможности, Canvas 2D |
| [`examples/demo_2.0.html`](examples/demo_2.0.html) | 1920×1080 | 30 с | полноценный ролик — источник демо выше |
| [`examples/земля.html`](examples/земля.html) | 854×480 | 25 с | лёгкий пример для быстрой проверки |

---

## 🧠 Как это устроено

```text
anim → job.js ──► preflight: lint + проверка VIDEO/renderFrame + детерминизм
                        │
Chromium (1 процесс, N вкладок, чистый CDP по WebSocket)
     │ кадры (PNG/JPEG), готовятся вразнобой
     ▼
конвейер: выстраивает кадры по порядку, ограничивает буфер в памяти
     │ image2pipe
     ▼
FFmpeg (libx264, yuv420p, faststart, звук) → video.mp4
```

| Модуль | Ответственность |
|---|---|
| `src/cdp.js` | клиент CDP: PUT `/json/new`, таймауты команд, детект падения вкладки, свободный порт |
| `src/renderer.js` | preflight, конвейер кадров, защита от «хвоста», motion blur (`tmix`), запуск FFmpeg |
| `src/lint.js`, `src/report.js` | статическая проверка и текст для нейросети |
| `src/selftest.js` | настоящая диагностика мини-рендером |
| `src/cleanup.js` | очистка при Ctrl+C и остатков после аварий |
| `src/termux.js` | wake lock, уведомления, галерея, буфер обмена |

---

## 🛠 Если что-то не так

| Проблема | Решение |
|---|---|
| `CANNOT LINK EXECUTABLE ... cannot locate symbol` | `pkg update && pkg upgrade -y && pkg reinstall chromium` (или запустите `install.sh`) |
| Долго на 97–99 % | Обновитесь до 2.0: зависшие кадры дублируются. Журнал: `TR_DEBUG=1 anim ...` → `~/tr-debug.log` |
| Вылеты по памяти | `--threads 2`, `--fast`, меньшее разрешение; `anim clean` |
| Видео не в галерее | `termux-setup-storage` |
| Нет уведомлений | `pkg install termux-api` и приложение Termux:API |
| `Permission denied` при запуске | Запускайте `anim` из `~/termux-animation-renderer` (установщик сам копирует проект) |

Проверка окружения одной командой: **`anim selftest`**

---

## 🧪 Тесты и вклад

```bash
npm test
```

Тесты проверяют конвейер (порядок кадров, зависший «хвост»), сборку MP4 через pipe с motion blur, проверку кода и разбор команд.

<div align="center">

**Issues и Pull Request приветствуются** — подробности в [CONTRIBUTING.md](CONTRIBUTING.md)

[![Contributing](https://img.shields.io/badge/guide-CONTRIBUTING-blue.svg)](CONTRIBUTING.md)
[![Issues](https://img.shields.io/github/issues/EGO-CYBER/termux-animation-renderer)](https://github.com/EGO-CYBER/termux-animation-renderer/issues)
[![Stars](https://img.shields.io/github/stars/EGO-CYBER/termux-animation-renderer?style=social)](https://github.com/EGO-CYBER/termux-animation-renderer)

</div>

---

## 📜 Лицензия

[MIT](LICENSE) · Copyright (c) 2026 Termux Animation Renderer contributors

Если проект пригодился — поставьте ⭐

<div align="center">
<sub>Сделано на Android · Chromium CDP · FFmpeg · без единой зависимости от Puppeteer</sub>
</div>
