/**
 * **省 token 模式(lean)的上下文预打包**。
 *
 * 经典模式下,模型每个阶段都要靠 list_run_files / read_run_file 一个个翻 fetch/、calcs/、stages/,
 * 每多一轮工具往返,整段对话(含先前读过的全部文件)就重发一次 —— 实测腾讯一只 114 次调用、
 * cache_read 573 万 token。
 *
 * lean 模式把"翻文件"这件程序就能干的事交给程序:在发第一条消息前,由这里把本阶段需要的
 * 取数证据、已有计算、上游阶段产物压成一份紧凑摘要(每条证据一行,保留 evidence id / raw_ref /
 * calc id,出处照样可追溯),直接放进提示词。模型只需要做判断:一轮并行发出全部 calculate,
 * 一轮 write_stage / write_report,写成功且收工检查放行就由程序直接收尾,不再多要一轮。
 */
import fs from "node:fs";
import path from "node:path";

const STAGE_ORDER = ["profile", "financials", "estimates", "valuation", "risk", "report"] as const;
/** 摘要总长度上限(字符)。超了按"先当前阶段、后上游"的顺序截掉尾部文件,并在摘要里写明。 */
const DIGEST_CAP = 160_000;
const EXTRA_CAP = 1_200;
const DETAILS_CAP = 700;

function readJson(p: string): any {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(+v.toPrecision(10));
  if (typeof v === "string") return v.replace(/\s+/g, " ").replace(/\|/g, "/");
  return JSON.stringify(v);
}

function trimExtra(extra: unknown): string {
  if (!extra || typeof extra !== "object") return "";
  const e = { ...(extra as Record<string, unknown>) };
  for (const k of ["raw_files", "provenance", "endpoint", "local_now"]) delete e[k];
  const s = JSON.stringify(e);
  return s.length > EXTRA_CAP ? s.slice(0, EXTRA_CAP) + "…(截断,完整内容可 read_run_file)" : s;
}

/** 一个 fetch/<script>.json → 紧凑文本:头部一行 + 每条证据一行 */
export function digestFetchFile(file: string, name: string): string {
  const d = readJson(file);
  if (!d || typeof d !== "object") return `### fetch/${name}.json (无法解析)\n`;
  const ev: any[] = Array.isArray(d.evidence) ? d.evidence : [];
  const raws: string[] = [];
  const rawIdx = (r: string) => { let i = raws.indexOf(r); if (i < 0) { raws.push(r); i = raws.length - 1; } return `r${i}`; };
  const rows = ev.map((x) => [x.id, x.field, x.period ?? "", fmt(x.value), x.unit ?? "", x.currency && x.currency !== x.unit ? x.currency : "",
    x.source ?? "", x.raw_ref ? rawIdx(x.raw_ref) : "", fmt(x.note ?? "").slice(0, 80)].join("|"));
  const head = [`### fetch/${name}.json status=${d.status} primary_source=${d.primary_source ?? ""} used=${(d.used_sources ?? []).join(",")} evidence=${ev.length}`];
  if (d.errors && (Array.isArray(d.errors) ? d.errors.length : Object.keys(d.errors).length)) head.push(`errors=${JSON.stringify(d.errors).slice(0, 400)}`);
  if (d.missing && (Array.isArray(d.missing) ? d.missing.length : Object.keys(d.missing).length)) head.push(`missing=${JSON.stringify(d.missing).slice(0, 400)}`);
  const ex = trimExtra(d.extra); if (ex) head.push(`extra=${ex}`);
  if (raws.length) head.push(`raw_ref: ${raws.map((r, i) => `r${i}=${r}`).join(" ; ")}`);
  if (rows.length) head.push("id|field|period|value|unit|currency|source|raw|note", ...rows);
  return head.join("\n") + "\n";
}

export function digestCalcs(runDir: string): string {
  const dir = path.join(runDir, "calcs");
  if (!fs.existsSync(dir)) return "";
  const lines: string[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const c = readJson(path.join(dir, f));
    if (!c) continue;
    const o = c.output ?? {};
    const refs = (c.inputs_refs ?? []).map((r: any) => r.ref_id).join(",");
    let det = o.details ? JSON.stringify(o.details) : "";
    if (det.length > DETAILS_CAP) det = det.slice(0, DETAILS_CAP) + "…";
    lines.push(`${c.calculation_id}|calcs/${f}|${c.function}|${o.status}|display=${fmt(o.display)}|value=${fmt(o.value)} ${o.unit ?? ""}|refs=${refs}${o.reason ? `|reason=${fmt(o.reason)}` : ""}${det ? `|details=${det}` : ""}`);
  }
  return lines.length ? `## 已有计算 calcs/(calculation_id|文件|函数|状态|display|value|输入引用|details)\n${lines.join("\n")}\n` : "";
}

