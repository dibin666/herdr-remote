import type { Terminal } from '@xterm/xterm';

/** Herdr's name in large letters, with a title and subtitle beside it. */
export function writeBanner(term: Terminal, bannerTitle: string, bannerSubtitle: string): void {
  term.writeln('  ___ ___               .___      ');
  term.writeln(` /   |   \\  ____ _______| _/______   \x1b[1m${bannerTitle}\x1b[0m`);
  term.writeln(`/    ~    \\/ __ \\\\_  __ \\ __/  ___/   \x1b[2m${bannerSubtitle}\x1b[0m`);
  term.writeln('\\    Y    /  ___/ |  | \\/|_ \\___ \\ ');
  term.writeln(' \\___|_  / \\___  >|__|  /___/____  >');
  term.writeln('       \\/      \\/                \\/ ');
  term.writeln('');
}
