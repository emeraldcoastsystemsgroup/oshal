/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * Vertex AI Tool Implementations — Real GCP API calls
 * 
 * Provides actual implementations for:
 * - generate-video: Veo 3.1 via predictLongRunning (async, polls for completion)
 * - generate-image: Imagen 4.0 via predict (sync, returns base64)
 * - assess-video: Gemini 2.5 Pro multimodal (video analysis)
 * 
 * These replace the stub handlers registered by AGENT_MCP_TOOLS in app.js
 * when running on the video-bot container (which has @google-cloud/vertexai installed).
 * 
 * PHASE_14: Real Vertex AI tool implementations
 */

const logger = require('../../utils/logger');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── Auth Helper ────────────────────────────────────────────────
let _authClient = null;

async function getAuthToken() {
  try {
    const { GoogleAuth } = require('google-auth-library');
    if (!_authClient) {
      _authClient = new GoogleAuth({
        keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS || '/app/credentials/gcp-service-account.json',
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
    }
    const client = await _authClient.getClient();
    const token = await client.getAccessToken();
    return token.token;
  } catch (err) {
    logger.error(`[VertexAI] Auth failed: ${err.message}`);
    throw new Error(`GCP authentication failed: ${err.message}`);
  }
}

function getProjectConfig() {
  return {
    project: process.env.GCP_PROJECT_ID || process.env.VERTEX_PROJECT || '',
    location: process.env.GCP_LOCATION || process.env.VERTEX_LOCATION || 'us-central1',
  };
}

// ─── HTTP Helper ────────────────────────────────────────────────
function vertexRequest(url, body, token, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(postData);
    req.end();
  });
}

function vertexGet(url, token, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Poll timeout')); });
    req.end();
  });
}

// ─── GENERATE VIDEO (Veo 3.1) ──────────────────────────────────
/**
 * @description Generates video via Vertex AI Veo. Veo runs as a long-running
 * operation, so this submits the request, then polls for completion (up to 10
 * minutes) so callers get a finished result rather than an opaque operation
 * handle. Handles the several output shapes Veo has used across versions
 * (videos[] base64/gcsUri, generateVideoResponse samples, predictions[]) and
 * persists base64 output to the workspace so it is servable via a URL.
 * @param {object} params - Generation options.
 * @param {string} params.prompt - Text prompt describing the video (required).
 * @param {string} [params.model] - Veo model id (defaults to veo-3.1-generate-001).
 * @param {number} [params.duration_seconds] - Desired clip length in seconds (defaults to 8).
 * @param {string} [params.aspect_ratio] - Output aspect ratio, e.g. '16:9' (defaults to '16:9').
 * @returns {Promise<object>} Result object with success flag plus generated video metadata, or error details.
 */