/** 本阶段该看的 fetch 文件:按 _plan.json 的 stage_plan 累计到当前阶段;risk / report 看全部。 */
function fetchFilesFor(runDir: string, stage: string): string[] {
  const dir = path.join(runDir, "fetch");
  if (!fs.existsSync(dir)) return [];
  const all = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("_")).map((f) => f.slice(0, -5));
  const plan = readJson(path.join(dir, "_plan.json"))?.stage_plan as Record<string, { required?: string[]; optional?: string[] }> | undefined;
  const idx = STAGE_ORDER.indexOf(stage as any);
  if (!plan || idx < 0 || stage === "risk" || stage === "report") return all;
  const want: string[] = [];
  // 当前阶段的文件排在最前(截断时最后才被砍)
  for (let i = idx; i >= 0; i--) {
    const p = plan[STAGE_ORDER[i]];
    for (const n of [...(p?.required ?? []), ...(p?.optional ?? [])]) if (all.includes(n) && !want.includes(n)) want.push(n);
  }
  // 计划外但存在的(如 A 股 fetch_quote / fetch_trade_calendar)在 profile 就给
  for (const n of all) if (!want.includes(n) && !Object.values(plan).some((p) => [...(p.required ?? []), ...(p.optional ?? [])].includes(n))) want.push(n);
  return want;
}

export function buildRunDigest(runDir: string, stage: string): { text: string; files: string[]; truncated: string[] } {
  const parts: string[] = [];
  const files: string[] = [];
  const truncated: string[] = [];
  let size = 0;
  const push = (label: string, s: string) => {
    if (!s) return;
    if (size + s.length > DIGEST_CAP) { truncated.push(label); return; }
    parts.push(s); size += s.length; files.push(label);
  };
  const ledger = readJson(path.join(runDir, "fetch", "_ledger.json"));
  if (ledger) push("fetch/_ledger.json", `## 取数账本\n${Object.entries(ledger).map(([k, v]: [string, any]) => `${k}=${v?.status ?? "?"}${v?.reason ? `(${fmt(v.reason).slice(0, 80)})` : ""}`).join(", ")}\n`);
  const conf = readJson(path.join(runDir, "conflicts.json"));
  if (conf) push("conflicts.json", `## conflicts.json(编排器权威冲突集)\n${JSON.stringify(conf)}\n`);
  push("calcs/", digestCalcs(runDir));
  const sdir = path.join(runDir, "stages");
  if (fs.existsSync(sdir)) {
    for (const s of STAGE_ORDER) {
      if (s === stage) continue;
      const j = readJson(path.join(sdir, `${s}.json`));
      if (j) push(`stages/${s}.json`, `## stages/${s}.json\n${JSON.stringify(j)}\n`);
    }
  }
  const choke = readJson(path.join(runDir, "fetch", "_chokepoints.json"));
  if (choke && (stage === "risk" || stage === "report")) push("fetch/_chokepoints.json", `## fetch/_chokepoints.json\n${JSON.stringify(choke).slice(0, 4000)}\n`);
  for (const n of fetchFilesFor(runDir, stage)) push(`fetch/${n}.json`, digestFetchFile(path.join(runDir, "fetch", `${n}.json`), n));
  const header = `【运行目录摘要(lean 模式,由程序预读并压缩)】下面已经包含本阶段需要的取数证据、已有计算和上游阶段产物,` +
    `每条证据一行(id|field|period|value|unit|currency|source|raw|note,raw 列 rN 对应文件头 raw_ref 列表里的完整路径,需要 raw_ref 时照抄完整路径)。` +
    `**不要再调用 list_run_files / read_run_file 翻这些文件**;只有摘要明确写了"截断"的内容才允许 read_run_file 补读。\n` +
    (truncated.length ? `(以下文件因体积未放入摘要,确有需要再 read_run_file:${truncated.join(", ")})\n` : "");
  return { text: header + parts.join("\n"), files, truncated };
}

export const LEAN_WORKFLOW = `【lean 执行方式(必须遵守,省调用次数)】
1. 数据都在上面的摘要里,直接用,不要翻文件。
2. 本阶段要做的全部 calculate **在同一条回复里一次性并行发出**(多个 tool_calls);calc 互相依赖时,先把不依赖上游 calc 的一次发完,下一条回复再发依赖它们的。
3. 拿到 calc 结果后,**下一条回复直接调用 write_stage(report 阶段用 write_report)提交完整产物**。没有计算要做的阶段,第一条回复就直接写产物。
4. 写成功后程序会自动收尾,不需要再回复汇报 JSON。被收工检查拦下时,按清单一次改完再写。`;
