/**
 * (Retired) Purchasing tools — superseded by walmartToolKit.js.
 *
 * The original tools read Walmart credentials from env, which is the wrong pattern:
 * bots must act through the connector store, not baked-in keys. The real tools now
 * live in walmartToolKit.js (they shell scripts/oshal-walmart.js, which resolves the
 * operator's credential from oshal_connections via the token broker).
 *
 * Kept as an empty module so the toolsDir scan finds no duplicate tool names.
 *
 * @module purchasingTools
 */
module.exports = {};
