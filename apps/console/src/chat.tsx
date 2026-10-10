import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  get,
  post,
  session,
  SignedOut,
  type ChatEvent,
  type ConnectorView,
  type ConversationSummary,
} from './api.ts';
import { ApprovalCard } from './approval.tsx';
import { useI18n, type MessageKey } from './i18n.tsx';
import { Icon } from './icons.tsx';
import { MarkdownText } from './markdown.tsx';
import type { PageProps } from './pages.tsx';
import { Ltr } from './ui.tsx';

const MAX_MESSAGE = 8_000;
const MAX_ROWS = 8;
/** How long the stream may be down before the page says so (it reconnects on its own). */
const OFFLINE_AFTER_MS = 4_000;
/** The open conversation, kept for this tab so leaving the page does not lose it. */
const OPEN_KEY = 'kodra-agent.console.conversation';
const PANEL_KEY = 'kodra-agent.console.conversations-panel';

function readStore(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    // A convenience only.
  }
}

/** One suggested question per kind of connector the agent has. */
const SUGGESTIONS: Record<string, MessageKey> = {
  deploy: 'chat.suggest.deploy',
  source: 'chat.suggest.source',
  cicd: 'chat.suggest.cicd',
  cloud: 'chat.suggest.cloud',
  monitoring: 'chat.suggest.monitoring',
};

type Of<T extends ChatEvent['type']> = Extract<ChatEvent, { type: T }>;

interface Call {
  id: string;
  tool?: Of<'tool'>;
  approval?: Of<'approval'>;
  decision?: Of<'decision'>;
  /** A proposed change's steps, which run after it is approved (call ids `<call>#<n>`). */
  steps: Of<'tool'>[];
}

interface Turn {
  user: Of<'user'>;
  calls: Call[];
  answer?: Of<'answer'>;
  error?: Of<'error'>;
}

/** Groups a conversation's kept events into turns: a question, its tool calls, the answer. */
function buildTurns(events: readonly ChatEvent[]) {
  const turns: Turn[] = [];
  let status: Of<'status'>['state'] = 'idle';
  for (const e of events) {
    if (e.type === 'status') {
      status = e.state;
      continue;
    }
    if (e.type === 'user') {
      turns.push({ user: e, calls: [] });
      continue;
    }
    const turn = turns.at(-1);
    if (!turn || e.type === 'text') continue;
    if (e.type === 'answer') turn.answer = e;
    else if (e.type === 'error') turn.error = e;
    else {
      const [base = e.call, step] = e.call.split('#');
      let call = turn.calls.find((c) => c.id === base);
      if (!call) {
        call = { id: base, steps: [] };
        turn.calls.push(call);
      }
      if (step !== undefined && e.type === 'tool') {
        const at = call.steps.findIndex((s) => s.call === e.call);
        if (at === -1) call.steps.push(e);
        else call.steps[at] = e;
      } else if (e.type === 'tool') call.tool = e;
      else if (e.type === 'approval') call.approval = e;
      else call.decision = e;
    }
  }
  const last = turns.at(-1);
  const busy =
    status === 'working' ||
    status === 'queued' ||
    (last !== undefined && !last.answer && !last.error);
  return { turns, status, busy };
}

