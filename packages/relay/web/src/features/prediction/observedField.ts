import { type FieldCursor, type FieldScreen, ScreenReader, segmentAt } from './fieldScreen';
import type { InputField } from './inputField';

/** A candidate is a place to test echoes, never evidence that keys are text. */
export class ObservedField {
  private field: InputField | null = null;
  private prefix = '';
  private hidden = false;
  private generation = 0;

  detect(screen: FieldScreen, cursor: FieldCursor): InputField | null {
    const reader = new ScreenReader(screen);
    const { row, col } = cursor;
    if (row < reader.top || row > reader.bottom || col < 0 || col >= screen.cols) {
      this.reset();
      return null;
    }
    const segment = segmentAt(reader, row, col);
    if (!segment) {
      this.reset();
      return null;
    }
    const region = `${segment.start}-${segment.end}`;
    const previous = this.field;
    const startCol = previous?.startCol ?? col;
    // Include dimming so an overlay cannot inherit the field behind it.
    let prefix = '';
    for (let x = segment.start; x < startCol; x++) {
      prefix += `${reader.char(row, x) || ' '}\u0000${Number(reader.dim(row, x))}`;
    }
    if (
      previous &&
      previous.row === row &&
      previous.region === region &&
      this.hidden === cursor.hidden &&
      this.prefix === prefix &&
      col >= startCol &&
      !(col === startCol && previous.caretCol > startCol)
    ) {
      this.field = { ...previous, caretCol: col };
      return this.field;
    }

    this.generation++;
    this.prefix = '';
    for (let x = segment.start; x < col; x++) {
      this.prefix += `${reader.char(row, x) || ' '}\u0000${Number(reader.dim(row, x))}`;
    }
    this.hidden = cursor.hidden;
    this.field = {
      kind: 'observed',
      key: `observed:${this.generation}`,
      region,
      layout: `${row}`,
      row,
      caretCol: col,
      startCol: col,
      endCol: segment.end,
      // Neither placeholders nor protected prompt boundaries can be inferred here.
      empty: false,
      agentLike: false,
      vimInsert: null,
      modal: true,
      midWord: false,
      observed: true,
    };
    return this.field;
  }

  reset(): void {
    this.field = null;
  }
}
