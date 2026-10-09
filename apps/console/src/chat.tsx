import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  get,
  post,
  session,
  SignedOut,
  type ChatEvent,
  type ConversationSummary,
} from './api.ts';
import { ApprovalCard } from './approval.tsx';
import { useI18n } from './i18n.tsx';
import type { PageProps } from './pages.tsx';
import { Badge, Ltr } from './ui.tsx';

const MAX_MESSAGE = 8_000;
/** How long the stream may be down before the page says so (it reconnects on its own). */
const OFFLINE_AFTER_MS = 4_000;
/** The open conversation, kept for this tab so leaving the page does not lose it. */
const OPEN_KEY = 'kodra-agent.console.conversation';

function remembered(): string | null {
  try {
    return sessionStorage.getItem(OPEN_KEY);
  } catch {
    return null;
  }
}

function remember(id: string | null): void {
  try {
    if (id) sessionStorage.setItem(OPEN_KEY, id);
    else sessionStorage.removeItem(OPEN_KEY);
  } catch {
    // A convenience only.
  }
}

type Of<T extends ChatEvent['type']> = Extract<ChatEvent, { type: T }>;
interface Call {
  tool?: Of<'tool'>;
  approval?: Of<'approval'>;
  decision?: Of<'decision'>;
}
type Item =
  | { kind: 'user'; event: Of<'user'> }
  | { kind: 'answer'; event: Of<'answer'> }
  | { kind: 'error'; event: Of<'error'> }
  | { kind: 'call'; id: string };

/** Turns the event list into transcript items; a tool call's events merge into one item. */
function transcript(events: readonly ChatEvent[]) {
  const items: Item[] = [];
  const calls = new Map<string, Call>();
  let status: Of<'status'>['state'] | null = null;
  for (const e of events) {
    if (e.type === 'status') status = e.state;
    else if (e.type === 'user' || e.type === 'answer' || e.type === 'error') {
      items.push({ kind: e.type, event: e } as Item);
    } else {
      let call = calls.get(e.call);
      if (!call) {
        call = {};
        calls.set(e.call, call);
        items.push({ kind: 'call', id: e.call });
      }
      call[e.type] = e as never;
    }
  }
  const last = events.at(-1);
  const busy = status === 'working' || status === 'queued' || last?.type === 'user';
  return { items, calls, status, busy };
}

