#!/usr/bin/env node
/**
 * x-article-researcher
 *
 * SocialData API を使って X（旧 Twitter）の長文記事（x.com/i/article）の
 * うち、エンゲージメントの高い日本語投稿を収集し、JSON レポートに保存。
 * さらに Claude で日本語のトレンド分析・要約レポートを生成する。
 *
 * 使い方:
 *   SOCIALDATA_API_KEY=... ANTHROPIC_API_KEY=... node index.js
 *   node index.js --min-likes 2000 --days 14 --analyze-top 20
 *
 * 全オプションは `node index.js --help` を参照。
 */

import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import process from "node:process";

const SEARCH_ENDPOINT = "https://api.socialdata.tools/twitter/search";

const DEFAULTS = {
  minLikes: 1000,
  days: 30,
  lang: "ja",
  maxPages: 20,
  output: "report.json",
  report: "report.md",
  analyzeTop: 30,
  model: "claude-opus-4-7",
  maxTokens: 16000,
  effort: "high",
};

const HELP = `x-article-researcher — X の人気長文記事を収集し、Claude で日本語分析レポートを生成。

使い方
  x-article-researcher [オプション]

オプション
      --min-likes <n>     最小いいね数 (既定: ${DEFAULTS.minLikes})
      --days <n>          遡る日数 (既定: ${DEFAULTS.days})
      --lang <ja|all>     言語フィルター (既定: ${DEFAULTS.lang})
      --max-pages <n>     取得する最大ページ数 (既定: ${DEFAULTS.maxPages})
      --output <file>     収集データの保存先 JSON (既定: ${DEFAULTS.output})
      --report <file>     Claude 分析レポートの保存先 MD (既定: ${DEFAULTS.report})
      --analyze-top <n>   Claude に渡す上位件数 (既定: ${DEFAULTS.analyzeTop})
      --no-analyze        収集のみ。Claude 分析をスキップ
      --model <id>        Claude モデル ID (既定: ${DEFAULTS.model})
      --max-tokens <n>    最大出力トークン (既定: ${DEFAULTS.maxTokens})
      --effort <level>    low | medium | high | max (既定: ${DEFAULTS.effort})
      --no-thinking       adaptive thinking を無効化
  -h, --help              このヘルプを表示

環境変数
  SOCIALDATA_API_KEY      必須。SocialData API キー
  ANTHROPIC_API_KEY       Claude 分析を行う場合は必須（--no-analyze 時は不要）

例
  x-article-researcher --min-likes 2000 --days 14
  x-article-researcher --lang all --no-analyze --output tweets.json
`;

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      "min-likes": { type: "string" },
      days: { type: "string" },
      lang: { type: "string" },
      "max-pages": { type: "string" },
      output: { type: "string" },
      report: { type: "string" },
      "analyze-top": { type: "string" },
      "no-analyze": { type: "boolean" },
      model: { type: "string" },
      "max-tokens": { type: "string" },
      effort: { type: "string" },
      "no-thinking": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  const toInt = (raw, fallback, label) => {
    if (raw === undefined) return fallback;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`${label} の値が不正です: "${raw}"（正の整数を指定してください）`);
    }
    return n;
  };

  const lang = values.lang ?? DEFAULTS.lang;
  if (!["ja", "all"].includes(lang)) {
    throw new Error(`--lang が不正です: "${lang}"（ja | all）`);
  }

  const effort = values.effort ?? DEFAULTS.effort;
  if (!["low", "medium", "high", "max"].includes(effort)) {
    throw new Error(`--effort が不正です: "${effort}"（low | medium | high | max）`);
  }

  return {
    help: values.help ?? false,
    minLikes: toInt(values["min-likes"], DEFAULTS.minLikes, "--min-likes"),
    days: toInt(values.days, DEFAULTS.days, "--days"),
    lang,
    maxPages: toInt(values["max-pages"], DEFAULTS.maxPages, "--max-pages"),
    output: values.output ?? DEFAULTS.output,
    report: values.report ?? DEFAULTS.report,
    analyzeTop: toInt(values["analyze-top"], DEFAULTS.analyzeTop, "--analyze-top"),
    analyze: !(values["no-analyze"] ?? false),
    model: values.model ?? DEFAULTS.model,
    maxTokens: toInt(values["max-tokens"], DEFAULTS.maxTokens, "--max-tokens"),
    effort,
    thinking: !(values["no-thinking"] ?? false),
  };
}

const log = (s) => process.stderr.write(s);

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

// Python 版と同一: ひらがな・カタカナ (U+3040–U+30FF) と漢字 (U+4E00–U+9FFF)
const JP_RE = /[぀-ヿ一-鿿]/;
const isJapanese = (text) => JP_RE.test(text || "");

