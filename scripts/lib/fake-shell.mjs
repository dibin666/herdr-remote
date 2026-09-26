/**
 * A shell just capable enough to exercise predictive echo: it echoes what is
 * typed, edits the line (Backspace, Ctrl+C, Ctrl+L), answers Enter, and
 * answers `flood` with a 2000-line burst. `send` writes to the terminal;
 * setting `session.stopped` ends a burst in progress.
 */

/**
 * Handle rapid burst mode (2000 lines) for throughput and compression verification.
 */
function triggerFlood(session, send) {
  if (session.flooding) return;
  session.flooding = true;

  const TOTAL_LINES = 2000;
  const BATCH_SIZE = 100;
  let currentLine = 1;

  function sendBatch() {
    if (session.stopped) {
      session.flooding = false;
      return;
    }

    const endLine = Math.min(TOTAL_LINES, currentLine + BATCH_SIZE - 1);
    let chunk = '';
    for (let i = currentLine; i <= endLine; i++) {
      const pad = String(i).padStart(4, '0');
      chunk += `[flood ${pad}/2000] herdr burst benchmark payload line ${pad} -- abcdefghijklmnopqrstuvwxyz 0123456789\r\n`;
    }

    send(chunk);
    currentLine = endLine + 1;

    if (currentLine <= TOTAL_LINES) {
      setImmediate(sendBatch);
    } else {
      session.flooding = false;
      send('\r\n[flood] Finished 2000 lines.\r\n$ ');
    }
  }

  sendBatch();
}

/**
 * Process incoming keystrokes and line editing for a session.
 */
export function handleShellInput(session, payload, send) {
  const text = payload.toString('utf8');
  let echoAccumulator = '';

  const flushEcho = () => {
    if (echoAccumulator.length > 0) {
      send(echoAccumulator);
      echoAccumulator = '';
    }
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const code = text.charCodeAt(i);

    // Skip ANSI escape sequences (e.g. arrow keys, CSI sequences)
    if (code === 0x1b) {
      flushEcho();
      if (i + 1 < text.length && (text[i + 1] === '[' || text[i + 1] === 'O')) {
        i += 2;
        while (i < text.length && text.charCodeAt(i) >= 0x20 && text.charCodeAt(i) <= 0x3f) {
          i += 1;
        }
        if (i < text.length && text.charCodeAt(i) >= 0x40 && text.charCodeAt(i) <= 0x7e) {
          i += 1;
        }
      } else {
        i += 1;
      }
      continue;
    }

    // Ctrl+C (0x03)
    if (code === 0x03) {
      flushEcho();
      session.lineBuffer = '';
      send('^C\r\n$ ');
      i += 1;
      continue;
    }

    // Ctrl+L (0x0c) - Clear Screen
    if (code === 0x0c) {
      flushEcho();
      send(`\x1b[2J\x1b[H$ ${session.lineBuffer}`);
      i += 1;
      continue;
    }

    // Enter (\r or \n)
    if (ch === '\r' || ch === '\n') {
      if (ch === '\n' && session.lastWasCr) {
        session.lastWasCr = false;
        i += 1;
        continue;
      }
      session.lastWasCr = ch === '\r';
      flushEcho();

      const command = session.lineBuffer.trim();
      session.lineBuffer = '';

      if (command === 'flood') {
        send('\r\n');
        triggerFlood(session, send);
      } else {
        const resultLine =
          command.length > 0
            ? `[fake-shell] command executed: ${command}\r\n`
            : `[fake-shell] ok\r\n`;
        send(`\r\n${resultLine}$ `);
      }
      i += 1;
      continue;
    }

    session.lastWasCr = false;

    // Backspace (0x7f or 0x08)
    if (code === 0x7f || code === 0x08) {
      flushEcho();
      if (session.lineBuffer.length > 0) {
        session.lineBuffer = session.lineBuffer.slice(0, -1);
        send('\b \b');
      }
      i += 1;
      continue;
    }

    // Printable character: echo as-is for predictive echo confirmation
    if (code >= 32 && code !== 0x7f) {
      session.lineBuffer += ch;
      echoAccumulator += ch;
      i += 1;
      continue;
    }

    i += 1;
  }

  flushEcho();
}
