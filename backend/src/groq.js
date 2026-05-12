import OpenAI from 'openai';
import { config } from './config.js';

export const groq = new OpenAI({
  apiKey: config.groq.apiKey || 'missing-key',
  baseURL: config.groq.baseURL,
});

export const SYSTEM_PROMPT =
  'You are a friendly avatar assistant. Reply in 1-2 short, natural sentences. No markdown, no lists, no special characters. Plain conversational English.';
