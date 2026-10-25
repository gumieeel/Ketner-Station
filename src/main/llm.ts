import type { Config } from '../shared/types';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface Completion {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: string;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/** Человеческое объяснение ошибки API — его ассистент произнесёт вслух. */
export function describeApiError(status: number, code: string | undefined, message: string): string {
  if (status === 401) return 'Ключ Ketner не подошёл. Проверьте его в настройках.';
  if (status === 403) return 'Для голосового помощника нужен тариф Plus или выше.';
  if (status === 429 && code === 'insufficient_quota') return 'Бюджет вашего тарифа Ketner исчерпан.';
  if (status === 429) return 'Слишком много запросов к Ketner. Попробуйте через минуту.';
  if (status >= 500) return 'Сервер Ketner сейчас недоступен.';
  return `Ketner вернул ошибку: ${message}`;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class KetnerClient {
  constructor(
    private readonly getConfig: () => Config,
    private readonly getApiKey: () => string | null,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private headers(): Record<string, string> {
    const key = this.getApiKey();
    if (!key) throw new LlmError('Ключ Ketner не задан. Откройте настройки и вставьте ключ API.');
    return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  }

  async complete(messages: ChatMessage[], tools: unknown[], signal?: AbortSignal): Promise<Completion> {
    const { llm } = this.getConfig();
    let response: Response;
    try {
      response = await this.fetchImpl(`${llm.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          model: llm.model,
          messages,
          tools,
          tool_choice: 'auto',
          temperature: llm.temperature,
          max_tokens: 600,
          reasoning_effort: 'low',
        }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
      });
    } catch (err) {
      if (err instanceof LlmError) throw err;
      throw new LlmError('Нет связи с сервером Ketner. Проверьте интернет.');
    }

    const body = (await response.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] }; finish_reason?: string }>;
      error?: { message?: string; code?: string };
    } | null;

    if (!response.ok) {
      throw new LlmError(describeApiError(response.status, body?.error?.code, body?.error?.message ?? response.statusText), response.status, body?.error?.code);
    }
    const choice = body?.choices?.[0];
    if (!choice?.message) throw new LlmError('Ketner вернул пустой ответ.');
    return {
      content: choice.message.content ?? null,
      toolCalls: choice.message.tool_calls ?? [],
      finishReason: choice.finish_reason ?? 'stop',
    };
  }

  /** Проверка ключа и адреса: возвращает число доступных моделей. */
  async ping(): Promise<{ models: string[] }> {
    const { llm } = this.getConfig();
    let response: Response;
    try {
      response = await this.fetchImpl(`${llm.baseUrl}/models`, { headers: this.headers(), signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new LlmError('Нет связи с сервером Ketner. Проверьте интернет и адрес API.');
    }
    const body = (await response.json().catch(() => null)) as { data?: Array<{ id: string; available?: boolean }>; error?: { message?: string; code?: string } } | null;
    if (!response.ok) throw new LlmError(describeApiError(response.status, body?.error?.code, body?.error?.message ?? response.statusText), response.status);
    return { models: (body?.data ?? []).filter((m) => m.available !== false).map((m) => m.id) };
  }
}

export interface AgentDeps {
  client: Pick<KetnerClient, 'complete'>;
  tools: unknown[];
  maxSteps: number;
  /** Выполняет вызов инструмента и возвращает текст результата (ошибки — тоже текстом). */
  execute: (name: string, args: Record<string, unknown>) => Promise<string>;
  signal?: AbortSignal;
  onToolCall?: (name: string, args: Record<string, unknown>, result: string) => void;
}

export interface AgentResult {
  reply: string;
  steps: number;
}

function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Цикл «модель → инструмент → результат» до итогового текстового ответа. */
export async function runAgent(messages: ChatMessage[], deps: AgentDeps): Promise<AgentResult> {
  for (let step = 1; step <= deps.maxSteps; step++) {
    const completion = await deps.client.complete(messages, deps.tools, deps.signal);

    if (!completion.toolCalls.length) {
      return { reply: (completion.content ?? '').trim(), steps: step };
    }

    messages.push({ role: 'assistant', content: completion.content, tool_calls: completion.toolCalls });
    const truncated = completion.finishReason === 'length';

    for (const call of completion.toolCalls) {
      let result: string;
      const args = truncated ? null : parseArgs(call.function.arguments);
      if (!args) {
        result = 'Ошибка: аргументы вызова оборваны или не являются JSON. Повторите вызов.';
      } else {
        try {
          result = await deps.execute(call.function.name, args);
        } catch (err) {
          result = `Ошибка: ${err instanceof Error ? err.message : String(err)}`;
        }
        deps.onToolCall?.(call.function.name, args, result);
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }
  return { reply: 'Не удалось закончить за отведённое число шагов.', steps: deps.maxSteps };
}

export function buildSystemPrompt(config: Config, now = new Date()): string {
  const apps = config.apps.map((a) => `${a.name}${a.aliases.length ? ` (${a.aliases.join(', ')})` : ''}`).join('; ') || 'нет';
  const sites = config.sites.map((s) => `${s.name}${s.aliases.length ? ` (${s.aliases.join(', ')})` : ''} — ${s.url}`).join('\n') || 'нет';
  return `Ты — Кетнер, голосовой ассистент на компьютере пользователя с Windows. Пользователь говорит в микрофон, ты отвечаешь вслух, поэтому:
- отвечай по-русски, коротко: одна-две фразы, без списков, разметки, ссылок и эмодзи;
- сначала выполни просьбу инструментами, потом коротко сообщи результат («Открыл Дискорд», «Готово»);
- НЕ переспрашивай по пустякам: речь распознаётся неточно, поэтому выбирай самое вероятное толкование и сразу действуй. Просьба «открой …», «включи …», «найди …» — это немедленный вызов инструмента, а не вопрос;
- уточняй одним коротким вопросом только если без ответа действие невозможно или опасно;
- если инструмент вернул ошибку, скажи об этом честно и предложи, что можно сделать;
- не придумывай результатов, которых не было, и не выполняй то, о чём не просили.

Если фраза начинается с обращения («Кетнер», «Катнер» и похожих искажений), это твоё имя: не обращай на него внимания.
Речь распознаётся с ошибками: названия могут быть написаны по-русски («дискорд», «хром») — переводи в оригинальное название программы («Discord», «Chrome») при вызове open_app.
Если просят «включи музыку» или «Яндекс Музыку» — открой сайт; чтобы начать воспроизведение, можно после ожидания нажать space или использовать media_control.
Для сайтов используй open_url. Адреса поиска внутри сайтов: Яндекс Музыка — https://music.yandex.ru/search?text=ЗАПРОС, YouTube — https://www.youtube.com/results?search_query=ЗАПРОС (запрос кодируй в URL).

Сейчас: ${now.toLocaleString('ru-RU', { dateStyle: 'full', timeStyle: 'short' })}.
Программы пользователя: ${apps}.
Сайты пользователя:
${sites}`;
}
