import { GoogleGenAI } from '@google/genai';

/**
 * Default Gemini model for DataFix server-side AI diagnosis.
 * Uses gemini-3.1-flash-lite (with ThinkingLevel.MINIMAL) for fast, reliable
 * structured JSON output well within HTTP proxy timeouts.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite';

export function isGeminiConfigured(): boolean {
  const key = process.env.GEMINI_API_KEY;
  return Boolean(key && key.trim().length > 0 && key !== 'MY_GEMINI_API_KEY');
}

export function createGeminiClient(): GoogleGenAI {
  if (!isGeminiConfigured()) {
    throw new Error(
      'GEMINI_API_KEY is not configured. Add a valid key in Settings > Secrets to run live AI diagnosis.'
    );
  }

  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      timeout: 22000,
      retryOptions: {
        attempts: 1,
      },
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}
