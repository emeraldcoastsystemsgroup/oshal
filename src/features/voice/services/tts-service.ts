/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial extraction from chat-standalone.html
 *                     |                             | Text-to-speech service using speechSynthesis
 */

/* eslint-disable no-console -- client-side: browser speechSynthesis module (window/localStorage), no Node logger in the DOM */

/**
 * @description Service for managing text-to-speech functionality using browser speechSynthesis API
 * Handles voice playback, settings persistence, and playback state management
 */
export class TTSService {
  private enabled: boolean = false;
  private onPlaybackStart: (() => void) | null = null;
  private onPlaybackEnd: (() => void) | null = null;
  private onError: ((error: string) => void) | null = null;

  /**
   * @description Creates a new TTSService instance and loads settings from localStorage
   */
  constructor() {
    this.loadSettings();
  }

  /**
   * @description Loads TTS settings from localStorage
   */
  private loadSettings(): void {
    const savedEnabled = localStorage.getItem('ttsEnabled');
    this.enabled = savedEnabled === 'true';
  }

  /**
   * @description Saves TTS settings to localStorage
   */
  private saveSettings(): void {
    localStorage.setItem('ttsEnabled', this.enabled.toString());
  }

  /**
   * @description Checks if text-to-speech is supported in the current browser
   * @returns True if speechSynthesis is available, false otherwise
   */
  isSupported(): boolean {
    return 'speechSynthesis' in window;
  }

  /**
   * @description Checks if TTS is currently enabled
   * @returns True if TTS is enabled, false otherwise
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * @description Enables or disables TTS and persists the setting
   * @param enabled - Whether to enable TTS
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.saveSettings();
    console.log(`TTS ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * @description Toggles TTS enabled state
   * @returns New enabled state
   */
  toggle(): boolean {
    this.setEnabled(!this.enabled);
    return this.enabled;
  }

  /**
   * @description Speaks the provided text using browser text-to-speech
   * @param text - Text to speak
   * @returns True if speech started, false if TTS disabled or text empty
   */
  speak(text: string): boolean {
    if (!this.enabled || !text || text.trim().length === 0) {
      return false;
    }

    if (!this.isSupported()) {
      console.warn('speechSynthesis not supported');
      return false;
    }

    // Stop any existing speech
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    utterance.onstart = () => {
      if (this.onPlaybackStart) {
        this.onPlaybackStart();
      }
      console.log('🔊 TTS playback started');
    };

    utterance.onend = () => {
      if (this.onPlaybackEnd) {
        this.onPlaybackEnd();
      }
      console.log('✓ TTS playback ended');
    };

    utterance.onerror = (event) => {
      console.error('TTS error:', event.error);
      if (this.onError) {
        this.onError(event.error);
      }
      if (this.onPlaybackEnd) {
        this.onPlaybackEnd();
      }
    };

    window.speechSynthesis.speak(utterance);
    return true;
  }

  /**
   * @description Stops any ongoing speech playback
   */
  stop(): void {
    if (this.isSupported()) {
      window.speechSynthesis.cancel();
    }
  }

  /**
   * @description Registers a callback for playback start events
   * @param callback - Function to call when playback starts
   */
  setOnPlaybackStart(callback: () => void): void {
    this.onPlaybackStart = callback;
  }

  /**
   * @description Registers a callback for playback end events
   * @param callback - Function to call when playback ends
   */
  setOnPlaybackEnd(callback: () => void): void {
    this.onPlaybackEnd = callback;
  }

  /**
   * @description Registers a callback for error events
   * @param callback - Function to call when an error occurs
   */
  setOnError(callback: (error: string) => void): void {
    this.onError = callback;
  }

  /**
   * @description Cleans up resources and stops playback
   */
  dispose(): void {
    this.stop();
    this.onPlaybackStart = null;
    this.onPlaybackEnd = null;
    this.onError = null;
  }
}