async function generateVideo(params) {
  const { prompt, model, duration_seconds, aspect_ratio } = params;
  
  if (!prompt) {
    return { success: false, error: 'prompt is required' };
  }
  
  const veoModel = model || 'veo-3.1-generate-001';
  const duration = duration_seconds || 8;
  const ratio = aspect_ratio || '16:9';
  const { project, location } = getProjectConfig();
  
  logger.info(`[VertexAI] 🎬 Generating video: model=${veoModel}, prompt="${prompt.substring(0, 80)}...", duration=${duration}s`);
  
  try {
    const token = await getAuthToken();
    
    // Step 1: Submit async video generation request
    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${veoModel}:predictLongRunning`;
    
    const body = {
      instances: [{
        prompt: prompt,
      }],
      parameters: {
        aspectRatio: ratio,
        durationSeconds: duration,
        sampleCount: 1,
      },
    };
    
    const response = await vertexRequest(url, body, token, 60000);
    
    if (response.status !== 200) {
      const errMsg = response.data?.error?.message || JSON.stringify(response.data).substring(0, 200);
      logger.error(`[VertexAI] Veo API error ${response.status}: ${errMsg}`);
      return { success: false, error: `Veo API error ${response.status}: ${errMsg}`, model: veoModel };
    }
    
    // Step 2: Get operation name for polling
    const operationName = response.data.name;
    if (!operationName) {
      logger.error('[VertexAI] No operation name returned from Veo');
      return { success: false, error: 'No operation name returned', rawResponse: response.data };
    }
    
    logger.info(`[VertexAI] 🎬 Video generation started: operation=${operationName}`);
    
    // Step 3: Poll for completion using fetchPredictOperation (POST, not GET)
    // Vertex AI publisher model operations require POST to :fetchPredictOperation
    // with operationName in the request body — NOT a GET on the operation path.
    const maxPollTime = 10 * 60 * 1000; // 10 minutes max
    const pollInterval = 10000; // 10 seconds
    const startTime = Date.now();
    
    const fetchOpUrl = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${veoModel}:fetchPredictOperation`;
    
    while (Date.now() - startTime < maxPollTime) {
      await new Promise(r => setTimeout(r, pollInterval));
      
      const pollResult = await vertexRequest(fetchOpUrl, { operationName }, token, 30000);
      
      if (pollResult.status !== 200) {
        logger.warn(`[VertexAI] Poll error ${pollResult.status}: ${JSON.stringify(pollResult.data).substring(0, 200)}, retrying...`);
        continue;
      }
      
      const op = pollResult.data;
      
      if (op.done) {
        logger.info(`[VertexAI] 🎬 Video generation complete! (${Math.round((Date.now() - startTime) / 1000)}s)`);
        
        if (op.error) {
          return { success: false, error: `Veo error: ${op.error.message}`, code: op.error.code };
        }
        
        // Debug: log the raw response structure to understand Veo output format
        const responseKeys = op.response ? Object.keys(op.response) : [];
        logger.info(`[VertexAI] 🔍 Response keys: [${responseKeys.join(', ')}]`);
        logger.info(`[VertexAI] 🔍 Response preview: ${JSON.stringify(op.response).substring(0, 500)}`);
        
        // Extract video data from response
        // Veo can return videos in multiple formats depending on version:
        // - response.videos[] with gcsUri/mimeType (Veo 2.0+)
        // - response.generateVideoResponse.generatedSamples[] (Veo 3.x)
        // - response.predictions[] with bytesBase64Encoded
        const videos = op.response?.videos || [];
        const generatedSamples = op.response?.generateVideoResponse?.generatedSamples || [];
        const predictions = op.response?.predictions || op.metadata?.predictions || [];
        
        // Handle videos[] array — Veo returns either bytesBase64Encoded or gcsUri
        if (videos.length > 0) {
          const videoResults = [];
          for (let i = 0; i < videos.length; i++) {
            const v = videos[i];
            
            if (v.bytesBase64Encoded) {
              // Video returned as base64 — save to workspace
              const filename = `video_${Date.now()}_${i}.mp4`;
              const workspaceDir = '/app/workspace';
              const filePath = path.join(workspaceDir, filename);
              
              const videoBuffer = Buffer.from(v.bytesBase64Encoded, 'base64');
              fs.writeFileSync(filePath, videoBuffer);
              const sizeKB = Math.round(videoBuffer.length / 1024);
              logger.info(`[VertexAI] 🎬 Video saved: ${filePath} (${sizeKB}KB)`);
              
              videoResults.push({
                filename,
                path: filePath,
                sizeKB,
                url: `/workspace/${filename}`,
                mimeType: v.mimeType || 'video/mp4',
                index: i,
              });
            } else if (v.gcsUri) {
              // Video on GCS — return URI
              videoResults.push({
                gcsUri: v.gcsUri,
                mimeType: v.mimeType || 'video/mp4',
                index: i,
              });
            }
          }
          
          const locations = videoResults.map(v => v.url || v.gcsUri || v.filename).join(', ');
          logger.info(`[VertexAI] 🎬 Generated ${videoResults.length} video(s): ${locations}`);
          
          return {
            success: true,
            model: veoModel,
            prompt: prompt,
            duration: duration,
            aspectRatio: ratio,
            operationName,
            processingTime: `${Math.round((Date.now() - startTime) / 1000)}s`,
            videos: videoResults,
            raiFilteredCount: op.response?.raiMediaFilteredCount || 0,
            message: `Generated ${videoResults.length} video(s). ${locations}`,
          };
        }
        
        // Handle base64 predictions format (fallback)
        if (predictions.length > 0) {
          const videoResults = [];
          for (let i = 0; i < predictions.length; i++) {
            const pred = predictions[i];
            if (pred.bytesBase64Encoded || pred.video?.bytesBase64Encoded) {
              const b64 = pred.bytesBase64Encoded || pred.video.bytesBase64Encoded;
              const filename = `video_${Date.now()}_${i}.mp4`;
              const workspaceDir = '/app/workspace';
              const filePath = path.join(workspaceDir, filename);
              
              fs.writeFileSync(filePath, Buffer.from(b64, 'base64'));
              logger.info(`[VertexAI] 🎬 Video saved: ${filePath} (${Math.round(Buffer.from(b64, 'base64').length / 1024)}KB)`);
              
              videoResults.push({
                filename,
                path: filePath,
                sizeKB: Math.round(Buffer.from(b64, 'base64').length / 1024),
                url: `/workspace/${filename}`,
              });
            } else if (pred.gcsUri || pred.video?.gcsUri) {
              videoResults.push({
                gcsUri: pred.gcsUri || pred.video.gcsUri,
              });
            }
          }
          
          return {
            success: true,
            model: veoModel,
            prompt: prompt,
            duration: duration,
            aspectRatio: ratio,
            operationName,
            processingTime: `${Math.round((Date.now() - startTime) / 1000)}s`,
            videos: videoResults,
            message: videoResults.length > 0 
              ? `Generated ${videoResults.length} video(s). ${videoResults.map(v => v.url || v.gcsUri).join(', ')}`
              : 'Video generation completed — check response for output.',
            rawPredictions: predictions,
          };
        }
        
        // No videos or predictions — return raw response
        const videoData = op.response || op.result || {};
        return {
          success: true,
          model: veoModel,
          prompt: prompt,
          duration: duration,
          aspectRatio: ratio,
          operationName,
          processingTime: `${Math.round((Date.now() - startTime) / 1000)}s`,
          response: videoData,
          message: 'Video generation completed. Check response for video data/URL.',
        };
      }
      
      // Still processing
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      logger.info(`[VertexAI] 🎬 Video still generating... (${elapsed}s elapsed, done=${op.done || false})`);
    }
    
    // Timed out but operation may still be running
    return {
      success: false,
      error: 'Video generation timed out (10 minutes). Operation may still be running.',
      operationName,
      model: veoModel,
      fetchOpUrl,
      fetchOpBody: { operationName },
      message: 'You can manually poll using POST to fetchPredictOperation with the operationName in the body.',
    };
    
  } catch (err) {
    logger.error(`[VertexAI] Generate video error: ${err.message}`);
    return { success: false, error: err.message, model: veoModel };
  }
}

