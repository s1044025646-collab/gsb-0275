# LCG 随机流跳步实验室（Windows 本地后端）

离线确定性的**线性同余（LCG）整数随机流**实验服务，支持任意非负步数的 O(log k) 跳步与“步长子序列”复现。
只提供 **REST API 与 CLI**，无前端。纯 TypeScript + Node.js + 内置 SQLite（`node:sqlite`），
**不依赖 Docker、WSL、付费服务或任何在线 API**，运行时零第三方依赖。

> 用途仅限**可复现模拟与算法教学**。本项目不生成密码、密钥、身份令牌或加密随机数，
> 也不做抽奖资格、候补管理或真实概率认证。LCG 是确定性递推，**确定性不代表统计质量或长周期**，
> 本项目不证明周期、不支持逆向跳步、不实现任何密码学随机算法。

## 数学约定

递推：`x_next = (a × x + c) mod m`，所有整数全程使用 **BigInt**，API/CLI 一律以**十进制字符串**输入输出，
绝不先经过 `Number`，因此 200 位参数、30 位步号也不会丢失精度。

把一步看作模 `m` 下的仿射函数 `f(x) = A·x + B`，用 `[A, B]` 表示：

- 复合（先 `g` 后 `f`）：`compose(f, g) = [f.A·g.A, f.A·g.B + f.B] (mod m)`
- `k` 步变换 `f^k` 用**二进制平方幂**对仿射映射做复合，复杂度 **O(log k)**，不循环 k 次
- **不使用** `(a^k-1)/(a-1)` 的普通除法，也**不假设 `a-1` 有模逆**（合法参数不保证可逆）
- `k=0` 返回恒等映射 `[1,0]`，状态保持不变；`a=1`、`c=0`、`a=0`、合数模数均直接正确
- 复合关系：`jump(u+v, x) = jump(v, jump(u, x)) = jump(u, jump(v, x))`

复合顺序实现在 `src/math.ts`，并有注释说明。

## 参数与上限

| 项 | 规则 |
| --- | --- |
| `m` | `m >= 2`，十进制字符串，最多 200 位 |
| `a`、`c`、`seed` | `0 <= 值 <= m-1`，十进制字符串，最多 200 位 |
| `k` / `r` | 非负步数/位置，十进制字符串，最多 30 位（可远超 `Number.MAX_SAFE_INTEGER`） |
| `d` | 子序列步长，**正整数**，最多 30 位 |
| `count` | 单次生成数量，安全整数，`0..1000` |

服务不会为了“更好看的周期”自动修改用户参数。

## 输出约定

- **生成 N 个数** = 当前状态之后的 N 个状态，**不把当前种子算作第一项**
  （例：`m=10,a=3,c=5,seed=7` 接下来 5 项是 `6,3,4,7,6`）
- 返回 `startPosition`（本次起点，即推进前当前状态的绝对步号）、
  `endPosition`（推进后绝对步号 = start + N）、`values`、以及更新后的流（含最终状态）
- **预览跳步** `POST /jumps/preview`：只计算，不写库、不改版本，可重复调用
- **提交跳步** `POST /jumps`：必须带 `expectedVersion`；当前版本不符返回 **409 版本冲突**
- 批量生成同样带 `expectedVersion`，结果与新状态在**单个 SQLite 事务**中原子提交，失败整体回滚

## 子序列

`POST /api/streams/:id/subsequence { "r": "2", "d": "3" }` 取**原序列位置**
`r, r+d, r+2d, …` 构成的新流（`r>=0, d>=1`）：

- 首状态 `x_r`：从初始种子跳 `r` 步，O(log r)
- 新流仍是 LCG：对一步变换做 `d` 次仿射复合得 `f^d(x) = A·x+B (mod m)`，
  新参数即 `(m, a'=A, c'=B, seed'=x_r)`，O(log d)，**不复制任何中间输出**
- 响应内附前 5 个位置的一致性核对：子序列逐项结果与原序列直接跳步结果必须完全相等

## 目录与数据

```
src/        math.ts(仿射跳步) validate.ts(校验/错误码) store.ts(SQLite) service.ts service
            server.ts(零依赖 HTTP) cli.ts(HTTP 客户端+demo) help.txt
test/       node:test 测试（数学/服务/HTTP 三层）
data/       运行后生成：lcg.sqlite (+WAL)、port.json（自动选择的端口）
dist/       tsc 构建产物
```

数据目录默认是项目内 `data/`，可用环境变量 `LCG_DATA_DIR` 覆盖。

## 快速开始（Windows PowerShell）

