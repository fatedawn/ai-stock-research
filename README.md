# Vibe-Research-lean

省 token 版的 [Vibe Research](https://github.com/simonlin1212/Vibe-Research)（原作者 simonlin1212，MIT）。
报告格式（`report.md`、`viewer.html`、附录）和可追溯规则（每个数字带 `ev-*` / `calc-*` 出处、数字校验、冲突表）跟原版一样，只换掉了"模型怎么拿上下文"这一层。

## 跟原版的区别

| | 原版（classic） | lean |
|---|---|---|
| 每个阶段怎么读数据 | 模型反复调用 `list_run_files` / `read_run_file`，每轮重发全部上下文 | 程序先把本阶段需要的抓取文件、证据、计算、前序阶段结果压成一份摘要（`lean_context.ts`），第一轮就给模型 |
| 每阶段调用次数 | 十几到几十次 | 通常 2–4 次：一轮并行 `calculate`，一轮 `write_stage`，校验通过即结束，不再多跑收尾轮 |
| 多源核对 | 模型自己比 | 程序比（`lean_xcheck.ts`）：股价 1%、市值 3%、PE 8%、营收 2%、净利润 3% 等阈值，超阈值写进 `conflicts`，结果在 `xcheck.json` / `xcheck.md` |
| 外部核对源 | — | 美股：SEC EDGAR companyfacts；A 股：baostock；港股：AKShare（新浪港股日线） |
| 新闻 | 抓取器 | 另外在风险阶段调一次模型联网搜索（`web_search_options`），存 `news_web.json`，报告里只能作"未核实线索"并附网址 |
| 用量记录 | 无 | `events.jsonl` 里每次调用记 `usage`；`node scripts/token_usage.mjs <run目录>` 汇总 |

两种模式用 `--context-mode lean|classic` 切换，默认还是 `classic`。

## 实测（DeepSeek v4.1 flash，本地代理，2026-10-28）

| 标的 | 模式 | 范围 | 调用次数 | prompt tokens（其中缓存） | completion tokens | 状态 |
|---|---|---|---|---|---|---|
| 00700 腾讯 | classic（GLM flash，同一代理日志） | 全流程 | 114 | ≈672 万（缓存 ≈573 万） | ≈26 万 | 报告阶段失败 |
| 00700 腾讯 | classic（DeepSeek flash） | 全流程 | 88 | 未记录 | 未记录 | 完成 |
| NVDA | lean | 全流程 | 16 | 96.1 万（61.5 万） | 2.8 万 | 完成 |
| 600498 烽火通信 | lean | 全流程 | 24 | 174.6 万（131.5 万） | 5.2 万 | incomplete |
| 600021 上海电力 | lean | 全流程 | 23 | 162.3 万（120.6 万） | 4.9 万 | incomplete |
| 00700 腾讯 | lean | 只重跑报告阶段 | 3 | 19.6–28.6 万 | 1.4–2.2 万 | — |

调用次数约为原版的 1/4–1/7，prompt 总量约为 1/4–1/7，输出约为 1/5。
`incomplete` 是数据缺口被如实标出（比如某个口径只有一个来源），不是程序出错。

## 安装和运行

环境要求和装依赖跟原版一样（见 [README.upstream.md](README.upstream.md)）：先跑 `scripts/setup`（Windows 用 `scripts\setup-windows.cmd`），再给 `.venv` 补装核对用的两个包：`pip install baostock akshare`。

在 `.local/providers/` 放一个模型配置（目录已在 .gitignore 里），OpenAI 兼容接口即可，例如：

```json
{ "id": "my-llm", "name": "my llm", "base_url": "http://127.0.0.1:3425/v1",
  "env_key": "MY_LLM_KEY", "default_model": "deepseek-v4.1-flash" }
```

```bash
export MY_LLM_KEY=...            # 不需要 key 的本地代理随便填
export VRA_SEC_UA="your-app your@email"   # SEC 要求带联系方式的 User-Agent
node orchestrator/src/run.ts --symbol NVDA --market US --provider my-llm --python .venv/bin/python --context-mode lean
```

复用已有阶段：`--seed-from <fixture目录> --stages risk,report`（`scripts/make_fixture.ts` 从已有 run 生成 fixture，这种 run 会标为 test_scenario）。

## 数据源和使用条款

| 来源 | 覆盖 | 用途 | 商用 |
|---|---|---|---|
| SEC EDGAR | 美股财报 | 核对 | 美国政府公开数据，可商用；需遵守访问频率和 UA 要求 |
| Yahoo Finance | 美/港股行情、财务 | 抓取+核对 | 条款限个人使用，商用需授权 |
| 东方财富、腾讯、新浪、同花顺、百度股市通 | A/港/美 | 抓取+核对 | 非官方接口，条款未开放商用，商用需授权 |
| baostock | A 股行情、PE、营收 | 核对 | 免费，商用条款未明确，商用前先问 |
| AKShare | 港股日线（新浪） | 核对 | 代码 MIT；数据版权归上游网站，定位研究学习 |
| 巨潮资讯 | A 股公告 | 抓取 | 公开披露信息，转载需注明出处 |
| 模型联网搜索 | 新闻事件 | 线索 | 取决于你用的模型服务条款 |

结论：个人研究可以用；要商用，只有 SEC 这类官方数据可以直接用，其余要换成有授权的数据商。

## 许可

MIT，见 [LICENSE](LICENSE)。原项目版权 © 2026 simonlin1212；lean 改动同样按 MIT 发布。
