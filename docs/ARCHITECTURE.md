# 当前模块边界

页面和扩展UI通过runtime消息访问后台。service-worker是对外唯一写入入口，先校验sender/capability、代次和数据，再串行处理。credential-policy在新增/更改/导入登录密码和确认保存前要求已建立加密库；旧明文读写兼容仅服务恢复、删除及不增加新凭据的内部操作。

- background：消息入口、候选与回执、密码库、短期解锁挑战、脱敏诊断。
- lib/storage：后台使用的repository与串行读改写。该历史路径保留以避免无收益的广泛重命名，不供UI直接写入。
- lib/storage-schema、vault-crypto、类型和策略：纯数据校验、加密算法及有限规则；options/diagnostics只从纯schema导入常量和校验。
- content：本站摘要、局部表单识别、显式选择后单条填充、受限提交意图与保存提示。没有直接持久化或整库读取能力。
- popup/options/unlock：扩展来源的受信任UI，各有明确消息能力，不能互借权限。

local保存逻辑schema v1或加密封装。session保存15分钟派生解锁材料、五分钟候选、回执及短期挑战，均限制TRUSTED_CONTEXTS。多阶段迁移不是全局事务；候选与恢复副本先验证，primary与generation同次set提交。清空把空primary提交安排为最后一次存储调用，避免清空后恢复副本仍待删除。

源码与已加载dist分离，.build是可重建暂存。package/deploy验证固定公钥ID、协议、权限、允许文件和版本；发布证据包含源提交与hash。公开源码工具只导出允许文件，不带私有历史/恢复资料/证据。原私有仓库不直接推送公开；公开quick-fill从允许列表快照建立全新Git历史。

现役事实来源：PRODUCT定义行为，AGENTS定义操作边界，SECURITY/PRIVACY定义安全与隐私。docs/plans与SECURITY-REVIEW为有日期的历史执行记录；不要把已完成计划当成待开发功能。最新执行结果在私有release-evidence，真实站点验收与自动测试分开。

0.6.1：Profile可选lastUsedAt与内容updatedAt分离；新写入严格校验、兼容旧已知字段的读取分开。解锁显隐与旧明文状态由小型共享UI工具处理，主密码不经过父网页。填充在可选使用时间更新后仍需再次验证权限/代次/绝对到期。SPA回放的过期请求只允许一个有界补取，不引入定时轮询或远端规则。
