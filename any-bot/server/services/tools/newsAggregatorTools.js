/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * News Aggregator Tools
 * Implements RSS parsing, NewsAPI integration, sentiment analysis, and entity extraction
 */

const axios = require('axios');
const Parser = require('rss-parser');
const logger = require('../../utils/logger');

const rssParser = new Parser({
  customFields: {
    item: [
      ['media:content', 'mediaContent'],
      ['media:thumbnail', 'mediaThumbnail'],
      ['dc:creator', 'creator']
    ]
  }
});

// ============================================================================
// RSS FEED PARSING
// ============================================================================

/**
 * Fetch and parse RSS feed from a given URL
 * @param {Object} params - { url: string, maxItems?: number }
 * @returns {Promise<Object>} - { success: boolean, articles: Array, source: string }
 */
async function fetchRssFeed(params) {
  const { url, maxItems = 50 } = params;
  
  try {
    logger.info(`Fetching RSS feed from: ${url}`);
    const feed = await rssParser.parseURL(url);
    
    const articles = feed.items.slice(0, maxItems).map(item => ({
      title: item.title || '',
      description: item.contentSnippet || item.description || '',
      content: item.content || item.contentSnippet || item.description || '',
      url: item.link || '',
      publishedDate: item.pubDate || item.isoDate || new Date().toISOString(),
      author: item.creator || item.author || 'Unknown',
      source: feed.title || url,
      categories: item.categories || [],
      guid: item.guid || item.link || '',
      mediaUrl: item.mediaThumbnail?.$ || item.mediaContent?.$ || null
    }));
    
    logger.info(`Successfully parsed ${articles.length} articles from ${feed.title}`);
    
    return {
      success: true,
      articles,
      source: feed.title || url,
      feedInfo: {
        title: feed.title,
        description: feed.description,
        link: feed.link,
        lastUpdated: feed.lastBuildDate
      }
    };
  } catch (error) {
    logger.error(`Error fetching RSS feed from ${url}: ${error.message}`);
    return {
      success: false,
      error: error.message,
      articles: []
    };
  }
}

/**
 * Fetch articles from multiple RSS feeds in parallel
 * @param {Object} params - { urls: string[], maxItemsPerFeed?: number }
 * @returns {Promise<Object>} - { success: boolean, results: Array, totalArticles: number }
 */
async function fetchMultipleRssFeeds(params) {
  const { urls, maxItemsPerFeed = 20 } = params;
  
  try {
    logger.info(`Fetching ${urls.length} RSS feeds in parallel`);
    
    const promises = urls.map(url => 
      fetchRssFeed({ url, maxItems: maxItemsPerFeed })
        .catch(err => ({ success: false, error: err.message, articles: [], url }))
    );
    
    const results = await Promise.all(promises);
    const allArticles = results.flatMap(r => r.articles || []);
    
    return {
      success: true,
      results,
      totalArticles: allArticles.length,
      successCount: results.filter(r => r.success).length,
      failureCount: results.filter(r => !r.success).length
    };
  } catch (error) {
    logger.error(`Error fetching multiple RSS feeds: ${error.message}`);
    return {
      success: false,
      error: error.message,
      results: []
    };
  }
}

// ============================================================================
// NEWSAPI INTEGRATION
// ============================================================================

/**
 * Search news articles via NewsAPI
 * @param {Object} params - { query: string, from?: string, to?: string, language?: string, sortBy?: string, pageSize?: number }
 * @returns {Promise<Object>} - { success: boolean, articles: Array, totalResults: number }
 */
async function searchNewsApi(params) {
  const { 
    query, 
    from, 
    to, 
    language = 'en', 
    sortBy = 'publishedAt',
    pageSize = 100 
  } = params;
  
  const apiKey = process.env.NEWSAPI_KEY;
  
  if (!apiKey) {
    return {
      success: false,
      error: 'NEWSAPI_KEY not configured. Set via bot config.',
      articles: []
    };
  }
  
  try {
    logger.info(`Searching NewsAPI for: ${query}`);
    
    const response = await axios.get('https://newsapi.org/v2/everything', {
      params: {
        q: query,
        from,
        to,
        language,
        sortBy,
        pageSize,
        apiKey
      }
    });
    
    const articles = response.data.articles.map(article => ({
      title: article.title || '',
      description: article.description || '',
      content: article.content || article.description || '',
      url: article.url || '',
      publishedDate: article.publishedAt || new Date().toISOString(),
      author: article.author || 'Unknown',
      source: article.source?.name || 'NewsAPI',
      urlToImage: article.urlToImage,
      guid: article.url
    }));
    
    logger.info(`Found ${articles.length} articles via NewsAPI`);
    
    return {
      success: true,
      articles,
      totalResults: response.data.totalResults,
      status: response.data.status
    };
  } catch (error) {
    logger.error(`Error searching NewsAPI: ${error.message}`);
    return {
      success: false,
      error: error.response?.data?.message || error.message,
      articles: []
    };
  }
}

