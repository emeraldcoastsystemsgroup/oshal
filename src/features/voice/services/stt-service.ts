/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial extraction from chat-standalone.html
 *                     |                             | Speech-to-text service using Web Speech API
 */

/* eslint-disable no-console -- client-side: browser Web Speech API module (window), no Node logger in the DOM */

/**
 * @description Service for managing speech-to-text functionality using Web Speech API
 * Handles voice recording, transcription, and browser compatibility checks
 */
export class STTService {
  private recognition: any = null;
  private isRecording: boolean = false;
  private finalTranscript: string = '';
  private interimTranscript: string = '';
  private onTranscriptUpdate: ((transcript: string) => void) | null = null;
  private onError: ((error: string) => void) | null = null;

  /**
   * @description Creates a new STTService instance and initializes Web Speech API if available
   */
  constructor() {
    this.initializeRecognition();
  }

  /**
   * @description Initializes the Web Speech API recognition engine
   */
  private initializeRecognition(): void {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    
    if (!SpeechRecognition) {
      console.log('Web Speech API not available');
      return;
    }

    try {
      this.recognition = new SpeechRecognition();
      this.recognition.continuous = true;
      this.recognition.interimResults = true;
      this.recognition.lang = 'en-US';
      
      this.recognition.onresult = (event: any) => {
        this.interimTranscript = '';
        
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcript = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            this.finalTranscript += transcript + ' ';
          } else {
            this.interimTranscript += transcript;
          }
        }
        
        const fullTranscript = (this.finalTranscript + this.interimTranscript).trim();
        if (this.onTranscriptUpdate) {
          this.onTranscriptUpdate(fullTranscript);
        }
      };
      
      this.recognition.onerror = (event: any) => {
        console.error('Speech recognition error:', event.error);
        if (event.error === 'not-allowed') {
          if (this.onError) {
            this.onError('Microphone access denied. Please allow microphone access and try again.');
          }
          this.stopRecording();
        }
      };
      
      this.recognition.onend = () => {
        if (this.isRecording) {
          try {
            this.recognition.start();
          } catch (error) {
            console.warn('Failed to restart recognition:', error);
          }
        }
      };
      
      console.log('✓ Web Speech API initialized');
    } catch (error) {
      console.warn('Web Speech API initialization failed:', error);
    }
  }

  /**
   * @description Checks if speech recognition is supported in the current browser
   * @returns True if Web Speech API is available, false otherwise
   */
  isSupported(): boolean {
    return this.recognition !== null;
  }

  /**
   * @description Starts voice recording and transcription
   * @returns True if recording started successfully, false otherwise
   */
  startRecording(): boolean {
    if (!this.recognition) {
      console.error('Speech recognition not available');
      return false;
    }
    
    try {
      this.finalTranscript = '';
      this.interimTranscript = '';
      
      this.recognition.start();
      this.isRecording = true;
      
      console.log('🎤 Voice recording started');
      return true;
    } catch (error) {
      console.error('Failed to start recording:', error);
      return false;
    }
  }

  /**
   * @description Stops voice recording and transcription
   */
  stopRecording(): void {
    if (!this.recognition || !this.isRecording) return;
    
    try {
      this.recognition.stop();
    } catch (error) {
      console.warn('Error stopping recognition:', error);
    }
    
    this.isRecording = false;
    console.log('🎤 Voice recording stopped');
  }

  /**
   * @description Gets the current recording status
   * @returns True if currently recording, false otherwise
   */
  getRecordingStatus(): boolean {
    return this.isRecording;
  }

  /**
   * @description Registers a callback for transcript updates
   * @param callback - Function to call when transcript is updated
   */
  setOnTranscriptUpdate(callback: (transcript: string) => void): void {
    this.onTranscriptUpdate = callback;
  }

  /**
   * @description Registers a callback for error events
   * @param callback - Function to call when an error occurs
   */
  setOnError(callback: (error: string) => void): void {
    this.onError = callback;
  }

  /**
   * @description Cleans up resources and stops recording
   */
  dispose(): void {
    this.stopRecording();
    this.onTranscriptUpdate = null;
    this.onError = null;
  }
}