import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/shared/config-defaults';
import { buildSystemPrompt, describeApiError, KetnerClient, LlmError, runAgent, type ChatMessage, type Completion } from '../src/main/llm';

const call = (id: string, name: string, args: string) => ({ id, type: 'function' as const, function: { name, arguments: args } });
const scripted = (...steps: Completion[]) => {
  const queue = [...steps];
  return { complete: vi.fn(async () => queue.shift() ?? { content: 'конец', toolCalls: [], finishReason: 'stop' }) };
};

describe('runAgent', () => {
  it('returns the plain answer when no tools are called', async () => {
    const client = scripted({ content: ' Привет ', toolCalls: [], finishReason: 'stop' });
    const out = await runAgent([{ role: 'user', content: 'hi' }], { client, tools: [], maxSteps: 3, execute: vi.fn() });
    expect(out).toEqual({ reply: 'Привет', steps: 1 });
  });

  it('executes tool calls and feeds results back before answering', async () => {
    const client = scripted(
      { content: null, toolCalls: [call('c1', 'open_app', '{"name":"Discord"}')], finishReason: 'tool_calls' },
      { content: 'Открыл Дискорд', toolCalls: [], finishReason: 'stop' },
    );
    const execute = vi.fn(async () => 'Запущено: Discord.');
    const messages: ChatMessage[] = [{ role: 'user', content: 'открой дискорд' }];
    const out = await runAgent(messages, { client, tools: [], maxSteps: 4, execute });
    expect(execute).toHaveBeenCalledWith('open_app', { name: 'Discord' });
    expect(out.reply).toBe('Открыл Дискорд');
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(messages[2]).toMatchObject({ tool_call_id: 'c1', content: 'Запущено: Discord.' });
  });

  it('never runs a tool whose arguments were cut off', async () => {
    const client = scripted(
      { content: null, toolCalls: [call('c1', 'run_powershell', '{"command":"Remove-Ite')], finishReason: 'length' },
      { content: 'Не вышло', toolCalls: [], finishReason: 'stop' },
    );
    const execute = vi.fn();
    await runAgent([{ role: 'user', content: 'x' }], { client, tools: [], maxSteps: 3, execute });
    expect(execute).not.toHaveBeenCalled();
  });

  it('reports malformed JSON arguments back to the model instead of executing', async () => {
    const client = scripted(
      { content: null, toolCalls: [call('c1', 'open_app', 'not json')], finishReason: 'tool_calls' },
      { content: 'ок', toolCalls: [], finishReason: 'stop' },
    );
    const execute = vi.fn();
    const messages: ChatMessage[] = [{ role: 'user', content: 'x' }];
    await runAgent(messages, { client, tools: [], maxSteps: 3, execute });
    expect(execute).not.toHaveBeenCalled();
    expect(messages[2]?.content).toMatch(/Ошибка/);
  });

  it('turns tool exceptions into tool messages and keeps going', async () => {
    const client = scripted(
      { content: null, toolCalls: [call('c1', 'open_app', '{"name":"x"}')], finishReason: 'tool_calls' },
      { content: 'Не нашёл', toolCalls: [], finishReason: 'stop' },
    );
    const messages: ChatMessage[] = [{ role: 'user', content: 'x' }];
    const out = await runAgent(messages, { client, tools: [], maxSteps: 3, execute: async () => { throw new Error('boom'); } });
    expect(messages[2]?.content).toBe('Ошибка: boom');
    expect(out.reply).toBe('Не нашёл');
  });

  it('stops after maxSteps', async () => {
    const loop: Completion = { content: null, toolCalls: [call('c', 'wait', '{"seconds":1}')], finishReason: 'tool_calls' };
    const client = scripted(loop, loop, loop, loop);
    const out = await runAgent([{ role: 'user', content: 'x' }], { client, tools: [], maxSteps: 3, execute: async () => 'ok' });
    expect(out.steps).toBe(3);
    expect(out.reply).toMatch(/шагов/);
  });
});

describe('KetnerClient', () => {
  const make = (fetchImpl: ConstructorParameters<typeof KetnerClient>[2], key: string | null = 'ketner_sk_test') =>
    new KetnerClient(() => DEFAULT_CONFIG, () => key, fetchImpl);

  it('posts an OpenAI-style request with the bearer key and parses tool calls', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe('auto');
      expect(body.tool_choice).toBe('auto');
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [call('c1', 'wait', '{}')] } }] }), { status: 200 });
    });
    const out = await make(fetchImpl).complete([{ role: 'user', content: 'x' }], []);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://ketner.org/v1/chat/completions');
    expect((fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>)['Authorization']).toBe('Bearer ketner_sk_test');
    expect(out.toolCalls).toHaveLength(1);
  });

  it('explains API failures in Russian', async () => {
    const fail = (status: number, code: string) => make(async () => new Response(JSON.stringify({ error: { code, message: 'm' } }), { status }));
    await expect(fail(401, 'invalid_api_key').complete([], [])).rejects.toThrow(/Ключ Ketner не подошёл/);
    await expect(fail(403, 'upgrade_required').complete([], [])).rejects.toThrow(/Plus/);
    await expect(fail(429, 'insufficient_quota').complete([], [])).rejects.toThrow(/исчерпан/);
    await expect(fail(502, 'upstream_error').complete([], [])).rejects.toThrow(/недоступен/);
  });

  it('fails clearly without a key and on network errors', async () => {
    await expect(make(vi.fn(), null).complete([], [])).rejects.toBeInstanceOf(LlmError);
    await expect(make(async () => { throw new TypeError('fetch failed'); }).complete([], [])).rejects.toThrow(/Нет связи/);
  });

  it('lists only available models on ping', async () => {
    const client = make(async () => new Response(JSON.stringify({ data: [{ id: 'auto', available: true }, { id: 'ketner-max', available: false }] }), { status: 200 }));
    expect((await client.ping()).models).toEqual(['auto']);
  });
});

describe('prompt and errors', () => {
  it('includes configured sites and apps in the system prompt', () => {
    const prompt = buildSystemPrompt({ ...DEFAULT_CONFIG, apps: [{ name: 'Nux Editor', aliases: ['нукс'], target: 'C:\\nux.exe' }] }, new Date('2026-10-25T10:00:00Z'));
    expect(prompt).toContain('Nux Editor (нукс)');
    expect(prompt).toContain('https://music.yandex.ru');
  });
  it('maps statuses to messages', () => {
    expect(describeApiError(400, undefined, 'bad')).toContain('bad');
  });
});