/**
 * Get top headlines from NewsAPI
 * @param {Object} params - { country?: string, category?: string, sources?: string, pageSize?: number }
 * @returns {Promise<Object>} - { success: boolean, articles: Array, totalResults: number }
 */
async function getTopHeadlines(params) {
  const { 
    country = 'us',
    category,
    sources,
    pageSize = 100 
  } = params;
  
  const apiKey = process.env.NEWSAPI_KEY;
  
  if (!apiKey) {
    return {
      success: false,
      error: 'NEWSAPI_KEY not configured. Set via bot config.',
      articles: []
    };
  }
  
  try {
    logger.info(`Fetching top headlines: country=${country}, category=${category || 'all'}`);
    
    const response = await axios.get('https://newsapi.org/v2/top-headlines', {
      params: {
        country: sources ? undefined : country,
        category,
        sources,
        pageSize,
        apiKey
      }
    });
    
    const articles = response.data.articles.map(article => ({
      title: article.title || '',
      description: article.description || '',
      content: article.content || article.description || '',
      url: article.url || '',
      publishedDate: article.publishedAt || new Date().toISOString(),
      author: article.author || 'Unknown',
      source: article.source?.name || 'NewsAPI',
      urlToImage: article.urlToImage,
      guid: article.url
    }));
    
    logger.info(`Found ${articles.length} top headlines`);
    
    return {
      success: true,
      articles,
      totalResults: response.data.totalResults,
      status: response.data.status
    };
  } catch (error) {
    logger.error(`Error fetching top headlines: ${error.message}`);
    return {
      success: false,
      error: error.response?.data?.message || error.message,
      articles: []
    };
  }
}

// ============================================================================
// SENTIMENT ANALYSIS (Using AWS Bedrock)
// ============================================================================

/**
 * Analyze sentiment of text using AWS Bedrock
 * @param {Object} params - { text: string, articleContext?: Object }
 * @returns {Promise<Object>} - { success: boolean, sentiment: Object }
 */
async function analyzeSentiment(params) {
  const { text, articleContext = {} } = params;
  
  if (!text || text.trim().length === 0) {
    return {
      success: false,
      error: 'No text provided for sentiment analysis'
    };
  }
  
  try {
    const BedrockRuntime = require('@aws-sdk/client-bedrock-runtime');
    const bedrock = new BedrockRuntime.BedrockRuntimeClient({ 
      region: process.env.AWS_REGION || 'us-gov-west-1' 
    });
    
    const prompt = `Analyze the sentiment and emotional tone of the following news text. Provide:
1. Overall sentiment (positive, negative, neutral)
2. Sentiment score (-1.0 to +1.0, where -1 is very negative, 0 is neutral, +1 is very positive)
3. Confidence score (0.0 to 1.0)
4. Key emotional tones (e.g., optimistic, concerned, angry, fearful, hopeful)
5. Brief explanation

Text to analyze:
"""
${text.substring(0, 2000)}
"""

Respond in JSON format:
{
  "sentiment": "positive|negative|neutral",
  "score": <number between -1.0 and 1.0>,
  "confidence": <number between 0.0 and 1.0>,
  "emotionalTones": ["tone1", "tone2"],
  "explanation": "brief explanation"
}`;

    const response = await bedrock.invokeModel({
      modelId: 'anthropic.claude-3-haiku-20240307-v1:0',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: prompt
        }]
      })
    });
    
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    const resultText = responseBody.content[0].text;
    
    // Extract JSON from response
    const jsonMatch = resultText.match(/\{[\s\S]*\}/);
    const sentimentData = jsonMatch ? JSON.parse(jsonMatch[0]) : {
      sentiment: 'neutral',
      score: 0,
      confidence: 0.5,
      emotionalTones: [],
      explanation: 'Could not parse sentiment'
    };
    
    logger.info(`Sentiment analysis complete: ${sentimentData.sentiment} (${sentimentData.score})`);
    
    return {
      success: true,
      sentiment: sentimentData,
      analyzedAt: new Date().toISOString()
    };
  } catch (error) {
    logger.error(`Error analyzing sentiment: ${error.message}`);
    return {
      success: false,
      error: error.message,
      sentiment: {
        sentiment: 'neutral',
        score: 0,
        confidence: 0,
        emotionalTones: [],
        explanation: 'Error during analysis'
      }
    };
  }
}

