#!/usr/bin/env node
/**
 * x-article-researcher
 *
 * X（旧 Twitter）の高エンゲージメント投稿を SocialData で収集し、
 * Claude（+ web_search）で「再現可能な型・アルゴリズム挙動・実装プラン・
 * 投稿アイデア・根拠ソース」までを含む日本語の戦略レポートを生成する。
 *
 * 使い方:
 *   SOCIALDATA_API_KEY=... ANTHROPIC_API_KEY=... \
 *     node index.js --theme "AI神プロンプト×ワーママ自己開示"
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
  maxPages: 5,
  output: "report.json",
  strategyOut: "strategy.md",
  analyzeTop: 40,
  maxSearches: 6,
  model: "claude-opus-4-7",
  maxTokens: 24000,
  effort: "high",
};

const HELP = `x-article-researcher — X の人気投稿を収集し、Claude で日本語の戦略レポートを生成。

使い方
  x-article-researcher --theme "<テーマ/文脈>" [オプション]

主要オプション
      --theme <text>      戦略の対象テーマ・文脈（推奨。例:
                          "Meru Phase1: AI神プロンプト×ワーママ自己開示"）
      --query <q>         SocialData 検索クエリ（複数指定可。未指定なら
                          --theme から検索。min_faves 等は自動付与）
      --articles          x.com/i/article（X長文記事）に限定する旧モード
      --min-likes <n>     最小いいね数 (既定: ${DEFAULTS.minLikes})
      --days <n>          遡る日数 (既定: ${DEFAULTS.days})
      --lang <ja|all>     言語フィルター (既定: ${DEFAULTS.lang})
      --max-pages <n>     クエリごとの最大ページ数 (既定: ${DEFAULTS.maxPages})

戦略生成オプション
      --no-strategy       収集のみ。Claude 戦略生成をスキップ
      --no-web            web_search による根拠ソース取得を無効化
      --analyze-top <n>   Claude に渡す上位件数 (既定: ${DEFAULTS.analyzeTop})
      --max-searches <n>  web_search の最大回数 (既定: ${DEFAULTS.maxSearches})
      --model <id>        Claude モデル ID (既定: ${DEFAULTS.model})
      --max-tokens <n>    最大出力トークン (既定: ${DEFAULTS.maxTokens})
      --effort <level>    low | medium | high | max (既定: ${DEFAULTS.effort})
      --no-thinking       adaptive thinking を無効化

出力
      --output <file>     収集データ JSON (既定: ${DEFAULTS.output})
      --strategy-out <f>  戦略レポート Markdown (既定: ${DEFAULTS.strategyOut})
  -h, --help              このヘルプを表示

環境変数
  SOCIALDATA_API_KEY      必須。SocialData API キー
  ANTHROPIC_API_KEY       戦略生成に必須（--no-strategy 時は不要）

例
  x-article-researcher --theme "AI神プロンプト×ワーママ" --min-likes 1500
  x-article-researcher --query "神プロンプト" --query "復職 時短" --days 21
`;

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      theme: { type: "string" },
      query: { type: "string", multiple: true },
      articles: { type: "boolean" },
      "min-likes": { type: "string" },
      days: { type: "string" },
      lang: { type: "string" },
      "max-pages": { type: "string" },
      "no-strategy": { type: "boolean" },
      "no-web": { type: "boolean" },
      "analyze-top": { type: "string" },
      "max-searches": { type: "string" },
      model: { type: "string" },
      "max-tokens": { type: "string" },
      effort: { type: "string" },
      "no-thinking": { type: "boolean" },
      output: { type: "string" },
      "strategy-out": { type: "string" },
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
    theme: (values.theme ?? "").trim(),
    queries: values.query ?? [],
    articles: values.articles ?? false,
    minLikes: toInt(values["min-likes"], DEFAULTS.minLikes, "--min-likes"),
    days: toInt(values.days, DEFAULTS.days, "--days"),
    lang,
    maxPages: toInt(values["max-pages"], DEFAULTS.maxPages, "--max-pages"),
    strategy: !(values["no-strategy"] ?? false),
    web: !(values["no-web"] ?? false),
    analyzeTop: toInt(values["analyze-top"], DEFAULTS.analyzeTop, "--analyze-top"),
    maxSearches: toInt(values["max-searches"], DEFAULTS.maxSearches, "--max-searches"),
    model: values.model ?? DEFAULTS.model,
    maxTokens: toInt(values["max-tokens"], DEFAULTS.maxTokens, "--max-tokens"),
    effort,
    thinking: !(values["no-thinking"] ?? false),
    output: values.output ?? DEFAULTS.output,
    strategyOut: values["strategy-out"] ?? DEFAULTS.strategyOut,
  };
}

const log = (s) => process.stderr.write(s);
const ymd = (date) => date.toISOString().slice(0, 10);

// Python 版と同一: ひらがな・カタカナ (U+3040–U+30FF) と漢字 (U+4E00–U+9FFF)
const JP_RE = /[぀-ヿ一-鿿]/;
const isJapanese = (text) => JP_RE.test(text || "");

/** 検索ベース語に min_faves / replies 除外 / 期間を付与してクエリ文字列化。 */
function buildQuery(base, opts, since, until) {
  return (
    `${base} min_faves:${opts.minLikes} -filter:replies ` +
    `since:${since} until:${until}`
  );
}

