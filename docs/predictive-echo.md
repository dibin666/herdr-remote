# Predictive echo

Predictive echo uses terminal behaviour, without requiring an agent or operating-system allowlist. Unknown TUI inputs, editors, custom shell prompts and Windows terminals can learn to show typing before its remote echo arrives. Recognized prompt and box shapes still provide useful editing boundaries and mode hints.

## How it works

1. **Observe.** An unknown layout gets a candidate region at the cursor, bounded by pane edges. A hidden terminal cursor is allowed because many TUIs paint their own caret.
2. **Learn.** Predictions initially stay invisible. Two changed character cells, matched by real output with the cursor advancing past them on the same row, establish confidence. Existing text, blank erasures and background redraws do not establish confidence. Recognized fields retain their existing one-echo warm-up.
3. **Render.** Further input appears in a separate overlay, with the style learned from the echoed cells. Canvas and DOM renderers use the same predictions. Predicted text never enters xterm's authoritative buffer or changes the bytes sent to the host.
4. **Reconcile.** Compare parsed output with predictions after synchronized frames finish. Matching predictions disappear; mismatches discard the run and its confidence. Unknown regions also relearn after control keys, pointer actions, changed prompt context, cursor visibility changes, or a move to another row. Reconnects and resizes reset learning.
5. **Expire.** A timer clears unanswered predictions even when both endpoints are silent. The deadline follows observed echo latency, within 1.5–4 seconds. An unknown region loses confidence after expiry.

`Auto` shows learned predictions when measured echo latency exceeds 40 ms. `Always On` removes the latency threshold; it still requires evidence of echoing. `Off` hides the overlay. The debug HUD shows `observed` for an unrecognized candidate region.

## Limits and validation

Uniform behaviour means the same learning and correction rules across platforms, not immediate prediction of every possible action. From terminal pixels alone, a client cannot know whether the next key inserts text, invokes a command, changes modes, or enters a password. Unchanged/masked output does not train the unknown-field predictor. A program can still change behaviour without any visible signal; wrong guesses are withdrawn when feedback arrives or the deadline expires.

Backspaces are limited to known editable text; unknown regions protect everything before their initial caret. Edge wrapping, arbitrary cursor navigation, emoji with uncertain widths and application-specific edits wait for authoritative output. This avoids assuming one program's editing semantics apply to another.

Regression coverage includes custom and hidden-cursor TUIs, unframed editing, simulated CMD and custom PowerShell prompts, narrow screens, Chinese wide cells, masking, menu-text coincidences, mode changes, expiry, and DOM fallback. Real xterm parser tests cover incremental ANSI output, alternate screens and synchronized redraws split across writes. These are deterministic terminal-output tests; they do not constitute live validation of every agent or a Windows host.

A local Chromium check also verifies DOM overlay position, wide-cell sizing, learned colours and the untouched authoritative buffer. Mismatch diagnostics omit raw characters so masked input does not appear in the debug HUD.

The design follows the tentative-epoch and authoritative-overlay approach described in the [Mosh paper](https://mosh.org/mosh-paper.pdf) and its [prediction implementation](https://github.com/mobile-shell/mosh/blob/master/src/frontend/terminaloverlay.cc), located with Exa. Unlike Mosh, this stream protocol has no application-level echo acknowledgment: a transport receipt alone must not be treated as proof that the application rendered an input.
