// A canned action a browser window asks for on one pane of the workstation's
// Herdr: jump to it, or jump and press the key it is waiting on.
//
// Every action focuses the pane first: the keys that follow must land in the
// pane the user was looking at, not wherever Herdr happens to point. That
// focus is global — `pane.focus` moves every client attached to this Herdr,
// which is the price of the phone showing the right pane when it acts.
//
// The keys are fixed here rather than chosen by the window: `enter` answers
// the highlighted option of a blocked agent's prompt, `escape` dismisses it,
// and `ctrl+c` interrupts a running agent.

import { requestHerdr } from '../herdr-api.js';
import { createTranslator, detectLocale } from '../i18n/index.js';
import type { RelayPaneActionMessage } from 'herdr-remote-relay/protocol';

const ACTION_KEYS: Record<Exclude<RelayPaneActionMessage['action'], 'focus'>, string[]> = {
  approve: ['enter'],
  reject: ['escape'],
  interrupt: ['ctrl+c'],
};

/** Run one canned action on a pane of this workstation's Herdr. */
export async function runPaneAction({
  socketPath,
  paneId,
  action,
  request = requestHerdr,
}: {
  socketPath: string;
  paneId: string;
  action: RelayPaneActionMessage['action'];
  request?: typeof requestHerdr;
}): Promise<void> {
  await request(socketPath, 'pane.focus', { pane_id: paneId });
  if (action === 'focus') return;
  await request(socketPath, 'pane.send_keys', { pane_id: paneId, keys: ACTION_KEYS[action] });
}

/** Run the action for a browser window, and tell that window when it could not. */
export async function runPaneActionFor(
  streamId: string | null,
  message: RelayPaneActionMessage,
  options: {
    socketPath: string;
    language?: string;
    send: (payload: unknown) => void;
    request?: typeof requestHerdr;
  },
): Promise<void> {
  const t = createTranslator(detectLocale({ preference: options.language }));
  try {
    await runPaneAction({
      socketPath: options.socketPath,
      paneId: message.paneId,
      action: message.action,
      ...(options.request ? { request: options.request } : {}),
    });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    process.stderr.write(`herdr-remote host connector: pane action failed: ${text}\n`);
    options.send({
      type: 'error',
      clientId: streamId,
      code: 'pane_action_failed',
      message: t('agents.actionFailed', { error: text }),
    });
  }
}
