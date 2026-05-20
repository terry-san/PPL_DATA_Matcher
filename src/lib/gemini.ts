import { GoogleGenAI, Type } from "@google/genai";

let genAI: GoogleGenAI | null = null;

function getAI() {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("Missing GEMINI_API_KEY. If you are on GitHub, please set it in your secrets.");
    }
    genAI = new GoogleGenAI({ apiKey });
  }
  return genAI;
}

export async function extractTextFromVideo(base64Data: string, mimeType: string): Promise<string[]> {
  const models = ["gemini-3.5-flash", "gemini-3.1-flash-lite"];
  const ai = getAI();
  let lastError: any = null;

  for (const model of models) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: [
          {
            role: "user",
            parts: [
              {
                text: "Please analyze this video/GIF and extract all unique meaningful text items or labels visible. Output the result in a JSON array of strings. Only output the JSON array.",
              },
              {
                inlineData: {
                  data: base64Data,
                  mimeType: mimeType,
                },
              },
            ],
          },
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.STRING,
            },
          },
        },
      });

      const text = response.text;
      if (!text) return [];
      return JSON.parse(text);
    } catch (error: any) {
      console.warn(`Extraction failed with model ${model}, trying next...`, error);
      lastError = error;
      // If it's a rate limit or API key error, don't fallback; fail fast.
      const errorMsg = error?.message || JSON.stringify(error);
      if (errorMsg.includes("API key") || errorMsg.includes("Too Many Requests") || error?.status === 429) {
        break;
      }
    }
  }

  // If all models failed
  console.error("All Gemini Models Extraction Failed:", lastError);
  const errorMessage = lastError?.message || JSON.stringify(lastError);
  if (errorMessage.includes("API key")) {
    throw new Error("Invalid or missing API key.");
  }
  if (errorMessage.includes("Too Many Requests") || lastError?.status === 429) {
    throw new Error("System is busy (Rate Limit). Please try again in a minute.");
  }
  throw new Error(errorMessage || "Internal Analysis Error");
}
