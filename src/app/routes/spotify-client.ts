/**
 * Spotify Web API client — thin, token-in helpers for the Spotify concierge.
 *
 * Each function takes a user access token (resolved + refreshed by the connector store via
 * getValidAccessToken) and calls the Spotify Web API on that user's behalf. Pure read/act
 * over HTTP — no storage, no secrets beyond the supplied token. Normalizes Spotify's verbose
 * objects into the small shapes the surface + concierge use (tracks, playlists, now-playing).
 *
 * Playback truth: Spotify has no "play this for a free user" API — controlling playback needs
 * Premium + the Web Playback SDK. So discovery + playlist-building happen here via the API, and
 * actually pressing play is a DEEP-LINK HANDOFF (open.spotify.com) the user completes in their
 * own Spotify app. We never store or move money/credentials.
 *
 * CHANGE LOG
 * ---------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — search, me, now-playing,
 *            | playlists, create-playlist + add-tracks, top-tracks. No /recommendations
 *            | (deprecated for apps created after 2024-11) — discovery is search-driven.
 * ---------------------------------------------------------------------------
 * @module spotify-client
 */

const API = 'https://api.spotify.com/v1';

export interface SpotifyTrack {
  id: string;
  uri: string;
  title: string;
  artist: string;
  album: string;
  imageUrl: string | null;
  durationMs: number;
  url: string;          // open.spotify.com deep link (press play in the user's own app)
  previewUrl: string | null;
  explicit: boolean;
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  trackCount: number;
  imageUrl: string | null;
  url: string;
  owner: string;
  isPublic: boolean;
}

/** Authenticated Spotify call → parsed JSON, or throws with the status + body snippet. */
async function call(token: string, path: string, init?: RequestInit): Promise<any> {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  if (r.status === 204) return {}; // e.g. nothing currently playing
  const text = await r.text();
  if (!r.ok) {
    const err: any = new Error(`spotify ${r.status}: ${text.slice(0, 200)}`);
    err.status = r.status;
    throw err;
  }
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}

/** Smallest image at-or-above a target width (Spotify returns largest-first). */
function pickImage(images?: Array<{ url?: string; width?: number }>): string | null {
  if (!Array.isArray(images) || !images.length) return null;
  return images[images.length - 1].url || images[0].url || null;
}

export function normTrack(t: any): SpotifyTrack {
  return {
    id: String(t?.id || ''),
    uri: String(t?.uri || (t?.id ? `spotify:track:${t.id}` : '')),
    title: String(t?.name || 'Unknown'),
    artist: (t?.artists || []).map((a: any) => a?.name).filter(Boolean).join(', ') || 'Unknown',
    album: String(t?.album?.name || ''),
    imageUrl: pickImage(t?.album?.images),
    durationMs: Number(t?.duration_ms || 0),
    url: String(t?.external_urls?.spotify || (t?.id ? `https://open.spotify.com/track/${t.id}` : '')),
    previewUrl: t?.preview_url || null,
    explicit: !!t?.explicit,
  };
}

function normPlaylist(p: any): SpotifyPlaylist {
  return {
    id: String(p?.id || ''),
    name: String(p?.name || 'Untitled'),
    trackCount: Number(p?.tracks?.total || 0),
    imageUrl: pickImage(p?.images),
    url: String(p?.external_urls?.spotify || (p?.id ? `https://open.spotify.com/playlist/${p.id}` : '')),
    owner: String(p?.owner?.display_name || p?.owner?.id || ''),
    isPublic: !!p?.public,
  };
}

/** The connected account's profile (display name, market, free vs premium). */
export async function spotifyMe(token: string): Promise<{ id: string; displayName: string; product: string; imageUrl: string | null; country: string }> {
  const j = await call(token, '/me');
  return {
    id: String(j?.id || ''),
    displayName: String(j?.display_name || j?.id || 'You'),
    product: String(j?.product || 'free'),   // 'premium' | 'free' | 'open'
    imageUrl: pickImage(j?.images),
    country: String(j?.country || ''),
  };
}

/** Search tracks (the concierge's discovery primitive). */
export async function spotifySearchTracks(token: string, query: string, limit = 12): Promise<SpotifyTrack[]> {
  const q = String(query || '').trim();
  if (!q) return [];
  const market = process.env.SPOTIFY_MARKET || 'from_token';
  const j = await call(token, `/search?type=track&limit=${Math.min(50, Math.max(1, limit))}&market=${encodeURIComponent(market)}&q=${encodeURIComponent(q)}`);
  return (j?.tracks?.items || []).map(normTrack).filter((t: SpotifyTrack) => t.id);
}

/** What the user is playing right now, or null when nothing is. */
export async function spotifyNowPlaying(token: string): Promise<{ track: SpotifyTrack; isPlaying: boolean } | null> {
  const j = await call(token, '/me/player/currently-playing?market=from_token');
  if (!j || !j.item) return null;
  return { track: normTrack(j.item), isPlaying: !!j.is_playing };
}

/** The user's own + followed playlists. */
export async function spotifyMyPlaylists(token: string, limit = 24): Promise<SpotifyPlaylist[]> {
  const j = await call(token, `/me/playlists?limit=${Math.min(50, Math.max(1, limit))}`);
  return (j?.items || []).map(normPlaylist).filter((p: SpotifyPlaylist) => p.id);
}

/** The user's top tracks (taste signal for recommendations the concierge can riff on). */
export async function spotifyTopTracks(token: string, limit = 10): Promise<SpotifyTrack[]> {
  try {
    const j = await call(token, `/me/top/tracks?limit=${Math.min(50, Math.max(1, limit))}&time_range=medium_term`);
    return (j?.items || []).map(normTrack).filter((t: SpotifyTrack) => t.id);
  } catch { return []; } // top-read may be unauthorized / empty for new accounts — non-fatal
}

/**
 * Create a playlist on the user's account and add the given track URIs. Returns the new
 * playlist (with its open.spotify.com deep link). Requires the playlist-modify-* scope.
 */
export async function spotifyCreatePlaylist(
  token: string, userId: string, name: string, trackUris: string[], opts?: { description?: string; isPublic?: boolean },
): Promise<SpotifyPlaylist & { added: number }> {
  const created = await call(token, `/users/${encodeURIComponent(userId)}/playlists`, {
    method: 'POST',
    body: JSON.stringify({
      name: String(name || 'OSHAL Mix').slice(0, 100),
      description: String(opts?.description || 'Built by the OSHAL Spotify concierge').slice(0, 300),
      public: opts?.isPublic ?? false,
    }),
  });
  const playlist = normPlaylist(created);
  let added = 0;
  const uris = (trackUris || []).filter(Boolean).slice(0, 100); // one add call handles up to 100
  if (playlist.id && uris.length) {
    await call(token, `/playlists/${playlist.id}/tracks`, { method: 'POST', body: JSON.stringify({ uris }) });
    added = uris.length;
  }
  return { ...playlist, trackCount: added, added };
}

/** Append track URIs to an existing playlist (must be owned/collaborative). */
export async function spotifyAddTracks(token: string, playlistId: string, trackUris: string[]): Promise<number> {
  const uris = (trackUris || []).filter(Boolean).slice(0, 100);
  if (!playlistId || !uris.length) return 0;
  await call(token, `/playlists/${encodeURIComponent(playlistId)}/tracks`, { method: 'POST', body: JSON.stringify({ uris }) });
  return uris.length;
}
