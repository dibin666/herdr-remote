import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { type ITheme, Terminal } from '@xterm/xterm';
import { openTerminalLink } from './terminalLinks';

/**
 * The xterm instance, with wide-character widths and links. The only palette
 * in play is the host's, when the host could report one. There is no client
 * theme and no `minimumContrastRatio`, so every SGR/OSC color the Herdr host
 * emits reaches the screen unaltered.
 */
export function createTerminal({
  fontSize,
  fontFamily,
  theme,
  cols,
  rows,
}: {
  fontSize: number;
  fontFamily: string;
  theme: ITheme | null | undefined;
  cols: number;
  rows: number;
}): Terminal {
  const term = new Terminal({
    fontSize,
    fontFamily,
    lineHeight: 1.15,
    ...(theme ? { theme: { ...theme } } : {}),
    allowProposedApi: true,
    convertEol: true,
    scrollback: 5000,
    // `drawBoldTextInBrightColors` is deliberately not set: forcing it would
    // be this client recoloring the host's bold text. xterm's own default
    // stands, which is what the mainstream host emulators do as well.
    cols,
    rows,
    screenReaderMode: false,
    // An OSC 8 hyperlink resolves in *this* browser. Herdr would open it on
    // the workstation, which is no use to the phone reading it.
    linkHandler: {
      activate: (_event, uri) => {
        openTerminalLink(uri);
      },
    },
  });

  try {
    const unicode11Addon = new Unicode11Addon();
    term.loadAddon(unicode11Addon);
    term.unicode.activeVersion = '11';
  } catch (e) {
    console.debug('Unicode11 addon unavailable, using default width table:', e);
  }

  try {
    // Bare URLs printed as text, which is most of what an agent produces.
    // While a pane has mouse reporting on, xterm hands clicks to the pane and
    // this layer only answers with Shift held — the bypass every emulator
    // shares. Touch has no Shift, which is what the long-press menu is for.
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        openTerminalLink(uri);
      }),
    );
  } catch (e) {
    console.debug('WebLinks addon unavailable, URLs stay plain text:', e);
  }
  return term;
}
