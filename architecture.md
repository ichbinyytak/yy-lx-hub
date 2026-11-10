# 🎵 yy-lx-hub 核心架构设计与工程规范手册 (architecture.md)

> **版本**：v2.2.0 (生命周期自愈 + 平台标签 + GitHub Actions 实战版)  
> **更新时间**：2026-11-10  
> **定位**：全网音源动态巡航、高能效沙箱质检与双生态（洛雪生态 + Amusic 原生）双产出超级中枢。  
> **部署环境铁律**：**本项目核心巡航与验源流水线必须原生兼容并运行在 GitHub Actions 环境中**。  
> **当前研发聚焦**：**现阶段不急于联调 Amusic**，全力聚焦于打磨「全网音源的发现收集（静态底座 + 30天动态雷达）」与「沙箱验证准确率（过滤假源与试听片段）」。

---

## 零、 GitHub Actions 运行环境约束与开发铁律（⚠️ 所有后续代码必须严格遵守）

由于本项目后续将常态化托管在 **GitHub Actions** 定时自动运行，所有模块的设计与修改必须时刻牢记以下 5 条物理约束：

1. **无状态一次性运行（Stateless Runner）**：
   - 本项目定位为纯无头命令行 / GitHub Actions 定时流水线（已移除 Web 主页与常驻 HTTP 服务），运行容器每次触发都是全新的、跑完即销毁。
   - 通过独立且完备的命令行单次入口（`bin/extract.js`），完成**“启动 → 雷达扫描 → 并发抓取 → 串行验源 → 落地产物并发布 Release → 优雅退出”**的完整闭环。
2. **严格的时间预算与并发控制**：
   - Actions 单次任务不宜超过 10~15 分钟。因此抓取必须使用并发池（如 6 路并发），每个仓库必须设置合理的文件数上限，单次 HTTP 请求必须有硬性超时中断（`AbortSignal.timeout`），杜绝拖死整个工作流。
3. **原生消费 `GITHUB_TOKEN` 突破限频**：
   - 在 Actions 中必须自动读取环境变量 `GITHUB_TOKEN`，将 GitHub API 每小时 60 次的匿名限额提升至 1000 次，确保 30 天动态雷达与全仓库树扫描顺畅不报 403。
4. **海外机房网络环境感知（Geo-Block 与日志可观测性）**：
   - GitHub Actions 跑在海外服务器（Azure），部分国内音乐平台（或国内公益反代）可能屏蔽海外 IP 或延迟较高。
   - **日志必须实时输出到标准输出 (`stdout`)**，清楚区分“接口本身失效”与“海外网络超时/地区拦截”，便于通过 Actions 控制台排查问题。
5. **纯静态产物输出与安全边界**：
   - 跑完后产物应能直接作为静态文件（如 `public/sources.zip`、前端展示页数据、`extracted_apis.json`）发布到 GitHub Pages 或 Artifacts；
   - 若未来在公开仓库发布底层 API 清单，需注意敏感 Key 的加密或仓库私有化隔离，防止接口暴露被公网爬虫打崩。

---

## 一、 项目背景与第一性原理

在数字音乐生态中，存在两个诉求截然不同但互相补充的系统：

1. **`洛雪生态（LX Music）`**：
   - 依赖外部 JavaScript 脚本生态；
   - 社区存在数十个爱好者维护的音源仓库，民间大神通过混淆加密、反调试手段包装真实 API。
   - 需求：需要一个稳定、新鲜、自动验源的**音源订阅站**与**可用脚本 ZIP 打包导出**能力。

2. **`Amusic 原生播放器`**：
   - 追求 **0ms 冷启动、秒级出声、低功耗、零 Node.js 进程开销** 的纯原生轻骑兵播放器（如 Python/Serverless 部署）；
   - 无法也不应该在运行时加载笨重的 Node.js 环境或执行不可控的外部 JS 代码；
   - 需求：只需要纯粹、无状态、高可用的底层物理 HTTP 接口模板（即直接填入歌曲 ID 就能拿到音频的 API 网址）。

**`yy-lx-hub` 的核心使命**：
立足于原版 `lx-hub` 的优秀基座，升维打造为**“一鱼多吃、活水双输出”**的超级中枢：
既全面兼容洛雪生态的日常消费，又通过底层嗅探萃取出极简的 API 菜单供给 `Amusic`。

---

## 二、 三大核心升级基石

