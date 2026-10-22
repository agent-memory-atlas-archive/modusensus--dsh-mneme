# dsh-mneme 记忆分享包

## 概览

把本机记忆打成一个可外发的 JSON 包，发给同样装着 dsh-mneme 的人。包只含活跃行，
`agent_scope` / `workspace_scope` 与本机 home 前缀一律不进包，命中密钥/PII 的行
**整条不进**（不打码）。这一刀只出包：对面的 `receive` 在车道 C，本刀合完之后
发出去的包还吃不进去。

## 用法

```bash
dsh-mneme share --dry-run                  # 只看会进多少条、跳过多少条，不落盘
dsh-mneme share --out ~/Desktop/pack.json  # 写包
dsh-mneme share --alias 名字 --out …       # 在包里署名：对方看到的是这个，不是你的路径
dsh-mneme share --type decision,pitfall --out …   # 超水位时分批
dsh-mneme share --tag 存储 --dry-run       # 按标签收窄（与 --type 同为分批用的两只旗标）
```

`--out` 与 `--dry-run` 一个都不给就直接拒绝：不写文件又把整库打到 stdout，报告会被 JSON 淹掉。
`--type` 可逗号并列（CLI 拆成数组），`--tag` 原样透传单个标签；两者都只在填了时才进 body。
`--out` 里的 `~/…` 由 CLI 自己展开（`expandHome`）：Git Bash 会替未加引号的那个展开，
PowerShell 与 cmd 不会——那两侧它是字面量，`writeFileSync` 直接 `ENOENT`，现场只剩一坨堆栈。

前置：面板「设置 → 外部访问」打开，token 用 `dsh-mneme config set <url> <token>` 配一次。命令走 standalone 数据面 `POST /share`。

同一个动作有两张皮：宿主内面板面是 `POST /api/dsh-mneme/share`（`policy: token`，与 `/export` 同门；
成功时多带一个 `Content-Disposition`，浏览器点一下就落盘），数据面是 `POST /share`（Bearer）。
解析与答复只有一份（`src/share-http.js`），两边刻意只许差在鉴权与路径（#411 的口径）；
两边的 GET 都是显式 **405**，不是掉到链尾的 404——这条路由的存在感来自「有人主动按分享键」，不给面板轮询用。

## 装什么、不装什么

判序就是下表顺序（`classifyRowForShare`），一个原因只记一次：状态位 → 类型 → 空白/噪声 → 敏感。
`report.skipped` 的六个计数按这些键给，CLI 打印的是右边那列中文，两边都对着同一份账。

| 对象（`report.skipped` 的键 → CLI 显示） | 动作 | 为什么 |
|---|---|---|
| `archived` / `forgotten` → 归档 / 已遗忘 | 跳过 | 分享的是「现在还在用的我」，不是全部历史；这两面本来就不可达 |
| `readonly_type` → 只读指针行（`document`） | 跳过 | 正文文件不随包走，导过去是「看着有、点开是空」 |
| `excluded_type` → 不随包走（`summary`） | 跳过 | 对面没有上下文读它，且会抢对面自己 dream 总览的注入档位 |
| `blank_or_noise` → 空白/噪声 | 跳过 | 判据复用写入准入的 `informationlessReason`，只许有一份；标题与正文归一后**都不剩字**才命中，所以「标题有字、正文空白」那条照常进包。它排在敏感判定之前——一条内容为空的记忆没有可泄露的东西，记成 sensitive 会让跳过原因说错话 |
| `sensitive` → 密钥/PII | **整条跳过**，不进包也不打码 | 半截打码的记忆是读不通的噪声。扫描走「任意文本」口径那份 `scanSensitive`，**不跟写入侧的 `sensitiveScanEnabled` 开关**：分享边界本身就是安全边界，没开写入闸门时恰恰最需要这里照常在扫 |
| `agent_scope` / `workspace_scope` | 不进包 | 里面是本机绝对路径与 agent 模板名 |
| 正文里的 home 前缀 | 换成 `~` | 正文字符串里同样会带出用户名目录 |

**跳过清单有上限，账没有**：`report.skip_list` 截到 `SHARE_SKIP_LIST_MAX` = 50（常量在 `src/share.js`），
`report.skipped` 的六个计数仍走全量。本机这次 5,837 条跳过 → 清单里只有
遍历顺序上前 50 个被跳过的行，CLI 又只打前 20 行，打满 50 格时终端补一句「跳过清单已截断，计数仍为全量」。
所以**绝大多数跳过项的标题根本不会出现**，命中密钥/PII 的那几条也一样——它们能不能挤进这 50 格，
取决于排在第几，而这份库被跳过的大头是归档行。要逐条核对就读计数、换 `--type` / `--tag` 收窄再跑一次，
不能把清单当成全集。上限同时是隐私口径：`skip_list` 会跟着包外发，50 格是「报告不该比包长」与
「不把整份敏感标题清单打包送走」两处约束的交点；清单里的标题在源头就遮过 home，下游不许再补第二刀。

