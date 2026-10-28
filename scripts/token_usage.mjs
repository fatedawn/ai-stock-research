#!/usr/bin/env node
// 统计一次或多次运行的模型调用次数与 token(读 <run>/events.jsonl 里的 direct.model_reply / direct.finalized)。
// 用法: node scripts/token_usage.mjs <run_dir> [<run_dir> ...]   输出 JSON 汇总。
import fs from "node:fs";
import path from "node:path";
const out = [];
for (const dir of process.argv.slice(2)) {
  const f = path.join(dir, "events.jsonl");
  if (!fs.existsSync(f)) { out.push({ run: path.basename(dir), error: "no events.jsonl" }); continue; }
  const per = {}; let mode = null;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "direct.turn_start" && e.context_mode) mode = e.context_mode;
    if (e.type !== "direct.model_reply" && e.type !== "direct.finalized" && !(e.type === "lean.news" && e.usage)) continue;
    const s = (per[e.stage] ??= { calls: 0, prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0 });
    s.calls += 1;
    const u = e.usage ?? {};
    s.prompt_tokens += u.prompt_tokens ?? u.input_tokens ?? 0;
    s.completion_tokens += u.completion_tokens ?? u.output_tokens ?? 0;
    s.cached_tokens += u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? u.cache_read_input_tokens ?? 0;
  }
  const total = Object.values(per).reduce((a, s) => { for (const k in s) a[k] = (a[k] ?? 0) + s[k]; return a; }, {});
  out.push({ run: path.basename(dir), context_mode: mode ?? "classic", total, per_stage: per });
}
console.log(JSON.stringify(out, null, 2));
