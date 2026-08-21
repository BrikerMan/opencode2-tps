/**
 * opencode2-tps — live LLM speed meter for the OpenCode V2 TUI.
 *
 * Renders `TPS x | AVG y | TTFT z` beside the session prompt
 * (`prompt.footer.status` slot).
 *
 * - TPS  — live tokens/s over a rolling window, estimated from the
 *          text/reasoning delta size (the protocol does not expose
 *          per-token counts while streaming). CJK/fullwidth runes
 *          count ~1 token each, latin text ~4 chars/token. When the
 *          stream ends the last live value stays on screen until the
 *          next stream replaces it.
 * - AVG  — session cumulative tokens/s from the real token counts of
 *          completed assistant messages (`message.tokens`), divided by
 *          pure streaming time (first → last delta per message, so tool
 *          execution time is excluded).
 * - TTFT — time from assistant message start to its first token; shown
 *          the moment the first token arrives and kept until the next
 *          message replaces it.
 *
 * Runtime imports go through the TUI host's runtime-module registry
 * (`opentui:runtime-module:<specifier>`): the host registers its own
 * solid-js / @opentui/solid instances there, so elements we create join the
 * host render tree (external npm copies have no renderer and crash with
 * "No renderer found"). On builds without that registry the imports throw
 * and the plugin stays silent instead of breaking the TUI.
 */

const WINDOW_MS = 5_000; // live TPS rolling window
const STALE_MS = 1_500; // no delta for this long → show "-"
const MIN_DURATION_MS = 250; // floor so a lone sample can't spike TPS
const ASCII_PER_TOKEN = 4; // heuristic for latin text

const runtimeModule = (specifier) => `opentui:runtime-module:${encodeURIComponent(specifier)}`;

// Estimate tokens from actual text: CJK/fullwidth runes ≈ 1 token each
// (Qwen/GPT tokenizers), latin ≈ ASCII_PER_TOKEN chars per token.
function tokensInText(text) {
  let tokens = 0;
  for (let i = 0; i < text.length; i++) tokens += text.charCodeAt(i) > 0x2e80 ? 1 : 1 / ASCII_PER_TOKEN;
  return tokens;
}