// ============================================================================
// ENTITY EXTRACTION (Using AWS Bedrock)
// ============================================================================

/**
 * Extract entities (people, organizations, events) from text using AWS Bedrock
 * @param {Object} params - { text: string, articleContext?: Object }
 * @returns {Promise<Object>} - { success: boolean, entities: Object }
 */
async function extractEntities(params) {
  const { text, articleContext = {} } = params;
  
  if (!text || text.trim().length === 0) {
    return {
      success: false,
      error: 'No text provided for entity extraction'
    };
  }
  
  try {
    const BedrockRuntime = require('@aws-sdk/client-bedrock-runtime');
    const bedrock = new BedrockRuntime.BedrockRuntimeClient({ 
      region: process.env.AWS_REGION || 'us-gov-west-1' 
    });
    
    const prompt = `Extract and categorize all named entities from the following news text. Identify:
1. PEOPLE: Names of individuals (politicians, executives, public figures)
2. ORGANIZATIONS: Companies, government agencies, political parties, institutions
3. LOCATIONS: Countries, cities, regions mentioned
4. EVENTS: Named events, summits, elections, incidents
5. DATES: Important dates and timeframes
6. MONEY: Financial amounts, budgets, deals
7. POLICIES: Specific policies, laws, regulations mentioned

Text to analyze:
"""
${text.substring(0, 3000)}
"""

Respond in JSON format:
{
  "people": [{"name": "Full Name", "role": "role/title", "mentions": count}],
  "organizations": [{"name": "Org Name", "type": "type", "mentions": count}],
  "locations": [{"name": "Location", "type": "city|country|region", "mentions": count}],
  "events": [{"name": "Event Name", "type": "type", "mentions": count}],
  "dates": [{"date": "date string", "context": "what happened"}],
  "monetary": [{"amount": "amount", "context": "context"}],
  "policies": [{"name": "policy name", "description": "brief desc"}]
}`;

    const response = await bedrock.invokeModel({
      modelId: 'anthropic.claude-3-haiku-20240307-v1:0',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: prompt
        }]
      })
    });
    
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    const resultText = responseBody.content[0].text;
    
    // Extract JSON from response
    const jsonMatch = resultText.match(/\{[\s\S]*\}/);
    const entities = jsonMatch ? JSON.parse(jsonMatch[0]) : {
      people: [],
      organizations: [],
      locations: [],
      events: [],
      dates: [],
      monetary: [],
      policies: []
    };
    
    const totalEntities = Object.values(entities).reduce((sum, arr) => sum + arr.length, 0);
    logger.info(`Entity extraction complete: ${totalEntities} entities found`);
    
    return {
      success: true,
      entities,
      extractedAt: new Date().toISOString(),
      totalCount: totalEntities
    };
  } catch (error) {
    logger.error(`Error extracting entities: ${error.message}`);
    return {
      success: false,
      error: error.message,
      entities: {
        people: [],
        organizations: [],
        locations: [],
        events: [],
        dates: [],
        monetary: [],
        policies: []
      }
    };
  }
}

// ============================================================================
// IMPACT CLASSIFICATION (Using AWS Bedrock)
// ============================================================================

/**
 * Classify the impact and significance of a news article
 * @param {Object} params - { text: string, title: string, entities?: Object, sentiment?: Object }
 * @returns {Promise<Object>} - { success: boolean, impact: Object }
 */
