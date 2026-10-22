import React, { useEffect, useState } from 'react';
import Console from './Console';

function App() {
  const [status, setStatus] = useState({
    state: 'loading',
    running: false
  });

  const [mode, setMode] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  // Получение состояния VM
  const refresh = async () => {
    try {
      const r = await fetch('/api/status');

      if (r.ok) {
        setStatus(await r.json());
      }
    } catch {
      setError('Backend недоступен');
    }
  };

  // Обновление состояния каждые 2 секунды
  useEffect(() => {
    refresh();

    const timer = setInterval(refresh, 2000);

    return () => clearInterval(timer);
  }, []);

  // Управление виртуальной машиной
  const command = async (action) => {
    setBusy(true);
    setError('');
    setMessage('');

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
        setMessage(
          'Виртуальная машина перезагружается. Подключитесь к SSH после загрузки Debian.'
        );
      }

      if (action === 'stop') {
        setMode(null);
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

  return (
    <main>
      <header>
        <div className="overline">
          QEMU 11.0.5 / DEBIAN 13
        </div>

        <h1>Управление виртуальной машиной</h1>

        <p>
          Статус:{' '}
          <span className={powered ? 'online' : 'offline'}>
            {status.state}
          </span>
        </p>
      </header>

      {/* Управление VM */}
      <section className="panel actions">
        <button
          disabled={busy || powered}
          onClick={() => command('start')}
        >
          ▶ Включить
        </button>

        <button
          disabled={busy || !powered}
          onClick={() => command('reboot')}
        >
          ↻ Перезагрузить
        </button>

        <button
          disabled={busy || !powered}
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
        <p role="status" className="online">
          {message}
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
            disabled={!powered}
            onClick={() => setMode('serial')}
          >
            Serial port
          </button>

          <button
            disabled={!powered}
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