export function ChatPage({ onSignedOut, me }: PageProps) {
  const { t, time, num } = useI18n();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(remembered);
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const messageId = useId();

  const failed = useCallback(
    (e: unknown) => {
      if (e instanceof SignedOut) onSignedOut();
    },
    [onSignedOut],
  );

  const refreshList = useCallback(() => {
    get<ConversationSummary[]>('chat')
      .then((list) => {
        setConversations(list);
        // A conversation from before the agent restarted is gone.
        const open = remembered();
        if (open && !list.some((c) => c.id === open)) {
          remember(null);
          setSelected((current) => (current === open ? null : current));
        }
      })
      .catch(failed);
  }, [failed]);

  useEffect(() => {
    refreshList();
  }, [refreshList]);

  // The live stream for the open conversation. The browser reconnects by itself and the
  // agent replays what was missed (Last-Event-ID); events are kept once by their number.
  useEffect(() => {
    if (!selected) return;
    const source = new EventSource(`/api/chat/events?conversation=${encodeURIComponent(selected)}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    source.onopen = () => {
      clearTimeout(timer);
      setOffline(false);
    };
    source.onmessage = (message: MessageEvent<string>) => {
      const event = JSON.parse(message.data) as ChatEvent;
      setEvents((prev) => (prev.some((e) => e.seq === event.seq) ? prev : [...prev, event]));
      if (event.type === 'status' && event.state === 'idle') refreshList();
    };
    source.onerror = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        setOffline(true);
        session()
          .then((s) => {
            if (!s.signedIn) {
              source.close();
              onSignedOut();
            }
          })
          .catch(() => undefined);
      }, OFFLINE_AFTER_MS);
    };
    return () => {
      clearTimeout(timer);
      source.close();
    };
  }, [selected, refreshList, onSignedOut]);

  const { items, calls, status, busy } = useMemo(() => transcript(events), [events]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [events.length]);

  const open = (id: string | null) => {
    setEvents([]);
    setProblem(null);
    setOffline(false);
    setSelected(id);
    remember(id);
  };

  const send = async () => {
    const message = text.trim();
    if (!message) return;
    setSending(true);
    setProblem(null);
    try {
      const result = await post<{ conversation: string }>('chat', {
        ...(selected ? { conversation: selected } : {}),
        text: message,
      });
      setText('');
      if (result.conversation !== selected) open(result.conversation);
      refreshList();
    } catch (e) {
      if (e instanceof SignedOut) {
        onSignedOut();
        return;
      }
      setProblem(
        t('chat.sendError', {
          message: e instanceof ApiError || e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <section aria-labelledby="page-title">
      <h1 id="page-title" className="text-2xl font-bold">
        {t('chat.title')}
      </h1>
      <p className="mt-1 text-sm text-ink-secondary">{t('chat.intro')}</p>

      <div className="mt-6 grid gap-6 md:grid-cols-[16rem_1fr]">
        <nav aria-label={t('chat.conversations')} className="min-w-0">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-bold">{t('chat.conversations')}</h2>
            <button
              type="button"
              className="rounded-md border border-line bg-white px-3 py-1.5 text-sm hover:bg-primary-tint"
              onClick={() => {
                open(null);
              }}
            >
              {t('chat.new')}
            </button>
          </div>
          {conversations.length === 0 ? (
            <p className="mt-3 text-sm text-ink-secondary">{t('chat.none')}</p>
          ) : (
            <ul className="mt-3 space-y-1">
              {conversations.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    aria-current={c.id === selected ? 'true' : undefined}
                    className={`w-full rounded-md border px-3 py-2 text-start text-sm ${
                      c.id === selected
                        ? 'border-primary bg-primary-tint'
                        : 'border-line bg-white hover:bg-primary-tint'
                    }`}
                    onClick={() => {
                      open(c.id);
                    }}
                  >
                    <span className="block truncate font-semibold" dir="auto">
                      {c.title}
                    </span>
                    <span className="block text-xs text-ink-secondary">
                      <Ltr>{c.startedBy}</Ltr> · {time(c.createdAt)}
                      {c.busy && (
                        <>
                          {' '}
                          <Badge tone="accent">{t('chat.busy')}</Badge>
                        </>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </nav>

        <div className="min-w-0">
          <div role="log" aria-label={t('chat.title')} className="space-y-3">
            {items.length === 0 && <p className="text-sm text-ink-secondary">{t('chat.start')}</p>}
            {items.map((item) => {
              if (item.kind === 'call') {
                const call = calls.get(item.id) ?? {};
                return (
                  <CallItem
                    key={item.id}
                    call={call}
                    canApprove={me.canApprove}
                    onSignedOut={onSignedOut}
                  />
                );
              }
              const e = item.event;
              if (item.kind === 'user' && e.type === 'user') {
                return (
                  <div key={e.seq} className="rounded-lg bg-primary-tint p-3">
                    <p className="text-xs font-semibold text-ink-secondary">
                      {e.by === me.user ? t('chat.you') : <Ltr>{e.by}</Ltr>}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap" dir="auto">
                      {e.text}
                    </p>
                  </div>
                );
              }
              if (item.kind === 'answer' && e.type === 'answer') {
                return <Answer key={e.seq} event={e} />;
              }
              if (e.type === 'error') {
                return (
                  <p
                    key={e.seq}
                    role="alert"
                    className="rounded-lg border border-line bg-white p-3"
                  >
                    {t('app.error', { message: e.message })}
                  </p>
                );
              }
              return null;
            })}
            <div ref={endRef} />
          </div>

          <div aria-live="polite" className="mt-3 text-sm text-ink-secondary">
            {busy && (status === 'queued' ? t('chat.queued') : t('chat.working'))}
            {offline && <p>{t('chat.offline')}</p>}
          </div>

          <form
            className="mt-4"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <label htmlFor={messageId} className="block text-sm font-semibold">
              {t('chat.message')}
            </label>
            <textarea
              id={messageId}
              dir="auto"
              rows={3}
              maxLength={MAX_MESSAGE}
              placeholder={t('chat.placeholder')}
              aria-describedby={`${messageId}-hint`}
              className="mt-1 w-full rounded-md border border-line bg-white px-3 py-2"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <p id={`${messageId}-hint`} className="text-xs text-ink-secondary">
              {t('chat.tooLong', { n: num(MAX_MESSAGE) })}
            </p>
            {problem && (
              <p role="alert" className="mt-2 text-sm font-semibold">
                {problem}
              </p>
            )}
            <button
              type="submit"
              disabled={sending || busy || text.trim() === ''}
              className="mt-2 rounded-md bg-primary px-4 py-2 font-semibold text-white hover:bg-primary-deep disabled:opacity-50"
            >
              {t('chat.send')}
            </button>
          </form>
        </div>
      </div>
    </section>
  );
}

function CallItem({
  call,
  canApprove,
  onSignedOut,
}: {
  call: Call;
  canApprove: boolean;
  onSignedOut: () => void;
}) {
  const { t, has } = useI18n();
  const base = call.tool ?? call.approval;
  if (!base) return null;
  const risk = `risk.${base.risk}`;
  const state = call.tool?.state;
  const stateKey = `state.${state ?? ''}`;
  const decisionKey = `decision.${call.decision?.decision ?? ''}`;
  const waiting = call.approval && !call.decision;
  return (
    <div className="rounded-lg border border-line bg-white p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Ltr>{`${base.connector}/${base.tool}`}</Ltr>
        <span className="text-ink-secondary">({has(risk) ? t(risk) : base.risk})</span>
        {state && !waiting && (
          <Badge tone={state === 'ok' ? 'accent' : 'plain'}>
            {has(stateKey) ? t(stateKey) : state}
          </Badge>
        )}
      </div>
      <p className="mt-1 break-all font-mono text-xs text-ink-secondary">
        <bdi dir="ltr">{base.args}</bdi>
      </p>
      {call.tool?.detail && (
        <p className="mt-1" dir="auto">
          {call.tool.detail}
        </p>
      )}
      {call.decision && (
        <p className="mt-1">
          {call.decision.decision === 'expired'
            ? t('approval.expired')
            : t('approvals.decided', {
                decision: has(decisionKey) ? t(decisionKey) : call.decision.decision,
                who: call.decision.by ?? '',
              })}
        </p>
      )}
      {waiting && call.approval && (
        <div className="mt-2">
          <ApprovalCard
            approval={call.approval}
            canApprove={canApprove}
            onDecided={() => undefined}
            onSignedOut={onSignedOut}
          />
        </div>
      )}
    </div>
  );
}

function Answer({ event: e }: { event: Of<'answer'> }) {
  const { t, num } = useI18n();
  return (
    <div className="rounded-lg border border-line bg-white p-3">
      <p className="text-xs font-semibold text-ink-secondary">{t('chat.agent')}</p>
      <p className="mt-1 whitespace-pre-wrap" dir="auto">
        {e.text}
      </p>
      <p className="mt-2 text-xs text-ink-secondary">
        {t('chat.usage', {
          input: num(e.usage.input),
          cached: num(e.usage.cacheRead),
          output: num(e.usage.output),
        })}
      </p>
    </div>
  );
}