async function classifyImpact(params) {
  const { text, title, entities = {}, sentiment = {} } = params;
  
  if (!text || text.trim().length === 0) {
    return {
      success: false,
      error: 'No text provided for impact classification'
    };
  }
  
  try {
    const BedrockRuntime = require('@aws-sdk/client-bedrock-runtime');
    const bedrock = new BedrockRuntime.BedrockRuntimeClient({ 
      region: process.env.AWS_REGION || 'us-gov-west-1' 
    });
    
    const prompt = `Analyze the impact and significance of this news article. Classify it across multiple dimensions:

Title: ${title}

Text:
"""
${text.substring(0, 2000)}
"""

Provide classification in JSON format:
{
  "marketImpact": "none|low|medium|high|critical",
  "marketImpactScore": <0-10>,
  "marketSectors": ["sector1", "sector2"],
  "policyImpact": "none|low|medium|high|critical",
  "policyAreas": ["area1", "area2"],
  "scandalPotential": "none|low|medium|high|critical",
  "publicInterest": "low|medium|high|viral",
  "timeHorizon": "immediate|short-term|medium-term|long-term",
  "geographicScope": "local|regional|national|international|global",
  "stakeholderGroups": ["group1", "group2"],
  "urgency": "low|medium|high|critical",
  "credibility": "low|medium|high",
  "overallSignificance": <1-10>,
  "reasoning": "brief explanation of classification"
}`;

    const response = await bedrock.invokeModel({
      modelId: 'anthropic.claude-3-haiku-20240307-v1:0',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 800,
        messages: [{
          role: 'user',
          content: prompt
        }]
      })
    });
    
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    const resultText = responseBody.content[0].text;
    
    // Extract JSON from response
    const jsonMatch = resultText.match(/\{[\s\S]*\}/);
    const impact = jsonMatch ? JSON.parse(jsonMatch[0]) : {
      marketImpact: 'low',
      marketImpactScore: 1,
      marketSectors: [],
      policyImpact: 'low',
      policyAreas: [],
      scandalPotential: 'none',
      publicInterest: 'low',
      timeHorizon: 'medium-term',
      geographicScope: 'regional',
      stakeholderGroups: [],
      urgency: 'low',
      credibility: 'medium',
      overallSignificance: 3,
      reasoning: 'Could not classify impact'
    };
    
    logger.info(`Impact classification complete: significance=${impact.overallSignificance}/10`);
    
    return {
      success: true,
      impact,
      classifiedAt: new Date().toISOString()
    };
  } catch (error) {
    logger.error(`Error classifying impact: ${error.message}`);
    return {
      success: false,
      error: error.message,
      impact: {
        marketImpact: 'low',
        marketImpactScore: 1,
        policyImpact: 'low',
        scandalPotential: 'none',
        overallSignificance: 1
      }
    };
  }
}

// ============================================================================
// CHROMADB INGESTION
// ============================================================================

/**
 * Store enriched article in ChromaDB
 * @param {Object} params - { article: Object, sentiment: Object, entities: Object, impact: Object, collectionName?: string }
 * @returns {Promise<Object>} - { success: boolean, documentId: string }
 */