```
                     ┌── 【静态底座】已知优质顶流大仓 (pdone, guoyue2010 等)
                     └── 【动态雷达】GitHub 搜索 API 动态追踪最近 30 天活跃新仓
                                          │
                                          ▼
                             yy-lx-hub 极速源池调度
                                          │
                                          ▼
                       轻量化 VM 安全沙箱 (严格单平台串行派发)
                                          │
                    ┌─────────────────────┴─────────────────────┐
                    ▼                                           ▼
         【产出 1：面向洛雪生态】                    【产出 2：面向 Amusic 生态】
       - 实测可用音源状态看板                      - 底层物理 HTTP 请求嗅探 (Hook)
       - 全量可用 JS 脚本一键 ZIP 打包             - 提炼万能 URL 模板与作者密钥/Token
       - 洛雪桌面端 / 服务端在线订阅源             - 第二曲目真机回放双重验真 (魔数+尺寸)
                                                   - 输出 extracted_apis.json
```

### 1. 升级基石一：全网动态巡航（从“死水潭”到“活水泉”）
* **摒弃原版缺陷**：原版仅依赖死板的 `builtin-repos.json`，收录了大量停更 1 年以上的僵尸死仓，却遗漏了近 24 小时高频维护的热门大仓；
* **双轨源池机制**：
  1. **静态底座池**：收录已知维护良好的核心大仓（如 `pdone/lx-music-source`、`guoyue2010/lxmusic-`、`jiaru1` 等）；
  2. **动态雷达池**：每日定时调用 GitHub Search API，以 `topic:lx-music`、`lx-music-source` 等为关键词，**动态捕获最近 30 天内有新提交（pushed）的活跃仓库**；
  3. **优胜劣汰机制**：连续 30 天无任何更新的仓库自动移至低频观察哨，确保源池 100% 鲜活。

### 2. 升级基石二：沙箱效能重构与洛雪全量产出保障
* **消除原版并发竞态**：
  - 原版使用 `Promise.all` 并发测速 5 大平台（wy, tx, kw, kg, mg），在高并发或网络抖动时极易产生超时卡死、端口抢占与沙箱请求串台。
  - **`yy-lx-hub` 准则**：沙箱测试采用**严格串行派发**，杜绝并发竞争，大幅提升测速吞吐量与稳定性。
* **完整保留洛雪生态产出与平台可视化标注**：
  - **带平台标签的 JS 脚本打包**：`public/sources.zip` 内的每个 `.js` 文件名自动冠以实测可用平台前缀（如 `[网易云+酷我] 溯音音源.js`、`[5平台全通] BiliMusic 音源.js`），并附带 `00_平台适用清单.txt` 分类总表；
  - **静态看板数据**：自动输出 `public/data.json`，记录所有可用源的平台、版本与来源；
  - **直推服务端**：保留向私有洛雪服务端（LX Server、HollyMusic 等）一键灌入可用源的能力。

### 4. 升级基石四：「去死留活 + 增量纳新」全生命周期自愈机制
* **存量保留复测**：无论是 `.js` 脚本还是已提炼的 `.json` API，通过 GitHub Actions Cache（持久化 `data/` 目录）长期保留历史活源档案；每轮运行全量复测，避免因老仓库跌出雷达榜而误丢仍在工作的活源；
* **当日即时隔离**：任意 `.js` 或 API 只要本轮验证失败，**当天生成的 `sources.zip` 与 `extracted_apis.json` 立刻不输出它**，确保产物 100% 实时可用；
* **三振出局永久清理**：连续失效满 **3 轮**（`failStreak >= 3`）的源与孤立缓存脚本文件自动从档案和磁盘永久清除，防止垃圾堆积。

### 3. 升级基石三：深检底层嗅探与 API 萃取（供给 Amusic）
在沙箱测试脚本能否出歌的同时，利用宿主拦截探针（Sniffer Hook）完成底层穿透：
* **拦截时机**：在 `globalThis.lx.request` 发起真实网络调用的瞬间，捕获目标 URL、请求方法、Headers、Body 与返回音频流；
* **全派系覆盖与密钥捕获**：
  - **派系 A（第三方穿透 / 车机免密后门）**：如海棠、念心、酷我车载奇瑞接口，直接将测试曲目参数逆向替换为 `{id}`、`{songmid}`、`{quality}`；
  - **派系 B（内置自建 Token / 专属 VIP Cookie）**：自动提取作者在脚本内反算好的真实有效 Token（如 HYW key、玉宁熙 apikey、QQ 音乐凭证 Cookie），固化为可用模板的一部分；
  - **官方端侧实时算密（如网易 eapi）**：针对网易官方基于固定密钥 `e82ckenh8dichen8` 的 AES-128-ECB 算密，提供标准算子声明，供 Amusic 端 5 行原生代码打通。