async function searchArticles(opts, apiKey) {
  const since = ymd(new Date(Date.now() - opts.days * 86400000));
  const until = ymd(new Date());
  const query =
    `url:x.com/i/article min_faves:${opts.minLikes} -filter:replies ` +
    `since:${since} until:${until}`;

  log(`クエリ: ${query}\n`);

  const allTweets = [];
  let cursor = null;
  let page = 0;

  while (true) {
    page += 1;
    const params = new URLSearchParams({ query, type: "Latest" });
    if (cursor) params.set("cursor", cursor);

    log(`ページ ${page} 取得中...\n`);

    let res;
    try {
      res = await fetch(`${SEARCH_ENDPOINT}?${params}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch (err) {
      log(`通信エラー: ${err.message ?? err}\n`);
      break;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log(`API エラー ${res.status}: ${body}\n`);
      break;
    }

    const data = await res.json();
    const tweets = Array.isArray(data.tweets) ? data.tweets : [];
    log(`  → ${tweets.length}件取得\n`);

    if (tweets.length === 0) break;

    allTweets.push(...tweets);
    cursor = data.next_cursor ?? null;
    if (!cursor || page >= opts.maxPages) break;
  }

  log(`\n検索合計: ${allTweets.length}件\n`);

  let filtered;
  if (opts.lang === "ja") {
    filtered = allTweets.filter(
      (t) =>
        isJapanese(t.full_text) ||
        isJapanese(t.user?.description) ||
        isJapanese(t.user?.name),
    );
    log(`日本語フィルター後: ${filtered.length}件\n`);
  } else {
    filtered = allTweets;
  }

  const seen = new Map();
  for (const t of filtered) {
    const key = `${t.user?.screen_name}_${(t.full_text || "").slice(0, 50)}`;
    const prev = seen.get(key);
    if (!prev || (prev.favorite_count ?? 0) < (t.favorite_count ?? 0)) {
      seen.set(key, t);
    }
  }

  const deduped = [...seen.values()].sort(
    (a, b) => (b.favorite_count ?? 0) - (a.favorite_count ?? 0),
  );
  log(`重複除去後: ${deduped.length}件\n`);

  return deduped;
}

function mapReport(tweets) {
  return tweets.map((t) => ({
    title: t.article?.title ?? "",
    text: t.full_text ?? "",
    url: `https://x.com/i/web/status/${t.id_str ?? ""}`,
    author: t.user?.name ?? "",
    username: t.user?.screen_name ?? "",
    followers: t.user?.followers_count ?? 0,
    likes: t.favorite_count ?? 0,
    retweets: t.retweet_count ?? 0,
    bookmarks: t.bookmark_count ?? 0,
    views: t.views_count ?? 0,
    date: t.created_at ?? "",
  }));
}

const ANALYSIS_SYSTEM = `あなたは日本語で書く編集アナリストです。X（旧 Twitter）で
話題になった長文記事の投稿データ（タイトル、本文抜粋、エンゲージメント指標、
投稿者）が与えられます。これをもとに、簡潔で実用的な日本語レポートを
Markdown で作成してください。

構成:
1. # トレンド分析 — 人気テーマ、記事間の共通点、注目すべき投稿者、
   エンゲージメント（いいね/RT/ブックマーク/閲覧）の傾向を概観。
2. # 注目記事 — 上位記事を1件ずつ、タイトル・要点（2〜4文の日本語要約）・
   主要指標・リンクで簡潔にまとめる。

ルール:
- 与えられたデータに基づくこと。推測は「推測」と明示する。
- 数値や投稿者名、URL を捏造しない。データにない情報は補わない。
- レポート本文（Markdown）のみを出力し、前置きや作業説明は書かない。`;

function buildAnalysisInput(report, top) {
  const items = report.slice(0, top).map((r, i) => ({
    rank: i + 1,
    title: r.title,
    text: (r.text || "").slice(0, 800),
    author: r.author,
    username: r.username,
    followers: r.followers,
    likes: r.likes,
    retweets: r.retweets,
    bookmarks: r.bookmarks,
    views: r.views,
    url: r.url,
    date: r.date,
  }));
  return (
    `以下は X で収集した人気長文記事の投稿データ（いいね数の多い順、` +
    `上位${items.length}件）です。これを分析し、日本語レポートを作成してください。\n\n` +
    "```json\n" +
    JSON.stringify(items, null, 2) +
    "\n```"
  );
}

