/**
 * **lean 模式的多源交叉核对 + 实时新闻检索**(全部由程序完成,核对本身不耗 token)。
 *
 * 1. 交叉核对:把 fetch/ 里不同数据源的同口径数字(价格 / 市值 / PE / 营收 / 归母净利,按报告期)
 *    归一单位后两两比较,超过阈值记为"偏差",写进 RUN/xcheck.json 与 RUN/xcheck.md,并放进模型摘要;
 *    美股额外拉 SEC EDGAR companyfacts(官方 10-K/10-Q,免费无 key)与 Stooq 收盘价作独立第二来源。
 * 2. 新闻:每只股票只调用一次模型的联网检索(web_search_options),只要新闻 / 公告 / 近期事件,
 *    结果带来源网址写进 RUN/news_web.json;报告里只能当"未核实线索"引用。财报与行情仍由程序取。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface XRow { key: string; period: string; source: string; value: number; unit: string; currency: string; ref: string; raw?: number; rawUnit?: string }
export interface XCheck { key: string; period: string; rows: XRow[]; max_rel_diff: number; threshold: number; verdict: "一致" | "偏差超阈值" | "单一来源" }

const GROUPS: Record<string, { fields: string[]; tol: number }> = {
  price: { fields: ["price"], tol: 0.01 },
  market_cap: { fields: ["total_market_cap", "market_cap"], tol: 0.03 },
  pe_ttm: { fields: ["pe_ttm", "pe_ttm_latest"], tol: 0.08 },
  revenue: { fields: ["revenue", "revenue_total", "total_revenue", "operating_revenue"], tol: 0.02 },
  net_profit_parent: { fields: ["net_profit_parent", "net_profit", "net_income"], tol: 0.03 },
  revenue_cum: { fields: ["revenue_cum"], tol: 0.02 },
  net_profit_parent_cum: { fields: ["net_profit_parent_cum"], tol: 0.02 },
  total_assets: { fields: ["total_assets"], tol: 0.01 },
  operating_profit: { fields: ["operating_profit"], tol: 0.03 },
};
const KEY_LABEL: Record<string, string> = { price: "股价", market_cap: "总市值", pe_ttm: "PE(TTM)", revenue: "营收(年度/报告期)", net_profit_parent: "归母净利",
  revenue_cum: "营收累计(YTD)", net_profit_parent_cum: "归母净利累计(YTD)", total_assets: "总资产", operating_profit: "经营利润" };

function currencyOf(unit: string, cur?: string): string {
  if (cur) return cur.toUpperCase();
  if (/港/.test(unit)) return "HKD";
  if (/美元|USD/i.test(unit)) return "USD";
  if (/人民币|元/.test(unit)) return "CNY";
  return unit.replace(/[亿万千百]/g, "") || "?";
}
function scaleOf(unit: string): number {
  if (/万亿/.test(unit)) return 1e12;
  if (/亿/.test(unit)) return 1e8;
  if (/万/.test(unit)) return 1e4;
  if (/billion|\bB\b/i.test(unit)) return 1e9;
  if (/million|\bM\b/i.test(unit)) return 1e6;
  return 1;
}

function readJson(p: string): any { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }

export function collectRows(runDir: string): XRow[] {
  const dir = path.join(runDir, "fetch");
  const rows: XRow[] = [];
  if (!fs.existsSync(dir)) return rows;
  const fieldToKey = new Map<string, string>();
  for (const [k, g] of Object.entries(GROUPS)) for (const f of g.fields) fieldToKey.set(f, k);
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json") || f.startsWith("_")) continue;
    const d = readJson(path.join(dir, f));
    for (const e of d?.evidence ?? []) {
      const key = fieldToKey.get(e.field);
      if (!key || typeof e.value !== "number" || !Number.isFinite(e.value)) continue;
      const unit = String(e.unit ?? "");
      const isMoney = key !== "pe_ttm" && key !== "price";
      const value = isMoney ? e.value * scaleOf(unit) : e.value;
      const period = key === "price" || key === "market_cap" || key === "pe_ttm" ? "最新" : String(e.period ?? "");
      rows.push({ key, period, source: String(e.source ?? "?"), value, unit: isMoney ? "元(归一)" : unit, currency: key === "pe_ttm" ? "倍" : currencyOf(unit, e.currency), ref: e.id, raw: e.value, rawUnit: unit });
    }
  }
  const ext = readJson(path.join(runDir, "xcheck_external.json"));
  for (const r of ext?.rows ?? []) rows.push(r);
  return rows;
}

export function crossCheck(rows: XRow[]): XCheck[] {
  const by = new Map<string, XRow[]>();
  for (const r of rows) {
    const k = `${r.key}|${r.period}|${r.currency}`;
    (by.get(k) ?? by.set(k, []).get(k)!).push(r);
  }
  const out: XCheck[] = [];
  for (const [k, rs] of by) {
    const [key, period] = k.split("|");
    // 同一来源同一口径只留一条(取第一条),避免自己跟自己比
    const uniq: XRow[] = [];
    for (const r of rs) if (!uniq.some((u) => u.source === r.source)) uniq.push(r);
    const tol = GROUPS[key]?.tol ?? 0.03;
    if (uniq.length < 2) continue;
    const vals = uniq.map((r) => r.value);
    const mx = Math.max(...vals), mn = Math.min(...vals);
    const base = Math.max(Math.abs(mx), Math.abs(mn)) || 1;
    const rel = (mx - mn) / base;
    out.push({ key, period, rows: uniq, max_rel_diff: +rel.toFixed(4), threshold: tol, verdict: rel > tol ? "偏差超阈值" : "一致" });
  }
  out.sort((a, b) => (a.verdict === b.verdict ? 0 : a.verdict === "偏差超阈值" ? -1 : 1) || a.key.localeCompare(b.key) || b.period.localeCompare(a.period));
  return out;
}

/** 摘要里给模型看的紧凑表;最多 40 组,偏差优先 */
export function xcheckDigest(checks: XCheck[]): string {
  if (!checks.length) return "## 多源交叉核对(程序完成)\n本次取数没有可对照的同口径多源数字。\n";
  const lines = checks.slice(0, 40).map((c) => `${KEY_LABEL[c.key] ?? c.key}|${c.period}|${c.verdict}|差异 ${(c.max_rel_diff * 100).toFixed(2)}% (阈值 ${(c.threshold * 100).toFixed(0)}%)|` +
    c.rows.map((r) => `${r.source}:${r.raw ?? r.value}${r.rawUnit ?? ""}[${r.ref}]`).join(" vs "));
  const bad = checks.filter((c) => c.verdict === "偏差超阈值").length;
  return `## 多源交叉核对(程序完成,完整表见 RUN/xcheck.md)\n共 ${checks.length} 组可对照,其中 ${bad} 组偏差超阈值。` +
    `risk 阶段:偏差超阈值的组写进 source_conflicts(kind="cross_check",values 带各自 ref_id);report 阶段在「风险与反证」或「数据缺口」用文字说明哪些口径不一致、引用对应 ev id,不要自己计算差异百分比。\n` +
    `口径|报告期|结论|差异|各来源值[证据 id 或外部来源]\n${lines.join("\n")}\n`;
}