**进包的那几行也不是整行拷贝**：每行只有白名单字段——`external_id`、`type`、`title`、`content`、
`tags`、`importance`、`epistemic_status`、`created_at`、`updated_at`、`content_hash`；
`id` / `embedding` / `content_history` / `_full_content` / `evidence` / `doc_path` /
`agent_scope` / `workspace_scope` / `sensitivity` **一律不带**。`test/share-pack.test.js`
（"pack carries the whitelist and nothing else"）锁的就是这份「不含什么」：本机 id 与 scope 到了对面
会被当成真相源，向量与历史快照则是纯死重。剩下的字节几乎全由正文长短决定——这就是水位只能量
**最终序列化字节**、不能量条数的原因（按条数判，对「条少但每条很长」的库说谎；按字符数判，
中文字符与 UTF-8 字节差三倍，等于把 413 留给对面）。

## 代价与实测

测法：把本机记忆库**复制**到临时目录后直接驱动出货代码（`createStore` → `store.all()` →
`buildSharePack`）取数，没动活库。读数来自单机单库的一次样本，不代表所有用户。
端到端的活体跑尚未发生：当前在跑的宿主实例加载的是比本车道更早的构建，`/share` 在它那里
要等插件 relink 之后才可达（此前只会回 404）。下面的数字是进程内代码路径的读数，
不是网络往返的读数。

样本：`<本机记忆库副本>`，共 11,615 行（含归档与已遗忘）。

| 项 | 读数 |
|---|---:|
| 整库打包进包条数 | 5,778（跳过 5,837：`archived` 5,754 / `sensitive` 79 / `readonly_type` 2 / `excluded_type` 1 / `forgotten` 1 / `blank_or_noise` 0；清单只留前 50 条，六个计数是全量） |
| 整库包字节 | 4,526,523 B ≈ 4.3 MiB → **3 MiB 水位命中，这一份发不出去** |
| `buildSharePack` 全程耗时（出货路径） | 123–143 ms：定性 + 扫描 + 铸 `external_id` + 序列化。**分享一次真实要付的进程内成本看这一格** |
| 整库逐条 `scanSensitive`（**另一次探针，不是出货路径**） | 98 ms / 11,615 行（title+content+tags 拼接口径）。测量脚本直接对全表逐条调它；出货路径按判序在扫描**之前**就返回了归档、已遗忘、两类类型与空白噪声，真正走到扫描的是进包的 5,778 条加被判 sensitive 的 79 条。这一格是同一把尺的上界，不是包内成本 |
| 首次全表读 `store.all()`（冷副本，含页调入） | 约 1.1 s |
| 按 type 分批后的最大单批 | project 1,309 条 ≈ 1.09 MiB；每个单独 type 都在水位之内 |

spec §12 等的三个数，读出来都是「口径成立」：

- **条数 → 字节**：万行级库整库一份装不下，`--type` / `--tag` 分批是主路径而不是兜底；
  好在每个 type 单独都在水位之内，实践上是「两份起步」而不是逐条挑。
- **扫描成本**：出货路径那一格里没有「整库逐条扫描」这件事——判序把大头（归档）挡在扫描之前，
  123–143 ms 就是全部。98 ms 那格是整库探针，别拿它当包的成本。
  等待的大头在数据面本来就有的全表读，不是分享包新加的那一刀，所以 share 侧不需要进度输出。
- **水位命中**：是，但要分清两个数各管哪一侧。`MAX_PACK_BYTES` = **3 MiB**（`src/share.js`）
  是分享侧出货的水位，量的是最终序列化字节：超了就在源头拒成 413，答复只给 `bytes` /
  `limitBytes` / `hint` 加一份 report，**不回 pack**——把刚拒掉的几 MB 再序列化一遍是第二类事故。
  **4 MiB** 是两张皮各自写死的**入站** body 上限（`api.js` 与 `api-standalone.js` 的
  `MAX_REQUEST_BODY_BYTES`，同值同义的既有防御，不属于分享包；车道 C 的接收面将来读的也是这一档，
  那条路由还没落地）。水位刻意比入站上限留 1 MiB：包要原样当 body POST 回去，贴着上限等于给自己埋
  413。这份 4.3 MiB 的整库包两个都超，而拒发发生在第一个数字上——对面从来不会拿到它。

另一个参考值（spec §12 第 3 项）：正文里的 home 前缀替换命中 205/11,615 行（约 1.8%）——
分母是整库副本的全部行，不是进包那 5,778 条，所以它是「这台机器上有多少正文带过用户名目录」的
整库口径；正文级泄露真实存在但不泛滥，没到要回头改 §4 取行口径的程度。

## 已知：包还吃不进去

车道 C（`POST /receive` + 幂等两列 + 整包退出）未到。现在收到包的人只能把它当
一份人可读的 Markdown 之外的 JSON 存着。
