/**
 * Movies & TV tool kit — discoverable tools that SHELL the oshal-tmdb CLI.
 *
 * The CLI resolves the operator's TMDB key from the connector store (broker ->
 * .oshal-cred-tmdb, else DB decrypt, else TMDB_API_KEY env) and calls the free TMDB API.
 * No keys live here and none live in env/compose — the connector pattern.
 *
 * Honest reality: watching + tickets are deep-link handoffs — 'where-to-watch' returns
 * TMDB's JustWatch page, 'find-showtimes' returns a Fandango ticket-search link. The viewer
 * streams or buys there.
 *
 * Pattern: exports { 'tool-name': async (params) => {...} } — auto-discovered (ADR-025) and
 * bound to the movies-concierge's persona authorizations.
 *
 * CHANGE LOG
 * ---------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — real bot tools for the
 *            | movies-concierge (search, where-to-watch, recommendations, showtimes, watchlist),
 *            | so the bot is a proper swarm citizen, not a surface-only concierge.
 * ---------------------------------------------------------------------------
 * @module moviesToolKit
 * @agent movies-concierge
 */
const { runBrokeredCli } = require('../brokered-cli-runner');

function runCli(args, params = {}, context = {}) {
  return runBrokeredCli({ script: 'oshal-tmdb.js', args, params, context, errorLabel: 'tmdb' });
}

module.exports = {
  // Search movies + TV by title, mood, or genre.
  'title-search': async (p = {}, c = {}) => runCli(['search', String(p.query || p.q || ''), String(p.limit || 12)], p, c),
  // Where a title streams/rents/buys (JustWatch via TMDB) — needs media type ('movie'|'tv') + id.
  'where-to-watch': async (p = {}, c = {}) => runCli(['where-to-watch', String(p.mediaType || p.type || 'movie'), String(p.id || '')], p, c),
  // Similar/recommended titles for a given title.
  'recommendations': async (p = {}, c = {}) => runCli(['recommendations', String(p.mediaType || p.type || 'movie'), String(p.id || '')], p, c),
  // A Fandango ticket-search deep link for a movie title (handoff).
  'find-showtimes': async (p = {}, c = {}) => runCli(['showtimes', String(p.title || ''), String(p.location || '')], p, c),
  // Save a title to the viewer's own watchlist.
  'watchlist-add': async (p = {}, c = {}) => runCli(['watchlist-add', String(p.mediaType || p.type || 'movie'), String(p.id || ''), String(p.title || ''), String(p.year || '')], p, c),
  // Is a TMDB key available to this caller?
  'tmdb-accounts': async (p = {}, c = {}) => runCli(['accounts'], p, c),
};
