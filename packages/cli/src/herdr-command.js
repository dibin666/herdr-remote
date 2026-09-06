'use strict';

// How a spawned Herdr is located.
//
// `HERDR_BIN_PATH` is what the service layer hands to the host connector, and
// it is also the escape hatch for an install that is not on `PATH`.

function resolveHerdrCommand() {
  return process.env.HERDR_BIN_PATH || 'herdr';
}

module.exports = { resolveHerdrCommand };
