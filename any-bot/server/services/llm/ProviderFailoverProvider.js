/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added provider stall failover wrapper for bot-node any-bot providers.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Classify SUCCESSFUL primary/fallback responses with the narrow runtime-banner check, not the broad throttle/auth keywords, so a valid answer mentioning 429/quota/unauthorized is no longer treated as a failover-eligible failure.
 */

'use strict';

const logger = require('../../utils/logger');
const {
  formatProviderFailure,
  isProviderRecoverableRuntimeFailure,
  isProviderRuntimeBanner,
  isProviderRuntimeStall,
  isProviderThrottle,
  isProviderAuthFailure,
  isProviderCliRuntimeFailure,
} = require('./providerFailureClassifier');

/**
 * @description Provider-agnostic failover wrapper for the any-bot generateResponse()
 * contract. It retries only when the primary throws or returns a known provider
 * runtime/auth/throttle failure banner.
 */
class ProviderFailoverProvider {
  /**
   * @param {{primary: object, fallback: object, primaryName: string, fallbackName: string, reason?: string}} config
   */
  constructor(config) {
    if (!config || !config.primary || !config.fallback) {
      throw new Error('ProviderFailoverProvider requires primary and fallback providers');
    }
    this.primary = config.primary;
    this.fallback = config.fallback;
    this.primaryName = config.primaryName || readProviderName(config.primary) || 'primary';
    this.fallbackName = config.fallbackName || readProviderName(config.fallback) || 'fallback';
    this.reason = config.reason || 'provider_runtime_stall';
    logger.info(`[ProviderFailover] initialized: ${this.primaryName} -> ${this.fallbackName} (${this.reason})`);
  }

  async generateResponse(messages, options = {}) {
    let primaryResponse;
    try {
      primaryResponse = await this.primary.generateResponse(messages, options);
    } catch (primaryError) {
      if (!isProviderRecoverableRuntimeFailure(primaryError)) {
        throw primaryError;
      }
      return this._runFallback(messages, options, primaryError);
    }

    // primaryResponse is a SUCCESSFUL response object here — classify it with the
    // narrow banner check (isProviderFailureResponse), never the broad throttle/auth
    // keywords, so a valid answer mentioning 429/quota/unauthorized is not mistaken
    // for a failure and needlessly failed over.
    if (!isProviderFailureResponse(primaryResponse)) {
      return primaryResponse;
    }
    return this._runFallback(messages, options, primaryResponse);
  }

  async _runFallback(messages, options, primaryFailure) {
    const primaryFailureText = formatProviderFailure(primaryFailure);
    logger.warn(
      `[ProviderFailover] ${this.primaryName} failed with ${this.reason}; ` +
      `retrying via ${this.fallbackName}: ${primaryFailureText.substring(0, 300)}`,
    );

    let fallbackResponse;
    try {
      fallbackResponse = await this.fallback.generateResponse(messages, {
        ...options,
        source: options.source || 'provider-stall-fallback',
      });
    } catch (fallbackError) {
      throw new Error(
        `Provider failover failed (${this.reason}). ` +
        `primary=${this.primaryName}; fallback=${this.fallbackName}; ` +
        `primaryError=${primaryFailureText}; fallbackError=${formatProviderFailure(fallbackError)}`,
      );
    }

    if (isProviderFailureResponse(fallbackResponse)) {
      throw new Error(
        `Provider failover failed (${this.reason}). ` +
        `primary=${this.primaryName}; fallback=${this.fallbackName}; ` +
        `primaryError=${primaryFailureText}; fallbackError=${formatProviderFailure(fallbackResponse)}`,
      );
    }

    logger.info(`[ProviderFailover] fallback succeeded via ${this.fallbackName}`);
    return {
      ...fallbackResponse,
      provider: fallbackResponse.provider || this.fallbackName,
      providerFailover: {
        reason: this.reason,
        primary: this.primaryName,
        fallback: this.fallbackName,
      },
    };
  }

  getModelInfo() {
    const primaryInfo = typeof this.primary.getModelInfo === 'function' ? this.primary.getModelInfo() : {};
    const fallbackInfo = typeof this.fallback.getModelInfo === 'function' ? this.fallback.getModelInfo() : {};
    return {
      ...primaryInfo,
      provider: `failover:${this.primaryName}->${this.fallbackName}`,
      fallback: fallbackInfo,
    };
  }

  getProviderInfo() {
    return {
      name: `failover:${this.primaryName}->${this.fallbackName}`,
      displayName: 'Provider Failover',
      description: `Primary ${this.primaryName}, fallback ${this.fallbackName}`,
    };
  }

  async testConnection() {
    const primaryOk = typeof this.primary.testConnection === 'function'
      ? await this.primary.testConnection().catch(() => false)
      : true;
    const fallbackOk = typeof this.fallback.testConnection === 'function'
      ? await this.fallback.testConnection().catch(() => false)
      : true;
    return primaryOk || fallbackOk;
  }
}

// Classifies a SUCCESSFUL response object (not an error). Uses only the narrow
// runtime/stall/CLI-error banners — deliberately NOT the broad throttle/auth keyword
// patterns — because those match valid answers and would trigger spurious failover.
function isProviderFailureResponse(value) {
  return isProviderRuntimeBanner(value);
}

function readProviderName(provider) {
  if (!provider) return '';
  if (typeof provider.provider === 'string') return provider.provider;
  if (typeof provider.providerName === 'string') return provider.providerName;
  if (typeof provider.getProviderInfo === 'function') {
    try {
      const info = provider.getProviderInfo();
      if (info && typeof info.name === 'string') return info.name;
    } catch {
      return '';
    }
  }
  if (provider.config && typeof provider.config.provider === 'string') return provider.config.provider;
  return '';
}

module.exports = {
  ProviderFailoverProvider,
  formatProviderFailure,
  isProviderAuthFailure,
  isProviderCliRuntimeFailure,
  isProviderRecoverableRuntimeFailure,
  isProviderRuntimeBanner,
  isProviderRuntimeStall,
  isProviderThrottle,
  isProviderFailureResponse,
};
