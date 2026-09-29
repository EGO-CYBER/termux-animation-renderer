#!/data/data/com.termux/files/usr/bin/bash
# install.sh - установщик Termux Animation Renderer.
#
# Запуск из клонированного репозитория:   bash install.sh
# Установка одной командой (замените адрес на свой репозиторий):
#   curl -fsSL https://raw.githubusercontent.com/EGO-CYBER/termux-animation-renderer/main/install.sh | bash
#
# Что делает: обновляет пакеты, ставит Node.js/Chromium/FFmpeg (только то,
# чего нет), проверяет, что Chromium реально запускается, переносит проект
# в домашнюю папку Termux, создаёт команду `anim` и запускает самопроверку.
# Безопасно запускать повторно.
#
# Параметры:  --update (обновить программу)   --no-test (без самопроверки)

set -u

REPO_URL="${TR_REPO:-https://github.com/EGO-CYBER/termux-animation-renderer.git}"
INSTALL_DIR="${TR_HOME:-$HOME/termux-animation-renderer}"
MODE="install"
RUN_TEST=1

for arg in "$@"; do
    case "$arg" in
        --update) MODE="update" ;;
        --no-test) RUN_TEST=0 ;;
    esac
done

say()  { printf '%s\n' "$*"; }
ok()   { printf '✓ %s\n' "$*"; }
warn() { printf '⚠ %s\n' "$*"; }
die()  { printf '✗ %s\n' "$*" >&2; exit 1; }

say ""
say "╔══════════════════════════════════════════════╗"
say "║   Установка Termux Animation Renderer        ║"
say "╚══════════════════════════════════════════════╝"
say ""

if [ -z "${PREFIX:-}" ] || [[ "$PREFIX" != *"com.termux"* ]]; then
    warn "Похоже, это не Termux: пакеты через pkg могут быть недоступны."
fi

# Где лежит этот скрипт (пусто, если запущен через curl | bash).
SRC_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

# ---------------------------------------------------------------------
# Режим обновления
# ---------------------------------------------------------------------
if [ "$MODE" = "update" ]; then
    TARGET="${SRC_DIR:-$INSTALL_DIR}"
    if [ -d "$TARGET/.git" ] && command -v git >/dev/null 2>&1; then
        say "→ Обновление программы (git pull)..."
        git -C "$TARGET" pull --ff-only || die "Не удалось обновить. Проверьте подключение и локальные изменения."
        ok "Программа обновлена."
    else
        die "Обновление возможно только для установки через git clone. Скачайте свежий архив вручную."
    fi
    exit 0
fi

# ---------------------------------------------------------------------
# Свободное место
# ---------------------------------------------------------------------
FREE_MB="$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2 {print int($4/1024)}')"
if [ -n "${FREE_MB:-}" ] && [ "$FREE_MB" -lt 1200 ]; then
    warn "Свободно всего ${FREE_MB} МБ. Chromium и FFmpeg занимают около 1 ГБ - освободите место."
fi

# ---------------------------------------------------------------------
# Пакеты
# ---------------------------------------------------------------------
say "→ Обновление списка пакетов и системы (важно для совместимости библиотек Chromium)..."
export DEBIAN_FRONTEND=noninteractive
pkg update -y -o Dpkg::Options::="--force-confold" >/dev/null 2>&1 || warn "Не удалось обновить список пакетов (нет сети?), продолжаю."
pkg upgrade -y -o Dpkg::Options::="--force-confold" >/dev/null 2>&1 || warn "Не удалось обновить пакеты, продолжаю."
pkg install -y libc++ procps >/dev/null 2>&1 || true
echo ""

need_pkg() {   # need_pkg команда пакет
    if command -v "$1" >/dev/null 2>&1; then
        ok "$2 уже установлен."
    else
        say "→ Установка $2..."
        pkg install -y "$2" || die "Не удалось установить $2."
        ok "$2 установлен."
    fi
}

need_pkg git git
need_pkg node nodejs

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 18 ] || die "Нужен Node.js 18 или новее (сейчас: $(node --version 2>/dev/null)). Выполните: pkg upgrade nodejs"

need_pkg ffmpeg ffmpeg
if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q libx264; then
    ok "FFmpeg умеет H.264."
else
    warn "В FFmpeg нет libx264, переустанавливаю..."
    pkg reinstall -y ffmpeg >/dev/null 2>&1
