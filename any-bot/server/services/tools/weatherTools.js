/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added a CLI entrypoint so the first-class weather bot-node can invoke the same deterministic format-weather implementation from its Codex sandbox.
 */

/**
 * Weather Tool Implementations — NWS API + Multi-Format Output
 * 
 * Provides real implementation for:
 * - format-weather: Fetches weather from NWS API and formats as md/html/json/xml/csv
 * 
 * PHASE_16: Auto-discovered by app.js dynamic tool file scanning
 * Pattern: exports { 'tool-name': handlerFn } — keys match mcp_tools[].name
 */

const logger = require('../../utils/logger');
const https = require('https');
const http = require('http');

// ─── NWS API Helper ─────────────────────────────────────────
const NWS_USER_AGENT = process.env.NWS_USER_AGENT || 'weather-bot/1.0 (ai-lab-swarm)';

/**
 * Make an HTTP(S) GET request and return parsed JSON.
 */
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const reqHeaders = {
      'User-Agent': NWS_USER_AGENT,
      'Accept': 'application/json',
      ...headers,
    };
    const req = client.get(url, { headers: reqHeaders, timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ raw: data, statusCode: res.statusCode });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTP timeout')); });
  });
}

// ─── Well-known US city coordinates (avoid geocoding for common requests) ────
const CITY_COORDS = {
  'san antonio': { lat: 29.4241, lon: -98.4936 },
  'san antonio, tx': { lat: 29.4241, lon: -98.4936 },
  'new york': { lat: 40.7128, lon: -74.0060 },
  'new york, ny': { lat: 40.7128, lon: -74.0060 },
  'chicago': { lat: 41.8781, lon: -87.6298 },
  'chicago, il': { lat: 41.8781, lon: -87.6298 },
  'los angeles': { lat: 34.0522, lon: -118.2437 },
  'los angeles, ca': { lat: 34.0522, lon: -118.2437 },
  'houston': { lat: 29.7604, lon: -95.3698 },
  'houston, tx': { lat: 29.7604, lon: -95.3698 },
  'phoenix': { lat: 33.4484, lon: -112.0740 },
  'phoenix, az': { lat: 33.4484, lon: -112.0740 },
  'dallas': { lat: 32.7767, lon: -96.7970 },
  'dallas, tx': { lat: 32.7767, lon: -96.7970 },
  'austin': { lat: 30.2672, lon: -97.7431 },
  'austin, tx': { lat: 30.2672, lon: -97.7431 },
  'seattle': { lat: 47.6062, lon: -122.3321 },
  'seattle, wa': { lat: 47.6062, lon: -122.3321 },
  'denver': { lat: 39.7392, lon: -104.9903 },
  'denver, co': { lat: 39.7392, lon: -104.9903 },
  'miami': { lat: 25.7617, lon: -80.1918 },
  'miami, fl': { lat: 25.7617, lon: -80.1918 },
  'atlanta': { lat: 33.7490, lon: -84.3880 },
  'atlanta, ga': { lat: 33.7490, lon: -84.3880 },
  'washington dc': { lat: 38.9072, lon: -77.0369 },
  'washington, dc': { lat: 38.9072, lon: -77.0369 },
  'boston': { lat: 42.3601, lon: -71.0589 },
  'boston, ma': { lat: 42.3601, lon: -71.0589 },
  'san francisco': { lat: 37.7749, lon: -122.4194 },
  'san francisco, ca': { lat: 37.7749, lon: -122.4194 },
};

/**
 * Resolve a location string to lat/lon coordinates.
 */
