'use strict';

// Render tests for the Ink interface.
//
// The TUI is TypeScript/JSX, so each run bundles it into a temporary file with
// the same esbuild settings as the shipped build and imports that. Testing the
// artifact rather than the sources means a build-level mistake (a bad banner, a
// dependency that cannot resolve at runtime) fails here too.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PACKAGE_ROOT = path.join(__dirname, '..');

let bundlePromise = null;

async function loadTui() {
  if (!bundlePromise) {
    bundlePromise = (async () => {
      const { build } = await import('esbuild');
      const { cjsBanner } = await import('../scripts/cjs-banner.mjs');
      // Inside the package tree, not the system temp directory: the bundle
      // leaves ink and react external, so Node must be able to resolve them
      // from the importing file's location. node_modules/.cache is never
      // published, so nothing leaks into the tarball.
      const directory = path.join(PACKAGE_ROOT, 'node_modules', '.cache', 'herdr-remote-tui-test');
      fs.mkdirSync(directory, { recursive: true });
      const outfile = path.join(directory, 'tui.mjs');
      await build({
        entryPoints: [path.join(PACKAGE_ROOT, 'tui', 'src', 'index.tsx')],
        outfile,
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node22',
        packages: 'external',
        jsx: 'automatic',
        logLevel: 'silent',
        banner: { js: cjsBanner },
        define: { __APP_VERSION__: JSON.stringify('test') },
      });
      return import(pathToFileURL(outfile).href);
    })();
  }
  return bundlePromise;
}

function withTemporaryHome() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-remote-tui-home-'));
  process.env.HERDR_REMOTE_CONFIG_DIR = path.join(directory, 'config');
  process.env.HERDR_REMOTE_STATE_DIR = path.join(directory, 'state');
  return () => fs.rmSync(directory, { recursive: true, force: true });
}

