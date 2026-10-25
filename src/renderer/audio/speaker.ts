import type { Config } from '../../shared/types';

type SinkAudio = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };

/** Озвучивание ответов: Piper (офлайн, выбор устройства вывода) либо голос Windows. */
export class Speaker {
  private current: SinkAudio | null = null;
  private cancelCurrent: (() => void) | null = null;

  constructor(
    private readonly getConfig: () => Config,
    private readonly synthesize: (text: string) => Promise<ArrayBuffer | null>,
    private readonly onWarning: (text: string) => void,
  ) {}

  stop(): void {
    this.cancelCurrent?.();
    this.cancelCurrent = null;
    this.current?.pause();
    this.current = null;
    window.speechSynthesis.cancel();
  }

  async speak(text: string): Promise<void> {
    const cfg = this.getConfig();
    if (cfg.tts.engine === 'piper') {
      try {
        const wav = await this.synthesize(text);
        if (wav) {
          await this.playWav(wav, cfg);
          return;
        }
        this.onWarning('Голос Piper ещё не скачан — говорю голосом Windows.');
      } catch (err) {
        this.onWarning(`Piper не сработал (${err instanceof Error ? err.message : String(err)}) — говорю голосом Windows.`);
      }
    }
    await this.speakWithWindows(text, cfg);
  }

  private async playWav(wav: ArrayBuffer, cfg: Config): Promise<void> {
    const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
    const audio: SinkAudio = new Audio(url);
    this.current = audio;
    audio.volume = cfg.speechVolume;
    if (cfg.outputDeviceId && audio.setSinkId) {
      try {
        await audio.setSinkId(cfg.outputDeviceId);
      } catch {
        this.onWarning('Выбранное устройство вывода недоступно — играю на устройстве по умолчанию.');
      }
    }
    await new Promise<void>((resolve, reject) => {
      this.cancelCurrent = resolve;
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error('не удалось воспроизвести звук'));
      audio.play().catch(reject);
    }).finally(() => {
      URL.revokeObjectURL(url);
      if (this.current === audio) this.current = null;
      this.cancelCurrent = null;
    });
  }

  private async speakWithWindows(text: string, cfg: Config): Promise<void> {
    const synth = window.speechSynthesis;
    const voices = await this.voices();
    const voice = voices.find((v) => v.lang.toLowerCase().startsWith('ru'));
    await new Promise<void>((resolve) => {
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = 'ru-RU';
      if (voice) utter.voice = voice;
      utter.volume = cfg.speechVolume;
      utter.rate = cfg.tts.rate;
      this.cancelCurrent = resolve;
      utter.onend = () => resolve();
      utter.onerror = () => resolve();
      synth.speak(utter);
    }).finally(() => (this.cancelCurrent = null));
  }

  private voices(): Promise<SpeechSynthesisVoice[]> {
    const synth = window.speechSynthesis;
    const now = synth.getVoices();
    if (now.length) return Promise.resolve(now);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(synth.getVoices()), 1500);
      synth.addEventListener('voiceschanged', () => {
        clearTimeout(timer);
        resolve(synth.getVoices());
      }, { once: true });
    });
  }
}
