
import { GoogleGenAI, Type, GenerateContentResponse } from "@google/genai";
import { Idea, Character, Scene } from "./types";

// Helper to create AI instance with current environment key
const getAI = () => new GoogleGenAI({ apiKey: process.env.API_KEY });

export const generateStoryStream = async (
  idea: Idea, 
  characters: Character[],
  onChunk: (text: string) => void
): Promise<any> => {
  const ai = getAI();
  const charContext = characters.map(c => `${c.name} (${c.role}): ${c.description}. Rules: ${c.consistencyRules.join(', ')}`).join('\n');
  
  const prompt = `
    Create a cinematic video storyboard JSON.
    Language: ${idea.language === 'ID' ? 'Indonesian' : 'English'}
    Theme: ${idea.theme}
    Genre: ${idea.genre}
    Duration: ${idea.durationSec}s
    Platform: ${idea.platform}
    Style: ${idea.stylePreset}
    Mood: ${idea.mood}
    CTA: ${idea.cta}

    Characters:
    ${charContext}

    Output valid JSON:
    {
      "synopsis": "summary",
      "beats": ["beat1", "beat2"],
      "scenes": [
        {
          "title": "Scene 1",
          "durationSec": 5,
          "shotType": "Wide",
          "setting": "Loc",
          "action": "desc",
          "characterIds": ["name"],
          "vo": "voiceover"
        }
      ]
    }
    Exactly 8 scenes. All text must be in ${idea.language === 'ID' ? 'Indonesian' : 'English'}.
  `;

  const responseStream = await ai.models.generateContentStream({
    model: 'gemini-3-pro-preview',
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          synopsis: { type: Type.STRING },
          beats: { type: Type.ARRAY, items: { type: Type.STRING } },
          scenes: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                durationSec: { type: Type.NUMBER },
                shotType: { type: Type.STRING },
                setting: { type: Type.STRING },
                action: { type: Type.STRING },
                characterIds: { type: Type.ARRAY, items: { type: Type.STRING } },
                vo: { type: Type.STRING }
              },
              required: ["title", "durationSec", "shotType", "setting", "action", "characterIds", "vo"]
            }
          }
        },
        required: ["synopsis", "beats", "scenes"]
      }
    }
  });

  let fullText = '';
  for await (const chunk of responseStream) {
    const text = chunk.text;
    if (text) {
      fullText += text;
      onChunk(fullText);
    }
  }

  return JSON.parse(fullText);
};

export const generateScenePrompt = async (scene: Scene, storyContext: string, characters: Character[]): Promise<any> => {
  const ai = getAI();
  const sceneChars = characters.filter(c => scene.characterIds.includes(c.name));
  const charDesc = sceneChars.map(c => `${c.name}: ${c.description} (Visual: ${c.consistencyRules.join(', ')})`).join('\n');

  const prompt = `
    Generate a high-quality visual prompt for this storyboard scene:
    Background: ${storyContext}
    Scene: ${scene.action}
    Shot: ${scene.shotType}
    Location: ${scene.setting}
    Characters:
    ${charDesc}

    Return JSON:
    {
      "positive": "vivid descriptive prompt...",
      "negative": "low quality...",
      "stylePreset": "preset name"
    }
  `;

  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          positive: { type: Type.STRING },
          negative: { type: Type.STRING },
          stylePreset: { type: Type.STRING }
        },
        required: ["positive", "negative", "stylePreset"]
      }
    }
  });

  return JSON.parse(response.text);
};

export const generateSceneImage = async (
  prompt: string, 
  aspectRatio: "9:16" | "16:9" = "16:9", 
  seed?: number,
  references?: string[] // base64 images
): Promise<string> => {
  const ai = getAI();
  const parts: any[] = [];

  if (references && references.length > 0) {
    references.forEach((ref) => {
      const cleanData = ref.replace(/^data:image\/\w+;base64,/, '');
      parts.push({
        inlineData: {
          mimeType: 'image/png',
          data: cleanData
        }
      });
    });
    parts.push({ text: `Based on the provided character references, generate: ${prompt}` });
  } else {
    parts.push({ text: prompt });
  }

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-image',
    contents: { parts },
    config: { 
      imageConfig: { aspectRatio },
      seed: seed
    }
  });

  for (const part of response.candidates[0].content.parts) {
    if (part.inlineData) {
      return `data:image/png;base64,${part.inlineData.data}`;
    }
  }
  throw new Error("No image data returned");
};

export const generateVoiceOver = async (text: string, voiceName: string = 'Kore'): Promise<string> => {
  const ai = getAI();
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-preview-tts",
    contents: [{ parts: [{ text }] }],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName },
        },
      },
    },
  });

  const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!base64Audio) throw new Error("No audio data generated");
  return base64Audio;
};

export const generateCharacterAvatar = async (character: Character, style: string, seed?: number): Promise<string> => {
  const ai = getAI();
  const prompt = `Full body cinematic character portrait of ${character.name}. 
    Description: ${character.description}. 
    Style: ${style}. 
    Visual rules: ${character.consistencyRules.join(', ')}. 
    High quality, professional lighting, centered.`;
    
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-image',
    contents: { parts: [{ text: character.avatarPrompt || prompt }] },
    config: { 
      imageConfig: { aspectRatio: "1:1" },
      seed: seed
    }
  });

  for (const part of response.candidates[0].content.parts) {
    if (part.inlineData) {
      return `data:image/png;base64,${part.inlineData.data}`;
    }
  }
  throw new Error("No avatar data returned");
};
