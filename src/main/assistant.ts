import { dialog } from 'electron';
import { cleanForSpeech } from '../shared/speech-text';
import { matchLocalCommand } from '../shared/local-commands';
import type { Answer } from '../shared/text';
import type { CommandResult, LogEntry } from '../shared/types';
import type { ConfigStore } from './config';
import { buildSystemPrompt, LlmError, runAgent, type ChatMessage, type KetnerClient } from './llm';
import type { AudioRpc } from './rpc';
import type { TimerManager } from './timers';
import { needsConfirmation, TOOL_MAP, toOpenAiTools } from './tools';

export type CommandSource = 'voice' | 'text';

const HISTORY_TURNS = 4;
const HISTORY_TTL_MS = 5 * 60_000;
const LOG_LIMIT = 200;

export class Assistant {
  private busy = false;
  private history: ChatMessage[] = [];
  private lastTurnAt = 0;
  private logId = 0;
  private readonly logBuffer: LogEntry[] = [];
  private readonly logListeners = new Set<(e: LogEntry) => void>();

  constructor(
    private readonly config: ConfigStore,
    private readonly client: KetnerClient,
    private readonly audio: AudioRpc,
    private readonly timers: TimerManager,
  ) {}

  getLog(): LogEntry[] {
    return this.logBuffer;
  }

  onLog(listener: (e: LogEntry) => void): () => void {
    this.logListeners.add(listener);
    return () => this.logListeners.delete(listener);
  }

  log(kind: LogEntry['kind'], text: string): void {
    const entry: LogEntry = { id: ++this.logId, time: Date.now(), kind, text };
    this.logBuffer.push(entry);
    if (this.logBuffer.length > LOG_LIMIT) this.logBuffer.shift();
    for (const l of this.logListeners) l(entry);
  }

  /** Произнести фразу вслух (таймеры, системные сообщения). */
  async say(text: string, proactive = false): Promise<void> {
    const clean = cleanForSpeech(text);
    if (!clean) return;
    try {
      await this.audio.call('speak', { text: clean, proactive });
    } catch (err) {
      this.log('error', `Не удалось произнести: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async handle(text: string, source: CommandSource): Promise<CommandResult> {
    if (this.busy) return { reply: 'Я ещё занят предыдущей командой.', ok: false };
    this.busy = true;
    this.log('heard', text);
    try {
      const local = matchLocalCommand(text);
      if (local) {
        const result = await this.execute(local.tool, local.args, source);
        const ok = !result.startsWith('Ошибка');
        if (!ok) await this.say(result);
        else await this.audio.call('chime', { kind: 'done' }).catch(() => undefined);
        return { reply: ok ? '' : result, ok };
      }

      const reply = await this.askModel(text, source);
      await this.say(reply);
      return { reply, ok: true };
    } catch (err) {
      const message = err instanceof LlmError ? err.message : `Что-то пошло не так: ${err instanceof Error ? err.message : String(err)}`;
      this.log('error', message);
      await this.audio.call('chime', { kind: 'error' }).catch(() => undefined);
      await this.say(message);
      return { reply: message, ok: false };
    } finally {
      this.busy = false;
    }
  }

  private async askModel(text: string, source: CommandSource): Promise<string> {
    const cfg = this.config.get();
    if (Date.now() - this.lastTurnAt > HISTORY_TTL_MS) this.history = [];

    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt(cfg) },
      ...this.history,
      { role: 'user', content: text },
    ];
    const out = await runAgent(messages, {
      client: this.client,
      tools: toOpenAiTools(),
      maxSteps: cfg.llm.maxSteps,
      execute: (name, args) => this.execute(name, args, source),
    });

    const reply = cleanForSpeech(out.reply) || 'Готово.';
    this.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
    this.history = this.history.slice(-HISTORY_TURNS * 2);
    this.lastTurnAt = Date.now();
    this.log('reply', reply);
    return reply;
  }

  private async execute(name: string, args: Record<string, unknown>, source: CommandSource): Promise<string> {
    const tool = TOOL_MAP.get(name);
    if (!tool) return `Ошибка: неизвестный инструмент «${name}».`;

    const description = tool.describe(args);
    if (needsConfirmation(tool, args, this.config.get().confirm)) {
      const answer = await this.confirm(description, source);
      if (answer !== 'yes') {
        this.log('tool', `Отклонено: ${description}`);
        return 'Пользователь не подтвердил действие. Не выполняй его и сообщи, что отменено.';
      }
    }
    try {
      const result = await tool.run(args, { config: this.config.get(), timers: this.timers });
      this.log('tool', `${description} → ${result.split('\n')[0]}`);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log('error', `${description}: ${message}`);
      return `Ошибка: ${message}`;
    }
  }

  private async confirm(description: string, source: CommandSource): Promise<Answer> {
    if (source === 'text') {
      const { response } = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Выполнить', 'Отмена'],
        defaultId: 1,
        cancelId: 1,
        title: 'Ketner Station',
        message: `Выполнить: ${description}?`,
      });
      return response === 0 ? 'yes' : 'no';
    }
    try {
      return await this.audio.call<Answer>('confirm', { question: `Выполнить: ${description}? Скажите «да» или «нет».` });
    } catch {
      return 'unknown';
    }
  }
}
