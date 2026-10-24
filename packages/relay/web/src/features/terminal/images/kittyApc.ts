/**
 * Herdr hands pane images to its outer terminal as Kitty graphics, APC
 * sequences (`ESC _ G … ESC \`). xterm 5.5 parses APC but offers no hook for
 * it and drops the payload, while it does let a program register an OSC
 * handler. Swapping the introducer turns each graphics command into an OSC
 * the image layer handles in-band, so it sees the cursor exactly where Herdr
 * left it. The terminator `ESC \` ends an OSC as well, so only the introducer
 * changes.
 */

/** An OSC number nothing else uses; the bytes never leave this browser. */
export const KITTY_GRAPHICS_OSC = 5_522_771;

const ESC = 0x1b;
const APC = 0x5f; // `_`
const GRAPHICS = 0x47; // `G`
const OSC_INTRODUCER = new TextEncoder().encode(`\x1b]${KITTY_GRAPHICS_OSC};`);

/**
 * A stateful rewriter for the output stream. A chunk can end partway into an
 * introducer; those bytes are held until the next chunk says what they were.
 */
export function createKittyApcRewriter(): (chunk: Uint8Array) => Uint8Array {
  let held = new Uint8Array(0);
  return (chunk) => {
    const data = held.length ? concat(held, chunk) : chunk;
    held = new Uint8Array(0);
    let start = data.indexOf(ESC);
    if (start === -1) return data;
    const parts: Uint8Array[] = [];
    let copied = 0;
    for (; start !== -1; start = data.indexOf(ESC, start + 1)) {
      if (start + 2 >= data.length) {
        // `ESC` or `ESC _` at the very end: wait for what follows.
        const tail = data.subarray(start);
        if (tail.length === 1 || tail[1] === APC) {
          held = tail.slice();
          parts.push(data.subarray(copied, start));
          copied = data.length;
          break;
        }
        continue;
      }
      if (data[start + 1] !== APC || data[start + 2] !== GRAPHICS) continue;
      parts.push(data.subarray(copied, start), OSC_INTRODUCER);
      copied = start + 3;
    }
    if (!parts.length) return data;
    parts.push(data.subarray(copied));
    return concat(...parts);
  };
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
