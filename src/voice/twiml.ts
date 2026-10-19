import twilio from "twilio";
import type VoiceResponseType from "twilio/lib/twiml/VoiceResponse.js";
import type { Contractor } from "../domain/types.js";

const { VoiceResponse } = twilio.twiml;

type SayAttributes = VoiceResponseType.SayAttributes;

/** Voice/language come from settings as free text; Twilio validates them at call time. */
function sayAttrs(contractor: Contractor): SayAttributes {
  return {
    voice: contractor.settings.voice.sayVoice as SayAttributes["voice"],
    language: contractor.settings.voice.language as SayAttributes["language"],
  };
}

export interface RelayOptions {
  relayUrl: string;
  actionUrl: string;
  callId: string;
  welcomeGreeting?: string;
  hints?: string;
}

/** <Connect><ConversationRelay> - hands the call's audio to the AI over a WebSocket. */
export function conversationRelayTwiml(contractor: Contractor, opts: RelayOptions): string {
  const response = new VoiceResponse();
  const connect = response.connect({ action: opts.actionUrl, method: "POST" });
  const v = contractor.settings.voice;
  const relay = connect.conversationRelay({
    url: opts.relayUrl,
    language: v.language,
    ...(v.ttsProvider ? { ttsProvider: v.ttsProvider } : {}),
    ...(v.voice ? { voice: v.voice } : {}),
    ...(v.transcriptionProvider ? { transcriptionProvider: v.transcriptionProvider } : {}),
    ...(v.speechModel ? { speechModel: v.speechModel } : {}),
    ...(opts.welcomeGreeting ? { welcomeGreeting: opts.welcomeGreeting, welcomeGreetingInterruptible: "any" } : {}),
    ...(opts.hints ? { hints: opts.hints } : {}),
    interruptible: "any",
    dtmfDetection: true,
  });
  relay.parameter({ name: "callId", value: opts.callId });
  return response.toString();
}

export interface DialOptions {
  to: string;
  callerId: string;
  ringSeconds: number;
  actionUrl: string;
  whisperUrl: string;
}

/** Rings a team member. Their leg first runs the whisper (summary + "press 1") before the lead is bridged. */
export function dialTeamMemberTwiml(opts: DialOptions): string {
  const response = new VoiceResponse();
  const dial = response.dial({
    action: opts.actionUrl,
    method: "POST",
    timeout: opts.ringSeconds,
    callerId: opts.callerId,
  });
  dial.number({ url: opts.whisperUrl, method: "POST" }, opts.to);
  return response.toString();
}

export function whisperTwiml(contractor: Contractor, message: string, acceptUrl: string): string {
  const response = new VoiceResponse();
  const gather = response.gather({
    numDigits: 1,
    timeout: 6,
    action: acceptUrl,
    method: "POST",
    actionOnEmptyResult: true,
  });
  gather.say(sayAttrs(contractor), message);
  gather.pause({ length: 1 });
  gather.say(sayAttrs(contractor), "Press 1 to talk to them now.");
  response.hangup();
  return response.toString();
}

/** Empty response = continue and bridge the two calls. */
export function bridgeTwiml(): string {
  return new VoiceResponse().toString();
}

export function voicemailTwiml(contractor: Contractor, message: string): string {
  const response = new VoiceResponse();
  response.pause({ length: 1 });
  response.say(sayAttrs(contractor), message);
  response.hangup();
  return response.toString();
}

export function sayAndHangupTwiml(contractor: Contractor, message: string): string {
  const response = new VoiceResponse();
  response.say(sayAttrs(contractor), message);
  response.hangup();
  return response.toString();
}

export function hangupTwiml(): string {
  const response = new VoiceResponse();
  response.hangup();
  return response.toString();
}

export function emptyMessagingTwiml(): string {
  return new twilio.twiml.MessagingResponse().toString();
}
