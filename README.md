# QEMU Web Console — Debian 13 / QEMU 11.0.5

Веб-приложение для управления **одной** виртуальной машиной Debian 13 (Trixie).

- **Backend:** Python, FastAPI, QMP, AsyncSSH, WebSocket.
- **Frontend:** React, xterm.js, Nginx.
- **Запуск:** Docker Compose; QEMU 11.0.5 компилируется при сборке backend.

## Архитектура

```text
Браузер (127.0.0.1:8080)
    │
    └── Nginx + React ── /api/* ── FastAPI
                                    ├── QMP unix socket ── QEMU 11.0.5
                                    ├── Serial unix socket ── ttyS0
                                    └── AsyncSSH ── localhost:2222 ── Debian:22
```

Backend запускает процесс QEMU через `subprocess.Popen()`, затем использует QMP для управления им. 

## Почему QEMU собирается из исходников

В тестовом задании требуется **QEMU 11.0.5**. Версия пакета `qemu-system-x86`, доступная через `apt` в Debian 13 (Trixie), отличается от указанной, поэтому обычное `apt install qemu-system-x86` не гарантирует соблюдение требования.

В `backend/Dockerfile` используется **multi-stage сборка**:

1. В образе `debian:trixie` скачивается исходный архив QEMU 11.0.5 и собирается только эмулятор `x86_64-softmmu`, без графического интерфейса.
2. В итоговый образ `python:3.13-slim-trixie` копируется установленный QEMU и добавляются Python-зависимости backend.

Так компиляторы и исходники QEMU не попадают в итоговый runtime-образ. QEMU компилируется **во время сборки контейнерного образа, а не при каждом запуске виртуальной машины**. При повторной сборке Docker/Podman может использовать кэш, если соответствующие слои не изменились.

### Альтернативный вариант

Вместо компиляции можно использовать готовый Docker-образ [`pboqemu/qemu-releases:v11.0.5`](https://hub.docker.com/r/pboqemu/qemu-releases), содержащий QEMU 11.0.5. Наличие нужной версии было проверено командой:

```bash
docker run --rm pboqemu/qemu-releases:v11.0.5 qemu-system-x86_64 --version
```

Однако для его использования потребуется адаптировать Dockerfile и обеспечить совместимость готовых бинарных файлов QEMU с окружением Python backend.

В текущей реализации оставлена сборка из исходников, поскольку она позволяет контролировать конфигурацию QEMU и не зависеть от стороннего готового образа.

## Требования

- Linux x86_64 с Docker Engine и плагином Docker Compose
- Рекомендуется не менее 4 ГБ доступной оперативной памяти и примерно 25 ГБ свободного места для первой сборки
- Доступ к `/dev/kvm` для быстрой виртуализации
- На хосте: `curl`, `qemu-img`, `cloud-localds`, `ssh-keygen`, `python3`, `openssl`

Установка зависимостей подготовки на Ubuntu/Debian:

```bash
sudo apt-get update
sudo apt-get install -y curl qemu-utils cloud-image-utils openssh-client python3 openssl
```

## Первый запуск

### Подготовка виртуальной машины

```bash
cp .env.example .env
```

Настройте имя пользователя и пароль в `.env`.

```bash
./scripts/prepare-image.sh
```

### Сборка и запуск

```bash
docker compose up -d --build
```

Откройте **http://127.0.0.1:8080**.

### Остановка

```bash
docker compose down
```

### Без `/dev/kvm`

Включите программную эмуляцию TCG:

```bash
docker compose -f compose.yaml -f compose.no-kvm.yaml config
docker compose -f compose.yaml -f compose.no-kvm.yaml up -d --build
```

Вторая конфигурация удаляет устройство `/dev/kvm` через `!reset`. Требуется достаточно свежий Docker Compose с поддержкой `!reset`.

## Как пользоваться

1. Нажмите **Включить** и дождитесь загрузки Debian. При первом запуске `cloud-init` потребуется дополнительное время.
2. **SSH терминал** подключается автоматически по приватному SSH-ключу, который хранится только в `data/keys/` на хосте.
3. **Serial port** показывает сообщения загрузки. Нажмите Enter, введите `VM_USER` и пароль `VM_PASSWORD` из `.env`.
4. **Перезагрузить** отправляет QMP `system_reset` (жёсткий reset). SSH-соединение прервётся; после загрузки откройте его снова.
5. **Выключить** отправляет QMP `system_powerdown` (ACPI). Завершение работы может занять несколько секунд.

`VM_USER` и `VM_PASSWORD` используются **только при первоначальной настройке новой VM**. Изменение `.env` не изменяет пользователей или пароли на уже созданном диске. 

Диск `data/debian.qcow2` — QCOW2 overlay с виртуальным размером 20 ГБ: на SSD он занимает только реально записанные данные

## API

| Действие | Маршрут | Реализация |
|---|---|---|
| Статус | `GET /api/status` | QMP `query-status` |
| Включение | `POST /api/start` | Запуск QEMU, проверка QMP |
| Перезагрузка | `POST /api/reboot` | QMP `system_reset` |
| Выключение | `POST /api/stop` | QMP `system_powerdown` |
| Serial | `WS /api/terminal/serial` | Unix socket, WebSocket, xterm.js |
| SSH | `WS /api/terminal/ssh` | AsyncSSH, WebSocket, xterm.js |

Если QEMU-процесс жив, но QMP ещё недоступен, статус отображается как `unknown`, а не как `off`.

## Команды и диагностика

```bash
docker compose logs -f backend          # логи backend
cat data/run/qemu.log                   # stderr/stdout QEMU
curl http://127.0.0.1:8080/api/status   # проверить API
```
