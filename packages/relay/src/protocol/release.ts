// Where herdr-remote is released. The CLI updates from here and the browser
// shows the same addresses in its manual steps, so there is one definition.
//
// GitHub Releases is the primary channel: a release is downloadable the moment
// it is created, whereas npm can take many minutes after `npm publish` before
// a new version installs. npm carries the same tarballs as a fallback.

const RELEASE_REPOSITORY = 'dibin666/herdr-remote';

/** Also the name an update check reports as its source. */
export const GITHUB_RELEASES_URL = `https://github.com/${RELEASE_REPOSITORY}/releases`;

/** `{ schema, version, tag, relayVersion, tarball }`, attached to every release. */
export const LATEST_RELEASE_MANIFEST_URL = `${GITHUB_RELEASES_URL}/latest/download/latest.json`;

/** The newest self-contained CLI tarball, for a workstation that cannot say which it needs. */
export const LATEST_CLI_TARBALL_URL = `${GITHUB_RELEASES_URL}/latest/download/herdr-remote.tgz`;

/** One CLI release's self-contained tarball; it bundles the relay it was released with. */
export function cliTarballUrl(version: string): string {
  return `${GITHUB_RELEASES_URL}/download/herdr-remote-v${version}/herdr-remote-${version}.tgz`;
}