async function analyzeWithClaude(report, opts) {
  let Anthropic;
  try {
    ({ default: Anthropic } = await import("@anthropic-ai/sdk"));
  } catch {
    log("エラー: 依存関係が未インストールです。`npm install` を実行してください。\n");
    process.exit(2);
  }

  const client = new Anthropic();
  const thinking = opts.thinking
    ? { type: "adaptive", display: "summarized" }
    : { type: "disabled" };

  log(`\nClaude で分析中（上位${Math.min(opts.analyzeTop, report.length)}件）...\n`);

  let stream;
  try {
    stream = client.messages.stream({
      model: opts.model,
      max_tokens: opts.maxTokens,
      system: [
        {
          type: "text",
          text: ANALYSIS_SYSTEM,
          cache_control: { type: "ephemeral" },
        },
      ],
      thinking,
      output_config: { effort: opts.effort },
      messages: [
        { role: "user", content: buildAnalysisInput(report, opts.analyzeTop) },
      ],
    });

    let inThinking = false;
    for await (const event of stream) {
      if (event.type === "content_block_start") {
        const b = event.content_block;
        if (b?.type === "thinking" && opts.thinking) {
          if (!inThinking) log("\n[思考] ");
          inThinking = true;
        } else if (b?.type === "text") {
          inThinking = false;
        }
      } else if (event.type === "content_block_delta") {
        const d = event.delta;
        if (d?.type === "thinking_delta" && opts.thinking) {
          log(d.thinking);
        } else if (d?.type === "text_delta") {
          log(".");
        }
      }
    }

    const msg = await stream.finalMessage();
    if (msg.stop_reason === "refusal") {
      log(
        "\nClaude が分析を拒否しました" +
          (msg.stop_details?.explanation
            ? `: ${msg.stop_details.explanation}\n`
            : "。\n"),
      );
      return null;
    }
    if (msg.stop_reason === "max_tokens") {
      log("\n警告: max_tokens に達しました。--max-tokens を増やして再実行してください。\n");
    }

    const text = (msg.content ?? [])
      .filter((b) => b?.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    const u = msg.usage ?? {};
    log(
      `\nClaude 完了。トークン in/out: ${u.input_tokens ?? "?"}/${u.output_tokens ?? "?"}\n`,
    );
    return text || null;
  } catch (err) {
    log("\n");
    if (err instanceof Anthropic.AuthenticationError) {
      log("エラー: ANTHROPIC_API_KEY が無効です。\n");
    } else if (err instanceof Anthropic.RateLimitError) {
      log("エラー: API のレート制限に達しました。時間をおいて再実行してください。\n");
    } else if (err instanceof Anthropic.APIError) {
      log(`API エラー (${err.status ?? "?"}): ${err.message}\n`);
    } else {
      log(`エラー: ${err.message ?? err}\n`);
    }
    return null;
  }
}

async function main() {
  let opts;
  try {
    opts = parseCli(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`エラー: ${err.message}\n\n${HELP}`);
    process.exit(2);
  }

  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  const socialKey = process.env.SOCIALDATA_API_KEY;
  if (!socialKey) {
    process.stderr.write(
      "エラー: 環境変数 SOCIALDATA_API_KEY が未設定です。\n",
    );
    process.exit(2);
  }
  if (opts.analyze && !process.env.ANTHROPIC_API_KEY) {
    process.stderr.write(
      "エラー: 環境変数 ANTHROPIC_API_KEY が未設定です" +
        "（Claude 分析が不要なら --no-analyze を指定）。\n",
    );
    process.exit(2);
  }

  const deduped = await searchArticles(opts, socialKey);
  const report = mapReport(deduped);

  await writeFile(opts.output, JSON.stringify(report, null, 2) + "\n", "utf-8");
  log(`\nレポート保存: ${opts.output} (${report.length}件)\n`);

  if (opts.analyze && report.length > 0) {
    const analysis = await analyzeWithClaude(report, opts);
    if (analysis) {
      await writeFile(
        opts.report,
        analysis.endsWith("\n") ? analysis : analysis + "\n",
        "utf-8",
      );
      log(`分析レポート保存: ${opts.report}\n`);
    }
  } else if (opts.analyze) {
    log("\n収集件数が 0 のため、Claude 分析はスキップしました。\n");
  }

  const top = report.slice(0, 5);
  let out = "\n=== 上位5件 ===\n";
  top.forEach((r, i) => {
    out += `\n#${i + 1} いいね${(r.likes ?? 0).toLocaleString("ja-JP")} @${r.username}\n`;
    out += `  ${(r.text || "").slice(0, 100)}...\n`;
  });
  process.stdout.write(out);
}

main();
