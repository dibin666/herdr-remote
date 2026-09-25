import React from 'react';
import { render } from 'ink';
import { App } from './App.js';
import { MouseProvider, createMouseSource } from './mouse/index.js';
import { enterFullScreen, restoreTerminal } from './terminal.js';
import { configExists, type Locale } from './api.js';

export { App } from './App.js';
export { Wizard } from './screens/Wizard.js';

export type StartTuiOptions = { language?: Locale | null };

export async function startTui({ language = null }: StartTuiOptions = {}): Promise<void> {
  const needsWizard = !configExists();
  const mouse = createMouseSource(process.stdin, process.stdout);

  // Before render: Ink draws from wherever the cursor is, and the mouse hit
  // test assumes the app starts at row 1.
  enterFullScreen();

  const instance = render(
    <MouseProvider source={mouse}>
      <App initialLanguage={language} needsWizard={needsWizard} />
    </MouseProvider>,
    { stdin: mouse.stdin, exitOnCtrlC: false },
  );

  const cleanup = () => {
    mouse.dispose();
    restoreTerminal();
  };
  const onSignal = () => {
    instance.unmount();
    cleanup();
    process.exit(0);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.once('exit', cleanup);

  try {
    await instance.waitUntilExit();
  } finally {
    cleanup();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
