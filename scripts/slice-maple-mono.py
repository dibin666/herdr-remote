#!/usr/bin/env python3
"""
Cut Maple Mono NL NF CN into the webfont slices under
packages/relay/web/public/fonts/maple-mono/, plus the stylesheet that
declares them.

The family is ~20 MB per weight. Served whole, a phone would fetch all of it
to draw one line of Chinese, so it is cut the way Google Fonts cuts CJK: the
common Hanzi in small slices grouped by frequency (taken from Google's own
Noto Sans SC slicing), the rare ones in large contiguous blocks, and the Nerd
Font icons in blocks of their own. A browser fetches a slice only once a
character in its `unicode-range` is drawn.

The rare blocks are declared *before* the frequency slices and their ranges
span the common characters too; CSS checks overlapping faces last-declared
first, so a common character always resolves to its small slice. That keeps
the stylesheet to one range list per common slice instead of one per block.

Usage (from the repo root, with the release's TTFs unpacked in <dir>):

  curl -LO https://github.com/subframe7536/maple-font/releases/download/v7.9/MapleMonoNL-NF-CN-unhinted.zip
  unzip MapleMonoNL-NF-CN-unhinted.zip -d /tmp/maple
  uv run --with 'fonttools[woff]==4.60.1' scripts/slice-maple-mono.py /tmp/maple
"""

import io
import multiprocessing
import os
import re
import shutil
import sys
import urllib.request

from fontTools import subset
from fontTools.ttLib import TTFont

VERSION = '7.9'
FAMILY = 'Herdr Maple Mono'
OUT_DIR = os.path.join('packages', 'relay', 'web', 'public', 'fonts', 'maple-mono')
URL_PREFIX = '/fonts/maple-mono/'
WEIGHTS = {400: 'Regular', 700: 'Bold'}
GOOGLE_CSS = 'https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400'
# Google numbers its Noto Sans SC slices so that the highest hold the most
# frequent characters; 100 and up cover nearly all of GB 2312 level one.
FREQUENT_FROM = 100
RARE_BLOCK_GLYPHS = 1200
ICON_BLOCK_GLYPHS = 600

LATIN = [(0x0000, 0x024F), (0x1E00, 0x1EFF), (0x2000, 0x206F), (0x20A0, 0x20CF), (0x2100, 0x214F)]
CJK = [
    (0x2E80, 0x2FDF), (0x3000, 0x9FFF), (0xF900, 0xFAFF), (0xFE30, 0xFE4F),
    (0xFF00, 0xFFEF), (0x20000, 0x3FFFF),
]
ICONS = [(0xE000, 0xF8FF), (0xF0000, 0x10FFFF)]


def within(cp, ranges):
    return any(lo <= cp <= hi for lo, hi in ranges)


def parse_range_list(text):
    out = set()
    for token in text.split(','):
        token = token.strip()[2:]
        lo, _, hi = token.partition('-')
        out.update(range(int(lo, 16), int(hi or lo, 16) + 1))
    return out


def frequency_slices():
    request = urllib.request.Request(
        GOOGLE_CSS,
        # Without a modern browser's agent Google serves one unsliced TTF.
        headers={'User-Agent': (
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) '
            'Chrome/130.0 Safari/537.36'
        )},
    )
    css = urllib.request.urlopen(request, timeout=60).read().decode()
    found = re.findall(r"\.(\d+)\.woff2\) format\('woff2'\);\s*unicode-range: ([^;]+);", css)
    if not found:
        sys.exit('no numbered slices in the Google Fonts stylesheet')
    slices = [(int(index), parse_range_list(ranges)) for index, ranges in found]
    return [cps for index, cps in sorted(slices) if index >= FREQUENT_FROM]


def blocks(cps, size, area):
    """
    Contiguous runs of `size` glyphs, each owning every code point up to the
    next run, but only inside `area`: a span crossing into another category
    (rare Hanzi reaching over the icon block) would be fetched for its icons.
    """
    cps = sorted(cps)
    runs = [cps[i : i + size] for i in range(0, len(cps), size)]
    spans = []
    for i, run in enumerate(runs):
        lo, hi = run[0], runs[i + 1][0] - 1 if i + 1 < len(runs) else run[-1]
        spans.append((run, [(max(lo, a), min(hi, b)) for a, b in area if a <= hi and lo <= b]))
    return spans


