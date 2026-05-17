#!/usr/bin/env node
/**
 * x-article-researcher
 *
 * Give it a topic; it researches the topic with Claude's live web search
 * tool and produces a finished, cited article.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... node index.js "your topic here"
 *   node index.js --topic "your topic" --length long --output article.md
 *
 * Run `node index.js --help` for all options.
 */

import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import process from "node:process";

const DEFAULTS = {
  model: "claude-opus-4-7",
  maxTokens: 32000,
  effort: "high",
  maxSearches: 8,
  maxContinuations: 6,
  length: "medium",
};

const HELP = `x-article-researcher — research a topic with Claude + web search, output a cited article.

USAGE
  x-article-researcher <topic> [options]
  x-article-researcher --topic "<topic>" [options]

OPTIONS
  -t, --topic <text>        Topic to research (or pass as a positional argument).
  -o, --output <file>       Write the article to <file> instead of stdout.
      --length <size>       short | medium | long, or a word count like "1200".
                            (default: ${DEFAULTS.length})
      --audience <text>     Who the article is for, e.g. "software engineers".
      --tone <text>         Desired tone, e.g. "neutral and analytical".
      --model <id>          Claude model ID (default: ${DEFAULTS.model}).
      --max-tokens <n>      Max output tokens (default: ${DEFAULTS.maxTokens}).
      --effort <level>      low | medium | high | max (default: ${DEFAULTS.effort}).
      --max-searches <n>    Cap on web searches (default: ${DEFAULTS.maxSearches}).
      --max-continuations <n>
                            Cap on server tool-loop continuations
                            (default: ${DEFAULTS.maxContinuations}).
      --no-thinking         Disable adaptive thinking.
  -h, --help                Show this help.

ENVIRONMENT
  ANTHROPIC_API_KEY         Required. Your Anthropic API key.

EXAMPLES
  x-article-researcher "the state of solid-state batteries in 2026"
  x-article-researcher -t "RISC-V adoption" --length long -o riscv.md
  x-article-researcher "EU AI Act enforcement" --audience "policy analysts"
`;

function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      topic: { type: "string", short: "t" },
      output: { type: "string", short: "o" },
      length: { type: "string" },
      audience: { type: "string" },
      tone: { type: "string" },
      model: { type: "string" },
      "max-tokens": { type: "string" },
      effort: { type: "string" },
      "max-searches": { type: "string" },
      "max-continuations": { type: "string" },
      "no-thinking": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  const topic = (values.topic ?? positionals.join(" ")).trim();

  const toInt = (raw, fallback, label) => {
    if (raw === undefined) return fallback;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`Invalid value for ${label}: "${raw}" (expected a positive integer)`);
    }
    return n;
  };

  const effort = values.effort ?? DEFAULTS.effort;
  if (!["low", "medium", "high", "max"].includes(effort)) {
    throw new Error(`Invalid --effort: "${effort}" (expected low | medium | high | max)`);
  }

  return {
    help: values.help ?? false,
    topic,
    output: values.output,
    length: values.length ?? DEFAULTS.length,
    audience: values.audience,
    tone: values.tone,
    model: values.model ?? DEFAULTS.model,
    maxTokens: toInt(values["max-tokens"], DEFAULTS.maxTokens, "--max-tokens"),
    effort,
    maxSearches: toInt(values["max-searches"], DEFAULTS.maxSearches, "--max-searches"),
    maxContinuations: toInt(
      values["max-continuations"],
      DEFAULTS.maxContinuations,
      "--max-continuations",
    ),
    thinking: !(values["no-thinking"] ?? false),
  };
}

const SYSTEM_PROMPT = `You are a meticulous research writer. Given a topic, you use the
web_search tool to gather current, reliable information from primary and
reputable secondary sources, then write a single finished article.

Research rules:
- Search before you assert. Prefer recent, authoritative sources; cross-check
  surprising or contested claims against more than one source.
- Distinguish established facts from speculation, and note disagreement
  between sources where it exists.
- Never invent facts, quotes, statistics, or URLs.

Output rules:
- Respond with ONLY the article itself, in Markdown. No preamble, no
  meta-commentary, no description of your research process in the response
  text (do that thinking internally).
- Open with an H1 title, then a short standfirst/lede, then well-structured
  sections with H2/H3 headings as appropriate.
- Attribute specific claims inline by naming the source/publication in prose
  (e.g. "according to Reuters" or "a 2026 IEA report found"). Do NOT write a
  numbered "References" or "Sources" list yourself — a verified Sources
  section is appended automatically from the pages you actually searched.
- Be accurate and concrete over comprehensive. Aim for the requested length.`;

function buildUserPrompt(opts) {
  const lines = [`Research and write an article on the following topic:`, ``, opts.topic, ``];

  const lengthGuide = {
    short: "Length: concise — roughly 500–800 words.",
    medium: "Length: standard — roughly 1000–1500 words.",
    long: "Length: in-depth — roughly 2000–3000 words.",
  };
  if (lengthGuide[opts.length]) {
    lines.push(lengthGuide[opts.length]);
  } else {
    lines.push(`Length: approximately ${opts.length} words.`);
  }

  if (opts.audience) lines.push(`Audience: ${opts.audience}.`);
  if (opts.tone) lines.push(`Tone: ${opts.tone}.`);

  lines.push(
    ``,
    `Use web search to ground the article in current information before writing.`,
  );
  return lines.join("\n");
}

/** Pull a deduped {url, title} list out of web_search_tool_result blocks. */
function collectSources(messages) {
  const byUrl = new Map();
  for (const msg of messages) {
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const block of content) {
      if (block?.type !== "web_search_tool_result") continue;
      const results = block.content;
      if (!Array.isArray(results)) continue; // error result -> object, skip
      for (const r of results) {
        if (r?.type === "web_search_result" && r.url && !byUrl.has(r.url)) {
          byUrl.set(r.url, { url: r.url, title: r.title || r.url });
        }
      }
    }
  }
  return [...byUrl.values()];
}

