import { matchWake, parseYesNo, tokens, type Answer } from './text';

export interface RecognizedWord {
  word: string;
  conf: number;
}

export type VoiceEvent =
  | { type: 'wake' }
  | { type: 'command'; text: string }
  | { type: 'confirm'; answer: Answer }
  | { type: 'timeout' };

export interface VoiceSessionOptions {
  wakeWords: () => string[];
  earlyWake: () => boolean;
  /** Минимальная уверенность распознавания слова активации в режиме ожидания. */
  minWakeConfidence?: () => number;
  listenTimeoutMs: () => number;
  followUpMs: () => number;
  now?: () => number;
}

type Mode = 'idle' | 'listening' | 'confirming' | 'busy';

/**
 * Конечный автомат диалога: ждёт слово активации, собирает одну команду,
 * принимает ответ «да/нет». Не знает ни про микрофон, ни про распознавание —
 * получает готовые частичные и итоговые тексты и сообщает, что делать.
 */
export class VoiceSession {
  private mode: Mode = 'idle';
  private deadline = 0;
  private wakeAnnounced = false;
  private readonly now: () => number;

  constructor(
    private readonly opts: VoiceSessionOptions,
    private readonly emit: (event: VoiceEvent) => void,
  ) {
    this.now = opts.now ?? Date.now;
  }

  get state(): Mode {
    return this.mode;
  }

  /** Принудительно начать слушать (горячая клавиша, кнопка). */
  startListening(): void {
    this.mode = 'listening';
    this.deadline = this.now() + this.opts.listenTimeoutMs();
    this.wakeAnnounced = true;
    this.emit({ type: 'wake' });
  }

  /** Ждать «да/нет» (после вопроса о подтверждении). */
  startConfirming(timeoutMs: number): void {
    this.mode = 'confirming';
    this.deadline = this.now() + timeoutMs;
  }

  /** Ассистент занят: говорит или выполняет команду, ввод игнорируется. */
  setBusy(): void {
    this.mode = 'busy';
  }

  /** Ассистент закончил; при включённом «продолжении разговора» остаёмся в режиме прослушивания. */
  setIdle(): void {
    const follow = this.opts.followUpMs();
    if (follow > 0) {
      this.mode = 'listening';
      this.deadline = this.now() + follow;
      this.wakeAnnounced = true;
    } else {
      this.mode = 'idle';
      this.wakeAnnounced = false;
    }
  }

  onPartial(text: string): void {
    if (this.mode !== 'idle' || !this.opts.earlyWake()) return;
    if (matchWake(text, this.opts.wakeWords())) {
      this.mode = 'listening';
      this.deadline = this.now() + this.opts.listenTimeoutMs();
      this.wakeAnnounced = true;
      this.emit({ type: 'wake' });
    }
  }

  onFinal(text: string, words?: RecognizedWord[]): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    if (this.mode === 'confirming') {
      this.mode = 'busy';
      this.emit({ type: 'confirm', answer: parseYesNo(trimmed) });
      return;
    }

    const wake = matchWake(trimmed, this.opts.wakeWords());

    if (this.mode === 'idle') {
      if (!wake) return;
      if (this.wakeConfidence(text, wake.index, wake.length, words) < (this.opts.minWakeConfidence?.() ?? 0)) return;
      if (!this.wakeAnnounced) this.emit({ type: 'wake' });
      this.deliver(wake.rest);
      return;
    }

    if (this.mode === 'listening') {
      this.deliver(wake ? wake.rest : trimmed);
    }
  }

  /** Вызывать периодически (раз в 200–500 мс), чтобы сработали таймауты. */
  tick(): void {
    if ((this.mode === 'listening' || this.mode === 'confirming') && this.now() > this.deadline) {
      const wasConfirming = this.mode === 'confirming';
      this.mode = 'idle';
      this.wakeAnnounced = false;
      this.emit(wasConfirming ? { type: 'confirm', answer: 'unknown' } : { type: 'timeout' });
    }
  }

  /** Средняя уверенность распознавания слов, составивших слово активации. 1, если слова не выровнены с текстом. */
  private wakeConfidence(text: string, index: number, length: number, words?: RecognizedWord[]): number {
    if (!words?.length || words.length !== tokens(text).length) return 1;
    const slice = words.slice(index, index + length);
    return slice.length ? slice.reduce((sum, w) => sum + w.conf, 0) / slice.length : 1;
  }

  private deliver(command: string): void {
    if (command.trim()) {
      this.mode = 'busy';
      this.wakeAnnounced = false;
      this.emit({ type: 'command', text: command.trim() });
    } else {
      // одно слово активации: ждём продолжения
      this.mode = 'listening';
      this.deadline = this.now() + this.opts.listenTimeoutMs();
      this.wakeAnnounced = true;
    }
  }
}
