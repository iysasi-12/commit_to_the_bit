export type ServiceMode = "live" | "demo" | "unavailable";

export interface AppConfigInfo {
  demoMode: boolean;
  consentVersion: string;
  aiProvider: "anthropic" | "gemini" | "demo" | null;
  signIn: { google: boolean; demo: boolean };
  services: { gmail: ServiceMode; ai: ServiceMode; voice: ServiceMode };
  aiModel: string | null;
  voiceModel: string | null;
  limits: { summaryMaxEmails: number; cloneMaxFiles: number; cloneMaxFileMb: number; maxCategories: number; cacheTtlHours: number };
}

export interface Settings {
  summaryLength: "brief" | "detailed";
  speakingSpeed: number;
  summaryCount: number;
  autoPlay: boolean;
  autoSort: boolean;
}

export interface Me {
  id: string;
  name: string;
  email: string;
  isDemo: boolean;
  mailMode: "live" | "demo";
  consent: { accepted: boolean; acceptedAt: number | null; version: string | null };
  settings: Settings;
  selectedVoiceRef: string | null;
}

export interface InboxItem {
  id: string;
  threadId: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  date: string;
  internalDate: number;
  snippet: string;
  unread: boolean;
  categoryId: string | null;
}

export interface InboxResponse {
  messages: InboxItem[];
  unclassified: number;
  categoriesVersion: number;
}

export interface FullMessage extends InboxItem {
  bodyText: string;
  bodyTruncated: boolean;
}

export interface Category {
  id: string;
  name: string;
  description: string;
  color: string;
  isFallback: boolean;
}

export interface CategoriesResponse {
  categoriesVersion: number;
  categories: Category[];
}

export interface Summary {
  id: string;
  title: string;
  text: string;
  scope: string;
  messageCount: number;
  truncatedCount: number;
  aiMode: string;
  createdAt: number;
}

export interface AudioInfo {
  id: string;
  url: string;
  mime: string;
  voiceMode: string;
  voiceName: string | null;
  voiceKind: string | null;
  chars: number;
}

export interface StockVoice {
  providerVoiceId: string;
  name: string;
  description: string;
  previewUrl: string | null;
  labels: Record<string, string>;
}

export interface LibraryVoice {
  publicOwnerId: string;
  providerVoiceId: string;
  name: string;
  description: string;
  previewUrl: string | null;
  category: string;
  language: string | null;
  accent: string | null;
  gender: string | null;
  age: string | null;
  useCase: string | null;
}

export interface MyVoice {
  id: string;
  ref: string;
  kind: "own" | "library";
  name: string;
  status: "preview" | "approved";
  createdAt: number;
  recordingKept: boolean;
  requiresVerification: boolean;
  madeInDemo: boolean;
}

export interface ResolvedVoice {
  ref: string;
  providerVoiceId: string;
  name: string;
  kind: "stock" | "own" | "library";
}

export interface VoicesResponse {
  mode: ServiceMode;
  selected: ResolvedVoice | null;
  stock: StockVoice[];
  stockError: string | null;
  mine: MyVoice[];
}

export type Tab = "inbox" | "filter" | "voice" | "gmail" | "settings";
