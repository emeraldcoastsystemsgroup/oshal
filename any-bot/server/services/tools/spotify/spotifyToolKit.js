/**
 * Spotify tool kit — discoverable tools that SHELL the oshal-spotify CLI.
 *
 * The CLI resolves the caller's Spotify access token from the connector store (controller
 * broker -> .oshal-cred-spotify, else DB decrypt) and calls the real Spotify Web API on the
 * user's OWN account. No keys live here and none live in env/compose — the connector pattern
 * (docs/connector-backed-apps.md).
 *
 * Honest reality: starting playback needs Premium + the Web Playback SDK, which OSHAL does not
 * drive, so 'open-track' returns an open.spotify.com deep link the person plays in their own app.
 *
 * Pattern: exports { 'tool-name': async (params) => {...} } — auto-discovered (ADR-025) and
 * bound to the spotify-concierge's persona authorizations. Tools pass params.userSub ->
 * OSHAL_USER_SUB so the CLI resolves the right account.
 *
 * CHANGE LOG
 * ---------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — real bot tools for the
 *            | spotify-concierge (search, now-playing, playlists, build-playlist), so the bot
 *            | is a proper swarm citizen, not a surface-only concierge.
 * ---------------------------------------------------------------------------
 * @module spotifyToolKit
 * @agent spotify-concierge
 */
const { runBrokeredCli } = require('../brokered-cli-runner');

/** Run the Spotify CLI and parse its JSON stdout. Never throws — returns {error} instead. */
function runCli(args, params = {}, context = {}) {
  return runBrokeredCli({ script: 'oshal-spotify.js', args, params, context, errorLabel: 'spotify' });
}

module.exports = {
  // Search the user's Spotify for tracks by song, artist, or vibe.
  'music-search': async (p = {}, c = {}) => runCli(['search', String(p.query || p.q || ''), String(p.limit || 12)], p, c),
  // What the user is playing right now (or null).
  'now-playing': async (p = {}, c = {}) => runCli(['now-playing'], p, c),
  // The user's own + followed playlists.
  'list-playlists': async (p = {}, c = {}) => runCli(['playlists', String(p.limit || 24)], p, c),
  // Build a playlist on the user's account: pass name + a comma/space list of spotify:track: URIs.
  'build-playlist': async (p = {}, c = {}) => runCli(['build-playlist', String(p.name || 'OSHAL Mix'), String(p.uris || p.trackUris || '')], p, c),
  // Is Spotify connected (and usable) for this caller?
  'spotify-accounts': async (p = {}, c = {}) => runCli(['accounts'], p, c),
};
