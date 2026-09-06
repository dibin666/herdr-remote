'use strict';

/**
 * Exit codes the supervisor interprets.
 *
 * `REPLACED` means another host connector has taken over this workstation on
 * the relay. Restarting after that would make the two instances kick each other
 * off in turn, and every browser attached to the relay is disconnected on each
 * swap — the endless "Connection closed (1012). Retrying…" loop. So it is the
 * one exit the supervisor must respect rather than recover from.
 */
const EXIT_REPLACED = 12;

module.exports = { EXIT_REPLACED };
