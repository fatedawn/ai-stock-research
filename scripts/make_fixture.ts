// 把一次已完成前几个阶段的运行快照成夹具,供 --seed-from 复用(不重新取数、不重跑已完成阶段)。
// 用法: node scripts/make_fixture.ts <run_dir> <out_dir> <symbol> <market> <stage,stage,...>
import path from "node:path";
import { createFixture } from "../orchestrator/src/fixture.ts";
const [runDir, outDir, symbol, market, stages] = process.argv.slice(2);
if (!stages) { console.error("用法: node scripts/make_fixture.ts <run_dir> <out_dir> <symbol> <market> <stages>"); process.exit(2); }
const m = createFixture(path.resolve(runDir), path.resolve(outDir), { stages: stages.split(","), symbol, market, runId: path.basename(path.resolve(runDir)) });
console.log(JSON.stringify({ fixture: outDir, stages: m.stages, data_day: m.data_day, files: Object.keys(m.files).length }));