export function writeXcheckFiles(runDir: string, checks: XCheck[]): void {
  fs.writeFileSync(path.join(runDir, "xcheck.json"), JSON.stringify({ generated_by: "lean_xcheck(program)", checks }, null, 2));
  const md = ["# 多源交叉核对(程序生成,不经模型)", "", "| 口径 | 报告期 | 结论 | 最大相对差异 | 阈值 | 各来源(值 · 出处) |", "|---|---|---|---|---|---|",
    ...checks.map((c) => `| ${KEY_LABEL[c.key] ?? c.key} | ${c.period} | ${c.verdict} | ${(c.max_rel_diff * 100).toFixed(2)}% | ${(c.threshold * 100).toFixed(0)}% | ${c.rows.map((r) => `${r.source}: ${r.raw ?? r.value} ${r.rawUnit ?? ""} · ${r.ref}`).join("<br>")} |`)];
  fs.writeFileSync(path.join(runDir, "xcheck.md"), md.join("\n") + "\n");
}

// ── 外部独立来源(美股):SEC EDGAR + Stooq,免费无 key ──
const UA = process.env.VRA_SEC_UA || "Vibe-Research-lean research tool (set VRA_SEC_UA to 'name email')";
async function getJson(url: string, timeoutMs = 20_000): Promise<any> {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

export async function fetchExternalUS(runDir: string, symbol: string): Promise<{ rows: XRow[]; errors: string[] }> {
  const rows: XRow[] = [], errors: string[] = [];
  try {
    const map = await getJson("https://www.sec.gov/files/company_tickers.json");
    const hit = Object.values(map as Record<string, any>).find((x: any) => String(x.ticker).toUpperCase() === symbol.toUpperCase()) as any;
    if (!hit) throw new Error("SEC ticker 映射里找不到该代码");
    const cik = String(hit.cik_str).padStart(10, "0");
    const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
    const facts = await getJson(url);
    const pick = (tags: string[], key: string) => {
      for (const t of tags) {
        const usd = facts?.facts?.["us-gaap"]?.[t]?.units?.USD as any[] | undefined;
        if (!usd) continue;
        // 只要全年(10-K、跨度约一年)最近 4 期
        const annual = usd.filter((u) => u.form === "10-K" && u.start && (Date.parse(u.end) - Date.parse(u.start)) > 300 * 864e5);
        const seen = new Set<string>();
        for (const u of annual.sort((a, b) => b.end.localeCompare(a.end))) {
          if (seen.has(u.end)) continue; seen.add(u.end);
          rows.push({ key, period: u.end, source: "sec_edgar", value: u.val, unit: "元(归一)", currency: "USD", ref: `SEC ${t} ${u.accn} ${url}`, raw: u.val, rawUnit: "USD" });
          if (seen.size >= 4) break;
        }
        return;
      }
    };
    pick(["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet"], "revenue");
    pick(["NetIncomeLoss"], "net_profit_parent");
    pick(["Assets"], "total_assets");
    pick(["OperatingIncomeLoss"], "operating_profit");
  } catch (e) { errors.push(`sec_edgar: ${e instanceof Error ? e.message : String(e)}`); }
  try {
    const r = await fetch(`https://stooq.com/q/l/?s=${symbol.toLowerCase()}.us&f=sd2t2ohlcv&h&e=csv`, { signal: AbortSignal.timeout(15_000) });
    const [, line] = (await r.text()).trim().split(/\r?\n/);
    const c = line?.split(",") ?? [];
    const close = Number(c[6]);
    if (Number.isFinite(close) && close > 0) rows.push({ key: "price", period: "最新", source: "stooq", value: close, unit: "美元", currency: "USD", ref: `stooq ${c[1]} close`, raw: close, rawUnit: "美元" });
    else errors.push("stooq: 无有效收盘价");
  } catch (e) { errors.push(`stooq: ${e instanceof Error ? e.message : String(e)}`); }
  return { rows, errors };
}

/** 每个阶段开头调用:外部来源只拉一次(缓存在 RUN/xcheck_external.json),核对每次重算(上游可能新增证据) */
/** A 股 / 港股第二来源:调 scripts/lean_xcheck_cn.py(baostock / AKShare),失败只记错误不阻断 */
function fetchExternalCN(symbol: string, market: string, python: string): { rows: XRow[]; errors: string[] } {
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "lean_xcheck_cn.py");
  const r = spawnSync(python, [script, symbol, market], { encoding: "utf8", timeout: 120_000, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  try { return JSON.parse(String(r.stdout).trim().split(/\r?\n/).pop() || "{}"); }
  catch { return { rows: [], errors: [`lean_xcheck_cn.py: ${String(r.stderr || r.error || "no output").slice(0, 300)}`] }; }
}

export async function prepareXcheck(runDir: string, symbol: string, market: string, python = "python"): Promise<{ digest: string; checks: number; bad: number; external_errors: string[] }> {
  const extPath = path.join(runDir, "xcheck_external.json");
  let errors: string[] = [];
  if (!fs.existsSync(extPath) && symbol) {
    const ext = /^US$/i.test(market) ? await fetchExternalUS(runDir, symbol) : fetchExternalCN(symbol, market, python);
    errors = ext.errors ?? [];
    fs.writeFileSync(extPath, JSON.stringify({ fetched_at: new Date().toISOString(), ...ext }, null, 2));
  }
  const checks = crossCheck(collectRows(runDir));
  writeXcheckFiles(runDir, checks);
  return { digest: xcheckDigest(checks), checks: checks.length, bad: checks.filter((c) => c.verdict === "偏差超阈值").length, external_errors: errors };
}

// ── 新闻:模型联网检索,每只一次 ──
export async function fetchNewsOnce(opts: { runDir: string; symbol: string; market: string; name?: string; baseURL: string; apiKey: string; model: string }):
  Promise<{ digest: string; usage: Record<string, unknown> | null; cached: boolean; error?: string }> {
  const p = path.join(opts.runDir, "news_web.json");
  const fmt = (j: any) => `## 近期新闻 / 公告 / 事件(模型联网检索一次,未经程序核实;报告里只能标"未核实线索"并附网址,不得据此改写财务或行情数字;**引用时只写日期、事件名和网址,不要写事件里的任何数量 / 金额 / 百分比**,否则数字校验会把它判成无出处数字)\n${String(j.content ?? "").slice(0, 6000)}\n`;
  if (fs.existsSync(p)) { const j = readJson(p); return { digest: fmt(j), usage: null, cached: true }; }
  const today = new Date().toISOString().slice(0, 10);
  const q = `请联网检索 ${opts.name ?? ""}(${opts.market}:${opts.symbol})最近 30 天(截至 ${today})的重要新闻、公司公告、监管/诉讼、产品与业务事件。` +
    `只列事实,最多 8 条,每条一行:日期 | 标题/事件 | 一句话要点 | 来源网址。不要给财务数字和股价,不要给投资建议。`;
  try {
    const r = await fetch(`${opts.baseURL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({ model: opts.model, messages: [{ role: "user", content: q }], web_search_options: { search_context_size: "medium" }, max_tokens: 1200 }),
      signal: AbortSignal.timeout(180_000),
    });
    const j: any = await r.json();
    const content = j?.choices?.[0]?.message?.content ?? "";
    const rec = { fetched_at: new Date().toISOString(), model: opts.model, query: q, content, usage: j?.usage ?? null, note: "模型联网检索结果,未经程序核实" };
    fs.writeFileSync(p, JSON.stringify(rec, null, 2));
    return { digest: fmt(rec), usage: j?.usage ?? null, cached: false };
  } catch (e) {
    return { digest: "", usage: null, cached: false, error: e instanceof Error ? e.message : String(e) };
  }
}
