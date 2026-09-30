# Predictive echo

Predictive echo only runs inside an identified editable input field. Recognized prompt and box shapes supply editing boundaries and mode hints without an operating-system allowlist. Menus, output text, read-only screens and unknown layouts do not enable prediction, even if their output happens to match typed characters.

## How it works

1. **Locate the input.** The focused cursor must be inside a recognized prompt or input box. A hidden cursor is allowed only in a recognized box that supports it. Unknown regions have no fallback candidate.
2. **Learn.** Predictions initially stay invisible until an actual echo confirms the input field's behaviour. Echo confidence never grants permission to predict outside the field.
3. **Render.** Further input appears in a separate overlay, with the style learned from echoed cells. Canvas and DOM renderers use the same predictions. Predicted text never enters xterm's authoritative buffer or changes bytes sent to the host.
4. **Reconcile.** Compare parsed output with predictions after synchronized frames finish. Matching predictions disappear; mismatches discard the run and its confidence. Leaving an editable field clears pending predictions and its confidence, including when no input was pending or a run was frozen by a control key. Returning to the input requires a fresh echo. Reconnects and resizes reset learning.
5. **Expire.** A timer clears unanswered predictions even when both endpoints are silent. The deadline follows observed echo latency, within 1.5–4 seconds.

`Auto` shows learned predictions when measured echo latency exceeds 40 ms. `Always On` removes the latency threshold; it still requires an identified input field and evidence of echoing. `Off` hides the overlay.

## Local latency test WebUI

To use your **real system terminals and agents**, run `npm run build`, then `RELAY_DEV_LATENCY_MS=200 node scripts/real-terminal-preview.mjs`. This connects to the existing Herdr server using the workstation's configuration, with separate preview credentials and state. Open `http://127.0.0.1:8899/__test__` for the latency panel and pairing. Ctrl+C stops the preview connector and relay; the existing Herdr server stays running.

Run `npm run build`, then `RELAY_DEV_LATENCY_MS=400 node scripts/e2e-latency-harness.mjs`. Open the printed **Test WebUI** address (normally `http://127.0.0.1:8899/__test__`). The panel offers presets and custom extra round-trip delays from 0 to 5000 ms; each direction receives half. Changes wait for queued frames to finish so switching to zero cannot reorder input. The terminal stays connected while changing latency.

This uses a simulated shell. Type one character and wait for its echo, then type and backspace. Compare predictive echo modes in WebUI settings; Auto's smoothed latency needs several echoes to adjust. The latency panel and its HTTP routes are installed only by the test harness.

## Limits and validation

An unfamiliar TUI input must first be recognized as editable before prediction can be enabled. A matching output character or moving cursor alone is insufficient. This conservative rule prioritizes keeping predictions out of non-input areas over predicting on every interface.

Backspaces are limited to known editable text. Edge wrapping, arbitrary cursor navigation, emoji with uncertain widths and application-specific edits wait for authoritative output. Terminal screens cannot reveal every application's hidden state; field detection supplies the required boundary, and actual echoes validate typing within it.

Regression coverage includes recognized rule boxes, shell prompts, simulated CMD and PowerShell prompts, narrow screens and Chinese wide cells. Negative tests feed coincidental matching output into blank regions, output text, unknown prompts, Herdr help, less, Vim normal mode and agent menus: none may enable prediction. Tests also cover leaving and returning to input fields, expiry, masking and DOM fallback. Real xterm parser tests cover incremental ANSI output, alternate screens and synchronized redraws split across writes. These do not constitute live validation of every agent or a Windows host.

DOM overlay position, wide-cell sizing, learned colours and the untouched authoritative buffer were also checked in local Chromium. Mismatch diagnostics omit raw characters so masked input does not appear in the debug HUD.

The echo verification and authoritative-overlay design references the [Mosh paper](https://mosh.org/mosh-paper.pdf) and its [prediction implementation](https://github.com/mobile-shell/mosh/blob/master/src/frontend/terminaloverlay.cc), located with Exa. This implementation additionally requires a recognized editable field; it does not learn input locations from arbitrary output. A transport receipt alone is not proof that an application rendered an input.