* **第二曲目真机验真门禁（防翻车、防假链）**：
  - 提炼出的模板必须脱离沙箱，用**第二首基准测试曲目**发起一次纯 HTTP 请求；
  - 必须同时满足：**HTTP 200/206 + 音频魔数(MP3/FLAC/M4A) + 文件尺寸 > 1.2MB**，才被标记为正式可用。
* **最终产物**：输出标准静态清单 `public/extracted_apis.json`，供 Amusic 每天定时无感拉取。

---

## 三、 标准产物规范 (`public/extracted_apis.json`)

```json
{
  "version": "2.0.0",
  "updatedAt": "2026-11-10T08:00:00Z",
  "totalEndpoints": 10,
  "endpoints": [
    {
      "id": "kw_car_direct",
      "name": "酷我车载原生后门 (酷我官方)",
      "platform": "kw",
      "supportQualities": ["128k", "320k"],
      "type": "redirect",
      "method": "GET",
      "urlTemplate": "https://nmobi.kuwo.cn/mobi.s?f=web&user=0&source=kwplayerhd_ar_4.3.0.8_tianbao_T1A_qirui.apk&type=convert_url_with_sign&rid={id}&br=320kmp3",
      "headers": {
        "User-Agent": "Mozilla/5.0"
      },
      "verifiedStatus": "ok",
      "sampleLatencyMs": 180
    },
    {
      "id": "wy_oiapi_relay",
      "name": "网易云穿透中继 (第三方)",
      "platform": "wy",
      "supportQualities": ["320k"],
      "type": "json",
      "method": "GET",
      "urlTemplate": "https://oiapi.net/api/Music_163?id={id}",
      "headers": {
        "User-Agent": "Mozilla/5.0"
      },
      "responseExtractor": "data[0].url",
      "verifiedStatus": "ok",
      "sampleLatencyMs": 320
    },
    {
      "id": "tx_hotvkey_token",
      "name": "企鹅音乐直通通道 (带内置Token)",
      "platform": "tx",
      "supportQualities": ["128k", "320k"],
      "type": "json",
      "method": "POST",
      "urlTemplate": "https://ut.y.qq.com/cgi-bin/musicu.fcg",
      "headers": {
        "Content-Type": "application/json",
        "Referer": "https://y.qq.com/"
      },
      "bodyTemplate": "{\"comm\":{\"ct\":19,\"cv\":0,\"guid\":\"10000\",\"tmeAppID\":\"qqmusic\",\"qq\":\"0\"},\"hot\":{\"method\":\"CgiGetHotVkey\",\"module\":\"music.vkey.GetEVkey\",\"param\":{\"filename\":[\"M800{id}.mp3\"],\"songmid\":[\"{id}\"]}}}",
      "responseExtractor": "hot.data.urls[0].purl",
      "urlPrefix": "https://dl.stream.qqmusic.qq.com/",
      "verifiedStatus": "ok",
      "sampleLatencyMs": 240
    }
  ]
}
```

---

## 四、 项目工程目录结构

```text
yy-lx-hub/
├── .github/workflows/
│   └── crawl-and-extract.yml # GitHub Actions 定时全自动巡航、缓存自愈与产物归档工作流
├── architecture.md           # 本核心设计与规范基线文档（单一事实来源）
├── package.json              # 项目依赖与启动脚本
├── builtin-repos.json        # 核心静态大仓底座
├── bin/
│   └── extract.js            # 命令行 / Actions 无状态单次全流程入口
├── lib/
│   ├── radar.js              # GitHub 30 天活跃仓动态搜索探测引擎
│   ├── core.js               # 并发抓取、安检门、60天淘汰、5路工人池及生命周期清理
│   ├── sandbox.js            # 高能效 VM 沙箱 (严格单平台串行、多曲目容灾池、Sniffer探针)
│   ├── sandbox-worker.js     # 沙箱隔离工人进程
│   ├── sniffer.js            # 物理 HTTP 嗅探器与因果判定引擎
│   ├── templatizer.js        # 模板化与参数反推引擎
│   ├── verifier.js           # 多曲目纯 HTTP 验真引擎 (魔数 + >1.2MB)
│   ├── extractor.js          # API 规则合并、交叉验真与生命周期清理
│   ├── apicrypto.js          # 零依赖 AEAD 密文封装器 (供 Amusic 及其他外部项目互通)
│   ├── exporter.js           # 带平台标签的 ZIP 打包器与静态 data.json 生成器
│   ├── zip.js                # 零依赖 ZIP 打包与安全解压工具
│   ├── netguard.js           # SSRF 出网防护与重定向追踪
│   └── store.js              # 冷热分离数据库与脚本清理
└── public/                   # 无状态运行产物输出目录（不托管 Web 主页）
    ├── extracted_apis.json   # 产物 1（本地）：Amusic 明文 API 清单
    ├── extracted_apis.enc    # 产物 1（发布）：专供 Amusic 消费的认证密文包
    ├── sources.zip           # 产物 2（发布）：带平台标签前缀的洛雪可用脚本压缩包
    └── data.json             # 产物 3（发布）：可用源统计清单
```

