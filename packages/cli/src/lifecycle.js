'use strict';

// Start/stop/restart that respect the keep-alive manager.
//
// When systemd or launchd supervises the services, killing the processes just
// makes the manager start them again — and starting them by hand produces a
// second, unmanaged copy fighting for the port. Every entry point goes through
// here so the managed and unmanaged paths behave the same from the outside.

const { loadConfig } = require('./config');
const keepalive = require('./keepalive');
const { restartServices, startServices, statusServices, stopServices } = require('./service');

function managerInUse(config) {
  const status = keepalive.status(config);
  return status.installed || status.active ? status : null;
}

function startAll(config = loadConfig()) {
  const managed = managerInUse(config);
  if (managed) {
    // Start means "make it run", not "restart it". Herdr runs this through the
    // plugin's startup hook every time a Herdr server starts, and a restart
    // there dropped every browser attached to the workstation — including the
    // one that had just asked for that Herdr to be started.
    if (!managed.active) keepalive.restart(config);
    return { ok: true, managed: true, manager: managed.manager, alreadyRunning: Boolean(managed.active) };
  }
  return { ...startServices(), managed: false };
}

function stopAll(config = loadConfig()) {
  const result = keepalive.stopManaged(config);
  if (result.managed) {
    // The manager stops the supervisor, which stops its children; clear the
    // recorded pids so status does not report ghosts.
    stopServices();
    return { ok: true, managed: true, manager: result.manager };
  }
  return { ...stopServices(), managed: false };
}

function restartAll(config = loadConfig()) {
  const managed = managerInUse(config);
  if (managed) {
    keepalive.restart(config);
    return { ok: true, managed: true, manager: managed.manager };
  }
  return { ...restartServices(), managed: false };
}

/** Service status plus the keep-alive picture, which is what the TUI shows. */
async function fullStatus(config = loadConfig()) {
  const [services, keepaliveStatus] = [await statusServices(), keepalive.status(config)];
  return {
    ...services,
    keepalive: keepaliveStatus,
    logsHint: keepalive.logsHint(config),
  };
}

module.exports = { startAll, stopAll, restartAll, fullStatus, managerInUse };