function writeConfig(contents) {
  const target = path.join(process.env.HERDR_REMOTE_CONFIG_DIR, 'config.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(contents));
}

/** Mount a screen. The mouse layer degrades to keyboard-only without a provider. */
async function mount(element) {
  const [{ render }, React] = await Promise.all([
    import('ink-testing-library'),
    import('react'),
  ]);
  const instance = render(element);
  // Let the first effects (status fetch, registration probe) settle.
  await new Promise((resolve) => setTimeout(resolve, 60));
  return instance;
}

test('the overview renders the service picture in English', async (t) => {
  const cleanup = withTemporaryHome();
  t.after(cleanup);
  writeConfig({ ui: { language: 'en' }, relay: { mode: 'local', port: 8787 } });

  const [{ App }, React] = await Promise.all([loadTui(), import('react')]);
  const instance = await mount(React.createElement(App, { initialLanguage: 'en', needsWizard: false }));
  t.after(() => instance.unmount());

  const output = instance.lastFrame();
  assert.match(output, /Herdr Remote/);
  assert.match(output, /Overview/);
  assert.match(output, /Access mode/);
  assert.match(output, /This machine only/);
  assert.match(output, /http:\/\/127\.0\.0\.1:8787/);
});

test('the interface switches to Chinese from the saved preference', async (t) => {
  const cleanup = withTemporaryHome();
  t.after(cleanup);
  writeConfig({ ui: { language: 'zh' }, relay: { mode: 'local', port: 8787 } });

  const [{ App }, React] = await Promise.all([loadTui(), import('react')]);
  const instance = await mount(React.createElement(App, { initialLanguage: null, needsWizard: false }));
  t.after(() => instance.unmount());

  const output = instance.lastFrame();
  assert.match(output, /概览/);
  assert.match(output, /访问方式/);
  assert.match(output, /仅本机/);
  assert.equal(/Access mode/.test(output), false);
});

test('an explicit language flag overrides the saved preference', async (t) => {
  const cleanup = withTemporaryHome();
  t.after(cleanup);
  writeConfig({ ui: { language: 'zh' }, relay: { mode: 'local' } });

  const [{ App }, React] = await Promise.all([loadTui(), import('react')]);
  const instance = await mount(React.createElement(App, { initialLanguage: 'en', needsWizard: false }));
  t.after(() => instance.unmount());

  assert.match(instance.lastFrame(), /Access mode/);
});

test('every tab is reachable and titled', async (t) => {
  const cleanup = withTemporaryHome();
  t.after(cleanup);
  writeConfig({ ui: { language: 'en' }, relay: { mode: 'local' } });

  const [{ App }, React] = await Promise.all([loadTui(), import('react')]);
  const instance = await mount(React.createElement(App, { initialLanguage: 'en', needsWizard: false }));
  t.after(() => instance.unmount());

  for (const label of ['Overview', 'Pair a device', 'Services', 'Relay', 'Keep-alive', 'Herdr', 'Language & about']) {
    assert.match(instance.lastFrame(), new RegExp(label.replace(/[&]/g, '\\&')));
  }
});

test('the first-run wizard opens on the language step', async (t) => {
  const cleanup = withTemporaryHome();
  t.after(cleanup);

  const [{ App }, React] = await Promise.all([loadTui(), import('react')]);
  const instance = await mount(React.createElement(App, { initialLanguage: 'en', needsWizard: true }));
  t.after(() => instance.unmount());

  const output = instance.lastFrame();
  assert.match(output, /First-time setup/);
  assert.match(output, /Choose language/);
  assert.match(output, /Step 1 of/);
  // The overview must not be reachable before the wizard is answered.
  assert.equal(/Access mode/.test(output), false);
});

test('the wizard walks language, access mode and finish', async (t) => {
  const cleanup = withTemporaryHome();
  t.after(cleanup);

  const [{ App }, React] = await Promise.all([loadTui(), import('react')]);
  const instance = await mount(React.createElement(App, { initialLanguage: 'en', needsWizard: true }));
  t.after(() => instance.unmount());

  const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

  instance.stdin.write('\r'); // accept the highlighted language
  await settle();
  assert.match(instance.lastFrame(), /Access mode/);
  assert.match(instance.lastFrame(), /Local network \/ Tailscale/);
  assert.match(instance.lastFrame(), /Self-hosted relay/);

  instance.stdin.write('\r'); // "This machine only"
  await settle();
  const finalFrame = instance.lastFrame();
  assert.match(finalFrame, /Finish/);
  assert.match(finalFrame, /Start services now/);
  assert.match(finalFrame, /Run in background/);
});

test('choosing the self-hosted relay adds the URL and credential steps', async (t) => {
  const cleanup = withTemporaryHome();
  t.after(cleanup);

  const [{ App }, React] = await Promise.all([loadTui(), import('react')]);
  const instance = await mount(React.createElement(App, { initialLanguage: 'en', needsWizard: true }));
  t.after(() => instance.unmount());

  const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

  instance.stdin.write('\r');
  await settle();
  instance.stdin.write('[B'); // down: local network
  instance.stdin.write('[B'); // down: official relay
  instance.stdin.write('[B'); // down: self-hosted relay
  await settle();
  assert.match(instance.lastFrame(), /Connect via self-hosted relay/);

  instance.stdin.write('\r');
  await settle();
  assert.match(instance.lastFrame(), /Relay server/);
  assert.match(instance.lastFrame(), /Relay URL/);
  assert.match(instance.lastFrame(), /Step 3 of 5/);
});

test('the relay screen offers a password only for a self-hosted relay', async (t) => {
  const cleanup = withTemporaryHome();
  t.after(cleanup);
  writeConfig({ ui: { language: 'en' }, relay: { mode: 'remote', remoteUrl: 'wss://relay.example.com' } });

  const [{ App }, React] = await Promise.all([loadTui(), import('react')]);
  const instance = await mount(React.createElement(App, { initialLanguage: 'en', needsWizard: false }));
  t.after(() => instance.unmount());

  instance.stdin.write('4'); // jump to the Relay tab
  await new Promise((resolve) => setTimeout(resolve, 40));

  const output = instance.lastFrame();
  assert.match(output, /Relay settings/);
  assert.match(output, /Relay password/);
  assert.match(output, /not set \(public\)/);
  // The host token is a credential and is never rendered.
  const { readRuntime } = require('../src/service');
  const runtime = readRuntime();
  if (runtime.hostToken) assert.equal(output.includes(runtime.hostToken), false);
});

test('a local relay needs no password, so the field is not offered', async (t) => {
  const cleanup = withTemporaryHome();
  t.after(cleanup);
  writeConfig({ ui: { language: 'en' }, relay: { mode: 'local' } });

  const [{ App }, React] = await Promise.all([loadTui(), import('react')]);
  const instance = await mount(React.createElement(App, { initialLanguage: 'en', needsWizard: false }));
  t.after(() => instance.unmount());

  instance.stdin.write('4');
  await new Promise((resolve) => setTimeout(resolve, 40));

  const output = instance.lastFrame();
  assert.match(output, /Relay settings/);
  assert.match(output, /Listen address/);
  assert.match(output, /127\.0\.0\.1:8787/);
  assert.equal(/Relay password/.test(output), false);
});

test('the relay screen commits an access-mode change to disk from its own row', async (t) => {
  // The reported failure: the relay was switched to the LAN and the services
  // restarted, but the relay kept binding loopback — every field here only
  // edits an in-memory draft, and the sole way to commit one was an
  // undocumented `s`, so the restart read the untouched file.
  const cleanup = withTemporaryHome();
  t.after(cleanup);
  writeConfig({ ui: { language: 'en' }, relay: { mode: 'local', port: 8787 } });

  const [{ App }, React] = await Promise.all([loadTui(), import('react')]);
  const instance = await mount(React.createElement(App, { initialLanguage: 'en', needsWizard: false }));
  t.after(() => instance.unmount());

  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
  const { bindAddress, loadConfig } = require('../src/config');

  instance.stdin.write('4'); // Relay tab
  await settle();
  assert.match(instance.lastFrame(), /Save settings/);

  instance.stdin.write('\r'); // open the access-mode chooser
  await settle();
  instance.stdin.write('[B'); // Local network / Tailscale
  await settle();
  instance.stdin.write('\r');
  await settle();

  // Still only a draft: nothing has touched the file, and the screen says so.
  assert.match(instance.lastFrame(), /Unsaved changes/);
  assert.match(instance.lastFrame(), /Listen address/);
  assert.match(instance.lastFrame(), /0\.0\.0\.0:8787/);
  assert.equal(loadConfig().relay.mode, 'local');

  // Walk down to the Save row and activate it.
  for (let step = 0; step < 4; step += 1) {
    instance.stdin.write('[B');
    await settle();
  }
  assert.match(instance.lastFrame(), /▸ Save settings/);
  instance.stdin.write('\r');
  await settle();

  assert.equal(loadConfig().relay.mode, 'lan');
  assert.equal(bindAddress(loadConfig()), '0.0.0.0');
});

test('the services screen refuses to restart onto a stale configuration', async (t) => {
  const cleanup = withTemporaryHome();
  t.after(cleanup);
  writeConfig({ ui: { language: 'en' }, relay: { mode: 'local', port: 8787 } });

  const [{ App }, React] = await Promise.all([loadTui(), import('react')]);
  const instance = await mount(React.createElement(App, { initialLanguage: 'en', needsWizard: false }));
  t.after(() => instance.unmount());

  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

  instance.stdin.write('4');
  await settle();
  instance.stdin.write('\r');
  await settle();
  instance.stdin.write('[B');
  await settle();
  instance.stdin.write('\r');
  await settle();

  instance.stdin.write('3'); // Services, with the draft still uncommitted
  await settle();
  assert.match(instance.lastFrame(), /unsaved changes/i);
});

// The official relay answers the "which relay" question by itself, so setup
// must not go on to ask for a URL: picking it lands straight on the last step.
test('the official relay is offered during setup and needs no further answers', async (t) => {
  const cleanup = withTemporaryHome();
  t.after(cleanup);

  const [{ App }, React] = await Promise.all([loadTui(), import('react')]);
  const instance = await mount(React.createElement(App, { initialLanguage: 'en', needsWizard: true }));
  t.after(() => instance.unmount());

  const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

  instance.stdin.write('\r');
  await settle();
  assert.match(instance.lastFrame(), /Official relay/);

  instance.stdin.write('[B'); // down: local network
  instance.stdin.write('[B'); // down: official relay
  await settle();
  assert.match(instance.lastFrame(), /Connect via official relay/);

  instance.stdin.write('\r');
  await settle();
  const frame = instance.lastFrame();
  assert.doesNotMatch(frame, /Relay URL/, 'the official relay URL is already known');
  // Three screens, and the counter has to say so: the official relay is a
  // remote relay, but it asks neither the URL nor the password question.
  assert.match(frame, /Step 3 of 3/);

  // The wizard commits the draft only on the final confirmation, which would
  // also start the services, so the flow above is what this test pins down.
  // The address it fills in is asserted separately, on the constant itself.
  const { OFFICIAL_RELAY_URL } = await import('../src/config.js');
  assert.equal(OFFICIAL_RELAY_URL, 'wss://herdr-remote.564616.xyz');
  assert.match(OFFICIAL_RELAY_URL, /^wss:\/\//, 'the official relay must be reached over TLS');
});

// Picking the official relay sets two fields at once. Each was applied through
// its own helper call, and because both started from the draft captured at the
// beginning of the render, the second committed the stale copy back over the
// first: the URL landed but the access mode silently stayed put.
test('choosing the official relay sets both the mode and the URL', async (t) => {
  const cleanup = withTemporaryHome();
  t.after(cleanup);
  writeConfig({ ui: { language: 'en' }, relay: { mode: 'local' } });

  const [{ App }, React] = await Promise.all([loadTui(), import('react')]);
  const instance = await mount(React.createElement(App, { initialLanguage: 'en', needsWizard: false }));
  t.after(() => instance.unmount());

  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

  instance.stdin.write('4'); // Relay tab
  await settle();
  instance.stdin.write('\r'); // open the access-mode chooser
  await settle();
  assert.match(instance.lastFrame(), /Official relay/);

  instance.stdin.write('[B'); // local network
  instance.stdin.write('[B'); // official relay
  await settle();
  instance.stdin.write('\r');
  await settle();
  instance.stdin.write('s'); // save
  await settle();

  const { loadConfig } = require('../src/config');
  const saved = loadConfig();
  assert.equal(saved.relay.mode, 'remote', 'the access mode must survive the second field write');
  assert.equal(saved.relay.remoteUrl, 'wss://herdr-remote.564616.xyz');
});

// Choosing the official relay used to leave every row below it describing a
// self-hosted relay that merely happened to hold our address: the mode read
// "Self-hosted relay", the URL sat in an editable box, and a password field
// invited a credential the official relay does not take.
test('the official relay is shown as itself, with a fixed address and no password', async (t) => {
  const cleanup = withTemporaryHome();
  t.after(cleanup);
  writeConfig({
    ui: { language: 'en' },
    relay: { mode: 'remote', remoteUrl: 'wss://herdr-remote.564616.xyz' },
  });

  const [{ App }, React] = await Promise.all([loadTui(), import('react')]);
  const instance = await mount(React.createElement(App, { initialLanguage: 'en', needsWizard: false }));
  t.after(() => instance.unmount());

  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

  instance.stdin.write('4'); // Relay tab
  await settle();

  const frame = instance.lastFrame();
  assert.match(frame, /Official relay/, 'the mode names the relay that is actually in use');
  assert.doesNotMatch(frame, /Self-hosted relay/);
  assert.match(frame, /wss:\/\/herdr-remote\.564616\.xyz\s+\(fixed\)/, 'the address is stated, not offered for editing');
  assert.doesNotMatch(frame, /Relay password/, 'the official relay takes no password');
  assert.match(frame, /no password is needed/);
});

test('switching from the official relay to a self-hosted one clears the address', async (t) => {
  const cleanup = withTemporaryHome();
  t.after(cleanup);
  writeConfig({
    ui: { language: 'en' },
    relay: { mode: 'remote', remoteUrl: 'wss://herdr-remote.564616.xyz' },
  });

  const [{ App }, React] = await Promise.all([loadTui(), import('react')]);
  const instance = await mount(React.createElement(App, { initialLanguage: 'en', needsWizard: false }));
  t.after(() => instance.unmount());

  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

  instance.stdin.write('4'); // Relay tab
  await settle();
  instance.stdin.write('\r'); // open the access-mode chooser
  await settle();
  // The cursor starts on the current answer, which is the official relay.
  instance.stdin.write('\u001B[B'); // self-hosted relay, the next row down
  await settle();
  instance.stdin.write('\r');
  await settle();

  const frame = instance.lastFrame();
  assert.match(frame, /Self-hosted relay/);
  // The address belongs to our server, not to theirs: it is cleared, and the
  // field asks for one rather than presenting ours as if it were already set.
  assert.doesNotMatch(frame, /wss:\/\/herdr-remote\.564616\.xyz/);
  assert.match(frame, /Relay password/, 'a relay somebody else runs may need a password');
});
