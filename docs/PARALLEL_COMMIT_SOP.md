# 并行会话提交 SOP(硬规则)

> 起因事故:2026-06-10 commit `f1cd9ee` 未 path 限定提交,裹挟了并行 T4 会话已 staged 的
> `scripts/polish-xlsx.py` 删除(-182),且 commit message 通篇未提该删除,造成归属记账污染
> (真实归属 = T4 输出层单写者收敛缺陷#7,见 `2624aef` message 与 `git notes show f1cd9ee`)。
> 同源记忆铁律:『并行写同仓库时只 path 限定提交自己验证过的改动,绝不 git add -A』。

## 提交流程(每条都是必做,缺一不可)

1. **逐文件 add,只 add 自己本会话改过且验证过的路径**:

   ```
   git add scripts/my-script.mjs
   git add src/my-module.js
   git add test/my-module.test.mjs
   ```

   - 绝不 `git add -A` / `git add .` / `git add -u` / `git commit -a`。
   - 目录级 `git add scripts/` 也禁止——并行会话可能正往同目录写文件。

2. **提交前自检 staged 集合,确认无他人改动被裹挟**:

   ```
   git diff --cached --stat
   ```

   - 输出里出现任何**不是本会话亲手改的文件**(包括看似无害的删除),立即
     `git restore --staged <该路径>` 摘出去,不准"顺手带走"。
   - 特别注意:并行会话可能已经 `git add` 过文件但还没 commit——index 不是你独占的。

3. **commit message 必须穷尽列出本次 staged 的全部文件及变更意图**:
   - message 提到的文件集合 == `git diff --cached --stat` 的文件集合,一一对应;
   - 有删除必须明说删除及理由,不准静默带删。

4. **commit 后立即复核**:

   ```
   git show --stat HEAD
   ```

   - 发现裹挟:若尚未被后续 commit 依赖,优先把误带文件摘出(revert 该文件部分);
   - 若已不可逆(历史已被引用/并行会话已基于其继续),用 `git notes add` 在
     涉事 commit 上补记真实归属,并在下一个 commit message 中同步更正——
     绝不放任记账污染(本仓库已有先例:`git notes show f1cd9ee`)。

## 其他并行纪律(同源,见长期记忆)

- 见到多个 claude.exe / 文件 mtime 在动 ≠ 失控,先判 openclaw 并行会话;
- 工作区里他人未提交的 `M`/`??` 文件一律不碰、不 add、不 checkout 覆盖;
- 不 push 除非用户明确要求。
