import { beforeEach, describe, expect, it } from 'vitest';
import { VoiceSession, type VoiceEvent } from '../src/shared/voice-session';

let time = 0;
let events: VoiceEvent[] = [];
let session: VoiceSession;
let early = true;
let follow = 0;

beforeEach(() => {
  time = 1000;
  events = [];
  early = true;
  follow = 0;
  session = new VoiceSession(
    {
      wakeWords: () => ['кетнер'],
      earlyWake: () => early,
      listenTimeoutMs: () => 5000,
      followUpMs: () => follow,
      now: () => time,
    },
    (e) => events.push(e),
  );
});

describe('VoiceSession wake confidence', () => {
  it('ignores a low-confidence wake word in idle mode', () => {
    const quiet = new VoiceSession(
      { wakeWords: () => ['кетнер'], earlyWake: () => false, minWakeConfidence: () => 0.6, listenTimeoutMs: () => 5000, followUpMs: () => 0, now: () => 0 },
      (e) => events.push(e),
    );
    quiet.onFinal('кетнер пауза', [{ word: 'кетнер', conf: 0.3 }, { word: 'пауза', conf: 1 }]);
    expect(events).toEqual([]);
    quiet.onFinal('кетнер пауза', [{ word: 'кетнер', conf: 0.9 }, { word: 'пауза', conf: 1 }]);
    expect(events.at(-1)).toEqual({ type: 'command', text: 'пауза' });
  });
});

describe('VoiceSession', () => {
  it('chimes early on partial and then takes the command from the final result', () => {
    session.onPartial('кетнер открой');
    expect(events).toEqual([{ type: 'wake' }]);
    session.onFinal('кетнер открой дискорд');
    expect(events).toEqual([{ type: 'wake' }, { type: 'command', text: 'открой дискорд' }]);
    expect(session.state).toBe('busy');
  });

  it('waits for the next phrase after a bare wake word', () => {
    session.onPartial('кетнер');
    session.onFinal('кетнер');
    expect(session.state).toBe('listening');
    session.onFinal('включи музыку');
    expect(events.at(-1)).toEqual({ type: 'command', text: 'включи музыку' });
  });

  it('announces the wake on final when early wake is off', () => {
    early = false;
    session.onPartial('кетнер');
    expect(events).toEqual([]);
    session.onFinal('кетнер пауза');
    expect(events).toEqual([{ type: 'wake' }, { type: 'command', text: 'пауза' }]);
  });

  it('ignores speech without the wake word while idle', () => {
    session.onPartial('привет как дела');
    session.onFinal('привет как дела');
    expect(events).toEqual([]);
  });

  it('times out when nothing follows the wake word', () => {
    session.onPartial('кетнер');
    time += 5001;
    session.tick();
    expect(events.at(-1)).toEqual({ type: 'timeout' });
    expect(session.state).toBe('idle');
  });

  it('ignores input while busy', () => {
    session.onFinal('кетнер пауза');
    session.onFinal('кетнер стоп');
    expect(events.filter((e) => e.type === 'command')).toHaveLength(1);
  });

  it('reads yes/no answers while confirming and times out as unknown', () => {
    session.startConfirming(4000);
    session.onFinal('да');
    expect(events.at(-1)).toEqual({ type: 'confirm', answer: 'yes' });

    session.setIdle();
    session.startConfirming(4000);
    time += 4001;
    session.tick();
    expect(events.at(-1)).toEqual({ type: 'confirm', answer: 'unknown' });
  });

  it('keeps listening after a reply when follow-up is enabled', () => {
    follow = 6000;
    session.onFinal('кетнер пауза');
    session.setIdle();
    expect(session.state).toBe('listening');
    session.onFinal('а теперь дальше');
    expect(events.at(-1)).toEqual({ type: 'command', text: 'а теперь дальше' });
  });

  it('starts listening on demand (hotkey)', () => {
    session.startListening();
    session.onFinal('какая погода');
    expect(events).toEqual([{ type: 'wake' }, { type: 'command', text: 'какая погода' }]);
  });
});