fi

# Chromium: недостаточно наличия бинарника - он должен запускаться.
CHROMIUM_BIN="$(command -v chromium-browser || command -v chromium || true)"
if [ -z "$CHROMIUM_BIN" ]; then
    say "→ Установка Chromium (это может занять несколько минут)..."
    pkg install -y chromium || die "Не удалось установить Chromium."
    CHROMIUM_BIN="$(command -v chromium-browser || command -v chromium || true)"
fi
if "$CHROMIUM_BIN" --version >/tmp/tr_chromium_check.log 2>&1; then
    ok "Chromium работает: $("$CHROMIUM_BIN" --version 2>/dev/null | head -n1)"
else
    warn "Chromium установлен, но не запускается (рассинхрон библиотек). Переустанавливаю..."
    pkg reinstall -y libc++ chromium >/dev/null 2>&1
    if "$CHROMIUM_BIN" --version >/tmp/tr_chromium_check.log 2>&1; then
        ok "Chromium исправлен."
    else
        say "Вывод ошибки:"; cat /tmp/tr_chromium_check.log
        die "Chromium не запускается. Попробуйте: pkg uninstall chromium && pkg install chromium"
    fi
fi

# Необязательно: уведомления и вибрация по завершении рендера.
pkg install -y termux-api >/dev/null 2>&1 && ok "termux-api установлен (для уведомлений нужно приложение Termux:API)." || true
echo ""

# ---------------------------------------------------------------------
# Размещение проекта
# ---------------------------------------------------------------------
# Из общей памяти Android (Download) файлы нельзя запускать: нет права
# на выполнение. Поэтому проект всегда живёт в домашней папке Termux.
PROJECT=""
if [ -n "$SRC_DIR" ] && [ -f "$SRC_DIR/src/main.js" ]; then
    case "$SRC_DIR" in
        /storage/*|/sdcard/*|"$HOME"/storage/*)
            say "→ Проект лежит в общей памяти Android, копирую в $INSTALL_DIR ..."
            mkdir -p "$INSTALL_DIR"
            cp -rf "$SRC_DIR"/. "$INSTALL_DIR"/ || die "Не удалось скопировать проект."
            PROJECT="$INSTALL_DIR" ;;
        *) PROJECT="$SRC_DIR" ;;
    esac
else
    if [ -d "$INSTALL_DIR/.git" ]; then
        say "→ Обновление проекта в $INSTALL_DIR ..."
        git -C "$INSTALL_DIR" pull --ff-only >/dev/null 2>&1 || warn "Не удалось обновить (продолжаю с текущей версией)."
    else
        say "→ Загрузка проекта в $INSTALL_DIR ..."
        git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" || die "Не удалось скачать проект. Проверьте адрес: $REPO_URL"
    fi
    PROJECT="$INSTALL_DIR"
fi

chmod +x "$PROJECT/anim" "$PROJECT/tr" "$PROJECT/install.sh" 2>/dev/null || true

# Команда `anim` из любой папки. (Имя `tr` не берём: оно занято системной утилитой.)
if [ -n "${PREFIX:-}" ] && [ -d "$PREFIX/bin" ]; then
    ln -sf "$PROJECT/anim" "$PREFIX/bin/anim" && ok "Команда создана: anim"
fi
ok "Проект: $PROJECT"

if [ ! -d "$HOME/storage" ]; then
    echo ""
    warn "Общее хранилище не подключено. Чтобы видео попадало в галерею, выполните один раз:"
    say  "   termux-setup-storage"
fi

# ---------------------------------------------------------------------
# Самопроверка
# ---------------------------------------------------------------------
if [ "$RUN_TEST" -eq 1 ]; then
    echo ""
    say "→ Самопроверка (мини-рендер, около минуты)..."
    if node "$PROJECT/src/main.js" selftest; then
        RESULT="Всё готово."
    else
        RESULT="Установка завершена, но самопроверка нашла проблемы (см. выше)."
    fi
else
    RESULT="Установка завершена."
fi

echo ""
say "╔══════════════════════════════════════════════╗"
say "║  $RESULT"
say "║  Запуск: anim   (или: bash $PROJECT/anim)"
say "║  Пример: anim render $PROJECT/examples/demo.html"
say "╚══════════════════════════════════════════════╝"
echo ""
