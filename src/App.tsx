import { useState, useRef, useEffect, useCallback } from "react";
import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const queryClient = new QueryClient();

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface Block {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  name?: string;
  input?: unknown;
  content?: string;
}

interface WalletStatus {
  daily_spend_cents: number;
  daily_limit_cents: number;
  per_call_limit_cents: number;
}

function fmtUSD(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

type MsgKind = "user" | "assistant" | "tool" | "error" | "system";

interface ChatMsg {
  kind: MsgKind;
  text: string;
}

function ChatMessage({ msg }: { msg: ChatMsg }) {
  const base =
    "px-3.5 py-2.5 rounded-xl text-sm leading-relaxed whitespace-pre-wrap break-words";
  const styles: Record<MsgKind, string> = {
    user: `${base} bg-blue-100 dark:bg-blue-950 self-end max-w-[80%]`,
    assistant: `${base} bg-white dark:bg-gray-800 self-start max-w-[90%] border border-black/5 dark:border-white/10`,
    tool: `${base} bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-100 font-mono text-xs w-full`,
    error: `${base} bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 w-full`,
    system: `text-xs text-gray-400 dark:text-gray-500 self-center`,
  };
  return <div className={styles[msg.kind]}>{msg.text}</div>;
}

function AgentApp() {
  const [provider, setProvider] = useState("anthropic");
  const [mcpUrl, setMcpUrl] = useState("");
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [history, setHistory] = useState<Message[]>([]);
  const [chatMsgs, setChatMsgs] = useState<ChatMsg[]>([]);
  const [wallet, setWallet] = useState<WalletStatus | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const addMsg = useCallback((kind: MsgKind, text: string) => {
    setChatMsgs((prev) => [...prev, { kind, text }]);
  }, []);

  const refreshWallet = useCallback(async () => {
    try {
      const r = await fetch("/api/wallet/status");
      if (!r.ok) return;
      const s: WalletStatus = await r.json();
      setWallet(s);
    } catch {}
  }, []);

  useEffect(() => {
    refreshWallet();
  }, [refreshWallet]);

  useEffect(() => {
    logRef.current?.lastElementChild?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chatMsgs]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const text = input.trim();
      if (!text) return;
      if (!mcpUrl.trim()) {
        addMsg("error", "Enter an MCP Server URL above.");
        return;
      }

      setInput("");
      setSending(true);
      addMsg("user", text);
      const newHistory: Message[] = [...history, { role: "user", content: text }];
      setHistory(newHistory);

      try {
        const r = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider, messages: newHistory, mcpUrl: mcpUrl.trim() }),
        });

        const data = await r.json();

        if (!r.ok) {
          addMsg("error", `Error: ${data.error || r.statusText}`);
          setHistory(history);
          return;
        }

        const blocks: Block[] = data.content || [];
        let assistantText = "";

        for (const b of blocks) {
          if (b.type === "text" && b.text) {
            assistantText += (assistantText ? "\n" : "") + b.text;
          } else if (b.type === "tool_use") {
            addMsg("tool", `→ ${b.name}(${JSON.stringify(b.input)})`);
          } else if (b.type === "tool_result") {
            const preview = (b.content || "").length > 600 ? (b.content || "").slice(0, 600) + "…" : b.content || "";
            addMsg("tool", `← ${preview}`);
          }
        }
        if (assistantText) addMsg("assistant", assistantText);

        if (data.wallet_error) {
          const w = data.wallet_error;
          const lines = [`Wallet blocked payment for "${w.tool || "?"}" (${w.price || "?"}):\n  ${w.code}: ${w.message}`];
          if (w.daily_spend_cents !== undefined) {
            lines.push(`  Daily: ${fmtUSD(w.daily_spend_cents)} spent / ${fmtUSD(w.daily_limit_cents)} limit`);
          }
          addMsg("error", lines.join("\n"));
          setHistory(history);
        } else if (data.payment_required) {
          addMsg("error", `Payment required for "${data.tool}" (${data.price_usd}) but wallet could not auto-pay.`);
          setHistory(history);
        } else {
          const lastText = blocks.filter((b) => b.type === "text").map((b) => b.text || "").join("\n");
          if (lastText) setHistory([...newHistory, { role: "assistant", content: lastText }]);
        }
      } catch (err: any) {
        addMsg("error", `Network error: ${err.message}`);
        setHistory(history);
      } finally {
        setSending(false);
        textareaRef.current?.focus();
        refreshWallet();
      }
    },
    [input, mcpUrl, history, provider, addMsg, refreshWallet]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as unknown as React.FormEvent);
    }
  };

  const walletPct = wallet ? Math.min(100, (wallet.daily_spend_cents / wallet.daily_limit_cents) * 100) : 0;

  return (
    <div className="flex flex-col h-screen bg-[#f6f7f9] dark:bg-[#14161a] text-[#1a1a1a] dark:text-[#eeeeee]">
      {/* Header */}
      <header className="flex items-center gap-3 px-5 py-3 border-b border-black/10 dark:border-white/10 shrink-0">
        <h1 className="text-sm font-semibold flex-1">MCP Test Agent</h1>
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          className="text-xs px-2.5 py-1.5 rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 cursor-pointer"
        >
          <option value="anthropic">Anthropic — claude-sonnet-4-6</option>
          <option value="openai">OpenAI — gpt-4o</option>
          <option value="gemini">Google — gemini-2.0-flash</option>
        </select>
      </header>

      {/* Config bar */}
      <div className="shrink-0 max-w-3xl w-full mx-auto mt-3 px-5">
        <div className="flex items-center gap-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-4 py-2.5">
          <label className="text-xs text-gray-400 whitespace-nowrap">MCP Server URL</label>
          <input
            type="text"
            value={mcpUrl}
            onChange={(e) => setMcpUrl(e.target.value)}
            placeholder="https://your-mcp-server.vercel.app/mcp"
            className="flex-1 text-sm bg-transparent outline-none min-w-0"
          />
        </div>
      </div>

      {/* Wallet bar */}
      {wallet && (
        <div className="shrink-0 max-w-3xl w-full mx-auto mt-2 px-5">
          <div className="flex items-center gap-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-4 py-2 text-xs flex-wrap">
            <span className="text-gray-400 uppercase tracking-wide text-[10px]">Wallet</span>
            <span>
              <span className="font-semibold tabular-nums">{fmtUSD(wallet.daily_spend_cents)}</span>
              {" / "}
              <span>{fmtUSD(wallet.daily_limit_cents)}</span>
            </span>
            <div className="flex-1 min-w-[100px] h-2 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${walletPct >= 100 ? "bg-red-500" : "bg-blue-500"}`}
                style={{ width: `${walletPct}%` }}
              />
            </div>
            <span className="text-gray-400 uppercase tracking-wide text-[10px]">Per-call cap</span>
            <span className="font-semibold tabular-nums">{fmtUSD(wallet.per_call_limit_cents)}</span>
          </div>
        </div>
      )}

      {/* Messages */}
      <div
        ref={logRef}
        className="flex-1 overflow-y-auto max-w-3xl w-full mx-auto px-5 py-4 flex flex-col gap-3"
      >
        {chatMsgs.length === 0 && (
          <p className="text-sm text-gray-400 dark:text-gray-500 self-center mt-10">
            Enter an MCP server URL and give the agent a task.
          </p>
        )}
        {chatMsgs.map((msg, i) => (
          <ChatMessage key={i} msg={msg} />
        ))}
        {sending && (
          <div className="self-start flex gap-1 px-3.5 py-2.5">
            <span className="w-2 h-2 rounded-full bg-gray-400 animate-bounce [animation-delay:0ms]" />
            <span className="w-2 h-2 rounded-full bg-gray-400 animate-bounce [animation-delay:150ms]" />
            <span className="w-2 h-2 rounded-full bg-gray-400 animate-bounce [animation-delay:300ms]" />
          </div>
        )}
      </div>

      {/* Input form */}
      <div className="shrink-0 sticky bottom-0 max-w-3xl w-full mx-auto px-5 pb-5 pt-3 bg-[#f6f7f9] dark:bg-[#14161a]">
        <form onSubmit={handleSubmit} className="flex gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Give the agent a task…"
            rows={1}
            disabled={sending}
            className="flex-1 resize-none px-3.5 py-2.5 text-sm rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 outline-none focus:ring-2 focus:ring-blue-400 min-h-[44px] max-h-40 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={sending || !input.trim()}
            className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
        <Switch>
          <Route path="/" component={AgentApp} />
          <Route>
            <div className="flex items-center justify-center h-screen">
              <p className="text-gray-400">Page not found</p>
            </div>
          </Route>
        </Switch>
      </WouterRouter>
    </QueryClientProvider>
  );
}

export default App;
