#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the SINGLE-SOURCE strategy engine shared by the live path (pick/monitor) AND the backtester, so the thing traded == the thing backtested. Mirrors the in-app TS algorithms.ts: momentum (close vs SMA20), gravity (ADR-054 market masses → displacement), donchian (20d breakout), meanrev (RSI-14), folded by a confidence-weighted ensemble. signalsAt/ensembleAt/positionAt evaluate at ANY bar i, so the exact ensemble that decides live also runs every historical bar in the backtest. Deterministic. Pure Node; imports the gravity engine.
 *
 * @module oshal-algos
 */
'use strict';
const G = require('./oshal-gravity.js');

const sma = (c, i, p) => { if (i + 1 < p) return null; let s = 0; for (let k = i - p + 1; k <= i; k++) s += c[k]; return s / p; };
function rsi(c, i, n = 14) { if (i < n) return null; let u = 0, d = 0; for (let k = i - n + 1; k <= i; k++) { const x = c[k] - c[k - 1]; if (x > 0) u += x; else d -= x; } return d === 0 ? 100 : 100 - 100 / (1 + u / d); }

/** Every algorithm's signal at bar i (each fires or abstains). Same logic as src/features/trading/algorithms.ts. */
function signalsAt(symbol, closes, i, indexCloses) {
  const out = [];
  const m = sma(closes, i, 20);
  if (m != null) { const g = (closes[i] - m) / m; out.push({ algo: 'momentum', dir: g >= 0 ? 'up' : 'down', confidence: Math.min(1, Math.abs(g) * 12) }); }
  const opts = indexCloses ? { indexCloses: indexCloses.slice(0, i + 1), indexName: 'SPY' } : {};
  const d = G.displacement(G.deriveMasses(symbol, closes.slice(0, i + 1), opts), 0);
  if (Math.abs(d) >= 0.01) out.push({ algo: 'gravity', dir: d > 0 ? 'up' : 'down', confidence: Math.min(1, Math.abs(d) * 2) });
  if (i >= 20) { let hi = -Infinity, lo = Infinity; for (let k = i - 20; k < i; k++) { hi = Math.max(hi, closes[k]); lo = Math.min(lo, closes[k]); } if (closes[i] > hi) out.push({ algo: 'donchian', dir: 'up', confidence: 0.7 }); else if (closes[i] < lo) out.push({ algo: 'donchian', dir: 'down', confidence: 0.7 }); }
  const r = rsi(closes, i, 14);
  if (r != null) { if (r < 35) out.push({ algo: 'meanrev', dir: 'up', confidence: Math.min(1, (35 - r) / 35) }); else if (r > 65) out.push({ algo: 'meanrev', dir: 'down', confidence: Math.min(1, (r - 65) / 35) }); }
  return out;
}

/** Confidence-weighted ensemble at bar i. weights = per-algo multiplier (the REFINE knob). */
function ensembleAt(symbol, closes, i, indexCloses, weights = {}) {
  const sigs = signalsAt(symbol, closes, i, indexCloses);
  if (!sigs.length) return { action: 'hold', side: null, score: 0, votes: [] };
  let s = 0, w = 0;
  for (const x of sigs) { const wt = weights[x.algo] ?? 1; const c = x.confidence * wt; s += (x.dir === 'up' ? 1 : -1) * c; w += c; }
  const norm = w ? s / w : 0;
  const action = norm > 0.15 ? 'buy' : norm < -0.15 ? 'sell' : 'hold';
  return { action, side: action === 'hold' ? null : action, score: Math.round(norm * 1000) / 1000, votes: sigs };
}

/** Backtest/live position at bar i: +1 long, -1 short, 0 flat (= ensemble action). */
function positionAt(symbol, closes, i, indexCloses, weights) { const e = ensembleAt(symbol, closes, i, indexCloses, weights); return e.action === 'buy' ? 1 : e.action === 'sell' ? -1 : 0; }

/** Single-algo position at bar i (for per-algo attribution): its dir, else carry-flat 0. */
function algoPositionAt(symbol, closes, i, indexCloses, algo) { const s = signalsAt(symbol, closes, i, indexCloses).find((x) => x.algo === algo); return s ? (s.dir === 'up' ? 1 : -1) : 0; }

module.exports = { signalsAt, ensembleAt, positionAt, algoPositionAt, ALGOS: ['momentum', 'gravity', 'donchian', 'meanrev'] };
