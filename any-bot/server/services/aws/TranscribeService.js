/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * AWS Transcribe Service
 * Converts speech to text using AWS Transcribe
 */

const {
  TranscribeClient,
  StartTranscriptionJobCommand,
  GetTranscriptionJobCommand,
} = require('@aws-sdk/client-transcribe');
const {
  S3Client,
  PutObjectCommand,
} = require('@aws-sdk/client-s3');
const logger = require('../../utils/logger');
const crypto = require('crypto');

/**
 * @description Encapsulates the AWS Transcribe speech-to-text workflow so the
 * rest of the application can request transcriptions without managing the
 * underlying S3 upload, job lifecycle, and result retrieval. Exposed to callers
 * as a single shared instance (see the module export below).
 */
class TranscribeService {
  /**
   * @description Configures the AWS clients and storage target from environment
   * so the service is ready to run transcription jobs in the deployed region,
   * defaulting to GovCloud and a known bucket when those are not provided.
   */
  constructor() {
    const region = process.env.AWS_REGION || 'us-gov-west-1';
    
    this.transcribeClient = new TranscribeClient({ region });
    this.s3Client = new S3Client({ region });
    this.bucket = process.env.TRANSCRIBE_BUCKET || 'any-bot-transcribe';
    
    logger.info(`TranscribeService initialized (region: ${region}, bucket: ${this.bucket})`);
  }

  /**
   * Transcribe audio buffer to text
   * @param {Buffer} audioBuffer - Audio file buffer
   * @param {string} format - Audio format (webm, ogg, mp3, etc.)
   * @returns {Promise<string>} Transcribed text
   */
  async transcribeAudio(audioBuffer, format = 'webm') {
    try {
      // Generate unique job name
      const jobName = `transcribe-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
      const s3Key = `audio/${jobName}.${format}`;
      
      logger.info(`Starting transcription job: ${jobName}`);
      logger.info(`Audio size: ${audioBuffer.length} bytes, format: ${format}`);
      
      // Step 1: Upload audio to S3
      logger.info(`Uploading audio to S3: s3://${this.bucket}/${s3Key}`);
      await this.s3Client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: s3Key,
        Body: audioBuffer,
        ContentType: `audio/${format}`,
      }));
      logger.info('✓ Audio uploaded to S3');
      
      // Step 2: Start transcription job
      const mediaFileUri = `s3://${this.bucket}/${s3Key}`;
      const mediaFormat = format === 'webm' ? 'webm' : (format === 'ogg' ? 'ogg' : format);
      
      await this.transcribeClient.send(new StartTranscriptionJobCommand({
        TranscriptionJobName: jobName,
        LanguageCode: 'en-US',
        MediaFormat: mediaFormat,
        Media: {
          MediaFileUri: mediaFileUri,
        },
        Settings: {
          ShowSpeakerLabels: false,
        },
      }));
      logger.info('✓ Transcription job started');
      
      // Step 3: Poll for completion
      logger.info('Polling for transcription completion...');
      let attempt = 0;
      const maxAttempts = 60; // 60 seconds max
      
      while (attempt < maxAttempts) {
        const response = await this.transcribeClient.send(
          new GetTranscriptionJobCommand({
            TranscriptionJobName: jobName,
          })
        );
        
        const status = response.TranscriptionJob.TranscriptionJobStatus;
        logger.info(`Attempt ${attempt + 1}/${maxAttempts}: Status = ${status}`);
        
        if (status === 'COMPLETED') {
          // Fetch transcript from S3
          const transcriptUri = response.TranscriptionJob.Transcript.TranscriptFileUri;
          logger.info(`Fetching transcript from: ${transcriptUri}`);
          
          const transcriptResponse = await fetch(transcriptUri);
          if (!transcriptResponse.ok) {
            throw new Error(`Failed to fetch transcript: ${transcriptResponse.statusText}`);
          }
          
          const transcriptData = await transcriptResponse.json();
          const text = transcriptData.results.transcripts[0].transcript;
          
          logger.info(`✓ Transcription completed: "${text.substring(0, 100)}..."`);
          return text;
          
        } else if (status === 'FAILED') {
          const failureReason = response.TranscriptionJob.FailureReason || 'Unknown reason';
          throw new Error(`Transcription failed: ${failureReason}`);
        }
        
        // Wait 1 second before polling again
        await new Promise(resolve => setTimeout(resolve, 1000));
        attempt++;
      }
      
      throw new Error('Transcription timeout after 60 seconds');
      
    } catch (error) {
      logger.error(`Transcription error: ${error.message}`);
      throw error;
    }
  }
}

/**
 * @description Default export is a single shared TranscribeService instance so
 * every consumer reuses the same configured AWS clients rather than
 * re-initializing connections per import.
 */
module.exports = new TranscribeService();
