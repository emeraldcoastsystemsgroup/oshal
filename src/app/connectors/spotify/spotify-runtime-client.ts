/**
 * Spotify client, ported onto the ConnectorClient runtime (ADR-065 proof-of-concept).
 *
 * This is the SAME concierge surface as routes/spotify-client.ts — search, me, now-playing,
 * playlists, top-tracks, create-playlist + add-tracks — but the bespoke `call()` (single fetch,
 * no retry, no rate-limit, bare-Error) is gone. The runtime now provides: refresh-on-401,
 * exponential backoff honoring Spotify's Retry-After (429s are common on the 5-user dev cap),
 * a token-bucket governor, cursor pagination, and a uniform ConnectorError.
 *
 * What's left here is the THIN MAPPING: declare the client once, then one line per resource that
 * maps Spotify's verbose JSON into our small shapes. That collapse — ~115 lines of transport down
 * to declarations + maps — is the whole point of the ADR. Response normalizers are reused from the
 * existing client so the only thing that changed is the transport.
 *
 * Additive + opt-in: the original routes/spotify-client.ts is untouched and still wired into the
 * live spotify routes. Nothing in the running deployment changes until a caller imports this.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-065 PoC port.
 * -----------------------------------------------------------------------------
 * @module connectors/spotify/spotify-runtime-client
 */

import { ConnectorClient } from '../runtime';
import type { TokenProvider } from '../runtime';
import { normTrack, type SpotifyPlaylist, type SpotifyTrack } from '@/app/routes/spotify-client';

const BASE = 'https://api.spotify.com/v1';

function normPlaylist(p: any): SpotifyPlaylist {
  const img = Array.isArray(p?.images) && p.images.length ? (p.images[p.images.length - 1].url || p.images[0].url || null) : null;
  return {
    id: String(p?.id || ''),
    name: String(p?.name || 'Untitled'),
    trackCount: Number(p?.tracks?.total || 0),
    imageUrl: img,
    url: String(p?.external_urls?.spotify || (p?.id ? `https://open.spotify.com/playlist/${p.id}` : '')),
    owner: String(p?.owner?.display_name || p?.owner?.id || ''),
    isPublic: !!p?.public,
  };
}

/**
 * Build a Spotify client bound to one user's token. `token` is the broker/connector TokenProvider
 * (wrap getValidAccessToken); the runtime calls it again with { force: true } on a 401.
 */
export function makeSpotifyClient(token: TokenProvider, overrides?: { fetchImpl?: typeof fetch; onCall?: ConstructorParameters<typeof ConnectorClient>[0]['onCall'] }): SpotifyRuntimeClient {
  const client = new ConnectorClient({
    provider: 'spotify',
    baseUrl: BASE,
    auth: { type: 'bearer', token },
    // Spotify dev apps throttle hard; let the governor smooth bursts and the retry honor Retry-After.
    rateLimit: { burst: 10, perSecond: 5 },
    retry: { maxRetries: 3, honorRetryAfter: true },
    fetchImpl: overrides?.fetchImpl,
    onCall: overrides?.onCall,
  });
  return new SpotifyRuntimeClient(client);
}

export class SpotifyRuntimeClient {
  constructor(private readonly c: ConnectorClient) {}

  /** The connected account's profile (free vs premium gates playback handoff). */
  async me(): Promise<{ id: string; displayName: string; product: string; imageUrl: string | null; country: string }> {
    const j = await this.c.request<any>('/me');
    const img = Array.isArray(j?.images) && j.images.length ? (j.images[j.images.length - 1].url || null) : null;
    return { id: String(j?.id || ''), displayName: String(j?.display_name || j?.id || 'You'), product: String(j?.product || 'free'), imageUrl: img, country: String(j?.country || '') };
  }

  /** Search tracks — the discovery primitive. */
  async searchTracks(query: string, limit = 12): Promise<SpotifyTrack[]> {
    const q = String(query || '').trim();
    if (!q) return [];
    const j = await this.c.request<any>('/search', { query: { type: 'track', limit: Math.min(50, Math.max(1, limit)), market: process.env.SPOTIFY_MARKET || 'from_token', q } });
    return (j?.tracks?.items || []).map(normTrack).filter((t: SpotifyTrack) => t.id);
  }

  /** What the user is playing right now, or null (204 -> emptyOk -> {}). */
  async nowPlaying(): Promise<{ track: SpotifyTrack; isPlaying: boolean } | null> {
    const j = await this.c.request<any>('/me/player/currently-playing', { query: { market: 'from_token' }, emptyOk: [204] });
    if (!j || !j.item) return null;
    return { track: normTrack(j.item), isPlaying: !!j.is_playing };
  }

  /** The user's playlists, walking every page via the runtime's cursor pagination. */
  async myPlaylists(limit = 50): Promise<SpotifyPlaylist[]> {
    const items = await this.c.paginate<any>(
      '/me/playlists',
      { type: 'cursor', param: 'offset', nextFrom: (page) => (page?.next ? String((page?.offset || 0) + (page?.items?.length || 0)) : null) },
      { query: { limit: Math.min(50, Math.max(1, limit)) } },
    );
    return items.map(normPlaylist).filter((p: SpotifyPlaylist) => p.id);
  }

  /** Top tracks (taste signal). Non-fatal for new accounts. */
  async topTracks(limit = 10): Promise<SpotifyTrack[]> {
    try {
      const j = await this.c.request<any>('/me/top/tracks', { query: { limit: Math.min(50, Math.max(1, limit)), time_range: 'medium_term' } });
      return (j?.items || []).map(normTrack).filter((t: SpotifyTrack) => t.id);
    } catch { return []; }
  }

  /** Create a playlist + add tracks (requires playlist-modify scope). */
  async createPlaylist(userId: string, name: string, trackUris: string[], opts?: { description?: string; isPublic?: boolean }): Promise<SpotifyPlaylist & { added: number }> {
    const created = await this.c.request<any>(`/users/${encodeURIComponent(userId)}/playlists`, {
      method: 'POST',
      body: { name: String(name || 'OSHAL Mix').slice(0, 100), description: String(opts?.description || 'Built by the OSHAL Spotify concierge').slice(0, 300), public: opts?.isPublic ?? false },
    });
    const playlist = normPlaylist(created);
    let added = 0;
    const uris = (trackUris || []).filter(Boolean).slice(0, 100);
    if (playlist.id && uris.length) {
      // A POST that creates resources: don't auto-retry it, to avoid duplicate adds.
      await this.c.request(`/playlists/${playlist.id}/tracks`, { method: 'POST', body: { uris }, retry: { maxRetries: 0 } });
      added = uris.length;
    }
    return { ...playlist, trackCount: added, added };
  }
}
