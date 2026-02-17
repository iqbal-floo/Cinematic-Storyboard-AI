
export type Platform = 'TikTok' | 'Reels' | 'Shorts' | 'YouTube';
export type Language = 'ID' | 'EN';

export interface Character {
  id: string;
  name: string;
  role: string;
  description: string;
  consistencyRules: string[];
  referenceImage?: string; // base64
  avatarPrompt?: string;
  status?: 'idle' | 'generating' | 'completed' | 'error';
}

export interface Idea {
  theme: string;
  genre: string;
  durationSec: number;
  platform: Platform;
  stylePreset: string;
  mood: string;
  cta: string;
  language: Language;
  voiceName: string;
  seed: number;
}

export interface Prompt {
  positive: string;
  negative: string;
  stylePreset: string;
}

export interface SceneImage {
  status: 'idle' | 'generating' | 'completed' | 'error';
  url?: string;
}

export interface SceneAudio {
  status: 'idle' | 'generating' | 'completed' | 'error';
  data?: string; // base64 pcm
}

export interface Scene {
  id: string;
  order: number;
  title: string;
  durationSec: number;
  shotType: string;
  setting: string;
  action: string;
  characterIds: string[]; // These will be character names for easier LLM reference
  vo: string;
  prompt: Prompt;
  image: SceneImage;
  audio?: SceneAudio;
  isRefining?: boolean;
  useSameCharacter?: boolean;
}

export interface Story {
  synopsis: string;
  beats: string[];
}

export interface ProjectVersion {
  id: string;
  createdAt: number;
  label: string;
  projectSnapshot: {
    story: Story;
    scenes: Scene[];
  };
}

export interface Project {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  idea: Idea;
  characters: Character[];
  story: Story;
  scenes: Scene[];
  versions: ProjectVersion[];
}

export interface AppState extends Project {
  history: Project[];
  historyIndex: number;
  isStreaming: boolean;
  streamingContent: string;
  autoUpdatePrompts: boolean;
}
