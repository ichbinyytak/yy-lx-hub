# 🔎 来自 Amusic 联调实测的反馈意见与改进方案 (FEEDBACK_FROM_AMUSIC.md)

> **来源**：Amusic 项目组实测审计（2026-11-10）  
> **测试对象**：`extracted_apis.json`（v2.0.0，16 个端点全量实测）  
> **测试结论**：总体表现非常优秀，尤其补齐了 QQ音乐 VIP（`tx_tang_api_s01s_cn_10` / `tx_cyapi_top_7`）与咪咕（`mg_oiapi_net_8`）短板；但实测中揪出了 **5 个必须修复的模板污染与严重串曲漏洞**，若不修复会导致消费端**放错歌（严重串曲）或播到 30s 试听残卷**。

---

## 一、 实测过程中发现的 5 个核心问题与根因定位

### 问题 1（致命串曲）：`kw_api_yunmge_com_12` 完全无视歌曲 ID，永远返回同一首歌
* **实测现象**：
  请求酷我 Beyond《海阔天空》（`id=5886682`）：
  `https://api.yunmge.com/api/song_kuwo?key=...&token=...&id=5886682`
  接口返回的 JSON 竟然是：`{"code":200, "data": {"song_id": "649671728", "name": "自由的你", "artist": "G.E.M.邓紫棋"}}`，文件大小 11.87MB！且高并发直接报 `code: 511（每秒上限1次）`。
* **为什么漏过了 `yy-lx-hub` 的验真门禁？**
  定位 [`lib/verifier.js`](lib/verifier.js) 中的 `verifyTemplateWithSecondSong`：它只检查了“是否返回大于 1.2MB 的音频流”，**没有校验“不同歌曲 ID 返回的直链/大小/歌名是否发生了变化”**！`api.yunmge.com` 对任何 ID 都返回 11.87MB 的邓紫棋《自由的你》，因此欺骗过了单曲大小检测。
* **改进方案**：
  1. 在 `lib/verifier.js` 与 `lib/extractor.js` 中引入**「双曲差分校验 (Differential Check)」**：
     - 同一模板用两首不同的基准曲目（Song A 与 Song B）依次回放请求；
     - 对比两次返回的**音频 CDN URL 路径（剔除 query token 后）**与 **`totalBytes` 文件大小**；
     - 若两首完全不同的歌返回了**一模一样的文件大小与文件 path**，直接判定为“硬编码/伪参数假接口”，一票否决剔除！
  2. 如果响应 JSON 本身自带 `name/song/title` 字段，直接与测试曲目歌名比对，不匹配即淘汰。

---

### 问题 2（严重模板污染 + 翻唱串曲）：`templatizer.js` 漏替换 `albumName` 与 `interval`
* **实测现象**：
  1. `kw_oiapi_net_14` 生成的模板为：
     `https://oiapi.net/api/Kuwo?msg={name}%E5%8F%B6%E6%83%A0%E7%BE%8E&n=1&br=2`
     其中 `%E5%8F%B6%E6%83%A0%E7%BE%8E` 是《晴天》的专辑名 **“叶惠美”** 没有被替换掉！
     在 Amusic 中用它请求《海阔天空》时，发出的是 `msg=海阔天空叶惠美`，结果竟然搜出了 **“大喵音乐台 - 汪小敏翻唱beyond粤语经典《海阔天空》”**（3.41MB），直接导致翻唱串曲！
  2. `tx_103_79_184_97_6` 中硬编码了 `albumName=%E5%8F%B6%E6%83%A0%E7%BE%8E`；
  3. `kw_yy_zddyr_top_4` 与 `wy_yy_zddyr_top_5` 中硬编码了 `interval=05%3A26` 和 `albumName={name}`（因为《海阔天空》的 `albumName` 也叫 `海阔天空`，导致被错误替换成了 `{name}`）。
* **根因定位**：
  查看 [`lib/templatizer.js`](lib/templatizer.js) 第 59~66 行，以及 [`lib/sandbox.js`](lib/sandbox.js) 第 24~49 行：
  - `TEST_SONGS` 里传入了 `albumName` 和 `interval` 字段；
  - 但 `templatizer.js` 的 `replacements` 列表**遗漏了 `albumName` 与 `interval`**；
  - 同时 `TEST_SONGS` 里《海阔天空》把 `albumName` 写成了 `'海阔天空'`（真实专辑是 **`乐与怒`**），导致歌名与专辑名同名混淆。
* **改进方案**：
  1. 修正 [`lib/sandbox.js`](lib/sandbox.js) 中的 `TEST_SONGS`：确保每首歌的 `albumName` 与 `name` **严格不同**（如《海阔天空》专辑改为 `'乐与怒'`），且不要与其他字段重复；
  2. 在 [`lib/templatizer.js`](lib/templatizer.js) 第 59~66 行的 `replacements` 中补全：
     - `{ value: info.albumName, token: '{album}' }`
     - `{ value: info.interval, token: '{interval}' }`
     *(注意：在 `replaceAllTokens` 后若 URL 依然残留未替换的中文 test 值，或像 `msg={name}%E5%8F%B6%E6%83%A0%E7%BE%8E` 这样 `{name}` 与其他未识别汉字紧贴拼接，应在模板检查阶段直接拦截或剔除后缀！)*