function formatRate(value) {
  if (!Number.isFinite(value) || value <= 0) return "-";
  if (value >= 100) return String(Math.round(value));
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function formatTtft(ms) {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "-";
  return `${(ms / 1000).toFixed(1)}s`;
}

// Live TPS from the rolling window. The last live value is cached on the
// session state so it can be kept on screen after the stream ends (stale /
// idle) until the next stream replaces it.
function liveTps(s, now) {
  const recent = s.samples.filter((x) => now - x.at <= WINDOW_MS);
  if (recent.length > 0) {
    const last = recent[recent.length - 1];
    if (now - last.at <= STALE_MS) {
      const tokens = recent.reduce((sum, x) => sum + x.tokens, 0);
      const duration = Math.max(now - recent[0].at, MIN_DURATION_MS);
      const value = formatRate(tokens / (duration / 1000));
      if (value !== "-") s.frozenTps = value;
      return value;
    }
  }
  return s.frozenTps ?? "-";
}

function avgTps(totals) {
  if (totals.tokens <= 0 || totals.durationMs <= 0) return "-";
  return formatRate(totals.tokens / (totals.durationMs / 1000));
}

const plugin = {
  id: "opencode2-tps",
  setup: async (ctx) => {
    // Resolve the host render runtime — one shared instance with the host
    // means our elements join its render tree. Anything else → stay silent.
    let jsx, createSignal, createRenderEffect, onCleanup;
    try {
      const solid = await import(runtimeModule("solid-js"));
      const jsxRuntime = await import(runtimeModule("@opentui/solid/jsx-runtime"));
      jsx = jsxRuntime.jsx;
      createSignal = solid.createSignal;
      createRenderEffect = solid.createRenderEffect;
      onCleanup = solid.onCleanup;
      if (typeof jsx !== "function" || typeof createSignal !== "function") return;
    } catch {
      return; // older build without the runtime-module registry
    }

    const sessions = new Map();

    const state = (sessionID) => {
      let s = sessions.get(sessionID);
      if (!s) {
        s = { samples: [], totals: { tokens: 0, durationMs: 0 }, ttftMs: undefined, frozenTps: undefined };
        sessions.set(sessionID, s);
      }
      return s;
    };

    const requestRender = () => {
      try {
        ctx.renderer?.requestRender?.();
      } catch {
        // Older TUI builds expose no renderer handle.
      }
    };

    // NOTE: the host event emitter does not reach plugins on all V2 betas,
    // so metrics are driven reactively from the host data store instead
    // (see Meter below). No event listeners are registered.
    const offs = [];

    const renderText = (sessionID) => {
      const s = sessions.get(sessionID);
      if (!s) return "TPS - | AVG - | TTFT -";
      return `TPS ${liveTps(s, Date.now())} | AVG ${avgTps(s.totals)} | TTFT ${formatTtft(s.ttftMs)}`;
    };

    // The host mounts claim renders as Solid components: the body runs once
    // (untracked), so input changes must be read through the props getter
    // inside a tracked effect. Reading the host data store inside the effect
    // re-runs it on every streaming delta — that is our event source.
    const Meter = (props) => {
      const [text, setText] = createSignal("TPS - | AVG - | TTFT -");
      // A stalled stream must flip live TPS back to "-" without a store
      // change, so refresh once a second from current state.
      const ticker = setInterval(() => {
        try {
          const sessionID = props.sessionID;
          if (!sessionID) return;
          setText(renderText(sessionID));
          requestRender();
        } catch {
          // ignore
        }
      }, 1000);
      onCleanup(() => clearInterval(ticker));

      // Per-message streaming trackers, reset when the assistant message changes
      let trackedMessageID;
      let firstGrowthAt;
      let lastGrowthAt;
      let prevTokens;

      const reset = () => {
        trackedMessageID = undefined;
        firstGrowthAt = undefined;
        lastGrowthAt = undefined;
        prevTokens = undefined;
      };

      createRenderEffect(() => {
        const sessionID = props.sessionID; // reactive to route/session changes
        if (!sessionID) {
          setText("TPS - | AVG - | TTFT -");
          return;
        }
        let messages = [];
        let status = "idle";
        try {
          messages = ctx.data.session.message.list(sessionID) ?? []; // reactive store read
          status = ctx.data.session.status(sessionID);
        } catch {
          setText("TPS - | AVG - | TTFT -");
          return;
        }

        // Find the streaming assistant message: last assistant message,
        // scanning backwards for the one still open or the newest completed.
        let target;
        for (let i = messages.length - 1; i >= 0 && i >= messages.length - 4; i--) {
          const message = messages[i];
          if (message?.type === "user") break;
          if (message?.type !== "assistant" || !Array.isArray(message.content)) continue;
          const tokens = message.content.reduce(
            (n, part) =>
              n +
              ((part?.type === "text" || part?.type === "reasoning") && typeof part.text === "string"
                ? tokensInText(part.text)
                : 0),
            0,
          );
          target = { message, tokens };
          if (message.time?.completed === undefined) break; // still streaming
        }

        const now = Date.now();
        if (!target || target.tokens === 0) {
          if (status === "idle") {
            reset();
          }
        } else if (target.message.id !== trackedMessageID) {
          // New assistant message started streaming
          reset();
          trackedMessageID = target.message.id;
          prevTokens = target.tokens;
          firstGrowthAt = now;
          lastGrowthAt = now;
          const s = state(sessionID);
          s.samples = [{ at: now, tokens: target.tokens }];
          s.ttftMs = Math.max(now - (target.message.time?.created ?? now), 0);
        } else if (target.tokens > prevTokens) {
          // Text grew: record the increment as streaming samples
          const s = state(sessionID);
          const grew = target.tokens - prevTokens;
          s.samples = [...s.samples.filter((x) => now - x.at <= WINDOW_MS), { at: now, tokens: grew }];
          s.ttftMs ??= Math.max(now - (target.message.time?.created ?? now), 0);
          prevTokens = target.tokens;
          lastGrowthAt = now;
        } else if (target.message.time?.completed !== undefined && lastGrowthAt !== undefined) {
          // Message completed: fold real token counts into the session average
          const s = state(sessionID);
          const tokens = (target.message.tokens?.output ?? 0) + (target.message.tokens?.reasoning ?? 0);
          if (tokens > 0 && firstGrowthAt !== undefined) {
            s.totals.tokens += tokens;
            s.totals.durationMs += Math.max(lastGrowthAt - firstGrowthAt, 1);
          }
          reset();
        }

        const s = sessions.get(sessionID);
        const line = s
          ? `TPS ${liveTps(s, now)} | AVG ${avgTps(s.totals)} | TTFT ${formatTtft(s.ttftMs)}`
          : "TPS - | AVG - | TTFT -";
        setText(line);
      });

      return jsx("text", {
        get children() {
          return text();
        },
        paddingRight: 1,
        fg: ctx.theme?.text?.subdued,
      });
    };

    // Slot spellings moved between V2 betas; the host renders only mounted
    // claims. Older betas expose ctx.ui.slot(name, render), newer ones take
    // a claim object.
    const offsSlots = [];
    const claim = (name, render) => {
      try {
        if ("renderer" in ctx) offsSlots.push(ctx.ui.slot({ append: name, render }));
        else offsSlots.push(ctx.ui.slot(name, render));
      } catch {
        // Slot not available on this build.
      }
    };
    claim("prompt.footer.status", Meter);
    claim("session_prompt_right", (props) =>
      jsx(Meter, {
        get sessionID() {
          return props.session_id;
        },
      }),
    );
    claim("session.header", Meter);

    return () => {
      for (const off of offs) off();
      for (const off of offsSlots) off();
    };
  },
};

export default plugin;