---

## 五、 实施路线与演进计划

1. **第一阶段：基座搭建与沙箱重构**
   - 确立 `yy-lx-hub` 基础工程代码，注入去中心化、无竞态的串行沙箱架构；
   - 实现洛雪脚本的原汁原味测试与导出保障。
2. **第二阶段：30 天动态雷达接入**
   - 编写 `lib/crawler.js` 动态搜索模块，实现“静态底座 + 动态 30 天 GitHub 活跃新源”自动融合。
3. **第三阶段：嗅探萃取与全派系捕获**
   - 挂载 `lib/sniffer.js` 与 `lib/templatizer.js`，自动提炼 URL 模板、自建 Token、Cookie 及参数映射；
   - 接入第二首歌曲 `lib/verifier.js` 魔数门禁验真。
4. **第四阶段：双生态联调与自愈闭环**
   - 生成 `public/extracted_apis.json`、`public/extracted_apis.enc` 与 `sources.zip`；
   - 与 `Amusic` 播放器完成拉取与歌曲播放闭环联调。

---

## 六、 跨项目对接与密文速查（🤖 AI / 二次开发一眼看懂）

如果你（或 AI）正在将本项目的可用 API 清单接入 **Amusic** 或其他新项目，直接按以下既定事实对接即可，**无需任何人工 Secret 配置**：

1. **公开发布产物地址（GitHub Release `sync-latest`，每日 04:00 更新）**
   - **Amusic / 原生播放器专用加密 API 包**：`https://github.com/ichbinyytak/yy-lx-hub/releases/download/sync-latest/extracted_apis.enc`
   - **洛雪生态可用脚本包（明文免密）**：`https://github.com/ichbinyytak/yy-lx-hub/releases/download/sync-latest/sources.zip`
   - **洛雪生态状态清单（明文免密）**：`https://github.com/ichbinyytak/yy-lx-hub/releases/download/sync-latest/data.json`

2. **加解密协议与内置密钥（0 第三方依赖）**
   - **直接复用模块**：Node.js 复制 `lib/apicrypto.js`（`decryptJson`）；Python 复制 `Amusic/api_crypto.py`（`decrypt_json`）。
   - **内置默认密码**：`yy-lx-hub::amusic::auto-sync-v1`（若设置了环境变量 `AMUSIC_SYNC_KEY` 或 `AMUSIC_SYNC_SECRET` 则自动优先使用环境变量）。
   - **算法规格**：`PBKDF2-HMAC-SHA256`（100,000 次迭代，输出 64B = `32B encKey + 32B macKey`）→ `SHA256-CTR` 异或流加密 → `HMAC-SHA256(macKey, "yy-lx-hub:v1:" + salt + nonce + ct)` 认证校验。
   - **密文信封格式（JSON）**：`{ "v": 1, "alg": "PBKDF2-SHA256-CTR-HMAC", "iter": 100000, "salt": "<b64 16B>", "nonce": "<b64 16B>", "ct": "<b64>", "mac": "<b64 32B>" }`。

3. **多仓错峰自动同步节奏（北京时间）**
   - **04:00 (`0 20 * * *`)**：`yy-lx-hub` 完成巡航、双曲验真并更新 `sync-latest` Release；
   - **05:00 (`0 21 * * *`)**：`Amusic`（或其他下游项目）拉取 `extracted_apis.enc` 内存解密测速并更新自身缓存。
