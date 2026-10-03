// 演示脚本：创建流 -> 生成 -> 预览/提交跳步 -> 子序列 -> 校验 -> 导出
const path = require("node:path");
const { Store } = require("../dist/src/store");
const { Service } = require("../dist/src/service");

const db = path.join(process.cwd(), "data", "demo.db");
const service = new Service(new Store(db));

const show = (label, v) => console.log(`\n== ${label} ==\n${JSON.stringify(v, null, 2)}`);

const s = service.createStream({ name: "demo", m: "8", a: "5", c: "1", seed: "0" });
show("创建流", s);

show("生成 4 个数", service.generate(s.id, "4", s.version));

show("预览跳 100 步（不写状态）", service.previewJump(s.id, "100"));

const cur = service.getStream(s.id);
show("提交跳 100 步", service.commitJump(s.id, "100", cur.version));

const sub = service.createSubstream(s.id, "1", "3");
show("创建子序列 r=1, d=3", sub);

service.generate(sub.id, "3", sub.version);
show("子序列一致性校验", service.verifySubstream(sub.id));

show("导出记录", service.exportRecords(s.id, "0", "10"));

service.store.close();