/** 単一クエリをページングしながら全件取得。 */
async function searchOnce(query, opts, apiKey) {
  log(`\nクエリ: ${query}\n`);
  const tweets = [];
  let cursor = null;
  let page = 0;

  while (true) {
    page += 1;
    const params = new URLSearchParams({ query, type: "Latest" });
    if (cursor) params.set("cursor", cursor);
    log(`  ページ ${page} 取得中...\n`);

    let res;
    try {
      res = await fetch(`${SEARCH_ENDPOINT}?${params}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch (err) {
      log(`  通信エラー: ${err.message ?? err}\n`);
      break;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log(`  API エラー ${res.status}: ${body}\n`);
      break;
    }

    const data = await res.json();
    const batch = Array.isArray(data.tweets) ? data.tweets : [];
    log(`    → ${batch.length}件取得\n`);
    if (batch.length === 0) break;

    tweets.push(...batch);
    cursor = data.next_cursor ?? null;
    if (!cursor || page >= opts.maxPages) break;
  }
  return tweets;
}

/** 複数クエリを実行し、日本語フィルタ・重複除去・いいね降順ソートまで。 */
async function collectTweets(opts, apiKey) {
  const since = ymd(new Date(Date.now() - opts.days * 86400000));
  const until = ymd(new Date());

  let bases;
  if (opts.articles) {
    bases = ["url:x.com/i/article"];
  } else if (opts.queries.length > 0) {
    bases = opts.queries;
  } else {
    bases = [opts.theme]; // テーマ語をそのまま検索語に
  }

  const all = [];
  for (const base of bases) {
    const q = buildQuery(base, opts, since, until);
    all.push(...(await searchOnce(q, opts, apiKey)));
  }
  log(`\n検索合計: ${all.length}件\n`);

  let filtered = all;
  if (opts.lang === "ja") {
    filtered = all.filter(
      (t) =>
        isJapanese(t.full_text) ||
        isJapanese(t.user?.description) ||
        isJapanese(t.user?.name),
    );
    log(`日本語フィルター後: ${filtered.length}件\n`);
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

const STRATEGY_SYSTEM = `あなたは X（旧 Twitter）のグロース戦略アナリストです。
与えられた「対象テーマ」と「収集投稿データ（SocialData 由来）」をもとに、
再現可能な日本語の戦略レポートを Markdown で作成します。

# 出力構成（この見出し構成に従う）
1. # テーマと調査範囲
2. # 調査上の制約（正直に明記）
   - SocialData は X の再構築データで、いいね数等は近似・遅延があり、
     検索網羅も X 内部検索とは異なる旨を必ず明記。
   - データに基づく「観測」と、一般原理からの「推論」を本文中で明確に区別。
3. # 主な発見
   - 土台（2026 年の X アルゴリズム挙動：初速・会話/リプライ・保存価値など、
     収集データで裏付く範囲とそうでない範囲を分けて）
   - テーマ別の勝ち型の要点
4. # 型の整理（表）
   - 5〜7 個。列: 型名 / 構造 / 具体例の方向性 / 伸びる理由 / 注意・炎上境界
5. # フェーズ別実装プラン
6. # 今月すぐ出せる投稿アイデア（10 案）＋ 必須チェックリスト
7. # 根拠ソース
   - 収集データの URL・著者・指標、および web_search で確認した一次情報を列挙。

# 厳守ルール
- 数値・引用・URL・投稿者名を捏造しない。収集データに無い指標は書かない。
- 収集データが薄い/空でも、一般的なアルゴリズム原理で戦略は作る。ただし
  「これは収集データの裏付けがなく原理からの推論」と明示する。
- web_search は事実確認と根拠ソース収集にのみ使う。検索結果も捏造しない。
- 出力は Markdown 本文のみ。前置きや作業説明は書かない。`;

function buildStrategyInput(theme, report, top) {
  const items = report.slice(0, top).map((r, i) => ({
    rank: i + 1,
    title: r.title,
    text: (r.text || "").slice(0, 600),
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
    `対象テーマ / 文脈:\n${theme || "(未指定)"}\n\n` +
    `収集投稿データ（SocialData 由来。いいね降順、上位${items.length}件。` +
    `件数が少ない/空の場合はその制約も踏まえて戦略を作成すること）:\n\n` +
    "```json\n" +
    JSON.stringify(items, null, 2) +
    "\n```\n\n" +
    `上記と必要に応じた web_search をもとに、指定の構成で日本語の戦略` +
    `レポートを作成してください。`
  );
}

/** web_search_tool_result から {url,title} を重複なく収集。 */
function collectSources(messages) {
  const byUrl = new Map();
  for (const msg of messages) {
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const block of content) {
      if (block?.type !== "web_search_tool_result") continue;
      const results = block.content;
      if (!Array.isArray(results)) continue;
      for (const r of results) {
        if (r?.type === "web_search_result" && r.url && !byUrl.has(r.url)) {
          byUrl.set(r.url, { url: r.url, title: r.title || r.url });
        }
      }
    }
  }
  return [...byUrl.values()];
}

async function generateStrategy(theme, report, opts) {
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
  const tools = opts.web
    ? [{ type: "web_search_20260209", name: "web_search", max_uses: opts.maxSearches }]
    : [];

  const base = {
    model: opts.model,
    max_tokens: opts.maxTokens,
    system: [
      { type: "text", text: STRATEGY_SYSTEM, cache_control: { type: "ephemeral" } },
    ],
    thinking,
    output_config: { effort: opts.effort },
    ...(tools.length ? { tools } : {}),
  };

  let messages = [
    { role: "user", content: buildStrategyInput(theme, report, opts.analyzeTop) },
  ];
  const transcript = [];

  log(
    `\nClaude で戦略生成中（対象${Math.min(opts.analyzeTop, report.length)}件` +
      `${opts.web ? " / web_search 有効" : ""}）...\n`,
  );

  try {
    for (let turn = 0; turn <= 6; turn++) {
      const stream = client.messages.stream({ ...base, messages });
      for await (const event of stream) {
        if (event.type === "content_block_start") {
          const b = event.content_block;
          if (b?.type === "server_tool_use" && b?.name === "web_search") {
            log("\n  web 検索…");
          } else if (b?.type === "web_search_tool_result") {
            const n = Array.isArray(b.content) ? b.content.length : 0;
            log(n ? ` ${n}件\n` : " (0件)\n");
          } else if (b?.type === "thinking" && opts.thinking) {
            log("\n[思考] ");
          }
        } else if (event.type === "content_block_delta") {
          const d = event.delta;
          if (d?.type === "thinking_delta" && opts.thinking) log(d.thinking);
          else if (d?.type === "text_delta") log(".");
        }
      }

      const msg = await stream.finalMessage();
      transcript.push({ role: "assistant", content: msg.content });

      if (msg.stop_reason === "pause_turn") {
        messages = [...messages, { role: "assistant", content: msg.content }];
        log("\n  …戦略生成を継続\n");
        continue;
      }
      if (msg.stop_reason === "refusal") {
        log(
          "\nClaude が生成を拒否しました" +
            (msg.stop_details?.explanation
              ? `: ${msg.stop_details.explanation}\n`
              : "。\n"),
        );
        return null;
      }
      if (msg.stop_reason === "max_tokens") {
        log("\n警告: max_tokens に達しました。--max-tokens を増やして再実行してください。\n");
      }

      const text = transcript
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .filter((b) => b?.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();

      const sources = collectSources(transcript);
      let out = text;
      if (sources.length) {
        const list = sources
          .map((s, i) => `${i + 1}. [${s.title}](${s.url})`)
          .join("\n");
        out += `\n\n## web_search で確認したソース\n\n${list}\n`;
      }

      const u = msg.usage ?? {};
      log(
        `\nClaude 完了。トークン in/out: ${u.input_tokens ?? "?"}/${u.output_tokens ?? "?"}` +
          `, web 検索: ${u.server_tool_use?.web_search_requests ?? 0}\n`,
      );
      return out || null;
    }
    log("\n継続上限に達しました。--max-tokens 等を見直して再実行してください。\n");
    return null;
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

  if (!opts.theme && opts.queries.length === 0 && !opts.articles) {
    process.stderr.write(
      "エラー: --theme か --query を指定してください（--articles も可）。\n\n" + HELP,
    );
    process.exit(2);
  }
  if (!process.env.SOCIALDATA_API_KEY) {
    process.stderr.write("エラー: 環境変数 SOCIALDATA_API_KEY が未設定です。\n");
    process.exit(2);
  }
  if (opts.strategy && !process.env.ANTHROPIC_API_KEY) {
    process.stderr.write(
      "エラー: 環境変数 ANTHROPIC_API_KEY が未設定です" +
        "（戦略生成が不要なら --no-strategy）。\n",
    );
    process.exit(2);
  }

  const deduped = await collectTweets(opts, process.env.SOCIALDATA_API_KEY);
  const report = mapReport(deduped);
  await writeFile(opts.output, JSON.stringify(report, null, 2) + "\n", "utf-8");
  log(`\n収集データ保存: ${opts.output} (${report.length}件)\n`);

  if (opts.strategy) {
    if (report.length === 0) {
      log(
        "\n注意: 収集件数が 0 です。収集データの裏付けなしの「原理ベース戦略」" +
          "として生成します（レポート内に明記されます）。\n",
      );
    }
    const strategy = await generateStrategy(opts.theme, report, opts);
    if (strategy) {
      await writeFile(
        opts.strategyOut,
        strategy.endsWith("\n") ? strategy : strategy + "\n",
        "utf-8",
      );
      log(`戦略レポート保存: ${opts.strategyOut}\n`);
      process.stdout.write(
        `収集 ${report.length}件 / 戦略レポート: ${opts.strategyOut}\n`,
      );
    } else {
      process.stdout.write(
        `収集 ${report.length}件 / 戦略生成は失敗（上のログ参照）\n`,
      );
    }
  } else {
    process.stdout.write(`収集 ${report.length}件 / ${opts.output}\n`);
  }
}

main();
