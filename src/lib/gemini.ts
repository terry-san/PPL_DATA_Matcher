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
  const model = "gemini-3-flash-preview";
  const ai = getAI();
  
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
    console.error("Gemini Extraction Error:", error);
    if (error?.message?.includes("API key")) {
      throw new Error("Invalid or missing API key.");
    }
    if (error?.message?.includes("Too Many Requests") || error?.status === 429) {
      throw new Error("System is busy (Rate Limit). Please try again in a minute.");
    }
    throw new Error(error?.message || "Internal Analysis Error");
  }
}
