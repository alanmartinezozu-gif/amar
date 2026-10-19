import twilio from "twilio";
import type { Config } from "../config.js";

export interface PlaceCallOptions {
  to: string;
  from: string;
  /** TwiML URL fetched when the callee answers. */
  answerUrl: string;
  statusCallbackUrl: string;
  /** Async answering-machine-detection result callback. */
  amdCallbackUrl: string;
  ringTimeoutSeconds: number;
}

export interface ConfigureNumberOptions {
  phoneNumber: string;
  voiceUrl: string;
  statusCallbackUrl: string;
  smsUrl: string;
}

/** Everything the system needs from the phone carrier. Twilio in production, a fake in tests. */
export interface Telephony {
  placeCall(opts: PlaceCallOptions): Promise<{ sid: string }>;
  /** Replace the TwiML a live call is executing (used to drop a voicemail when AMD detects a machine). */
  updateCallTwiml(callSid: string, twiml: string): Promise<void>;
  hangup(callSid: string): Promise<void>;
  sendSms(opts: { to: string; from: string; body: string }): Promise<{ sid: string }>;
  validateSignature(signature: string, url: string, params: Record<string, string>): boolean;
  /** Point a Twilio number's voice/SMS webhooks at this server. */
  configureNumber(opts: ConfigureNumberOptions): Promise<void>;
}

export class TwilioTelephony implements Telephony {
  private client: twilio.Twilio | null = null;

  constructor(private readonly config: Config) {}

  private get api(): twilio.Twilio {
    if (!this.client) {
      if (!this.config.TWILIO_ACCOUNT_SID || !this.config.TWILIO_AUTH_TOKEN) {
        throw new Error("Twilio is not configured: set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN");
      }
      this.client = twilio(this.config.TWILIO_ACCOUNT_SID, this.config.TWILIO_AUTH_TOKEN);
    }
    return this.client;
  }

  async placeCall(opts: PlaceCallOptions): Promise<{ sid: string }> {
    const call = await this.api.calls.create({
      to: opts.to,
      from: opts.from,
      url: opts.answerUrl,
      method: "POST",
      statusCallback: opts.statusCallbackUrl,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      timeout: opts.ringTimeoutSeconds,
      machineDetection: "DetectMessageEnd",
      asyncAmd: "true",
      asyncAmdStatusCallback: opts.amdCallbackUrl,
      asyncAmdStatusCallbackMethod: "POST",
    });
    return { sid: call.sid };
  }

  async updateCallTwiml(callSid: string, twiml: string): Promise<void> {
    await this.api.calls(callSid).update({ twiml });
  }

  async hangup(callSid: string): Promise<void> {
    await this.api.calls(callSid).update({ status: "completed" });
  }

  async sendSms(opts: { to: string; from: string; body: string }): Promise<{ sid: string }> {
    const msg = await this.api.messages.create({ to: opts.to, from: opts.from, body: opts.body });
    return { sid: msg.sid };
  }

  validateSignature(signature: string, url: string, params: Record<string, string>): boolean {
    if (!this.config.TWILIO_AUTH_TOKEN) return false;
    return twilio.validateRequest(this.config.TWILIO_AUTH_TOKEN, signature, url, params);
  }

  async configureNumber(opts: ConfigureNumberOptions): Promise<void> {
    const numbers = await this.api.incomingPhoneNumbers.list({ phoneNumber: opts.phoneNumber, limit: 1 });
    if (numbers.length === 0) throw new Error(`${opts.phoneNumber} is not a phone number on this Twilio account`);
    await this.api.incomingPhoneNumbers(numbers[0].sid).update({
      voiceUrl: opts.voiceUrl,
      voiceMethod: "POST",
      statusCallback: opts.statusCallbackUrl,
      statusCallbackMethod: "POST",
      smsUrl: opts.smsUrl,
      smsMethod: "POST",
    });
  }
}
