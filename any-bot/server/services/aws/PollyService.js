/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * AWS Polly Service
 * Converts text to speech using AWS Polly
 */

const {
  PollyClient,
  SynthesizeSpeechCommand,
} = require('@aws-sdk/client-polly');
const logger = require('../../utils/logger');

class PollyService {
  constructor() {
    const region = process.env.AWS_REGION || 'us-gov-west-1';
    
    this.pollyClient = new PollyClient({ region });
    this.defaultVoice = process.env.POLLY_VOICE || 'Matthew'; // Changed from Joanna to Matthew (neural, less robotic)
    this.engine = process.env.POLLY_ENGINE || 'neural';
    
    logger.info(`PollyService initialized (region: ${region}, voice: ${this.defaultVoice}, engine: ${this.engine})`);
  }

  /**
   * Synthesize text to speech
   * @param {string} text - Text to convert to speech
   * @param {string} voiceId - Voice to use (optional)
   * @returns {Promise<Buffer>} Audio buffer (MP3)
   */
  async synthesizeSpeech(text, voiceId = this.defaultVoice) {
    try {
      // Handle empty or very short text
      if (!text || text.trim().length === 0) {
        throw new Error('Text cannot be empty');
      }

      // Handle long text by splitting
      if (text.length > 3000) {
        logger.info(`Text is long (${text.length} chars), splitting into chunks`);
        return await this.synthesizeLongText(text, voiceId);
      }

      logger.info(`Synthesizing speech: ${text.substring(0, 50)}... (${text.length} chars)`);
      
      const command = new SynthesizeSpeechCommand({
        Text: text,
        OutputFormat: 'mp3',
        VoiceId: voiceId,
        Engine: this.engine,
        TextType: 'text',
      });
      
      const response = await this.pollyClient.send(command);
      
      // Convert stream to buffer
      const chunks = [];
      for await (const chunk of response.AudioStream) {
        chunks.push(chunk);
      }
      
      const audioBuffer = Buffer.concat(chunks);
      logger.info(`Speech synthesized: ${audioBuffer.length} bytes`);
      
      return audioBuffer;
      
    } catch (error) {
      logger.error(`Speech synthesis error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Synthesize long text by splitting into chunks
   * @param {string} text - Long text to synthesize
   * @param {string} voiceId - Voice to use
   * @returns {Promise<Buffer>} Concatenated audio buffer
   */
  async synthesizeLongText(text, voiceId) {
    const chunks = this.splitTextIntoChunks(text, 3000);
    logger.info(`Split into ${chunks.length} chunks`);
    
    const audioBuffers = [];
    for (let i = 0; i < chunks.length; i++) {
      logger.info(`Synthesizing chunk ${i + 1}/${chunks.length}`);
      const buffer = await this.synthesizeSpeech(chunks[i], voiceId);
      audioBuffers.push(buffer);
    }
    
    return Buffer.concat(audioBuffers);
  }

  /**
   * Split text into chunks at sentence boundaries
   * @param {string} text - Text to split
   * @param {number} maxLength - Max length per chunk
   * @returns {Array<string>} Array of text chunks
   */
  splitTextIntoChunks(text, maxLength) {
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    const chunks = [];
    let currentChunk = '';
    
    for (const sentence of sentences) {
      if ((currentChunk + sentence).length > maxLength) {
        if (currentChunk) {
          chunks.push(currentChunk.trim());
        }
        currentChunk = sentence;
      } else {
        currentChunk += sentence;
      }
    }
    
    if (currentChunk) {
      chunks.push(currentChunk.trim());
    }
    
    return chunks;
  }

  /**
   * Get list of available voices
   * @returns {Array} List of voice objects
   */
  getAvailableVoices() {
    return [
      { id: 'Joanna', name: 'Joanna (Female, US)', language: 'en-US', gender: 'Female' },
      { id: 'Matthew', name: 'Matthew (Male, US)', language: 'en-US', gender: 'Male' },
      { id: 'Ivy', name: 'Ivy (Female, US)', language: 'en-US', gender: 'Female' },
      { id: 'Justin', name: 'Justin (Male, US)', language: 'en-US', gender: 'Male' },
      { id: 'Kendra', name: 'Kendra (Female, US)', language: 'en-US', gender: 'Female' },
      { id: 'Kimberly', name: 'Kimberly (Female, US)', language: 'en-US', gender: 'Female' },
      { id: 'Salli', name: 'Salli (Female, US)', language: 'en-US', gender: 'Female' },
      { id: 'Joey', name: 'Joey (Male, US)', language: 'en-US', gender: 'Male' },
    ];
  }
}

/**
 * @description Default export: a shared singleton PollyService instance, so all
 * callers reuse one configured AWS Polly client (region/voice/engine from env)
 * rather than constructing a new client per import.
 */
module.exports = new PollyService();