需要 Node.js >= 22.5（开发环境为 Node v25，内置 `node:sqlite`；启动命令带
`--disable-warning=ExperimentalWarning` 仅为消除实验性 API 提示）。

```powershell
npm install
npm run build
npm test          # tsc + 22 个 node:test 测试
npm run smoke     # 固定端口启动服务并做一次 HTTP 冒烟
npm start         # 启动服务：默认自动选择空闲端口，端口写入 data/port.json
```

指定端口：

```powershell
$env:PORT="38275"; npm start
```

一键演示（自动起临时服务、自动关闭，数据放在 `data/demo-*`）：

```powershell
npm run demo
```

## CLI 用法

CLI 通过 HTTP 访问服务，地址按 `--base` → 环境变量 `LCG_BASE` → `data/port.json` 解析。

```powershell
node dist/cli.js create --m 10 --a 3 --c 5 --seed 7
node dist/cli.js get <id>
node dist/cli.js generate <id> --count 5 --expected-version 1
node dist/cli.js jump-preview <id> --k 9007199254740993
node dist/cli.js jump <id> --k 9007199254740993 --expected-version 2
node dist/cli.js subseq <id> --r 2 --d 3
node dist/cli.js ops <id> --limit 100 --offset 0
node dist/cli.js help
```

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/streams` | 创建流，body：`m,a,c,seed`（均为字符串） |
| GET | `/api/streams/:id` | 查询参数、当前状态、绝对步号、版本 |
| POST | `/api/streams/:id/generate` | body：`count`(数), `expectedVersion`(数)；原子生成并推进 |
| POST | `/api/streams/:id/jumps/preview` | body：`k`(字符串)；纯预览不写状态 |
| POST | `/api/streams/:id/jumps` | body：`k`(字符串), `expectedVersion`(数)；原子跳步 |
| POST | `/api/streams/:id/subsequence` | body：`r`(字符串), `d`(字符串) |
| GET | `/api/streams/:id/operations?limit=&offset=` | 导出操作记录（create/generate/jump/subsequence） |
| GET | `/healthz` | 健康检查 |

错误响应统一为 `{ "error": { "code", "message", "field?" } }`：

| code | HTTP | 含义 |
| --- | --- | --- |
| `INVALID_INTEGER` | 400 | 不是合法非负十进制整数字符串（拒绝负号、小数、科学计数法） |
| `M_TOO_SMALL` | 400 | `m < 2` |
| `OUT_OF_RANGE` | 400 | 参数超出 `[0,m-1]`，或步长 `d<1` |
| `TOO_MANY_DIGITS` | 400 | 超过 200/30 位上限 |
| `BATCH_TOO_LARGE` | 400 | `count > 1000` |
| `MISSING_FIELD` / `BAD_REQUEST` | 400 | 缺字段 / JSON 非法 / 字段类型错误 |
| `NOT_FOUND` | 404 | 流不存在或路由不存在 |
| `VERSION_CONFLICT` | 409 | `expectedVersion` 与当前版本不一致 |

`curl` 示例：

```powershell
curl.exe -X POST http://127.0.0.1:38275/api/streams `
  -H "content-type: application/json" `
  -d '{\"m\":\"10\",\"a\":\"3\",\"c\":\"5\",\"seed\":\"7\"}'
```

## 持久化与重启

SQLite 表 `streams`（参数、当前状态、绝对步号 `position`、乐观锁 `version`）与
`operations`（每次变更的类型、详情、当时步号、版本、时间）。重启进程后用同一数据库文件即可
从断点继续，序列严格衔接；测试“重启衔接”用例关闭后重开同一文件并继续生成核对。

## 测试覆盖

- 手算小模数序列已知前几项（`10/3/5/7 → 6,3,4,7,6`；`a=1`；`a=0`；合数模 `c=0`）
- 对多组参数、`k=0..60`，快速跳步与独立逐步迭代逐一对照
- 复合关系 `jump(u+v)=jump(v,jump(u))`，包含 `2^53+1` 与 24 位大步号
- 200 位模数 + 30 位步号的即时计算
- 重复预览不改库、零步提交、单位乘数、版本冲突拒绝且状态不变
- 子序列前 10 项等于原序列下标 `r+i·d`；`r=0` 情形；`d=0` 被拒
- 关闭并重新打开同一数据库后继续衔接

## 限制与说明

- 仅后端、仅监听 `127.0.0.1`，未实现鉴权、TLS 与多节点部署（本地教学用途）
- 单条参数/步数有位数上限（200 位 / 30 位），单次最多生成 1000 项
- 不提供逆向跳步、周期分析、统计质量检验
- LCG 不应用于任何安全或真实概率场景
