/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * Cost Calculator
 * Calculates costs for different LLM providers and models
 */

class CostCalculator {
  constructor() {
    this.pricing = this.initializePricing();
  }

  /**
   * Initialize pricing data for all providers
   */
  initializePricing() {
    return {
      anthropic: {
        'claude-3-5-sonnet-20241022': {
          input: 3.0,
          output: 15.0,
          cacheWrite: 3.75,
          cacheRead: 0.30,
        },
        'claude-3-opus-20240229': {
          input: 15.0,
          output: 75.0,
          cacheWrite: 18.75,
          cacheRead: 1.50,
        },
        'claude-3-sonnet-20240229': {
          input: 3.0,
          output: 15.0,
          cacheWrite: 3.75,
          cacheRead: 0.30,
        },
        'claude-3-haiku-20240307': {
          input: 0.25,
          output: 1.25,
          cacheWrite: 0.30,
          cacheRead: 0.03,
        },
      },
      openai: {
        'gpt-4-turbo-preview': {
          input: 10.0,
          output: 30.0,
        },
        'gpt-4': {
          input: 30.0,
          output: 60.0,
        },
        'gpt-3.5-turbo': {
          input: 0.5,
          output: 1.5,
        },
      },
    };
  }

  /**
   * Calculate cost for a request
   */
  calculate(provider, model, usage) {
    const {
      inputTokens = 0,
      outputTokens = 0,
      cacheWrites = 0,
      cacheReads = 0,
    } = usage;

    const pricing = this.pricing[provider]?.[model];
    
    if (!pricing) {
      // Fallback to generic pricing
      return this.calculateGeneric(inputTokens, outputTokens, cacheWrites, cacheReads);
    }

    // Calculate costs (pricing is per million tokens)
    const inputCost = (inputTokens / 1000000) * pricing.input;
    const outputCost = (outputTokens / 1000000) * pricing.output;
    const cacheWriteCost = pricing.cacheWrite ? (cacheWrites / 1000000) * pricing.cacheWrite : 0;
    const cacheReadCost = pricing.cacheRead ? (cacheReads / 1000000) * pricing.cacheRead : 0;

    return {
      inputCost,
      outputCost,
      cacheWriteCost,
      cacheReadCost,
      totalCost: inputCost + outputCost + cacheWriteCost + cacheReadCost,
    };
  }

  /**
   * Calculate with generic pricing
   */
  calculateGeneric(inputTokens, outputTokens, cacheWrites = 0, cacheReads = 0) {
    const inputCost = (inputTokens / 1000000) * 3.0;
    const outputCost = (outputTokens / 1000000) * 15.0;
    const cacheWriteCost = (cacheWrites / 1000000) * 3.75;
    const cacheReadCost = (cacheReads / 1000000) * 0.30;

    return {
      inputCost,
      outputCost,
      cacheWriteCost,
      cacheReadCost,
      totalCost: inputCost + outputCost + cacheWriteCost + cacheReadCost,
    };
  }

  /**
   * Calculate cache savings
   */
  calculateCacheSavings(provider, model, cacheReads) {
    const pricing = this.pricing[provider]?.[model];
    if (!pricing || !pricing.cacheRead) {
      return 0;
    }

    // Savings = difference between full input price and cache read price
    const fullCost = (cacheReads / 1000000) * pricing.input;
    const cacheCost = (cacheReads / 1000000) * pricing.cacheRead;
    
    return fullCost - cacheCost;
  }

  /**
   * Get pricing info for a model
   */
  getPricing(provider, model) {
    return this.pricing[provider]?.[model] || null;
  }

  /**
   * List available models for a provider
   */
  listModels(provider) {
    return Object.keys(this.pricing[provider] || {});
  }

  /**
   * Add custom pricing
   */
  addPricing(provider, model, pricing) {
    if (!this.pricing[provider]) {
      this.pricing[provider] = {};
    }
    this.pricing[provider][model] = pricing;
  }
}

module.exports = CostCalculator;