function articleText(messages) {
  const parts = [];
  for (const msg of messages) {
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const block of content) {
      if (block?.type === "text" && block.text) parts.push(block.text);
    }
  }
  return parts.join("").trim();
}

async function main() {
  let opts;
  try {
    opts = parseCli(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n\n${HELP}`);
    process.exit(2);
  }

  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!opts.topic) {
    process.stderr.write(`Error: no topic provided.\n\n${HELP}`);
    process.exit(2);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    process.stderr.write(
      "Error: ANTHROPIC_API_KEY is not set. Export it and try again.\n",
    );
    process.exit(2);
  }

  let Anthropic;
  try {
    ({ default: Anthropic } = await import("@anthropic-ai/sdk"));
  } catch {
    process.stderr.write(
      "Error: dependencies are not installed. Run `npm install` first.\n",
    );
    process.exit(2);
  }

  const client = new Anthropic();

  // Article goes to stdout only when not writing a file; otherwise stdout
  // stays clean and progress/preview goes to stderr.
  const toFile = Boolean(opts.output);
  const articleStream = toFile ? process.stderr : process.stdout;
  const progress = (s) => process.stderr.write(s);

  const tools = [
    {
      type: "web_search_20260209",
      name: "web_search",
      max_uses: opts.maxSearches,
    },
  ];

  const thinking = opts.thinking
    ? { type: "adaptive", display: "summarized" }
    : { type: "disabled" };

  const requestBase = {
    model: opts.model,
    max_tokens: opts.maxTokens,
    system: [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ],
    thinking,
    output_config: { effort: opts.effort },
    tools,
  };

  let messages = [{ role: "user", content: buildUserPrompt(opts) }];
  const transcript = [];
  let finalMessage = null;

  progress(`Researching: ${opts.topic}\n`);

  try {
    for (let turn = 0; turn <= opts.maxContinuations; turn++) {
      const stream = client.messages.stream({ ...requestBase, messages });

      let inThinking = false;
      for await (const event of stream) {
        if (event.type === "content_block_start") {
          const b = event.content_block;
          if (b?.type === "server_tool_use" && b?.name === "web_search") {
            progress("\n  web search…");
          } else if (b?.type === "web_search_tool_result") {
            const n = Array.isArray(b.content) ? b.content.length : 0;
            progress(n ? ` ${n} results\n` : " (no results)\n");
          } else if (b?.type === "thinking" && opts.thinking) {
            if (!inThinking) progress("\n[thinking] ");
            inThinking = true;
          } else if (b?.type === "text") {
            inThinking = false;
            if (toFile) progress("\n[draft]\n");
          }
        } else if (event.type === "content_block_delta") {
          const d = event.delta;
          if (d?.type === "text_delta") {
            articleStream.write(d.text);
          } else if (d?.type === "thinking_delta" && opts.thinking) {
            progress(d.thinking);
          }
        }
      }

      const msg = await stream.finalMessage();
      transcript.push({ role: "assistant", content: msg.content });

      if (msg.stop_reason === "pause_turn") {
        // Server-side tool loop hit its iteration cap — resume it.
        messages = [...messages, { role: "assistant", content: msg.content }];
        progress("\n  …continuing research\n");
        continue;
      }

      finalMessage = msg;
      if (msg.stop_reason === "refusal") {
        progress("\n");
        process.stderr.write(
          "The model declined to produce this article" +
            (msg.stop_details?.explanation
              ? `: ${msg.stop_details.explanation}\n`
              : ".\n"),
        );
        process.exit(1);
      }
      if (msg.stop_reason === "max_tokens") {
        progress(
          "\nWarning: hit max_tokens — the article may be truncated. " +
            "Re-run with a larger --max-tokens.\n",
        );
      }
      break;
    }
  } catch (err) {
    progress("\n");
    if (err instanceof Anthropic.AuthenticationError) {
      process.stderr.write("Error: invalid ANTHROPIC_API_KEY.\n");
    } else if (err instanceof Anthropic.RateLimitError) {
      process.stderr.write("Error: rate limited by the API. Try again later.\n");
    } else if (err instanceof Anthropic.APIError) {
      process.stderr.write(`API error (${err.status ?? "?"}): ${err.message}\n`);
    } else {
      process.stderr.write(`Error: ${err.message ?? err}\n`);
    }
    process.exit(1);
  }

  if (!finalMessage) {
    process.stderr.write(
      "\nError: research did not finish within --max-continuations. " +
        "Increase it and retry.\n",
    );
    process.exit(1);
  }

  let article = articleText(transcript);
  if (!article) {
    process.stderr.write("\nError: the model returned no article text.\n");
    process.exit(1);
  }

  const sources = collectSources(transcript);
  if (sources.length) {
    const list = sources
      .map((s, i) => `${i + 1}. [${s.title}](${s.url})`)
      .join("\n");
    article += `\n\n## Sources\n\n${list}\n`;
  }

  if (toFile) {
    await writeFile(opts.output, article.endsWith("\n") ? article : article + "\n");
    progress(`\n\nSaved article to ${opts.output}\n`);
  } else {
    if (!article.endsWith("\n")) process.stdout.write("\n");
  }

  const u = finalMessage.usage ?? {};
  progress(
    `\nDone. tokens in/out: ${u.input_tokens ?? "?"}/${u.output_tokens ?? "?"}` +
      `, web searches: ${u.server_tool_use?.web_search_requests ?? 0}` +
      `, sources: ${sources.length}\n`,
  );
}

main();