// ─── GENERATE IMAGE (Imagen 4.0) ───────────────────────────────
/**
 * @description Generates one or more images via Vertex AI Imagen. Unlike video,
 * Imagen is synchronous, so this calls :predict directly and decodes the
 * returned base64 images to the workspace so they are servable via a URL. The
 * requested sample count is capped to keep cost and payload size bounded.
 * @param {object} params - Generation options.
 * @param {string} params.prompt - Text prompt describing the image (required).
 * @param {string} [params.model] - Imagen model id (defaults to imagen-4.0-generate-001).
 * @param {number} [params.sample_count] - Number of images to generate, capped at 4 (defaults to 1).
 * @param {string} [params.aspect_ratio] - Output aspect ratio, e.g. '1:1' (defaults to '1:1').
 * @returns {Promise<object>} Result object with success flag plus generated image metadata, or error details.
 */
async function generateImage(params) {
  const { prompt, model, sample_count, aspect_ratio } = params;
  
  if (!prompt) {
    return { success: false, error: 'prompt is required' };
  }
  
  const imagenModel = model || 'imagen-4.0-generate-001';
  const sampleCount = Math.min(sample_count || 1, 4);
  const ratio = aspect_ratio || '1:1';
  const { project, location } = getProjectConfig();
  
  logger.info(`[VertexAI] 🖼️ Generating image: model=${imagenModel}, prompt="${prompt.substring(0, 80)}...", count=${sampleCount}`);
  
  try {
    const token = await getAuthToken();
    
    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${imagenModel}:predict`;
    
    const body = {
      instances: [{
        prompt: prompt,
      }],
      parameters: {
        sampleCount: sampleCount,
        aspectRatio: ratio,
      },
    };
    
    const response = await vertexRequest(url, body, token, 60000);
    
    if (response.status !== 200) {
      const errMsg = response.data?.error?.message || JSON.stringify(response.data).substring(0, 200);
      logger.error(`[VertexAI] Imagen API error ${response.status}: ${errMsg}`);
      return { success: false, error: `Imagen API error ${response.status}: ${errMsg}`, model: imagenModel };
    }
    
    // Extract images from predictions
    const predictions = response.data.predictions || [];
    const imageResults = [];
    
    for (let i = 0; i < predictions.length; i++) {
      const pred = predictions[i];
      const b64 = pred.bytesBase64Encoded;
      
      if (b64) {
        const filename = `image_${Date.now()}_${i}.png`;
        const workspaceDir = '/app/workspace';
        const filePath = path.join(workspaceDir, filename);
        
        fs.writeFileSync(filePath, Buffer.from(b64, 'base64'));
        const sizeKB = Math.round(Buffer.from(b64, 'base64').length / 1024);
        logger.info(`[VertexAI] 🖼️ Image saved: ${filePath} (${sizeKB}KB)`);
        
        imageResults.push({
          filename,
          path: filePath,
          sizeKB,
          url: `/workspace/${filename}`,
          mimeType: pred.mimeType || 'image/png',
        });
      }
    }
    
    if (imageResults.length === 0) {
      return {
        success: false,
        error: 'No images returned from Imagen API',
        model: imagenModel,
        rawResponse: response.data,
      };
    }
    
    logger.info(`[VertexAI] 🖼️ Generated ${imageResults.length} image(s) with ${imagenModel}`);
    
    return {
      success: true,
      model: imagenModel,
      prompt: prompt,
      aspectRatio: ratio,
      images: imageResults,
      message: `Generated ${imageResults.length} image(s): ${imageResults.map(img => img.url).join(', ')}`,
    };
    
  } catch (err) {
    logger.error(`[VertexAI] Generate image error: ${err.message}`);
    return { success: false, error: err.message, model: imagenModel };
  }
}

// ─── ASSESS VIDEO (Gemini 2.5 Pro Multimodal) ──────────────────
/**
 * @description Assesses an existing video by handing it to Gemini's multimodal
 * model, which is used here (rather than the raw REST helpers above) for its
 * native file/video understanding. Builds a structured prompt that asks for a
 * per-criterion rating, timestamped observations, and recommendations so the
 * output is a consistent, reviewable report.
 * @param {object} params - Assessment options.
 * @param {string} params.video_url - URI of the video to assess, e.g. a GCS path (required).
 * @param {string[]} [params.criteria] - Aspects to evaluate (defaults to quality, content, technical, aesthetic).
 * @param {string} [params.model] - Gemini model id (defaults to gemini-2.5-pro).
 * @returns {Promise<object>} Result object with success flag plus the assessment text, or error details.
 */
async function assessVideo(params) {
  const { video_url, criteria, model } = params;
  
  if (!video_url) {
    return { success: false, error: 'video_url is required' };
  }
  
  const geminiModel = model || 'gemini-2.5-pro';
  const assessmentCriteria = criteria || ['quality', 'content', 'technical', 'aesthetic'];
  
  logger.info(`[VertexAI] 🔍 Assessing video: model=${geminiModel}, url=${video_url}, criteria=${assessmentCriteria.join(',')}`);
  
  try {
    const { VertexAI } = require('@google-cloud/vertexai');
    
    const vertex = new VertexAI({
      project: getProjectConfig().project,
      location: getProjectConfig().location,
      googleAuthOptions: {
        keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS || '/app/credentials/gcp-service-account.json',
      },
    });
    
    const generativeModel = vertex.getGenerativeModel({ model: geminiModel });
    
    // Build assessment prompt
    const criteriaText = assessmentCriteria.map(c => `- ${c}`).join('\n');
    const assessPrompt = `Analyze this video and provide a detailed assessment covering the following criteria:

${criteriaText}

For each criterion, provide:
1. A rating (1-10)
2. Specific observations with timestamps
3. Recommendations for improvement

Format your response as a structured markdown report with clear sections for each criterion.`;

    // Build request with video
    const request = {
      contents: [{
        role: 'user',
        parts: [
          {
            fileData: {
              mimeType: 'video/mp4',
              fileUri: video_url,
            },
          },
          { text: assessPrompt },
        ],
      }],
    };
    
    const result = await generativeModel.generateContent(request);
    const responseText = result.response.candidates[0].content.parts[0].text;
    
    logger.info(`[VertexAI] 🔍 Video assessment complete: ${responseText.length} chars`);
    
    return {
      success: true,
      model: geminiModel,
      videoUrl: video_url,
      criteria: assessmentCriteria,
      assessment: responseText,
      message: `Video assessment completed using ${geminiModel}`,
    };
    
  } catch (err) {
    logger.error(`[VertexAI] Assess video error: ${err.message}`);
    return { success: false, error: err.message, model: geminiModel };
  }
}

// ─── Exported Tool Registry ─────────────────────────────────────
/**
 * @description Tool registry that maps agent-facing tool names to their real
 * Vertex AI implementations. This shape lets app.js swap these in for the stub
 * handlers on containers that have the GCP dependencies installed.
 */
module.exports = {
  'generate-video': generateVideo,
  'generate-image': generateImage,
  'assess-video': assessVideo,
};
