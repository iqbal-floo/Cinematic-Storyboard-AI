
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Project, Character, Scene, AppState, Platform, ProjectVersion, Language } from './types';
import { generateStoryStream, generateScenePrompt, generateSceneImage, generateVoiceOver, generateCharacterAvatar } from './geminiService';
import { STYLE_PRESETS, SHOT_TYPES, GENRES, VOICES, ICONS, DEFAULT_NEGATIVE_PROMPT } from './constants';

const LOCAL_STORAGE_KEY = 'storyboard_ai_v3';

// AI Studio API Key helpers
const hasApiKey = async () => {
  try {
    return await (window as any).aistudio.hasSelectedApiKey();
  } catch (e) {
    return false;
  }
};

const openKeySelector = async () => {
  try {
    await (window as any).aistudio.openSelectKey();
    return true;
  } catch (e) {
    return false;
  }
};

const SidebarSection = ({ title, children, open = true }: { title: string; children?: React.ReactNode; open?: boolean }) => {
  const [isOpen, setIsOpen] = useState(open);
  return (
    <div className="border-b border-gray-200">
      <button 
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-4 hover:bg-gray-50 transition-colors"
      >
        <span className="text-xs font-bold text-gray-500 uppercase tracking-widest">{title}</span>
        <span className={`transform transition-transform text-gray-400 ${isOpen ? 'rotate-180' : ''}`}>▼</span>
      </button>
      {isOpen && <div className="p-4 pt-0">{children}</div>}
    </div>
  );
};

