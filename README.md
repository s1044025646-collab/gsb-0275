# LCG 确定性整数随机流实验服务

一个离线、确定性的线性同余（LCG）整数随机流后端，用于**可复现的模拟与算法教学**。
按 `x_next = (a * x + c) mod m` 产生序列，支持 O(log k) 跳步、子序列抽取与操作记录导出。
仅提供 HTTP API 与 CLI，无前端。

> **用途与免责声明**：本服务不生成密码、密钥、身份令牌或加密随机数，不用于抽奖资格、
> 候补管理或真实概率认证。**确定性不等于统计质量或长周期**——LCG 的低位比特、
> 短周期、网格结构等缺陷是已知的；本题不要求证明周期、不支持逆向跳步，
> 也不实现任何密码学随机算法。服务不会为了"更好的周期"而自动修改用户参数。

## 环境要求

- Windows 本地运行，Node.js >= 22.5（使用内置 `node:sqlite`，无需原生编译、Docker、WSL 或任何在线服务）
- 依赖仅 `typescript` 与 `@types/node`（开发依赖）

## 快速开始

```powershell
npm install
npm run build     # 编译 TypeScript 到 dist/
npm test          # 构建并运行全部测试
npm start         # 启动 HTTP 服务（默认自动选择空闲端口，--port N 可指定）
npm run demo      # 运行端到端演示脚本
```

数据保存在项目内 `data/lcg.db`（可用环境变量 `LCG_DATA_DIR` 覆盖），重启后序列从断点继续。

## 核心设计

### 跳步：仿射复合 + 二进制幂

一步变换视为模 `m` 下的仿射映射 `f(x) = a*x + c (mod m)`，用 `(mul, add)` 表示。
复合约定：`compose(f, g)` 表示**先应用 g，再应用 f**（即 `f∘g`）：

```
compose(f, g) = (f.mul * g.mul mod m,  f.mul * g.add + f.add mod m)
```

k 步变换通过对 `f` 做二进制幂（平方-乘）得到，复杂度 **O(log k)**，不实际循环 k 次。
整个过程只做仿射复合，**不计算 `(a^k - 1)/(a - 1)`，也不要求 `a - 1` 有模逆**，
因此 `a = 1`、`a = 0`、合数模数、`gcd(a-1, m) > 1` 等合法参数都能给出正确结果。
`k = 0` 是恒等映射，状态不变。

### 大整数

所有参数与状态以**十进制整数字符串**输入输出，内部一律使用 `BigInt`，
绝不经过 `Number` 转换，步号可以远超 `Number.MAX_SAFE_INTEGER`。

### 生成约定

- `generate(n)` 返回**接下来的 n 个状态**（不含当前种子/当前状态），
  并返回本次起始位置 `startPos`、结束位置 `endPos` 与 `finalState`。
- 跳步分**预览**（`commit=false`，不写库）与**提交**（`commit=true`，原子推进）。
- 提交类操作携带 `expectedVersion`：版本不匹配返回 `409 VERSION_CONFLICT`，
  同一版本上的并发/重复请求会被拒绝，且不会只推进一部分（事务保证原子性）。

### 子序列

子序列取原序列第 `r, r+d, r+2d, ...` 项（0 基，种子为第 0 项），`r >= 0`，`d >= 1`。
首状态 = 原变换跳 `r` 步；子序列的一步变换 = 原变换的 `d` 步复合（`a' = a^d mod m` 等）。
因此创建子序列是 O(log r + log d)，**不复制中间输出**。
`GET /streams/:id/verify` 会把子序列当前状态与原序列第 `r + pos*d` 项对比，展示一致性。

### 持久化

SQLite（WAL）保存：流参数（m/a/c/seed）、当前状态、绝对步号 `pos`、乐观锁 `version`、
父子流关系、每次生成的输出记录、操作日志。重启后继续产生相同序列。

## HTTP API

默认监听 `127.0.0.1`，端口 `0` 表示自动选择空闲端口（启动日志会打印实际端口）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/streams` | 创建流 `{m, a, c, seed, name?}` |
| GET | `/streams` | 列出所有流 |
| GET | `/streams/:id` | 查询参数与当前状态 |
| POST | `/streams/:id/generate` | 生成 `{n, expectedVersion?}` |
| POST | `/streams/:id/jump` | 跳步 `{k, commit?, expectedVersion?}` |
| POST | `/streams/:id/substream` | 创建子序列 `{r, d, name?}` |
| GET | `/streams/:id/verify` | 子序列与原序列一致性校验 |
| GET | `/streams/:id/export?from=&limit=` | 导出输出记录与操作日志 |

示例：

```powershell
curl -X POST http://127.0.0.1:PORT/streams -H "content-type: application/json" `
  -d '{"m":"8","a":"5","c":"1","seed":"0"}'
curl -X POST http://127.0.0.1:PORT/streams/1/generate -d '{"n":"4","expectedVersion":0}'
curl -X POST http://127.0.0.1:PORT/streams/1/jump -d '{"k":"100000000000000000000"}'
```

### 错误码

| 码 | HTTP | 含义 |
| --- | --- | --- |
| `INVALID_PARAM` | 400 | 参数格式/范围错误（m>=2，a/c/seed ∈ [0, m-1]，d>=1 等） |
| `LIMIT_EXCEEDED` | 400 | 超过位数（100 位）或批量上限（单次 10000） |
| `NOT_FOUND` | 404 | 流不存在 |
| `VERSION_CONFLICT` | 409 | 期望版本与当前版本不一致 |
| `INTERNAL` | 500 | 未预期错误 |

## CLI

```powershell
node dist/src/cli.js serve [--port N]
node dist/src/cli.js create --m 8 --a 5 --c 1 --seed 0 --name demo
node dist/src/cli.js list
node dist/src/cli.js show 1
node dist/src/cli.js generate 1 --n 4 --expected-version 0
node dist/src/cli.js jump 1 --k 100                 # 预览（默认）
node dist/src/cli.js jump 1 --k 100 --commit --expected-version 1
node dist/src/cli.js substream 1 --r 1 --d 3
node dist/src/cli.js verify 2
node dist/src/cli.js export 1 --from 0 --limit 100
```

## 测试

`npm test` 覆盖：

- 手算小模数序列（m=8, a=5, c=1）核对已知前几项
- 小 k 跳步 vs 独立逐步迭代
- 复合关系 `jump(u+v) = jump(v, jump(u, x))`
- 超过 `Number.MAX_SAFE_INTEGER` 的步号（如 2^60+7）
- 零步、`a=1`、`a=0`、`c=0`、合数模数且 `a-1` 不可逆
- 重复预览不写状态、版本冲突返回 409 且不部分推进
- 子序列等于原序列相应下标
- 关闭并重开数据库后序列衔接一致
- HTTP 端到端（创建/生成/预览/冲突/子序列/校验/错误码）

## 限制

- 仅本机回环地址监听，无认证；请勿暴露到网络。
- 单次生成上限 10000 条，参数十进制位数上限 100 位（见 `src/validate.ts`）。
- 不提供逆向跳步（k 必须非负）、不评估周期与统计质量。
- `node:sqlite` 在 Node 25 仍标记为 experimental，接口未来可能微调。
