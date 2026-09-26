import { describe, expect, it } from 'vitest';
import {
  SMS_CHANNEL_PROVIDER,
  WHATSAPP_CHANNEL_PROVIDER,
  normalizeE164,
  parseTwilioChannelAddress,
} from '@/features/chat-channels';

describe('Twilio chat-channel address normalization', () => {
  it('keeps WhatsApp and SMS identities distinct while normalizing the same number', () => {
    expect(parseTwilioChannelAddress('whatsapp:+1 (555) 111-0001')).toEqual({
      provider: WHATSAPP_CHANNEL_PROVIDER,
      number: '+15551110001',
    });
    expect(parseTwilioChannelAddress('+1 (555) 111-0001')).toEqual({
      provider: SMS_CHANNEL_PROVIDER,
      number: '+15551110001',
    });
    expect(parseTwilioChannelAddress('WHATSAPP:+15551110001')?.provider).toBe(WHATSAPP_CHANNEL_PROVIDER);
    expect(normalizeE164('whatsapp:+15551110001')).toBeNull();
  });

  it('rejects malformed or non-international channel addresses', () => {
    expect(parseTwilioChannelAddress('whatsapp:5551110001')).toBeNull();
    expect(parseTwilioChannelAddress('discord:+15551110001')).toBeNull();
    expect(parseTwilioChannelAddress('')).toBeNull();
  });
});