export function ChatPage({ onSignedOut, me }: PageProps) {
  const { t, time } = useI18n();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(() => readStore(OPEN_KEY));
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [draft, setDraft] = useState('');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [filter, setFilter] = useState('');
  const [panelOpen, setPanelOpen] = useState(
    () => readStore(PANEL_KEY) !== 'closed' && window.matchMedia('(min-width: 1024px)').matches,
  );
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
        const open = readStore(OPEN_KEY);
        if (open && !list.some((c) => c.id === open)) {
          writeStore(OPEN_KEY, null);
          setSelected((current) => (current === open ? null : current));
        }
      })
      .catch(failed);
  }, [failed]);

  useEffect(() => {
    refreshList();
  }, [refreshList]);

  // The live stream for the open conversation. The browser reconnects by itself and the
  // agent replays what was missed (Last-Event-ID). Kept events are deduplicated by number;
  // live text pieces (seq 0) build the answer while it is written.
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
      if (event.type === 'text') {
        setDraft((d) => d + event.text);
        return;
      }
      if (event.type === 'tool') {
        // Text before a tool call was a preamble; keep it, on its own paragraph.
        setDraft((d) => (d && !d.endsWith('\n\n') ? `${d}\n\n` : d));
      }
      if (event.type === 'answer' || event.type === 'error' || event.type === 'user') {
        setDraft('');
      }
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

  const { turns, status, busy } = useMemo(() => buildTurns(events), [events]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [events.length, draft]);

  const open = (id: string | null) => {
    setEvents([]);
    setDraft('');
    setProblem(null);
    setOffline(false);
    setSelected(id);
    writeStore(OPEN_KEY, id);
    // On a narrow screen the list covers the chat: close it once a conversation is picked.
    if (!window.matchMedia('(min-width: 1024px)').matches) setPanelOpen(false);
  };

  const togglePanel = () => {
    setPanelOpen((o) => {
      writeStore(PANEL_KEY, o ? 'closed' : 'open');
      return !o;
    });
  };

  const send = async (input = text) => {
    const message = input.trim();
    if (!message || sending || busy) return;
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

  const stop = () => {
    if (!selected) return;
    post('chat/stop', { conversation: selected }).catch(failed);
  };

  const current = conversations.find((c) => c.id === selected);
  const shown = conversations.filter((c) =>
    c.title.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  const rows = Math.min(MAX_ROWS, Math.max(1, text.split('\n').length));

  return (
    <div className="flex min-h-0 flex-1">
      {panelOpen && (
        <aside
          aria-label={t('chat.conversations')}
          className="flex w-full shrink-0 flex-col gap-3 border-e border-line bg-surface px-3.5 py-5 sm:w-64"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-[15px] font-semibold">{t('chat.conversations')}</h2>
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-strong bg-raised px-2.5 text-[13px] font-medium whitespace-nowrap hover:bg-muted"
              onClick={() => {
                open(null);
              }}
            >
              <Icon name="plus" size={14} />
              {t('chat.new')}
            </button>
          </div>
          <label className="block">
            <span className="sr-only">{t('chat.search')}</span>
            <input
              type="search"
              placeholder={t('chat.search')}
              className="h-9 w-full rounded-lg border border-line-strong bg-raised px-2.5 text-sm"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
              }}
            />
          </label>
          {conversations.length === 0 ? (
            <p className="px-1 text-sm text-ink-secondary">{t('chat.none')}</p>
          ) : (
            <ul className="flex flex-col gap-1 overflow-y-auto">
              {shown.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    aria-current={c.id === selected ? 'true' : undefined}
                    className={`flex w-full flex-col gap-0.5 rounded-xl border px-3 py-2.5 text-start ${
                      c.id === selected
                        ? 'border-primary bg-raised'
                        : 'border-transparent hover:bg-raised'
                    }`}
                    onClick={() => {
                      open(c.id);
                    }}
                  >
                    <span dir="auto" className="line-clamp-2 text-[13px] font-semibold">
                      {c.title}
                    </span>
                    <span className="flex flex-wrap items-center gap-1.5 text-xs text-ink-secondary">
                      {c.startedBy !== me.user && <Ltr>{c.startedBy}</Ltr>}
                      <span>{time(c.createdAt)}</span>
                      {c.busy && (
                        <span className="rounded-full bg-primary-tint px-1.5 text-[11px] font-medium text-primary-text">
                          {t('chat.busy')}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
      )}

      <section aria-labelledby="page-title" className="flex min-w-0 flex-1 flex-col bg-raised">
        <header className="flex items-center gap-3 border-b border-line px-4 py-3 md:px-7">
          <button
            type="button"
            aria-label={t(panelOpen ? 'chat.hideConversations' : 'chat.showConversations')}
            aria-expanded={panelOpen}
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-line-strong text-ink-secondary hover:text-ink"
            onClick={togglePanel}
          >
            <Icon name="panel" size={16} />
          </button>
          <div className="flex min-w-0 flex-col">
            <h1 id="page-title" dir="auto" className="truncate text-lg font-semibold">
              {current?.title ?? t('chat.title')}
            </h1>
            <span className="text-xs text-ink-secondary">{t('chat.policy')}</span>
          </div>
        </header>

        <div className="flex flex-1 flex-col items-center overflow-y-auto px-4 py-6 md:px-7">
          <div
            role="log"
            aria-label={t('chat.title')}
            className="flex w-full max-w-3xl flex-col gap-6"
          >
            {turns.length === 0 && !selected && (
              <EmptyState
                onPick={(q) => {
                  void send(q);
                }}
                onSignedOut={onSignedOut}
              />
            )}
            {turns.map((turn, i) => (
              <TurnView
                key={turn.user.seq}
                turn={turn}
                me={me}
                live={i === turns.length - 1 && busy}
                draft={i === turns.length - 1 ? draft : ''}
                queued={i === turns.length - 1 && status === 'queued'}
                onSignedOut={onSignedOut}
              />
            ))}
            <div ref={endRef} />
          </div>
        </div>

        <form
          className="flex justify-center border-t border-line bg-raised px-4 pt-3 pb-4 md:px-7"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <div className="flex w-full max-w-3xl flex-col gap-1.5">
            <label htmlFor={messageId} className="sr-only">
              {t('chat.message')}
            </label>
            <div className="flex items-end gap-2 rounded-xl border border-line-strong bg-raised py-2 ps-3.5 pe-2 shadow-sm focus-within:border-primary">
              <textarea
                id={messageId}
                dir="auto"
                rows={rows}
                maxLength={MAX_MESSAGE}
                placeholder={t(busy ? 'chat.placeholderBusy' : 'chat.placeholder')}
                aria-describedby={`${messageId}-hint`}
                className="flex-1 resize-none border-0 bg-transparent py-1.5 text-[15px] leading-[22px] outline-none"
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              {busy && selected ? (
                <button
                  type="button"
                  className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-line-strong bg-raised px-3 text-sm font-semibold hover:bg-muted"
                  onClick={stop}
                >
                  <Icon name="stop" size={12} />
                  {t('chat.stop')}
                </button>
              ) : (
                <button
                  type="submit"
                  aria-label={t('chat.send')}
                  disabled={sending || text.trim() === ''}
                  className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-white hover:bg-primary-deep disabled:opacity-50"
                >
                  <Icon name="send" size={16} />
                </button>
              )}
            </div>
            <p id={`${messageId}-hint`} className="text-xs text-ink-secondary">
              {busy ? t('chat.stopHint') : t('chat.hint', { n: MAX_MESSAGE.toLocaleString('en') })}
            </p>
            {problem && (
              <p role="alert" className="text-sm font-semibold text-bad-text">
                {problem}
              </p>
            )}
            {offline && <p className="text-sm text-ink-secondary">{t('chat.offline')}</p>}
          </div>
        </form>
      </section>
    </div>
  );
}

function EmptyState({
  onPick,
  onSignedOut,
}: {
  onPick: (question: string) => void;
  onSignedOut: () => void;
}) {
  const { t } = useI18n();
  const [connectors, setConnectors] = useState<ConnectorView[]>([]);
  useEffect(() => {
    get<ConnectorView[]>('connectors')
      .then(setConnectors)
      .catch((e: unknown) => {
        if (e instanceof SignedOut) onSignedOut();
      });
  }, [onSignedOut]);
  const ready = connectors.filter((c) => c.available);
  const kinds = [...new Set(ready.map((c) => c.category))].filter((k) => k in SUGGESTIONS);

  return (
    <div className="flex flex-col items-center gap-7 py-10 text-center">
      <div className="flex flex-col items-center gap-2">
        <span
          aria-hidden="true"
          className="inline-flex size-11 items-center justify-center rounded-xl bg-primary text-xl font-bold text-white"
        >
          K
        </span>
        <h2 className="mt-2 text-2xl font-semibold">{t('chat.emptyTitle')}</h2>
        <p className="max-w-lg text-[15px] text-ink-secondary">
          {ready.length > 0
            ? t('chat.emptyIntro', { connectors: ready.map((c) => c.name).join(', ') })
            : t('chat.start')}
        </p>
      </div>
      {kinds.length > 0 && (
        <ul className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2">
          {kinds.slice(0, 4).map((kind) => {
            const key = SUGGESTIONS[kind];
            if (!key) return null;
            const connector = ready.find((c) => c.category === kind);
            return (
              <li key={kind}>
                <button
                  type="button"
                  className="flex h-full w-full flex-col gap-1.5 rounded-xl border border-line bg-surface px-4 py-3.5 text-start hover:border-primary"
                  onClick={() => {
                    onPick(t(key));
                  }}
                >
                  <span className="text-xs font-medium text-primary-text">{connector?.name}</span>
                  <span className="text-sm">{t(key)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function TurnView({
  turn,
  me,
  live,
  draft,
  queued,
  onSignedOut,
}: {
  turn: Turn;
  me: PageProps['me'];
  live: boolean;
  draft: string;
  queued: boolean;
  onSignedOut: () => void;
}) {
  const { t, num } = useI18n();
  const tools = turn.calls.filter((c) => !c.approval);
  const changes = turn.calls.filter((c) => c.approval);
  const thinking = live && !draft && !turn.answer && !changes.some((c) => !c.decision);

  return (
    <>
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-ee-md bg-primary-tint px-3.5 py-2.5 text-[15px] leading-[22px]">
          {turn.user.by !== me.user && (
            <p className="mb-0.5 text-xs font-semibold text-ink-secondary">
              <Ltr>{turn.user.by}</Ltr>
            </p>
          )}
          <p dir="auto" className="whitespace-pre-wrap">
            {turn.user.text}
          </p>
        </div>
      </div>

      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-[13px] font-bold text-white"
        >
          K
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {tools.length > 0 && <ToolSummary calls={tools} />}
          {changes.map((call) => (
            <ChangeView key={call.id} call={call} me={me} onSignedOut={onSignedOut} />
          ))}
          {turn.answer ? (
            <div>
              <MarkdownText text={turn.answer.text} />
              <p className="mt-2 text-xs text-ink-secondary">
                {t('chat.usage', {
                  input: num(turn.answer.usage.input),
                  cached: num(turn.answer.usage.cacheRead),
                  output: num(turn.answer.usage.output),
                })}
              </p>
            </div>
          ) : (
            draft && (
              <div aria-busy="true">
                <MarkdownText text={draft} />
                <span aria-hidden="true" className="kodra-caret inline-block h-4 w-2 bg-primary" />
              </div>
            )
          )}
          {turn.error && (
            <p role="alert" className="rounded-lg border border-line bg-bad-tint p-3 text-bad-text">
              {t('app.error', { message: turn.error.message })}
            </p>
          )}
          {thinking && (
            <p aria-live="polite" className="flex items-center gap-2 text-sm text-ink-secondary">
              <span aria-hidden="true" className="flex gap-1">
                <span className="kodra-dot size-1.5 rounded-full bg-ink-secondary" />
                <span className="kodra-dot size-1.5 rounded-full bg-ink-secondary [animation-delay:0.2s]" />
                <span className="kodra-dot size-1.5 rounded-full bg-ink-secondary [animation-delay:0.4s]" />
              </span>
              {t(queued ? 'chat.queued' : 'chat.working')}
            </p>
          )}
        </div>
      </div>
    </>
  );
}

const STATE_TONE: Record<string, string> = {
  ok: 'bg-ok-tint text-ok-text',
  error: 'bg-bad-tint text-bad-text',
  blocked: 'bg-muted text-ink-secondary',
  denied: 'bg-bad-tint text-bad-text',
  expired: 'bg-muted text-ink-secondary',
  running: 'bg-primary-tint text-primary-text',
};

/** Tool calls as one quiet line that opens to the details. */
function ToolSummary({ calls }: { calls: Call[] }) {
  const { t, has } = useI18n();
  const [open, setOpen] = useState(false);
  const running = calls.find((c) => c.tool?.state === 'running');
  const failed = calls.filter((c) => c.tool && c.tool.state !== 'ok' && c.tool.state !== 'running');
  const names = [...new Set(calls.map((c) => c.tool?.tool).filter(Boolean))].join(' · ');
  const label = running
    ? t('chat.running', { tool: `${running.tool?.connector ?? ''} · ${running.tool?.tool ?? ''}` })
    : calls.length === 1
      ? t('chat.usedTool')
      : t('chat.usedTools', { n: calls.length });

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        className={`inline-flex max-w-full flex-wrap items-center gap-2 rounded-full border px-3 py-1.5 text-[13px] ${
          running
            ? 'border-primary bg-primary-tint text-primary-text'
            : 'border-line bg-surface text-ink-secondary hover:text-ink'
        }`}
        onClick={() => {
          setOpen((o) => !o);
        }}
      >
        <Icon
          name={running ? 'spinner' : failed.length > 0 ? 'alert' : 'check'}
          size={14}
          className={running ? 'animate-spin' : failed.length > 0 ? '' : 'text-ok-text'}
        />
        <span className="font-medium text-ink">{label}</span>
        {!running && (
          <bdi dir="ltr" className="font-mono text-xs">
            {names}
          </bdi>
        )}
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} className="rtl:-scale-x-100" />
      </button>
      {open && (
        <ul className="mt-2 flex flex-col gap-1.5 rounded-xl border border-line bg-surface p-2.5 text-[13px]">
          {calls.map((c) => {
            if (!c.tool) return null;
            const stateKey = `state.${c.tool.state}`;
            const riskKey = `risk.${c.tool.risk}`;
            return (
              <li key={c.id} className="flex flex-col gap-1 rounded-lg bg-raised px-3 py-2">
                <span className="flex flex-wrap items-center gap-2">
                  <Ltr>{`${c.tool.connector}/${c.tool.tool}`}</Ltr>
                  <span className="text-xs text-ink-secondary">
                    {has(riskKey) ? t(riskKey) : c.tool.risk}
                  </span>
                  <span
                    className={`rounded-full px-2 text-[11px] font-medium ${STATE_TONE[c.tool.state] ?? ''}`}
                  >
                    {has(stateKey) ? t(stateKey) : c.tool.state}
                  </span>
                </span>
                <bdi dir="ltr" className="font-mono text-xs break-all text-ink-secondary">
                  {c.tool.args}
                </bdi>
                {c.tool.detail && (
                  <span dir="auto" className="text-ink-secondary">
                    {c.tool.detail}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** A change that needed approval: the card while it waits, then what happened. */
function ChangeView({
  call,
  me,
  onSignedOut,
}: {
  call: Call;
  me: PageProps['me'];
  onSignedOut: () => void;
}) {
  const { t, has } = useI18n();
  const a = call.approval;
  if (!a) return null;
  if (!call.decision) {
    return (
      <ApprovalCard
        approval={a}
        canApprove={me.canApprove}
        onDecided={() => undefined}
        onSignedOut={onSignedOut}
      />
    );
  }
  const d = call.decision;
  const decisionKey = `decision.${d.decision}`;
  const ranSteps = call.steps.length > 0 ? call.steps : call.tool ? [call.tool] : [];
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <Icon
          name={d.decision === 'approved' ? 'check' : 'x'}
          size={15}
          className={d.decision === 'approved' ? 'text-ok-text' : 'text-bad-text'}
        />
        <span className="font-semibold">
          {a.title ? <bdi dir="auto">{a.title}</bdi> : <Ltr>{`${a.connector}/${a.tool}`}</Ltr>}
        </span>
        <span className="text-ink-secondary">
          {d.decision === 'expired'
            ? t('approval.expired')
            : t('approvals.decided', {
                decision: has(decisionKey) ? t(decisionKey) : d.decision,
                who: d.by ?? '',
              })}
        </span>
      </p>
      {ranSteps.length > 0 && (
        <ol className="mt-2 flex flex-col gap-1">
          {ranSteps.map((s) => {
            const stateKey = `state.${s.state}`;
            return (
              <li key={s.call} className="flex flex-wrap items-center gap-2 text-[13px]">
                <Ltr>{`${s.connector}/${s.tool}`}</Ltr>
                <span
                  className={`rounded-full px-2 text-[11px] font-medium ${STATE_TONE[s.state] ?? ''}`}
                >
                  {has(stateKey) ? t(stateKey) : s.state}
                </span>
                {s.detail && (
                  <span dir="auto" className="text-ink-secondary">
                    {s.detail}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
