import React, { useEffect, useRef, useState } from 'react';
import Console from './Console';

const REBOOT_NOTICE_MS = 8000;
const SHUTDOWN_COMPLETE_NOTICE_MS = 5000;
const SHUTDOWN_TIMEOUT_MS = 60000;

function App() {
  const [status, setStatus] = useState({
    state: 'loading',
    running: false
  });

  const [mode, setMode] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState(null);
  const [shutdownPending, setShutdownPending] = useState(false);

  const messageTimer = useRef(null);
  const shutdownTimer = useRef(null);
  const shutdownPendingRef = useRef(false);

  const clearMessageTimer = () => {
    if (messageTimer.current !== null) {
      clearTimeout(messageTimer.current);
      messageTimer.current = null;
    }
  };

  const showTemporaryMessage = (text, type, duration) => {
    clearMessageTimer();
    setMessage({ text, type });
    messageTimer.current = setTimeout(() => {
      setMessage(null);
      messageTimer.current = null;
    }, duration);
  };

  // Получение состояния VM
  const refresh = async () => {
    try {
      const r = await fetch('/api/status');

      if (r.ok) {
        const current = await r.json();
        setStatus(current);

        // ACPI shutdown асинхронный: QEMU может завершиться позднее ответа /api/stop.
        if (current.state === 'off' && shutdownPendingRef.current) {
          shutdownPendingRef.current = false;
          setShutdownPending(false);
          clearTimeout(shutdownTimer.current);
          shutdownTimer.current = null;
          showTemporaryMessage(
            'Виртуальная машина выключена.',
            'success',
            SHUTDOWN_COMPLETE_NOTICE_MS
          );
        }
      }
    } catch {
      setError('Backend недоступен');
    }
  };

  // Обновление состояния каждые 2 секунды
  useEffect(() => {
    refresh();

    const timer = setInterval(refresh, 2000);

    return () => {
      clearInterval(timer);
      clearMessageTimer();
      clearTimeout(shutdownTimer.current);
    };
  }, []);

  // Управление виртуальной машиной
  const command = async (action) => {
    setBusy(true);
    setError('');
    clearMessageTimer();
    setMessage(null);

    try {
      const r = await fetch(`/api/${action}`, {
        method: 'POST'
      });

      const data = await r.json();

      if (!r.ok) {
        throw new Error(data.detail || 'Ошибка API');
      }

      if (action === 'reboot') {
        setMode(null);
        showTemporaryMessage(
          'Виртуальная машина перезагружается. Подождите загрузки Debian.',
          'info',
          REBOOT_NOTICE_MS
        );
      }

      if (action === 'stop') {
        setMode(null);
        shutdownPendingRef.current = true;
        setShutdownPending(true);
        setMessage({
          text: 'Виртуальная машина выключается… Подождите завершения работы Debian.',
          type: 'warning'
        });

        // Если гостевая ОС не завершила работу, возвращаем возможность повторить команду.
        clearTimeout(shutdownTimer.current);
        shutdownTimer.current = setTimeout(() => {
          if (!shutdownPendingRef.current) return;
          shutdownPendingRef.current = false;
          setShutdownPending(false);
          setMessage({
            text: 'Выключение занимает больше минуты. Проверьте VM или повторите команду.',
            type: 'warning'
          });
          shutdownTimer.current = null;
        }, SHUTDOWN_TIMEOUT_MS);
      }

      await refresh();
    } catch (e) {
      setError(String(e.message));
    } finally {
      setBusy(false);
    }
  };

  const powered =
    status.state !== 'off' &&
    status.state !== 'loading';

  const statusText = shutdownPending && status.state !== 'off'
    ? 'выключается…'
    : status.state;

  return (
    <main>
      <header>
        <div className="overline">
          QEMU 11.0.5 / DEBIAN 13
        </div>

        <h1>Управление виртуальной машиной</h1>

        <p>
          Статус:{' '}
          <span className={powered && !shutdownPending ? 'online' : 'offline'}>
            {statusText}
          </span>
        </p>
      </header>

      {/* Управление VM */}
      <section className="panel actions">
        <button
          disabled={busy || shutdownPending || powered}
          onClick={() => command('start')}
        >
          ▶ Включить
        </button>

        <button
          disabled={busy || shutdownPending || !powered}
          onClick={() => command('reboot')}
        >
          ↻ Перезагрузить
        </button>

        <button
          disabled={busy || shutdownPending || !powered}
          onClick={() => command('stop')}
        >
          ■ Выключить
        </button>
      </section>

      {/* Ошибки */}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {/* Информационные сообщения */}
      {message && (
        <p role="status" className={`notice ${message.type}`}>
          {message.text}
        </p>
      )}

      {/* Выбор терминала */}
      <section className="panel">
        <h2>Консоль</h2>

        <p>
          Выберите способ подключения.
          SSH доступен после загрузки гостевой системы.
        </p>

        <div className="actions">
          <button
            disabled={!powered || shutdownPending}
            onClick={() => setMode('serial')}
          >
            Serial port
          </button>

          <button
            disabled={!powered || shutdownPending}
            onClick={() => setMode('ssh')}
          >
            SSH терминал
          </button>
        </div>
      </section>

      {/* Терминал */}
      {mode && (
        <Console
          key={mode}
          mode={mode}
          onClose={() => setMode(null)}
        />
      )}
    </main>
  );
}

export default App;