async function resolveCoordinates(location) {
  const normalized = location.toLowerCase().trim();
  if (CITY_COORDS[normalized]) {
    return CITY_COORDS[normalized];
  }
  // Check if already coordinates (lat,lon format)
  const coordMatch = normalized.match(/^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/);
  if (coordMatch) {
    return { lat: parseFloat(coordMatch[1]), lon: parseFloat(coordMatch[2]) };
  }
  // Keyless geocoding fallback for arbitrary US city/state requests. Nominatim requires
  // an identifying User-Agent (already supplied by httpGet) and is used only once per lookup.
  try {
    const matches = await httpGet(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&q=${encodeURIComponent(location)}`,
    );
    const first = Array.isArray(matches) ? matches[0] : null;
    const lat = Number(first?.lat);
    const lon = Number(first?.lon);
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
  } catch {
    return null;
  }
}

/**
 * Fetch weather data from NWS API.
 */
async function fetchNWSWeather(lat, lon) {
  // Step 1: Get the forecast URL for this location
  const pointsUrl = `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`;
  const pointsData = await httpGet(pointsUrl);

  if (!pointsData.properties || !pointsData.properties.forecast) {
    throw new Error(`NWS API: No forecast data for coordinates ${lat},${lon}`);
  }

  // Step 2: Fetch the actual forecast
  const forecastUrl = pointsData.properties.forecast;
  const forecastData = await httpGet(forecastUrl);

  if (!forecastData.properties || !forecastData.properties.periods) {
    throw new Error('NWS API: No forecast periods available');
  }

  const periods = forecastData.properties.periods.slice(0, 6); // Today + next ~3 days
  // The daily endpoint starts with a broad day/night period, not a current observation.
  // Prefer the first hourly period for the current glance and fall back safely when unavailable.
  let current = periods[0];
  if (pointsData.properties.forecastHourly) {
    try {
      const hourlyData = await httpGet(pointsData.properties.forecastHourly);
      current = hourlyData.properties?.periods?.[0] || current;
    } catch {
      // The daily forecast remains authoritative when the hourly endpoint is unavailable.
    }
  }

  return {
    location: pointsData.properties.relativeLocation?.properties?.city
      ? `${pointsData.properties.relativeLocation.properties.city}, ${pointsData.properties.relativeLocation.properties.state}`
      : `${lat}, ${lon}`,
    timestamp: new Date().toISOString(),
    current: {
      temp_f: current.temperature,
      temp_c: Math.round((current.temperature - 32) * 5 / 9),
      conditions: current.shortForecast,
      humidity: current.relativeHumidity?.value ?? null,
      precipitation_percent: current.probabilityOfPrecipitation?.value ?? null,
      wind_speed: parseInt(current.windSpeed) || 0,
      wind_direction: current.windDirection || '',
      valid_from: current.startTime || '',
      detailed: current.detailedForecast,
    },
    forecast: periods.map(p => ({
      name: p.name,
      temp_f: p.temperature,
      temp_c: Math.round((p.temperature - 32) * 5 / 9),
      conditions: p.shortForecast,
      precipitation_percent: p.probabilityOfPrecipitation?.value ?? null,
      wind: `${p.windDirection} ${p.windSpeed}`,
      detailed: p.detailedForecast,
      isDaytime: p.isDaytime,
    })),
  };
}

// ─── Weather Emoji Helper ───────────────────────────────────
function weatherEmoji(conditions) {
  const c = (conditions || '').toLowerCase();
  if (c.includes('sunny') || c.includes('clear')) return '☀️';
  if (c.includes('partly cloudy') || c.includes('partly sunny')) return '⛅';
  if (c.includes('cloudy') || c.includes('overcast')) return '☁️';
  if (c.includes('rain') || c.includes('shower')) return '🌧️';
  if (c.includes('thunder') || c.includes('storm')) return '⛈️';
  if (c.includes('snow') || c.includes('flurr')) return '🌨️';
  if (c.includes('fog') || c.includes('mist')) return '🌫️';
  if (c.includes('wind')) return '💨';
  if (c.includes('hot')) return '🔥';
  if (c.includes('cold') || c.includes('freez')) return '🥶';
  return '🌤️';
}

// ─── Format Functions ───────────────────────────────────────

function formatMarkdown(data) {
  const emoji = weatherEmoji(data.current.conditions);
  const now = new Date(data.timestamp);
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  let md = `# ${emoji} Weather Report: ${data.location}\n`;
  md += `**Date:** ${dateStr} | **Updated:** ${timeStr}\n\n`;
  md += `## Current Conditions\n`;
  md += `| Metric | Value |\n|--------|-------|\n`;
  md += `| 🌡️ Temperature | ${data.current.temp_f}°F (${data.current.temp_c}°C) |\n`;
  md += `| ${weatherEmoji(data.current.conditions)} Conditions | ${data.current.conditions} |\n`;
  if (data.current.humidity !== null) {
    md += `| 💧 Humidity | ${data.current.humidity}% |\n`;
  }
  if (data.current.precipitation_percent !== null) {
    md += `| Chance of precipitation | ${data.current.precipitation_percent}% |\n`;
  }
  md += `| 💨 Wind | ${data.current.wind_direction} ${data.current.wind_speed} mph |\n\n`;

  if (data.current.detailed) {
    md += `> ${data.current.detailed}\n\n`;
  }

  md += `## Forecast\n`;
  md += `| Period | Temp | Conditions |\n|--------|------|------------|\n`;
  for (const p of data.forecast) {
    md += `| ${p.name} | ${p.temp_f}°F (${p.temp_c}°C) | ${weatherEmoji(p.conditions)} ${p.conditions} |\n`;
  }

  return md;
}

function formatHTML(data) {
  const emoji = weatherEmoji(data.current.conditions);
  const forecastRows = data.forecast.map(p =>
    `<tr><td>${p.name}</td><td>${p.temp_f}°F (${p.temp_c}°C)</td><td>${weatherEmoji(p.conditions)} ${p.conditions}</td></tr>`
  ).join('\n          ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Weather: ${data.location}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; display: flex; justify-content: center; padding: 24px; }
    .card { background: linear-gradient(135deg, #1e293b, #0f172a); border-radius: 16px; padding: 24px; max-width: 500px; width: 100%; box-shadow: 0 8px 32px rgba(0,0,0,0.3); border: 1px solid #334155; }
    .header { text-align: center; margin-bottom: 20px; }
    .header h1 { font-size: 1.4rem; color: #38bdf8; }
    .header .emoji { font-size: 3rem; margin: 8px 0; }
    .header .temp { font-size: 2.5rem; font-weight: 700; color: #f8fafc; }
    .header .conditions { color: #94a3b8; font-size: 1.1rem; }
    .details { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 16px 0; }
    .detail { background: #1e293b; border-radius: 8px; padding: 10px; text-align: center; border: 1px solid #334155; }
    .detail .label { color: #64748b; font-size: 0.8rem; }
    .detail .value { color: #f8fafc; font-size: 1.1rem; font-weight: 600; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; }
    th { text-align: left; color: #64748b; font-size: 0.8rem; padding: 8px 4px; border-bottom: 1px solid #334155; }
    td { padding: 8px 4px; font-size: 0.9rem; border-bottom: 1px solid #1e293b; }
    .footer { text-align: center; color: #475569; font-size: 0.75rem; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1>📍 ${data.location}</h1>
      <div class="emoji">${emoji}</div>
      <div class="temp">${data.current.temp_f}°F</div>
      <div class="conditions">${data.current.conditions} · ${data.current.temp_c}°C</div>
    </div>
    <div class="details">
      ${data.current.humidity !== null ? `<div class="detail"><div class="label">💧 Humidity</div><div class="value">${data.current.humidity}%</div></div>` : ''}
      <div class="detail"><div class="label">💨 Wind</div><div class="value">${data.current.wind_direction} ${data.current.wind_speed} mph</div></div>
    </div>
    <table>
      <thead><tr><th>Period</th><th>Temp</th><th>Conditions</th></tr></thead>
      <tbody>
          ${forecastRows}
      </tbody>
    </table>
    <div class="footer">Data from NWS API · Updated ${new Date(data.timestamp).toLocaleTimeString()}</div>
  </div>
</body>
</html>`;
}

function formatJSON(data) {
  return JSON.stringify(data, null, 2);
}

function formatXML(data) {
  const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  xml += `<weather location="${escXml(data.location)}" timestamp="${data.timestamp}">\n`;
  xml += `  <current\n`;
  xml += `    temp_f="${data.current.temp_f}"\n`;
  xml += `    temp_c="${data.current.temp_c}"\n`;
  xml += `    conditions="${escXml(data.current.conditions)}"\n`;
  if (data.current.humidity !== null) {
    xml += `    humidity="${data.current.humidity}"\n`;
  }
  xml += `    wind_speed="${data.current.wind_speed}"\n`;
  xml += `    wind_direction="${escXml(data.current.wind_direction)}"\n`;
  xml += `  />\n`;
  xml += `  <forecast>\n`;
  for (const p of data.forecast) {
    xml += `    <period name="${escXml(p.name)}" temp_f="${p.temp_f}" temp_c="${p.temp_c}" conditions="${escXml(p.conditions)}" wind="${escXml(p.wind)}"/>\n`;
  }
  xml += `  </forecast>\n`;
  xml += `</weather>`;
  return xml;
}

function formatCSV(data) {
  let csv = 'metric,value\n';
  csv += `location,"${data.location}"\n`;
  csv += `timestamp,"${data.timestamp}"\n`;
  csv += `temperature_f,${data.current.temp_f}\n`;
  csv += `temperature_c,${data.current.temp_c}\n`;
  csv += `conditions,"${data.current.conditions}"\n`;
  if (data.current.humidity !== null) {
    csv += `humidity,${data.current.humidity}\n`;
  }
  csv += `wind_speed,${data.current.wind_speed}\n`;
  csv += `wind_direction,"${data.current.wind_direction}"\n`;
  csv += '\nperiod,temp_f,temp_c,conditions,wind\n';
  for (const p of data.forecast) {
    csv += `"${p.name}",${p.temp_f},${p.temp_c},"${p.conditions}","${p.wind}"\n`;
  }
  return csv;
}

// ─── Main Tool Handler ──────────────────────────────────────

/**
 * @description Handler for the 'format-weather' MCP tool. Exists so the swarm
 * can answer weather questions with deterministic, schema-stable output instead
 * of relying on the model to invent forecast numbers: it resolves a location to
 * coordinates, pulls live data from the NWS API, and renders it in the caller's
 * requested presentation format. Returns a structured error object (rather than
 * throwing) so an upstream agent can gracefully fall back to web search when a
 * location can't be resolved or NWS is unavailable.
 * @param {object} params - Tool invocation arguments.
 * @param {string} params.location - Location to look up, as a known "City, ST"
 *   name or a "lat,lon" coordinate string.
 * @param {string} [params.format='md'] - Output format; one of 'md', 'html',
 *   'json', 'xml', or 'csv'.
 * @returns {Promise<object>} On success, an object with `success: true`, the
 *   resolved `location`, normalized `format`, the rendered `output` string, and
 *   the raw `data`; on failure, an object containing an `error` message (and,
 *   where applicable, a `hint`/`usage` to guide recovery).
 */
async function formatWeather(params) {
  const { location, format = 'md' } = params;

  if (!location) {
    return { error: 'location parameter is required', usage: '{ "location": "San Antonio, TX", "format": "md" }' };
  }

  const validFormats = ['md', 'html', 'json', 'xml', 'csv'];
  const fmt = format.toLowerCase();
  if (!validFormats.includes(fmt)) {
    return { error: `Invalid format: ${format}. Valid formats: ${validFormats.join(', ')}` };
  }

  logger.info(`[weatherTools] format-weather: location="${location}", format="${fmt}"`);

  try {
    // Resolve coordinates
    const coords = await resolveCoordinates(location);
    if (!coords) {
      return {
        error: `Could not resolve coordinates for "${location}". Try using "City, ST" format (e.g., "San Antonio, TX") or lat,lon coordinates.`,
        hint: 'For international locations, the bot should use google_search instead.',
      };
    }

    // Fetch weather data from NWS
    const weatherData = await fetchNWSWeather(coords.lat, coords.lon);

    // Format output
    let output;
    switch (fmt) {
      case 'md': output = formatMarkdown(weatherData); break;
      case 'html': output = formatHTML(weatherData); break;
      case 'json': output = formatJSON(weatherData); break;
      case 'xml': output = formatXML(weatherData); break;
      case 'csv': output = formatCSV(weatherData); break;
      default: output = formatMarkdown(weatherData);
    }

    logger.info(`[weatherTools] format-weather: success (${fmt}, ${output.length} chars)`);

    return {
      success: true,
      location: weatherData.location,
      format: fmt,
      output,
      data: weatherData,
    };
  } catch (error) {
    logger.error(`[weatherTools] format-weather error: ${error.message}`);
    return {
      error: error.message,
      location,
      format: fmt,
      hint: 'NWS API may be unavailable. Try using google_search as fallback.',
    };
  }
}

/**
 * @description Run the registered format-weather implementation from a bot-node
 * Codex sandbox. The bot-node runtime intentionally exposes shell tools rather
 * than the legacy in-process MCP registry, so this adapter keeps one source of
 * truth for validation, NWS fetching, and output formatting.
 *
 * Usage:
 *   node weatherTools.js --location "Chicago, IL" --format json
 */
async function runCli(argv) {
  let location = '';
  let format = 'json';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--location' || arg === '-l') {
      location = argv[i + 1] || '';
      i += 1;
    } else if (arg === '--format' || arg === '-f') {
      format = argv[i + 1] || 'json';
      i += 1;
    } else if (!arg.startsWith('-') && !location) {
      location = arg;
    }
  }

  const result = await formatWeather({ location, format });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.error) process.exitCode = 1;
}

// ─── Export tool handlers (keys match mcp_tools[].name) ─────
module.exports = {
  'format-weather': formatWeather,
};

if (require.main === module) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`format-weather failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