async function storeArticleInChroma(params) {
  const { 
    article, 
    sentiment = {}, 
    entities = {}, 
    impact = {},
    collectionName = 'news-articles'
  } = params;
  
  try {
    const { ChromaClient } = require('chromadb');
    const client = new ChromaClient({ 
      path: process.env.CHROMA_URL || 'http://chromadb:8000' 
    });
    
    // Get or create collection
    let collection;
    try {
      collection = await client.getCollection({ name: collectionName });
    } catch (error) {
      collection = await client.createCollection({ 
        name: collectionName,
        metadata: { description: 'News articles with sentiment and entity analysis' }
      });
    }
    
    // Create document ID
    const documentId = `article_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Prepare metadata
    const metadata = {
      title: article.title || '',
      url: article.url || '',
      source: article.source || '',
      author: article.author || '',
      publishedDate: article.publishedDate || new Date().toISOString(),
      
      // Sentiment metadata
      sentiment: sentiment.sentiment || 'neutral',
      sentimentScore: sentiment.score || 0,
      sentimentConfidence: sentiment.confidence || 0,
      emotionalTones: JSON.stringify(sentiment.emotionalTones || []),
      
      // Entity counts
      peopleCount: (entities.people || []).length,
      organizationsCount: (entities.organizations || []).length,
      locationsCount: (entities.locations || []).length,
      eventsCount: (entities.events || []).length,
      
      // Entity names (top 3 each)
      topPeople: JSON.stringify((entities.people || []).slice(0, 3).map(p => p.name)),
      topOrganizations: JSON.stringify((entities.organizations || []).slice(0, 3).map(o => o.name)),
      topLocations: JSON.stringify((entities.locations || []).slice(0, 3).map(l => l.name)),
      
      // Impact metadata
      marketImpact: impact.marketImpact || 'low',
      marketImpactScore: impact.marketImpactScore || 1,
      policyImpact: impact.policyImpact || 'low',
      scandalPotential: impact.scandalPotential || 'none',
      overallSignificance: impact.overallSignificance || 1,
      urgency: impact.urgency || 'low',
      geographicScope: impact.geographicScope || 'regional',
      
      // Processing metadata
      processedAt: new Date().toISOString(),
      fullEntities: JSON.stringify(entities),
      fullImpact: JSON.stringify(impact)
    };
    
    // Store in ChromaDB
    await collection.add({
      ids: [documentId],
      documents: [article.content || article.description || article.title],
      metadatas: [metadata]
    });
    
    logger.info(`Stored article in ChromaDB: ${documentId}`);
    
    return {
      success: true,
      documentId,
      collectionName,
      metadata
    };
  } catch (error) {
    logger.error(`Error storing article in ChromaDB: ${error.message}`);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Query ChromaDB for articles mentioning specific entities or topics
 * @param {Object} params - { query: string, filters?: Object, limit?: number, collectionName?: string }
 * @returns {Promise<Object>} - { success: boolean, results: Array }
 */
async function queryArticles(params) {
  const { 
    query, 
    filters = {},
    limit = 10,
    collectionName = 'news-articles'
  } = params;
  
  try {
    const { ChromaClient } = require('chromadb');
    const client = new ChromaClient({ 
      path: process.env.CHROMA_URL || 'http://chromadb:8000' 
    });
    
    const collection = await client.getCollection({ name: collectionName });
    
    // Build where clause from filters
    const whereClause = {};
    if (filters.sentiment) whereClause.sentiment = filters.sentiment;
    if (filters.marketImpact) whereClause.marketImpact = filters.marketImpact;
    if (filters.source) whereClause.source = filters.source;
    
    const results = await collection.query({
      queryTexts: [query],
      nResults: limit,
      where: Object.keys(whereClause).length > 0 ? whereClause : undefined
    });
    
    const articles = results.ids[0].map((id, idx) => ({
      id,
      content: results.documents[0][idx],
      metadata: results.metadatas[0][idx],
      distance: results.distances?.[0]?.[idx]
    }));
    
    logger.info(`Query returned ${articles.length} articles`);
    
    return {
      success: true,
      results: articles,
      count: articles.length,
      query
    };
  } catch (error) {
    logger.error(`Error querying articles: ${error.message}`);
    return {
      success: false,
      error: error.message,
      results: []
    };
  }
}

/**
 * Process a single article through the full enrichment pipeline
 * @param {Object} params - { article: Object, storeInChroma?: boolean }
 * @returns {Promise<Object>} - Complete enriched article data
 */
async function processArticle(params) {
  const { article, storeInChroma = true } = params;
  
  logger.info(`Processing article: ${article.title}`);
  
  try {
    // Run sentiment analysis, entity extraction, and impact classification in parallel
    const [sentimentResult, entitiesResult, impactResult] = await Promise.all([
      analyzeSentiment({ text: article.content || article.description, articleContext: article }),
      extractEntities({ text: article.content || article.description, articleContext: article }),
      classifyImpact({ 
        text: article.content || article.description, 
        title: article.title,
        articleContext: article 
      })
    ]);
    
    const enrichedArticle = {
      ...article,
      sentiment: sentimentResult.sentiment || {},
      entities: entitiesResult.entities || {},
      impact: impactResult.impact || {},
      processedAt: new Date().toISOString()
    };
    
    // Store in ChromaDB if requested
    let chromaResult = null;
    if (storeInChroma) {
      chromaResult = await storeArticleInChroma({
        article,
        sentiment: sentimentResult.sentiment,
        entities: entitiesResult.entities,
        impact: impactResult.impact
      });
    }
    
    logger.info(`Article processing complete: ${article.title}`);
    
    return {
      success: true,
      enrichedArticle,
      chromaResult,
      processingStatus: {
        sentiment: sentimentResult.success,
        entities: entitiesResult.success,
        impact: impactResult.success,
        stored: chromaResult?.success || false
      }
    };
  } catch (error) {
    logger.error(`Error processing article: ${error.message}`);
    return {
      success: false,
      error: error.message,
      article
    };
  }
}

// Export all tools
/**
 * @description Public tool registry for the news aggregator capability. Maps the
 * stable, kebab-case tool names that the bot/agent layer invokes to their
 * underlying implementation functions, decoupling the external tool contract
 * from internal function naming so handlers can be refactored without breaking
 * callers. This object is the module's sole export.
 * @type {Object.<string, Function>}
 */
module.exports = {
  'fetch-rss-feed': fetchRssFeed,
  'fetch-multiple-rss-feeds': fetchMultipleRssFeeds,
  'search-newsapi': searchNewsApi,
  'get-top-headlines': getTopHeadlines,
  'analyze-sentiment': analyzeSentiment,
  'extract-entities': extractEntities,
  'classify-impact': classifyImpact,
  'store-article-in-chroma': storeArticleInChroma,
  'query-articles': queryArticles,
  'process-article': processArticle
};