---

### 问题 3（试听漏网）：`tx_103_79_184_97_6` 对周杰伦 VIP 曲目返回 30s 试听片段
* **实测现象**：
  在 Amusic 端用 QQ 音乐周杰伦《晴天》（`0039MnYb0qxYhV`）测试 `tx_103_79_184_97_6`，其返回的音频直链为 `http://ws.stream.qqmusic.qq.com/RS020039MnYb0qxYhV.mp3?...`，文件总大小仅 **`960,887` 字节（约 938KB < 1.2MB）**，属于典型的 30 秒试听截断残卷！
* **根因定位**：
  查看 [`lib/extractor.js`](lib/extractor.js) 第 127~134 行：
  ```javascript
  for (const altSong of checkSongs) {
    const vr = await verifier.verifyTemplateWithSecondSong(tpl, altSong);
    if (vr.ok) { passed = vr; break; } // 只要任何一首碰巧过了就 break 放行！
  }
  ```
  只要该接口碰巧对某 1 首非严格付费曲目返回 > 1.2MB，就立刻 `break` 放行，漏掉了对核心 VIP 曲目的严格拦截。
* **改进方案**：
  对于重点版权平台（尤其是 `tx` / `kw` / `wy`），建议将 `extractor.js` 的“任意 1 首通过即 break”升级为**至少 2 首测试曲目均通过（特别是强 VIP 曲目如《晴天》）**才视为 `verifiedStatus: "ok"`。

---

### 问题 4（结构设计建议）：缺少“精准 ID 取链”与“关键词搜索取链”的区分标识
* **现象**：
  目前产物中混杂了两类本质完全不同的接口：
  - **ID 精准取链型**：如 `kw_c_wwwweb_top_13`、`tx_tang_api_s01s_cn_10`、`kg_m_kugou_com_15`，直接凭平台唯一的歌曲 `id/songmid/hash` 取流，绝无翻唱串曲风险；
  - **关键词搜索型**：如 `mg_oiapi_net_8` (`?msg={name}`) 和 `kw_oiapi_net_14` (`?msg={name}`)，这类接口本质是搜歌名并返回第一条结果，**极易命中 Live 版、翻唱版、DJ 版**。
* **改进方案**：
  建议在输出 JSON 的每个 endpoint 对象中增加字段：
  - `"matchMode": "id" | "search"`（通过检查 `urlTemplate` + `bodyTemplate` 是否包含 `{id}`/`{songmid}`/`{hash}` 自动判定）；
  - 若为 `"search"` 模式，建议附带 `"metaFields": { "title": "data.song", "artist": "data.singer" }`（如 `mg_oiapi`），方便消费端（Amusic）对搜索结果强制施加**歌名/歌手一致性门禁**；且在调度优先级上，`"id"` 模式应排在 `"search"` 模式之前。

---

### 问题 5（动态 Token 与冗余字段清理）：`wy_yy_zddyr_top_5` 等 Header 与响应路径健壮性
* **观察 1**：`wy_yy_zddyr_top_5` 抓到了作者脚本构造的 `X-Token`（Base64 解码为 `{"device_id":...,"timestamp":1794300386,"random":...}`）。实测 `yy.zddyr.top` 其实不携带该 `X-Token`、且不带 `interval`/`albumName` 也能正常取链，建议在 `templatizer.js` 中对包含时间戳的动态 `X-Token` 做可省略性探测（尝试去掉非标准 Header 再跑验真，能通就不固化动态 Header，彻底消除未来过期隐患）。
* **观察 2**：部分接口支持无损或极高音质，但当前输出里 `supportQualities` 仅记录了测试用的 `["320k"]`，且像 `kw_api_yunmge` 依赖下标 `all_bitrates[2]` 非常脆弱。对于依赖数组末尾下标的提取规则，建议优先选用更稳定的直接字段接口（如 `c.wwwweb.top`、`yy.zddyr.top`、`tang.api.s01s.cn`、`cyapi.top`、`oiapi.net`、`gdstudio`）。

---

## 二、 附：本次 Amusic 端实测通过的优质黄金池参考

经实测，以下接口在 Amusic 端**双曲验证通过、音质与速度极佳**，可供 `yy-lx-hub` 作为质量标杆对照：
- **酷我 (`kw`)**：`kw_c_wwwweb_top_13` (333ms / 12.99MB)、`kw_yy_zddyr_top_4` (周杰伦全曲稳定)
- **企鹅 (`tx`)**：`tx_tang_api_s01s_cn_10` (周杰伦VIP 6.51MB)、`tx_cyapi_top_7` (周杰伦VIP 3.28MB)
- **网易 (`wy`)**：`wy_c_wwwweb_top_2` (470ms / 13.04MB)、`wy_oiapi_net_3` (645ms / 5.21MB)、`wy_music_api_gdstudio_xyz_9` (1200ms)、`wy_api_s0o1_com_16` (1268ms)
- **酷狗 (`kg`)**：`kg_m_kugou_com_15` (417ms / 5.15MB)、`kg_yy_zddyr_top_1` (1780ms / 12.89MB)
- **咪咕 (`mg`)**：`mg_oiapi_net_8` (1425ms / 3.83MB，需配合歌名/歌手防串曲校验)