def compress(cps):
    ranges = []
    for cp in sorted(cps):
        if ranges and cp == ranges[-1][1] + 1:
            ranges[-1][1] = cp
        else:
            ranges.append([cp, cp])
    return [tuple(r) for r in ranges]


def css_ranges(ranges):
    return ', '.join(f'U+{lo:x}' if lo == hi else f'U+{lo:x}-{hi:x}' for lo, hi in ranges)


def cut(job):
    source, cps, target = job
    # The source's own timestamp, so cutting again yields the same bytes.
    font = TTFont(io.BytesIO(source_bytes(source)), recalcTimestamp=False)
    options = subset.Options()
    options.flavor = 'woff2'
    # Language-support metadata a browser never reads.
    options.drop_tables += ['meta']
    # Keeps the copyright and license strings the OFL requires.
    options.name_IDs = ['*']
    options.notdef_outline = True
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=cps)
    subsetter.subset(font)
    subset.save_font(font, target, options)
    return os.path.getsize(target)


_SOURCES = {}


def source_bytes(path):
    if path not in _SOURCES:
        with open(path, 'rb') as handle:
            _SOURCES[path] = handle.read()
    return _SOURCES[path]


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    src_dir = sys.argv[1]
    sources = {w: os.path.join(src_dir, f'MapleMonoNL-NF-CN-{name}.ttf') for w, name in WEIGHTS.items()}
    cmap = set(TTFont(sources[400], lazy=True).getBestCmap())

    icons = {cp for cp in cmap if within(cp, ICONS)}
    cjk = {cp for cp in cmap if within(cp, CJK)}
    latin = {cp for cp in cmap if within(cp, LATIN)}
    symbols = cmap - icons - cjk - latin

    frequent = [cps & cjk for cps in frequency_slices()]
    frequent = [cps for cps in frequent if cps]
    rare = cjk.difference(*frequent)

    # (name, glyphs, unicode-range, weights it is cut in). Declaration order is
    # the order here: later wins where ranges overlap.
    slices = []
    for i, (run, span) in enumerate(blocks(icons, ICON_BLOCK_GLYPHS, ICONS)):
        slices.append((f'icons-{i}', run, span, (400,)))
    for i, (run, span) in enumerate(blocks(rare, RARE_BLOCK_GLYPHS, CJK)):
        slices.append((f'cjk-rare-{i}', run, span, (400, 700)))
    slices.append(('symbols', sorted(symbols), compress(symbols), (400, 700)))
    slices.append(('latin', sorted(latin), compress(latin), (400, 700)))
    for i, cps in enumerate(frequent):
        slices.append((f'cjk-{i}', sorted(cps), compress(cps), (400, 700)))

    shutil.rmtree(OUT_DIR, ignore_errors=True)
    os.makedirs(OUT_DIR)
    jobs = [
        (sources[w], glyphs, os.path.join(OUT_DIR, f'maple-mono-{name}-{w}.woff2'))
        for name, glyphs, _, weights in slices
        for w in weights
    ]
    with multiprocessing.Pool() as pool:
        sizes = pool.map(cut, jobs)

    rules = []
    for name, _, ranges, weights in slices:
        for w in (400, 700):
            # Icons are the same drawing at every weight: one file serves both,
            # declared twice so bold text finds it under its own descriptors.
            file_weight = w if w in weights else weights[0]
            rules.append(
                '@font-face {\n'
                f"  font-family: '{FAMILY}';\n"
                f"  src: url('{URL_PREFIX}maple-mono-{name}-{file_weight}.woff2') format('woff2');\n"
                f'  font-weight: {w};\n'
                '  font-style: normal;\n'
                '  font-display: swap;\n'
                f'  unicode-range: {css_ranges(ranges)};\n'
                '}\n'
            )
    header = (
        f'/* Maple Mono NL NF CN {VERSION} (https://github.com/subframe7536/maple-font),\n'
        ' * SIL Open Font License 1.1, see OFL.txt. Generated by\n'
        ' * scripts/slice-maple-mono.py; do not edit. */\n'
    )
    with open(os.path.join(OUT_DIR, 'maple-mono.css'), 'w') as handle:
        handle.write(header + '\n'.join(rules))
    shutil.copy(os.path.join(src_dir, 'LICENSE.txt'), os.path.join(OUT_DIR, 'OFL.txt'))

    print(f'{len(jobs)} files, {sum(sizes) / 1e6:.1f} MB')


if __name__ == '__main__':
    main()