// Base64 decoding utilities
function decode(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

// Utility to create a WAV file from raw PCM data
function createWavBlob(pcmData: Uint8Array, sampleRate: number = 24000) {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  // RIFF chunk descriptor
  view.setUint8(0, 'R'.charCodeAt(0));
  view.setUint8(1, 'I'.charCodeAt(0));
  view.setUint8(2, 'F'.charCodeAt(0));
  view.setUint8(3, 'F'.charCodeAt(0));
  view.setUint32(4, 36 + pcmData.length, true);
  view.setUint8(8, 'W'.charCodeAt(0));
  view.setUint8(9, 'A'.charCodeAt(0));
  view.setUint8(10, 'V'.charCodeAt(0));
  view.setUint8(11, 'E'.charCodeAt(0));

  // fmt sub-chunk
  view.setUint8(12, 'f'.charCodeAt(0));
  view.setUint8(13, 'm'.charCodeAt(0));
  view.setUint8(14, 't'.charCodeAt(0));
  view.setUint8(15, ' '.charCodeAt(0));
  view.setUint32(16, 16, true); // Subchunk1Size
  view.setUint16(20, 1, true); // AudioFormat (PCM = 1)
  view.setUint16(22, 1, true); // NumChannels
  view.setUint32(24, sampleRate, true); // SampleRate
  view.setUint32(28, sampleRate * 2, true); // ByteRate
  view.setUint16(32, 2, true); // BlockAlign
  view.setUint16(34, 16, true); // BitsPerSample

  // data sub-chunk
  view.setUint8(36, 'd'.charCodeAt(0));
  view.setUint8(37, 'a'.charCodeAt(0));
  view.setUint8(38, 't'.charCodeAt(0));
  view.setUint8(39, 'a'.charCodeAt(0));
  view.setUint32(40, pcmData.length, true);

  return new Blob([header, pcmData], { type: 'audio/wav' });
}

const App: React.FC = () => {
  const [isKeyConfigured, setIsKeyConfigured] = useState<boolean | null>(null);
  const [state, setState] = useState<AppState>(() => {
    const saved = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      return {
        ...parsed,
        history: [parsed],
        historyIndex: 0,
        isStreaming: false,
        streamingContent: '',
        autoUpdatePrompts: true,
      };
    }
    return {
      id: crypto.randomUUID(),
      title: 'Cinematic Project 01',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      idea: {
        theme: '',
        genre: 'Drama',
        durationSec: 60,
        platform: 'TikTok',
        stylePreset: 'Cinematic 35mm',
        mood: 'Dramatic',
        cta: 'Watch now',
        language: 'ID',
        voiceName: 'Kore',
        seed: Math.floor(Math.random() * 1000000),
      },
      characters: [
        { id: '1', name: 'Fiska', role: 'Main Character', description: 'Indonesia female office worker at 20s wear white shirt and navy blazer', consistencyRules: ['Selalu mengenakan kemeja putih dan blazer navy'], status: 'idle' }
      ],
      story: { synopsis: '', beats: [] },
      scenes: [],
      versions: [],
      history: [],
      historyIndex: 0,
      isStreaming: false,
      streamingContent: '',
      autoUpdatePrompts: true,
    };
  });

  const [activeTab, setActiveTab] = useState<'storyboard' | 'gallery' | 'export'>('storyboard');
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [showVersions, setShowVersions] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isTabDropdownOpen, setIsTabDropdownOpen] = useState(false);
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null);
  const [isTestingVoice, setIsTestingVoice] = useState(false);
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const dragItem = useRef<number | null>(null);
  const dragOverItem = useRef<number | null>(null);

  useEffect(() => {
    const checkKey = async () => {
      const hasKeySet = await hasApiKey();
      setIsKeyConfigured(hasKeySet);
    };
    checkKey();
  }, []);

  const getAspectRatio = (platform: Platform): "9:16" | "16:9" => {
    return (platform === 'YouTube') ? "16:9" : "9:16";
  };

  const currentAspectRatio = getAspectRatio(state.idea.platform);

  const updateState = useCallback((updater: (prev: AppState) => AppState, label = 'Action') => {
    setState(prev => {
      const next = updater(prev);
      const newHistory = [...prev.history.slice(0, prev.historyIndex + 1), next].slice(-50);
      return {
        ...next,
        updatedAt: Date.now(),
        history: newHistory,
        historyIndex: newHistory.length - 1,
      };
    });
  }, []);

  const handleApiError = (err: any) => {
    if (err.message?.includes("Requested entity was not found")) {
      setIsKeyConfigured(false);
      setToast({ msg: 'API Key invalid or Project not found. Please re-connect.', type: 'error' });
    } else {
      setToast({ msg: 'Operation failed: ' + err.message, type: 'error' });
    }
  };

  const undo = () => {
    if (state.historyIndex > 0) {
      setState(prev => ({
        ...prev,
        ...prev.history[prev.historyIndex - 1],
        historyIndex: prev.historyIndex - 1,
      }));
    }
  };

  const redo = () => {
    if (state.historyIndex < state.history.length - 1) {
      setState(prev => ({
        ...prev,
        ...prev.history[prev.historyIndex + 1],
        historyIndex: prev.historyIndex + 1,
      }));
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      const { history, historyIndex, isStreaming, streamingContent, ...saveData } = state;
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(saveData));
    }, 1000);
    return () => clearTimeout(timer);
  }, [state]);

  const handleGenerateStory = async () => {
    if (!state.idea.theme) {
      setToast({ msg: 'Theme is required.', type: 'error' });
      return;
    }
    setIsSidebarOpen(false);
    setState(prev => ({ ...prev, isStreaming: true, streamingContent: '' }));
    try {
      const result = await generateStoryStream(state.idea, state.characters, (text) => {
        setState(prev => ({ ...prev, streamingContent: text }));
      });

      const newScenes = result.scenes.map((s: any, idx: number) => ({
        ...s,
        id: crypto.randomUUID(),
        order: idx,
        image: { status: 'idle' },
        audio: { status: 'idle' },
        prompt: { positive: '', negative: DEFAULT_NEGATIVE_PROMPT, stylePreset: state.idea.stylePreset },
        useSameCharacter: true
      }));

      const newVersion: ProjectVersion = {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        label: `Auto-Gen: ${state.idea.theme.slice(0, 20)}...`,
        projectSnapshot: { story: { synopsis: result.synopsis, beats: result.beats }, scenes: newScenes }
      };

      updateState(prev => ({
        ...prev,
        story: { synopsis: result.synopsis, beats: result.beats },
        scenes: newScenes,
        versions: [newVersion, ...prev.versions]
      }), 'Generate Story');
      setToast({ msg: 'Storyboard generated!', type: 'success' });
    } catch (err: any) {
      handleApiError(err);
    } finally {
      setState(prev => ({ ...prev, isStreaming: false, streamingContent: '' }));
    }
  };

  const triggerGenerateImage = async (sceneId: string) => {
    const scene = state.scenes.find(s => s.id === sceneId);
    if (!scene) return;

    updateState(prev => ({
      ...prev,
      scenes: prev.scenes.map(s => s.id === sceneId ? { ...s, image: { status: 'generating' } } : s)
    }));

    try {
      let finalPrompt = scene.prompt.positive || scene.action;
      const references: string[] = [];

      if (scene.useSameCharacter !== false) {
        state.characters.forEach(char => {
          if (char.referenceImage && scene.characterIds.includes(char.name)) {
            references.push(char.referenceImage);
          }
        });

        if (!finalPrompt.toLowerCase().startsWith("using same character")) {
          finalPrompt = `Using same character, ${finalPrompt}`;
        }
      }
      
      const imageUrl = await generateSceneImage(
        finalPrompt, 
        currentAspectRatio, 
        state.idea.seed, 
        references
      );
      
      updateState(prev => ({
        ...prev,
        scenes: prev.scenes.map(s => s.id === sceneId ? { ...s, image: { status: 'completed', url: imageUrl } } : s)
      }), 'Generate Image');
      setToast({ msg: 'Scene visual rendered!', type: 'success' });
    } catch (err: any) {
      updateState(prev => ({
        ...prev,
        scenes: prev.scenes.map(s => s.id === sceneId ? { ...s, image: { status: 'error' } } : s)
      }));
      handleApiError(err);
    }
  };

  const triggerGenerateAudio = async (sceneId: string) => {
    const scene = state.scenes.find(s => s.id === sceneId);
    if (!scene || !scene.vo) {
      setToast({ msg: 'Voiceover script is empty', type: 'error' });
      return;
    }

    updateState(prev => ({
      ...prev,
      scenes: prev.scenes.map(s => s.id === sceneId ? { ...s, audio: { status: 'generating' } } : s)
    }));

    try {
      const base64Audio = await generateVoiceOver(scene.vo, state.idea.voiceName);
      updateState(prev => ({
        ...prev,
        scenes: prev.scenes.map(s => s.id === sceneId ? { ...s, audio: { status: 'completed', data: base64Audio } } : s)
      }), 'Generate Audio');
      setToast({ msg: 'Narration generated!', type: 'success' });
    } catch (err: any) {
      updateState(prev => ({
        ...prev,
        scenes: prev.scenes.map(s => s.id === sceneId ? { ...s, audio: { status: 'error' } } : s)
      }));
      handleApiError(err);
    }
  };

  const triggerGenerateAvatar = async (charId: string) => {
    const char = state.characters.find(c => c.id === charId);
    if (!char) return;

    updateState(prev => ({
      ...prev,
      characters: prev.characters.map(c => c.id === charId ? { ...c, status: 'generating' } : c)
    }));

    try {
      const imageUrl = await generateCharacterAvatar(char, state.idea.stylePreset, state.idea.seed);
      updateState(prev => ({
        ...prev,
        characters: prev.characters.map(c => c.id === charId ? { ...c, status: 'completed', referenceImage: imageUrl } : c)
      }), 'Generate Avatar');
      setToast({ msg: `${char.name} avatar rendered!`, type: 'success' });
    } catch (err: any) {
      updateState(prev => ({
        ...prev,
        characters: prev.characters.map(c => c.id === charId ? { ...c, status: 'error' } : c)
      }));
      handleApiError(err);
    }
  };

  const playSceneAudio = async (sceneId: string) => {
    const scene = state.scenes.find(s => s.id === sceneId);
    if (!scene || !scene.audio?.data) return;

    if (playingAudioId === sceneId) {
      stopAudio();
      return;
    }

    stopAudio();

    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      }
      
      const ctx = audioContextRef.current;
      const audioBytes = decode(scene.audio.data);
      const audioBuffer = await decodeAudioData(audioBytes, ctx, 24000, 1);
      
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      source.onended = () => setPlayingAudioId(null);
      
      audioSourceRef.current = source;
      source.start();
      setPlayingAudioId(sceneId);
    } catch (err) {
      console.error("Playback error:", err);
      setToast({ msg: 'Playback error', type: 'error' });
    }
  };

  const handleTestVoice = async () => {
    if (isTestingVoice) return;
    setIsTestingVoice(true);
    stopAudio();

    try {
      const selectedVoice = VOICES.find(v => v.name === state.idea.voiceName);
      const testPhrase = state.idea.language === 'ID' 
        ? `Halo! Saya adalah ${selectedVoice?.name}. Saya siap untuk menarasikan cerita Anda.`
        : `Hello! I am ${selectedVoice?.name}. I am ready to narrate your story.`;

      const base64Audio = await generateVoiceOver(testPhrase, state.idea.voiceName);
      
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      }
      
      const ctx = audioContextRef.current;
      const audioBytes = decode(base64Audio);
      const audioBuffer = await decodeAudioData(audioBytes, ctx, 24000, 1);
      
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      source.onended = () => setIsTestingVoice(false);
      
      audioSourceRef.current = source;
      source.start();
    } catch (err: any) {
      console.error("Test voice error:", err);
      handleApiError(err);
      setIsTestingVoice(false);
    }
  };

  const downloadSceneAudio = (scene: Scene) => {
    if (!scene.audio?.data) return;
    const audioBytes = decode(scene.audio.data);
    const blob = createWavBlob(audioBytes, 24000);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `VO_Scene_${scene.order + 1}.wav`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const stopAudio = () => {
    if (audioSourceRef.current) {
      try {
        audioSourceRef.current.stop();
      } catch (e) {}
      audioSourceRef.current = null;
    }
    setPlayingAudioId(null);
    setIsTestingVoice(false);
  };

  const handleDragStart = (index: number) => { dragItem.current = index; };
  const handleDragEnter = (index: number) => { dragOverItem.current = index; };
  const handleSort = () => {
    if (dragItem.current === null || dragOverItem.current === null) return;
    const newList = [...state.scenes];
    const item = newList.splice(dragItem.current, 1)[0];
    newList.splice(dragOverItem.current, 0, item);
    dragItem.current = null;
    dragOverItem.current = null;
    updateState(prev => ({ ...prev, scenes: newList.map((s, i) => ({ ...s, order: i })) }), 'Reorder Scenes');
  };

  const connectGemini = async () => {
    const success = await openKeySelector();
    if (success) {
      setIsKeyConfigured(true);
    }
  };

  // API Key Loading State
  if (isKeyConfigured === null) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-[#F9FAFB]">
        <div className="w-12 h-12 border-4 border-t-[#7C3AED] border-gray-200 rounded-full animate-spin"></div>
      </div>
    );
  }

  // API Key Setup Screen
  if (!isKeyConfigured) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-[#F9FAFB] p-6">
        <div className="max-w-md w-full bg-white rounded-[2.5rem] border border-gray-200 p-10 md:p-12 shadow-2xl text-center space-y-8 animate-in fade-in zoom-in duration-500">
           <div className="w-20 h-20 bg-[#7C3AED]/10 rounded-3xl flex items-center justify-center mx-auto mb-4">
              <div className="scale-[2.5] text-[#7C3AED]"><ICONS.Generate /></div>
           </div>
           <div className="space-y-4">
              <h1 className="text-3xl font-black tracking-tight text-gray-900">Connect to Gemini</h1>
              <p className="text-gray-500 text-sm leading-relaxed">
                To start creating, you need to connect your own Google Gemini API Key. 
                Please select a key from a <strong>paid GCP project</strong>.
              </p>
           </div>
           <div className="space-y-4">
              <button 
                onClick={connectGemini}
                className="w-full bg-[#7C3AED] hover:bg-[#6D28D9] text-white font-black py-5 rounded-[1.5rem] shadow-xl shadow-[#7C3AED]/20 transition-all active:scale-95 flex items-center justify-center gap-3 text-lg"
              >
                HUBUNGKAN API KEY
              </button>
              <a 
                href="https://ai.google.dev/gemini-api/docs/billing" 
                target="_blank" 
                rel="noopener noreferrer"
                className="block text-[10px] text-gray-400 font-bold uppercase tracking-widest hover:text-[#7C3AED] transition-colors"
              >
                Pelajari tentang penagihan API →
              </a>
           </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen bg-[#F9FAFB] text-[#111827] overflow-hidden selection:bg-[#7C3AED]/10">
      {/* Sidebar Overlay for Mobile */}
      {isSidebarOpen && (
        <div 
          className="fixed inset-0 bg-black/50 z-[60] md:hidden transition-opacity"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* Sidebar aside */}
      <aside className={`fixed inset-y-0 left-0 md:relative md:inset-auto md:flex w-[320px] md:h-full bg-white border-r border-gray-200 flex-col z-[70] transition-transform duration-300 ease-in-out ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'} shadow-xl md:shadow-none`}>
        <div className="p-4 flex items-center justify-between md:hidden border-b border-gray-100 shrink-0">
           <span className="font-black text-[#7C3AED]">PROJECT SETTINGS</span>
           <button onClick={() => setIsSidebarOpen(false)} className="p-2 text-gray-400"><ICONS.Close /></button>
        </div>
        
        <div className="flex-1 overflow-y-auto custom-scrollbar overflow-x-hidden overscroll-contain pb-32 md:pb-0">
          <SidebarSection title="Project Meta">
            <div className="space-y-4 pt-2">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-gray-400 uppercase font-bold mb-1 block">Language</label>
                  <select 
                    className="w-full bg-gray-50 border border-gray-200 rounded-lg p-2 text-xs text-gray-900" 
                    value={state.idea.language} 
                    onChange={(e) => updateState(prev => ({ ...prev, idea: { ...prev.idea, language: e.target.value as Language } }))}
                  >
                    <option value="EN">English (EN)</option>
                    <option value="ID">Indonesian (ID)</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] text-gray-400 uppercase font-bold mb-1 block">Genre</label>
                  <select className="w-full bg-gray-50 border border-gray-200 rounded-lg p-2 text-xs text-gray-900" value={state.idea.genre} onChange={(e) => updateState(prev => ({ ...prev, idea: { ...prev.idea, genre: e.target.value } }))}>
                    {GENRES.map(g => <option key={g} value={g}>{g}</option>)}
                  </select>
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-[10px] text-gray-400 uppercase font-bold mb-1 block">VO Character</label>
                <div className="flex gap-2">
                  <select 
                    className="flex-1 bg-gray-50 border border-gray-200 rounded-lg p-2 text-xs text-gray-900" 
                    value={state.idea.voiceName} 
                    onChange={(e) => updateState(prev => ({ ...prev, idea: { ...prev.idea, voiceName: e.target.value } }))}
                  >
                    {VOICES.map(v => <option key={v.name} value={v.name}>{v.name}</option>)}
                  </select>
                  <button 
                    onClick={handleTestVoice}
                    disabled={isTestingVoice}
                    className={`px-3 rounded-lg border transition-all flex items-center justify-center min-w-[40px] shadow-sm ${isTestingVoice ? 'bg-gray-100 border-gray-300 text-gray-400 cursor-not-allowed' : 'border-gray-200 text-[#7C3AED] hover:bg-gray-50 hover:border-[#7C3AED]/30 active:scale-95'}`}
                    title="Test Voice Sample"
                  >
                    {isTestingVoice ? (
                      <div className="w-4 h-4 border-2 border-[#7C3AED] border-t-transparent rounded-full animate-spin"></div>
                    ) : (
                      <ICONS.Speaker />
                    )}
                  </button>
                </div>
                {isTestingVoice && (
                  <p className="text-[9px] text-[#7C3AED] font-bold animate-pulse uppercase tracking-widest text-center py-1">Rendering sample...</p>
                )}
                <p className="text-[10px] text-gray-400 italic">
                  {VOICES.find(v => v.name === state.idea.voiceName)?.desc}
                </p>
              </div>
              <div>
                <label className="text-[10px] text-gray-400 uppercase font-bold mb-1 block">Project Title</label>
                <input 
                  className="w-full bg-gray-50 border border-gray-200 rounded-lg p-2 text-sm focus:border-[#7C3AED] outline-none text-gray-900 transition-colors"
                  value={state.title}
                  onChange={(e) => updateState(prev => ({ ...prev, title: e.target.value }))}
                />
              </div>
              <div>
                <label className="text-[10px] text-gray-400 uppercase font-bold mb-1 block">Idea / Theme</label>
                <textarea
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 text-sm focus:border-[#7C3AED] outline-none min-h-[100px] transition-all text-gray-900"
                  placeholder="Briefly describe your vision..."
                  value={state.idea.theme}
                  onChange={(e) => updateState(prev => ({ ...prev, idea: { ...prev.idea, theme: e.target.value } }))}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-gray-400 uppercase font-bold mb-1 block">Platform</label>
                  <select className="w-full bg-gray-50 border border-gray-200 rounded-lg p-2 text-xs text-gray-900" value={state.idea.platform} onChange={(e) => updateState(prev => ({ ...prev, idea: { ...prev.idea, platform: e.target.value as Platform } }))}>
                    {['TikTok', 'Reels', 'Shorts', 'YouTube'].map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
                <div>
                   <label className="text-[10px] text-gray-400 uppercase font-bold mb-1 block">Style</label>
                   <select className="w-full bg-gray-50 border border-gray-200 rounded-lg p-2 text-xs text-gray-900" value={state.idea.stylePreset} onChange={(e) => updateState(prev => ({ ...prev, idea: { ...prev.idea, stylePreset: e.target.value } }))}>
                    {STYLE_PRESETS.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </div>
              <button
                onClick={handleGenerateStory}
                disabled={state.isStreaming}
                className="w-full bg-[#7C3AED] hover:bg-[#6D28D9] disabled:opacity-50 text-white font-black py-3 rounded-xl flex items-center justify-center gap-2 shadow-md active:scale-[0.98] transition-all"
              >
                {state.isStreaming ? 'Thinking...' : <><ICONS.Generate /> Script Vision</>}
              </button>
            </div>
          </SidebarSection>

          <SidebarSection title="Casting & Style">
            <div className="space-y-3 pt-2">
              {state.characters.map(char => (
                <div key={char.id} className="bg-gray-50 p-3 rounded-xl border border-gray-200 group relative shadow-sm">
                  <button onClick={() => updateState(prev => ({ ...prev, characters: prev.characters.filter(c => c.id !== char.id) }))} className="absolute top-2 right-2 text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"><ICONS.Trash /></button>
                  <input className="bg-transparent font-bold text-sm w-[90%] outline-none text-[#7C3AED]" value={char.name} onChange={(e) => updateState(prev => ({ ...prev, characters: prev.characters.map(c => c.id === char.id ? { ...c, name: e.target.value } : c) }))} />
                  <textarea className="w-full bg-transparent text-xs text-gray-500 border-none outline-none resize-none h-12 custom-scrollbar" value={char.description} placeholder="Traits..." onChange={(e) => updateState(prev => ({ ...prev, characters: prev.characters.map(c => c.id === char.id ? { ...c, description: e.target.value } : c) }))} />
                  <div className="flex items-center gap-3 mt-2">
                    <div className="w-10 h-10 rounded-lg bg-white overflow-hidden flex-shrink-0 relative border border-gray-200 shadow-sm">
                      {char.referenceImage ? <img src={char.referenceImage} className="w-full h-full object-cover" /> : <label className="cursor-pointer w-full h-full flex items-center justify-center"><input type="file" className="hidden" onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          const reader = new FileReader();
                          reader.onloadend = () => updateState(prev => ({ ...prev, characters: prev.characters.map(c => c.id === char.id ? { ...c, referenceImage: reader.result as string } : c) }));
                          reader.readAsDataURL(file);
                        }
                      }} /><span className="text-[10px] text-gray-400 font-bold">Ref</span></label>}
                    </div>
                    <div className="flex-1">
                      <span className="text-[8px] text-gray-400 block uppercase font-bold mb-0.5">Key Stylistics</span>
                      <input className="text-[10px] bg-transparent border-b border-gray-200 w-full outline-none text-gray-700 focus:border-[#7C3AED] transition-colors" value={char.consistencyRules[0] || ''} placeholder="e.g. Always wears neon hat" onChange={(e) => updateState(prev => ({ ...prev, characters: prev.characters.map(c => c.id === char.id ? { ...c, consistencyRules: [e.target.value] } : c) }))} />
                    </div>
                  </div>
                </div>
              ))}
              <button onClick={() => updateState(prev => ({ ...prev, characters: [...prev.characters, { id: crypto.randomUUID(), name: 'Actor ' + (state.characters.length + 1), role: 'Support', description: '', consistencyRules: [], status: 'idle' }] }))} className="w-full py-2 border-2 border-dashed border-gray-200 rounded-xl text-xs text-gray-400 hover:text-[#7C3AED] hover:border-[#7C3AED] transition-all flex items-center justify-center gap-2 font-black"><ICONS.Plus /> Add Actor</button>
            </div>
          </SidebarSection>
          
          <div className="p-4 mt-auto">
            <button 
              onClick={connectGemini}
              className="w-full py-2 bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-xl text-[10px] font-black uppercase tracking-widest text-gray-400 transition-all flex items-center justify-center gap-2"
            >
              <div className="w-1.5 h-1.5 rounded-full bg-green-500"></div> API Connected
            </button>
          </div>
        </div>
      </aside>

      <div className="flex-1 flex flex-col relative bg-[#F9FAFB] min-w-0">
        <header className="h-16 border-b border-gray-200 flex items-center justify-between px-4 md:px-6 bg-white/80 backdrop-blur-md z-20 shadow-sm shrink-0">
          <div className="flex items-center gap-2 md:gap-6 overflow-hidden">
            <button 
              onClick={() => setIsSidebarOpen(true)}
              className="md:hidden p-2 text-gray-500 hover:text-gray-900 transition-colors"
            >
              <ICONS.Menu />
            </button>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-lg md:text-xl font-black bg-gradient-to-r from-[#7C3AED] to-[#22D3EE] bg-clip-text text-transparent truncate max-w-[120px] md:max-w-none">Storyboard AI</span>
            </div>
            <div className="hidden sm:flex gap-1">
              <button onClick={undo} disabled={state.historyIndex <= 0} className="p-2 hover:bg-gray-100 rounded-lg text-gray-400 disabled:opacity-20 transition-all"><ICONS.Undo /></button>
              <button onClick={redo} disabled={state.historyIndex >= state.history.length -1} className="p-2 hover:bg-gray-100 rounded-lg text-gray-400 disabled:opacity-20 transition-all"><ICONS.Redo /></button>
            </div>
          </div>

          <nav className="relative flex items-center shrink-0">
            <div className="hidden md:flex items-center gap-1 bg-gray-50 p-1 rounded-xl border border-gray-200">
              {['storyboard', 'gallery', 'export'].map((t) => (
                <button 
                  key={t} 
                  onClick={() => setActiveTab(t as any)} 
                  className={`px-5 py-1.5 rounded-lg text-xs font-black transition-all capitalize whitespace-nowrap ${activeTab === t ? 'bg-[#7C3AED] text-white shadow-md' : 'text-gray-500 hover:text-gray-900'}`}
                >
                  {t}
                </button>
              ))}
            </div>

            <div className="md:hidden relative">
              <button 
                onClick={() => setIsTabDropdownOpen(!isTabDropdownOpen)}
                className="flex items-center gap-2 px-4 py-2 bg-gray-50 border border-gray-200 rounded-xl text-[10px] font-black uppercase tracking-widest text-[#7C3AED] active:scale-95 transition-all shadow-sm"
              >
                {activeTab}
                <ICONS.ChevronDown />
              </button>
              
              {isTabDropdownOpen && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setIsTabDropdownOpen(false)} />
                  <div className="absolute top-full right-0 mt-2 w-40 bg-white border border-gray-100 rounded-2xl shadow-2xl py-2 z-40 animate-in fade-in slide-in-from-top-2 duration-200 overflow-hidden">
                    {['storyboard', 'gallery', 'export'].map((t) => (
                      <button 
                        key={t} 
                        onClick={() => {
                          setActiveTab(t as any);
                          setIsTabDropdownOpen(false);
                        }}
                        className={`w-full text-left px-5 py-3 text-[10px] font-black uppercase tracking-widest transition-colors ${activeTab === t ? 'text-[#7C3AED] bg-gray-50' : 'text-gray-500 hover:bg-gray-50'}`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </nav>

          <div className="flex items-center gap-2 md:gap-3 shrink-0">
            <button onClick={() => setShowVersions(!showVersions)} className="text-[10px] md:text-xs text-gray-500 hover:text-[#7C3AED] transition-colors flex items-center gap-1.5 font-black">
               <span className="hidden sm:inline">HISTORY</span>
               <ICONS.Save />
            </button>
            <div className={`w-2 h-2 rounded-full ${state.isStreaming ? 'bg-[#7C3AED] animate-pulse' : 'bg-green-500'}`}></div>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-4 md:p-10 space-y-8 md:space-y-12 custom-scrollbar overflow-x-hidden">
          {activeTab === 'storyboard' && (
            <div className="max-w-6xl mx-auto space-y-6 md:space-y-10 animate-in fade-in duration-700">
              {state.story.synopsis && (
                <>
                  <div className="bg-white p-6 md:p-10 rounded-3xl md:rounded-[2.5rem] border border-gray-100 relative overflow-hidden group shadow-xl">
                    <div className="absolute top-0 right-0 p-6 opacity-10 group-hover:opacity-100 transition-opacity text-[#7C3AED] hidden md:block"><ICONS.Generate /></div>
                    <h3 className="text-[10px] font-black text-[#7C3AED] uppercase tracking-[0.3em] mb-4 md:mb-6 border-b border-gray-100 pb-2 inline-block">Director's Synopsis</h3>
                    <textarea 
                      className="w-full bg-transparent border-none text-lg md:text-2xl font-black resize-none outline-none leading-tight text-gray-900 min-h-[100px]" 
                      value={state.story.synopsis} 
                      onChange={(e) => updateState(prev => ({ ...prev, story: { ...prev.story, synopsis: e.target.value } }))} 
                    />
                    <div className="flex flex-wrap gap-2 mt-4 md:mt-8">
                      {state.story.beats.map((b, i) => <span key={i} className="px-3 md:px-4 py-1.5 md:py-2 bg-gray-50 border border-gray-100 rounded-xl text-[8px] md:text-[10px] font-black text-[#7C3AED] uppercase tracking-wider">{b}</span>)}
                    </div>
                  </div>

                  {/* Generated Actor Section */}
                  <div className="bg-white p-6 md:p-10 rounded-3xl md:rounded-[2.5rem] border border-gray-100 shadow-xl space-y-6">
                    <h3 className="text-[10px] font-black text-[#7C3AED] uppercase tracking-[0.3em] border-b border-gray-100 pb-2 inline-block">Generated Actors</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                      {state.characters.map((char) => (
                        <div key={char.id} className="bg-gray-50 rounded-2xl p-4 border border-gray-200 flex flex-col gap-4 shadow-sm">
                          <div className="aspect-square w-full rounded-xl overflow-hidden bg-white border border-gray-100 relative group/actor">
                            {char.status === 'generating' ? (
                              <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/60 backdrop-blur-sm z-30">
                                <div className="w-8 h-8 border-[3px] border-t-[#7C3AED] border-gray-200 rounded-full animate-spin"></div>
                                <span className="text-[8px] font-black text-[#7C3AED] mt-2 uppercase tracking-widest animate-pulse">Rendering</span>
                              </div>
                            ) : char.referenceImage ? (
                              <img src={char.referenceImage} className="w-full h-full object-cover" />
                            ) : (
                              <div className="absolute inset-0 flex items-center justify-center text-gray-300">
                                <ICONS.Plus />
                              </div>
                            )}
                            <button 
                              onClick={() => triggerGenerateAvatar(char.id)}
                              className="absolute bottom-2 right-2 bg-[#7C3AED] text-white p-2 rounded-lg shadow-lg opacity-0 group-hover/actor:opacity-100 transition-all active:scale-95"
                            >
                              <ICONS.Generate />
                            </button>
                          </div>
                          <div>
                            <p className="font-black text-sm text-gray-900">{char.name}</p>
                            <p className="text-[10px] text-gray-400 uppercase font-black">{char.role}</p>
                          </div>
                          <div className="space-y-2">
                             <label className="text-[8px] text-gray-400 uppercase font-black">Visual Prompt</label>
                             <textarea 
                               className="w-full bg-white border border-gray-200 rounded-lg p-2 text-[10px] outline-none focus:border-[#7C3AED] h-16 resize-none custom-scrollbar"
                               placeholder="Customize visual prompt..."
                               value={char.avatarPrompt || ''}
                               onChange={(e) => updateState(prev => ({
                                 ...prev,
                                 characters: prev.characters.map(c => c.id === char.id ? { ...c, avatarPrompt: e.target.value } : c)
                               }))}
                             />
                          </div>
                          <button 
                            disabled={char.status === 'generating'}
                            onClick={() => triggerGenerateAvatar(char.id)}
                            className="w-full py-2 bg-white border border-gray-200 rounded-lg text-[10px] font-black uppercase tracking-widest hover:bg-gray-50 transition-all flex items-center justify-center gap-2"
                          >
                            {char.status === 'generating' ? 'Generating...' : <><ICONS.Generate /> Re-generate</>}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {state.isStreaming && (
                <div className="p-8 md:p-12 bg-white/50 rounded-3xl md:rounded-[3rem] border border-dashed border-[#7C3AED]/30 flex flex-col items-center gap-4 md:gap-6 backdrop-blur-sm shadow-inner">
                  <div className="w-12 h-12 md:w-16 md:h-16 border-[4px] md:border-[6px] border-t-[#7C3AED] border-gray-100 rounded-full animate-spin"></div>
                  <div className="text-center space-y-2">
                    <p className="text-lg md:text-xl font-black text-gray-900 tracking-tight animate-pulse">Drafting the sequences...</p>
                    <p className="text-[10px] md:text-xs text-gray-500 max-w-lg mx-auto leading-relaxed italic line-clamp-2 md:line-clamp-none">"{state.streamingContent.slice(-120)}..."</p>
                  </div>
                </div>
              )}

              <div className="space-y-8 md:space-y-12">
                {state.scenes.length === 0 && !state.isStreaming && (
                  <div className="h-64 flex flex-col items-center justify-center text-gray-400 border-2 border-dashed border-gray-200 rounded-3xl md:rounded-[3rem] p-6 md:p-12 text-center group hover:border-[#7C3AED]/30 transition-all bg-white shadow-sm">
                    <div className="mb-4 opacity-20 group-hover:opacity-100 transition-opacity text-[#7C3AED] scale-125 md:scale-150"><ICONS.Generate /></div>
                    <p className="font-black text-sm md:text-base">No sequences yet. Start by defining your idea in the sidebar.</p>
                    <p className="text-[10px] md:text-xs mt-2 opacity-60">AI will generate a complete cinematic script for you.</p>
                  </div>
                )}
                
                {state.scenes.map((scene, index) => (
                  <div
                    key={scene.id}
                    draggable
                    onDragStart={() => handleDragStart(index)}
                    onDragEnter={() => handleDragEnter(index)}
                    onDragEnd={handleSort}
                    onDragOver={(e) => e.preventDefault()}
                    className="group flex flex-col md:flex-row gap-4 md:gap-8 transition-all duration-300"
                  >
                    <div className="hidden md:flex w-12 flex-col items-center pt-10 cursor-move opacity-20 group-hover:opacity-100 transition-all shrink-0">
                      <span className="text-5xl font-black text-gray-200 group-hover:text-[#7C3AED] select-none transition-colors">{String(index + 1).padStart(2, '0')}</span>
                      <div className="w-px flex-1 bg-gray-200 mt-6 group-hover:bg-[#7C3AED]/20 transition-colors"></div>
                    </div>

                    <div className="flex-1 bg-white rounded-3xl md:rounded-[3rem] border border-gray-100 p-6 md:p-10 grid grid-cols-1 lg:grid-cols-12 gap-8 md:gap-10 hover:shadow-[0_20px_50px_rgba(0,0,0,0.05)] transition-all relative overflow-hidden active:scale-[0.99] group-hover:border-[#7C3AED]/20 shadow-md">
                      <div className="md:hidden flex items-center justify-between mb-2">
                        <span className="text-2xl font-black text-[#7C3AED]">{String(index + 1).padStart(2, '0')}</span>
                        <div className="flex gap-2">
                           <div className="px-3 py-1 bg-gray-50 rounded-lg text-[8px] font-black text-gray-500 border border-gray-100">{scene.durationSec}S</div>
                           <span className="px-3 py-1 bg-[#7C3AED]/10 text-[#7C3AED] text-[8px] font-black rounded-lg uppercase tracking-wider">{scene.shotType}</span>
                        </div>
                      </div>

                      <div className="lg:col-span-7 flex flex-col gap-6 md:gap-8">
                        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                          <input 
                            className="text-2xl md:text-3xl font-black bg-transparent border-none outline-none w-full text-gray-900 tracking-tighter placeholder-gray-200" 
                            value={scene.title} 
                            placeholder="Scene Title..."
                            onChange={(e) => updateState(prev => ({ ...prev, scenes: prev.scenes.map(s => s.id === scene.id ? { ...s, title: e.target.value } : s) }))} 
                          />
                          <div className="hidden md:flex gap-2 shrink-0">
                             <div className="relative group/tooltip">
                               <select className="bg-gray-50 border border-gray-100 text-[10px] px-4 py-2 rounded-xl font-black uppercase tracking-widest text-[#7C3AED] focus:border-[#7C3AED] outline-none transition-colors cursor-help" value={scene.shotType} onChange={(e) => updateState(prev => ({ ...prev, scenes: prev.scenes.map(s => s.id === scene.id ? { ...s, shotType: e.target.value } : s) }))}>
                                 {SHOT_TYPES.map(st => <option key={st} value={st}>{st}</option>)}
                               </select>
                             </div>
                             <div className="px-4 py-2 bg-gray-50 rounded-xl text-[10px] font-black text-gray-500 border border-gray-100 flex items-center">{scene.durationSec}S</div>
                          </div>
                        </div>

                        <div className="grid grid-cols-1 gap-6 md:gap-8">
                          <div className="space-y-3">
                            <h4 className="text-[9px] md:text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] flex items-center gap-2">Visual Script</h4>
                            <textarea className="w-full bg-gray-50 border border-gray-100 p-4 md:p-5 rounded-2xl text-xs md:text-sm min-h-[100px] md:min-h-[120px] outline-none focus:border-[#7C3AED] transition-all font-black custom-scrollbar text-gray-800 shadow-inner" placeholder="What is happening?..." value={scene.action} onChange={(e) => updateState(prev => ({ ...prev, scenes: prev.scenes.map(s => s.id === scene.id ? { ...s, action: e.target.value } : s) }))} />
                          </div>
                          <div className="space-y-3">
                            <h4 className="text-[9px] md:text-[10px] font-black text-[#22D3EE] uppercase tracking-[0.2em] flex items-center gap-2">Audio / Voiceover</h4>
                            <div className="bg-gray-50 border-l-4 border-[#22D3EE] rounded-r-2xl p-4 shadow-sm">
                              <textarea className="w-full bg-transparent text-xs md:text-sm font-black italic min-h-[60px] md:min-h-[80px] outline-none text-gray-600 leading-relaxed custom-scrollbar placeholder-gray-300" placeholder="Narrator: ..." value={scene.vo} onChange={(e) => updateState(prev => ({ ...prev, scenes: prev.scenes.map(s => s.id === scene.id ? { ...s, vo: e.target.value } : s) }))} />
                            </div>
                            <div className="flex gap-2">
                                {scene.audio?.status === 'generating' ? (
                                  <div className="w-full flex items-center justify-center py-2"><div className="w-4 h-4 border-2 border-[#22D3EE] border-t-transparent rounded-full animate-spin"></div></div>
                                ) : (
                                  <>
                                    {scene.audio?.data && (
                                      <>
                                        <button onClick={() => playSceneAudio(scene.id)} className={`flex-1 py-2 rounded-xl text-[10px] font-black transition-all ${playingAudioId === scene.id ? 'bg-[#7C3AED] text-white' : 'bg-[#7C3AED]/10 text-[#7C3AED]'}`}>
                                          {playingAudioId === scene.id ? 'STOP' : 'PLAY VO'}
                                        </button>
                                        <button onClick={() => downloadSceneAudio(scene)} className="px-4 py-2 bg-gray-100 rounded-xl text-[#7C3AED]"><ICONS.Download /></button>
                                      </>
                                    )}
                                    <button onClick={() => triggerGenerateAudio(scene.id)} className="flex-1 py-2 border border-gray-200 rounded-xl text-[10px] font-black text-gray-400 hover:text-[#7C3AED] transition-all">GENERATE VO</button>
                                  </>
                                )}
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="lg:col-span-5 flex flex-col gap-6">
                        <div className="p-4 md:p-6 bg-gray-50 rounded-2xl md:rounded-[2rem] border border-gray-100 flex-1 flex flex-col gap-4 shadow-sm min-h-[140px]">
                          <div className="flex items-center justify-between mb-2">
                            <h4 className="text-[9px] md:text-[10px] font-black text-gray-400 uppercase tracking-widest">Technical Prompt</h4>
                            <button onClick={() => triggerGenerateImage(scene.id)} disabled={scene.image.status === 'generating'} className="text-[9px] md:text-[10px] font-black bg-[#7C3AED] hover:bg-[#6D28D9] px-4 py-1.5 rounded-full shadow-lg text-white disabled:opacity-50">RENDER</button>
                          </div>
                          <textarea className="w-full bg-transparent text-[10px] md:text-[11px] leading-relaxed text-gray-500 font-black italic outline-none resize-none flex-1 custom-scrollbar min-h-[60px]" value={scene.prompt.positive} onChange={(e) => updateState(prev => ({ ...prev, scenes: prev.scenes.map(s => s.id === scene.id ? { ...s, prompt: { ...s.prompt, positive: e.target.value } } : s) }))} />
                          <label className="flex items-center gap-2 cursor-pointer group/check">
                            <input type="checkbox" checked={scene.useSameCharacter ?? true} onChange={(e) => updateState(prev => ({ ...prev, scenes: prev.scenes.map(s => s.id === scene.id ? { ...s, useSameCharacter: e.target.checked } : s) }))} className="accent-[#7C3AED]" />
                            <span className="text-[8px] font-black text-gray-400 uppercase tracking-wider group-hover/check:text-[#7C3AED]">Keep character consistency</span>
                          </label>
                        </div>

                        <div className={`bg-gray-50 rounded-2xl md:rounded-[2rem] border border-gray-100 overflow-hidden relative cursor-pointer transition-all shadow-inner ${currentAspectRatio === "9:16" ? "aspect-[9/16] max-h-[400px] md:max-h-[500px] mx-auto w-full" : "aspect-video"}`} onClick={() => triggerGenerateImage(scene.id)}>
                          {scene.image.status === 'generating' ? (
                            <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/60 backdrop-blur-sm z-30">
                              <div className="w-10 h-10 border-[4px] border-t-[#7C3AED] border-gray-200 rounded-full animate-spin"></div>
                              <span className="text-[9px] font-black text-[#7C3AED] mt-4 uppercase tracking-[0.3em] animate-pulse">Rendering</span>
                            </div>
                          ) : scene.image.url ? (
                            <img src={scene.image.url} className="w-full h-full object-cover" alt="Scene visual" />
                          ) : (
                            <div className="absolute inset-0 flex flex-col items-center justify-center opacity-30 text-gray-400">
                              <ICONS.Generate />
                              <span className="text-[9px] font-black uppercase tracking-widest mt-2">Generate Visual</span>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'gallery' && (
             <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-6 md:gap-10 animate-in zoom-in duration-500 max-w-7xl mx-auto">
               {state.scenes.filter(s => s.image.url).map(s => (
                 <div key={s.id} className="bg-white rounded-[2rem] overflow-hidden border border-gray-100 group shadow-lg">
                   <div className={`relative ${currentAspectRatio === "9:16" ? "aspect-[9/16]" : "aspect-video"}`}>
                     <img src={s.image.url} className="w-full h-full object-cover" />
                     <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent opacity-0 group-hover:opacity-100 transition-opacity p-6 flex flex-col justify-end">
                       <p className="text-[10px] font-black uppercase tracking-wider mb-1 text-[#7C3AED]">Sequence {s.order + 1}</p>
                       <p className="text-xs md:text-sm font-black text-white line-clamp-2">{s.title}</p>
                     </div>
                   </div>
                 </div>
               ))}
             </div>
          )}

          {activeTab === 'export' && (
            <div className="max-w-2xl mx-auto space-y-6 md:space-y-8 animate-in slide-in-from-bottom duration-500">
              <div className="bg-white p-8 md:p-12 rounded-[2.5rem] md:rounded-[4rem] border border-gray-100 text-center shadow-2xl">
                <div className="w-16 h-16 bg-[#7C3AED]/10 rounded-2xl flex items-center justify-center mx-auto mb-8">
                   <div className="scale-[2.5] text-[#7C3AED]"><ICONS.Save /></div>
                </div>
                <h2 className="text-2xl md:text-4xl font-black mb-4 tracking-tighter text-gray-900">Package Your Vision</h2>
                <p className="text-gray-500 mb-12 text-[10px] md:text-sm leading-relaxed max-w-md mx-auto">Export your full cinematic storyboard including all scripts, technical prompts, and character designs.</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
                  <button onClick={() => {
                     const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
                     const url = URL.createObjectURL(blob);
                     const a = document.createElement('a');
                     a.href = url; a.download = `${state.title.replace(/\s+/g, '_')}.json`; a.click();
                  }} className="bg-[#7C3AED] py-5 rounded-[1.5rem] font-black text-[10px] md:text-sm uppercase tracking-widest text-white shadow-xl shadow-[#7C3AED]/20">JSON PROJECT</button>
                  <button onClick={() => {
                    let csv = "Scene #,Title,Shot Type,Action,VO,Prompt\n";
                    state.scenes.forEach((s, i) => {
                      csv += `${i+1},"${s.title.replace(/"/g, '""')}","${s.shotType}","${s.action.replace(/"/g, '""')}","${s.vo.replace(/"/g, '""')}","${s.prompt.positive.replace(/"/g, '""')}"\n`;
                    });
                    const blob = new Blob([csv], { type: 'text/csv' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url; a.download = `${state.title.replace(/\s+/g, '_')}.csv`; a.click();
                  }} className="bg-white py-5 rounded-[1.5rem] font-black text-[10px] md:text-sm uppercase tracking-widest text-gray-600 border border-gray-200">CSV SPREADSHEET</button>
                </div>
              </div>
            </div>
          )}
        </main>

        {showVersions && (
          <div className="fixed inset-0 bg-white/90 backdrop-blur-2xl z-50 flex items-center justify-center p-4 md:p-6 animate-in fade-in duration-300" onClick={() => setShowVersions(false)}>
            <div className="bg-white w-full max-w-xl rounded-3xl md:rounded-[3rem] border border-gray-200 p-6 md:p-10 max-h-[85vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-8">
                <h3 className="text-xl md:text-2xl font-black tracking-tight text-gray-900">Archive History</h3>
                <button onClick={() => setShowVersions(false)} className="w-10 h-10 bg-gray-50 rounded-full flex items-center justify-center text-gray-400">✕</button>
              </div>
              <div className="flex-1 overflow-y-auto space-y-4 pr-2 custom-scrollbar">
                {state.versions.map(v => (
                  <div key={v.id} className="p-6 bg-gray-50 rounded-[2rem] border border-gray-100 flex items-center justify-between hover:border-[#7C3AED] transition-all cursor-pointer group hover:bg-white shadow-sm" onClick={() => {
                    updateState(p => ({ ...p, story: v.projectSnapshot.story, scenes: v.projectSnapshot.scenes }), `Restore: ${v.label}`);
                    setShowVersions(false);
                    setToast({ msg: 'Vision restored!', type: 'success' });
                  }}>
                    <div className="space-y-1 overflow-hidden">
                      <p className="text-sm font-black uppercase tracking-wider text-gray-700 truncate">{v.label}</p>
                      <p className="text-[10px] text-gray-400 font-bold">{new Date(v.createdAt).toLocaleString()}</p>
                    </div>
                    <div className="flex items-center gap-4 shrink-0">
                       <div className="w-8 h-8 rounded-full border border-gray-200 flex items-center justify-center text-gray-400 group-hover:bg-[#7C3AED] group-hover:text-white transition-all"><ICONS.Undo /></div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {toast && (
          <div className={`fixed bottom-8 md:bottom-12 left-1/2 transform -translate-x-1/2 px-10 py-5 rounded-[2rem] shadow-2xl border z-[100] animate-in slide-in-from-bottom duration-500 flex items-center gap-6 backdrop-blur-xl w-[90%] md:w-auto ${toast.type === 'success' ? 'bg-white/90 border-gray-100 text-[#7C3AED]' : 'bg-red-500 border-red-400 text-white'}`}>
            <span className="font-black text-[10px] md:text-sm uppercase tracking-widest truncate flex-1">{toast.msg}</span>
            <button onClick={() => setToast(null)} className="font-black opacity-60">✕</button>
          </div>
        )}
      </div>
    </div>
  );
};

export default App;
