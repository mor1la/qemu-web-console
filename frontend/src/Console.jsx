import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

function Console({ mode, onClose }) {
  const host = useRef(null);

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      theme: { background: '#101927' }
    });

    const fit = new FitAddon();

    term.loadAddon(fit);
    term.open(host.current);
    fit.fit();

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

    const ws = new WebSocket(
      `${protocol}//${location.host}/api/terminal/${mode}`
    );

    term.writeln(`Connecting to ${mode.toUpperCase()}...`);

    ws.onmessage = (ev) => {
      term.write(ev.data);
    };

    ws.onerror = () => {
      term.writeln('\r\n[Connection error]');
    };

    ws.onclose = () => {
      term.writeln('\r\n[Disconnected]');
    };

    const sendResize = () => {
      fit.fit();

      if (mode === 'ssh' && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'resize',
          cols: term.cols,
          rows: term.rows
        }));
      }
    };

    ws.onopen = sendResize;

    const input = term.onData((data) => {
      if (ws.readyState !== WebSocket.OPEN) return;

      ws.send(
        mode === 'ssh'
          ? JSON.stringify({ type: 'input', data })
          : data
      );
    });

    window.addEventListener('resize', sendResize);

    return () => {
      window.removeEventListener('resize', sendResize);
      input.dispose();
      ws.close();
      term.dispose();
    };
  }, [mode]);

  return (
    <section className="panel">
      <div className="consoleHead">
        <strong>
          {mode === 'ssh' ? 'SSH · debian@vm' : 'Serial · ttyS0'}
        </strong>

        <button onClick={onClose}>
          Закрыть
        </button>
      </div>

      <div className="terminal" ref={host} />
    </section>
  );
}

export default Console;