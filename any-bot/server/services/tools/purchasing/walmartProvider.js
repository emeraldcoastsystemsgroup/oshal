/**
 * (Retired) walmartProvider — superseded by the connector pattern.
 *
 * This module read Walmart credentials from env, which is the wrong pattern. The
 * live integration now goes: connector store (oshal_connections) -> token broker ->
 * scripts/oshal-walmart.js (signs + calls Walmart) -> walmartToolKit.js / the
 * purchasing route. No keys in env or compose.
 *
 * Kept as an empty module so the toolsDir scan registers no stray tools.
 *
 * @module walmartProvider
 */
module.exports = {};
