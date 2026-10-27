# 临床路径助手 V1 实施计划

[English](clinical-pathway-assistant-v1-implementation.md) | 中文

状态：截至 2026-10-26，只读工具及参考流程已本地部署，依据[PRD](clinical-pathway-assistant-v1.zh.md)完成合成技术验证；获准开发读取及真实入口的管理核对参考稿演示通过，临床质量及独立用户验收待完成。开发库只读元数据已核对 19 张表／287 个字段，未改 EMR／接口或业务数据。

## 摘要

在本项目实现一个可选临床路径组合：`pathway_read` 读定义，`history_query` 筛历史人群并返回口径明确的汇总，`case_read` 读所选就诊依据。兼容时复用已有有界 PostgreSQL 读取及 Session／工具机制，交付带引用的分析与参考稿；写入 API、业务草案、升版提交及审核接入留到未来阶段。

## 目录

- [归属与工具定义](#tools)
- [表与字段清单](#tables)
- [关联规则与查询口径](#joins)
- [实施任务](#tasks)
- [验证与验收](#validation)
- [兼容与未来接入](#future)
- [依赖与进度](#status)
- [开发备注](#dev-note)

<a id="tools"></a>
## 归属与工具定义

全部实现归本仓库：可选 DSH 插件、服务端固定查询执行、preset 指令、参考稿展示和 Session 记录。不计划修改 `emr-app`、临床助手后端、路径服务、业务 API 或数据库 schema；EMR 源码仍是解释数据模型的依据。

| 工具 | 计划输入与输出 | 查询行为 |
| --- | --- | --- |
| `pathway_read` | 搜索或确切 `pathwayId`，返回系列／版本／状态、科室、诊断、准入、有序节点／分支及支持的项目详情。 | 搜索有界，精确读取按定义 ID 而非只按系列编码；子集合分别读取后组装，避免关联放大行数。 |
| `history_query` | 获准科室／人群、诊断条件、明确时间字段／区间、可选路径／版本及来源状态、队列／汇总模式和有界分页，返回计数、住院／执行引用、覆盖及口径。 | 从住院队列出发，用诊断／路径 `EXISTS` 确定成员，明细另读子集合；明确区分去重住院与执行记录统计单位。 |
| `case_read` | 获准 `inpatId`、所选资料类别／引用、游标／范围，返回原值／状态／时间、有界可读文本及覆盖。 | 复用既有就诊／诊断／医嘱／文书 SQL 语义，不沿用仅在院目录的范围限制；类别选择和片段分页属于新工具工作，不是当前 reader 已有参数。 |

采用可信配置的医院／历史范围、服务端持有的账号及固定参数化 SQL，并校验 READ ONLY 事务；默认 `select-only` 要求专用只读角色，用户已确认选定开发目标可用 `development-transaction-only` 复用现有账号，不修改来源授权；模型不能传 SQL、表／列名、连接配置或凭据。读取器可由既有托管基础设施承载，但不新增医院中转后端；凭据不进入模型可读私有工作区。本阶段没有写工具、写路由、迁移或新审核流程。

<a id="tables"></a>
## 表与字段清单

清单区分源码证据和运行核验。**S** 指本项目已有[固定 SQL](../../packages/experimental/emr-reader-broker/src/sql.ts)及[目录 SQL](../../packages/experimental/emr-reader-broker/src/directory.ts)。**M** 指所查路径服务依赖的 `Synyi.CPOE.Model 2.0.1815-pg-develop` 中明确的 PostgreSQL `ToTable`／`HasColumnName` 映射，源文件为 [CPOEPgDbContext.cs](http://git.sy/Apollo/emr/backend/synyi-cpoe-model/-/blob/pg_develop/src/Synyi.CPOE.Model/CPOEPgDbContext.cs)。**H** 指路径服务[整方建表 DDL](http://git.sy/Apollo/emr/backend/synyi-emr-clinicalpathway/-/blob/pg_develop/scripts/postgresql/add_clinical_pathway_herbal_recipe.sql)。源码修订及目标开发库元数据由本机验证记录绑定；下列 19 张实际使用表的字段均已核对，候选节点执行表仍不作为任务完成依据。

### `pathway_read`：路径定义

以下业务关联已由映射及 DAL 核对，不表示所有旧表都已经存在数据库外键约束。读取支持的分支／整方时保留顺序和分组。

| 表 | 必须覆盖的字段组 | 键及关联 | 证据 |
| --- | --- | --- | --- |
| `cp_clinical_pathway` | `id`、`pathway_code`、`pathway_name`、`version_no`、`state_code`、`cur_hospital_code`、`dept_code`、`dept_name`、`days_lower_limit`、`days_upper_limit`、`fee_lower_limit`、`fee_upper_limit`、`is_deleted`、`is_branch_path`、`is_treatment_package`、`oper_time`。 | PK `id` 是具体版本，`pathway_code` 归组同一系列。 | M |
| `cp_clinical_pathway_dept` | `id`、`clinical_pathway_id`、`dept_code`、`dept_name`、`cur_hospital_code`。 | `clinical_pathway_id → cp_clinical_pathway.id`；使用科室与主表所属科室不同。 | M |
| `cp_clinical_pathway_diagnostic_groups` | `id`、`clinical_pathway_id`、`diagnosis_code`、`diagnosis_name`、`copy_id`、`cur_hospital_code`。 | `clinical_pathway_id → definition.id`，保留指定版本完整诊断集合。 | M |
| `cp_clinical_pathway_evaluate` | `id`、`clinical_pathway_id`、`evaluation_criteria`、`evaluation_type`、`is_required`、`basis_kind`、`basis_kind_name`、`cur_hospital_code`。 | `clinical_pathway_id → definition.id`，类型按业务枚举解释，不照抄有冲突的映射注释。 | M |
| `cp_clinical_pathway_node` | `id`、`clinical_pathway_id`、`last_node_id`、`node_attribute`、`node_name`、`clinical_properties`、`days_lower_limit`、`days_upper_limit`、`is_exist_branch_path`、`branch_path_id`、`cur_hospital_code`。 | `clinical_pathway_id → definition.id`，`last_node_id` 指前序节点，不能只按 ID 排序。 | M |
| `cp_branch_path` | `id`、`node_id`、`cpid`、`clinical_properties`、`cur_hospital_code`。 | `node_id → node.id`，`cpid → 分支定义.id`；物理列是 `cpid` 而非 `cp_id`，分支递归需有界并检测环。 | M |
| `cp_clinical_pathway_item` | 标识／类别：`id`、`node_id`、`item_type`、`item_code`、`item_name`、`item_class_code`、`item_class_name`、`item_sub_class_code`、`item_sub_class_name`、`order_type_code`。诊疗字段：`drug_id`、`once_dose`、`dose_unit`、`frequency_code`、`frequency_name`、`usage_code`、`usage_name`、`days`、`specs`、`base_unit_name`、`min_unit_name`、`pack_unit_name`。 | `node_id → node.id`，这是模板项目，不是医嘱或执行完成证据。 | M |
| `cp_clinical_pathway_item` 续 | `exec_dept_code`、`exec_dept_name`、`is_required`、`is_repeatable`、`is_multiple_choice`、`is_apply_order`、`group_code`、`operation_apply_id`、`template_code`、`remark`、`group_sign`、`group_flag`、`group_sn`、`group_package_flag`、`group_package_sn`、`group_sort`、`cur_hospital_code`、`usage_type_code`、`usage_type_name`、`is_once_dose_change`、`test_is_group`、`is_self`。 | 保留临床条件、文书／申请单关联及成组／组包顺序，不合并不同项目类别。 | M |
| `cp_clinical_pathway_item_operation` | `id`、`item_id`、`operation_code`、`operation_name`、`operation_code2`、`cur_hospital_code`。 | `item_id → 模板项目.id`，可选手术详情附表。 | M |
| `cp_clinical_pathway_item_dic` | `id`、`cur_hospital_code`、`dept_code`、`item_type`、`item_code`、`item_name`、`clinical_pathway_item_name`。 | 用于可选字典解释，不代表完整药品／检验／检查目录，也不能仅凭 `item_code` 声称存在全局外键。 | M |
| `cp_herbal_recipe` | `item_id`、`cur_hospital_code`、`order_name`、`order_type_code`、`exec_dept_code`、`exec_dept_name`、`drug_count`、`decoct_count`、`usage_code`、`usage_name`、`usage_code2`、`usage_name2`、`frequency_code`、`frequency_name`、`decoction_code`、`decoction_name`、`rules_treatment_name`、`note`、`special_usage_code`、`special_usage_name`、`is_decoction`、`is_prescription`、`is_out_pat`、`herb_type_code`、`decoction_dosage`、`decoction_times`、`rate_code`、`rate_name`。 | PK／FK `item_id → 模板项目.id`，支持的整方项目 `item_class_code='24'` 时读取。 | H |
| `cp_herbal_recipe_detail` | `id`、`item_id`、`sort`、`cur_hospital_code`、`drug_id`、`drug_code`、`drug_name`、`order_sub_class_code`、`order_sub_class_name`、`specs`、`qty`、`once_dose`、`dose_unit_code`、`dose_unit_name`、`dosage_code`、`dosage_name`、`base_dose`、`base_unit_code`、`base_unit_name`、`send_unit_code`、`send_unit_name`、`send_pack_qty`、`usage_code`、`usage_name`、`usage_code2`、`usage_name2`、`min_unit_code`、`min_unit_name`、`pack_unit_code`、`pack_unit_name`、`pack_qty`、`unit_sort`、`note`、`herb_type_code`。 | `item_id → recipe.item_id`，DDL 声明唯一 `(item_id, sort)`，保留药味顺序及单位，使用前核对安装状态。 | H |

### `history_query`：人群与已记录执行

住院表确定人群成员，再读诊断／执行子记录；没有路径记录的未入径病例不能因此丢失。每次执行关联当时实际定义版本。

| 表 | 必须覆盖的物理字段 | 关联与解释 | 证据 |
| --- | --- | --- | --- |
| `cpoe_inpat_record` | `inpat_id`、`inpat_code`、`cur_hospital_code`、`is_valid`、`inpat_state_code`、`in_time`、`out_time`、`current_dept_code`、`out_dept_code`、`out_dept_name`、`oper_time`。 | 队列主表，明确使用当前科室还是出院科室，不用当前入径标记或状态 4／5 过滤全部历史。 | S, M |
| `cpoe_diagnose_record` | `id`、`inpat_id`、`cur_hospital_code`、`diag_type`、`diag_type_name`、`diag_code`、`diag_name`、`icd_code`、`icd_name`、`is_main_diag`、`is_suspected`、`is_deleted`、`is_current`、`diag_date`、`oper_time`。 | 同 `inpat_id` 及医院用 `EXISTS` 筛选；医院诊断编码和 ICD 分开，保留诊断类型与状态。 | S, M |
| `cp_clinical_pathway_execution_records` | `id`、`cur_hospital_code`、`inpat_id`、`inpat_code`、`pathway_id`、`pathway_code`、`version_no`、`pathway_name`、`execution_status`、`create_time`、`oper_time`、`dept_code`、`is_deleted`、`is_treatment_package`、`evaluation_id`。 | 同医院及 `inpat_id → 住院记录`，`pathway_id → 具体定义.id`；一次住院可有多行，`evaluation_id` 是逗号分隔评估 ID 字符串，不是单个外键。 | M |
| `cp_execution_records_reason` | `id`、`cur_hospital_code`、`execution_pathway_id`、`execution_node_id`、`execution_item_id`、`reason_type`、`reason_id`、`other_reason`、`is_variation`、`create_time`。 | 先按原因类型识别重载父级；患者原因关联执行 ID，审核退回关联定义 ID，保留 nullable 变异标记。 | M + 服务写入 |
| `cp_clinical_pathway_item_execution_records` | `id`、`cur_hospital_code`、`exec_id`、`execution_node_id`、`item_id`、`item_code`、`item_name`、`item_class_code`、`create_time`。 | `exec_id → execution.id`；已核代码将 `execution_node_id` 与定义节点 ID 比较，将医嘱 ID 写入 `item_id`，不能把 `item_id` 直接连模板项目。 | M + 服务写入 |
| `cpoe_inpat_order` | `order_id`、`inpat_id`、`cur_hospital_code`、`cp_exec_id`、`cp_node_id`、`cp_source_project_id`、`order_state_id`、`is_deleted`、`begin_time`、`end_time`、`input_time`、`exec_time`、`exec_num`。 | `cp_exec_id → execution.id`，`cp_node_id → 定义节点.id`；已核路径读取用 `cp_source_project_id` 比较模板项目 ID，状态／时间保持医嘱语义。 | S, M + 服务读取 |
| `cp_clinical_pathway_node_execution_records` | `id`、`cur_hospital_code`、`execution_pathway_id`、`node_id`、`node_status`、`execution_begin_time`、`execution_end_time`、`create_time`。 | 仅已核映射候选，未确认当前 DAL 使用及真实维护／完整性，核实前不能依赖它判定任务完成。 | 仅 M |

`cp_variation_reason` 等原因字典可在核对列及范围后解释获准原因编码；`cp_variation_immunity_item` 属于配置，不是患者变异事件日志，不能替代 `cp_execution_records_reason`。

### `case_read`：就诊依据

当前最强证据是本项目固定 SQL，覆盖就诊、诊断、医嘱和已落地文书文本，不代表已具备完整病历或执行数仓。

| 表 | 所选物理字段 | 关联及读取限制 | 证据 |
| --- | --- | --- | --- |
| `cpoe_inpat_record` | `inpat_id`、`inpat_code`、`cur_hospital_code`、`is_valid`、`inpat_state_code`、`inpat_state_name`、`in_time`、`out_time`、`current_dept_code`、`out_dept_code`、`out_dept_name`、`source_inpat_id`、`source_inpat_no`、`sex_code`、`sex_name`、`age`、`age_unit`、`birth_date`、`discharge_mode_code`、`discharge_situation_code`、`oper_time`、`etl_time`。 | 在获准医院／历史范围内定位确切 `inpat_id`，只展示分析需要字段。 | S, M |
| `cpoe_diagnose_record` | `id`、`inpat_id`、`cur_hospital_code`、`diag_type`、`diag_type_name`、`diag_code`、`diag_name`、`icd_code`、`icd_name`、`is_main_diag`、`is_suspected`、`is_deleted`、`is_current`、`diag_date`、`oper_time`。 | 同 `inpat_id` 及医院分别查询，保留疑似／删除／当前标记，不把所有行当当前确诊。 | S |
| `cpoe_inpat_order` | `order_id`、`inpat_id`、`cur_hospital_code`、`cp_exec_id`、`cp_node_id`、`cp_source_project_id`、`order_name`、`order_type_code`、`order_class_code`、`order_state_id`、`is_deleted`、`begin_time`、`end_time`、`input_time`、`exec_time`、`exec_num`、`state_change_reason`、`is_out_pat`、`rowversion`、`drug_code`、`drug_name`、`once_dose`、`dose_unit_name`、`frequency_code`、`frequency_name`、`usage_code`、`usage_name`。 | 同 `inpat_id` 及医院查询，`exec_time/exec_num` 不是完整给药／执行明细，既有 SQL 没有医嘱 `available_at` 值。 | S, M |
| `cpoe_inpat_medical_record` | `id`、`inpat_id`、`record_name`、`folder_code`、`template_code`、`record_date`、`record_state_code`、`record_state_name`、`is_draft`、`sign1_time`、`sign2_time`、`sign3_time`、`oper_time`。 | 按 `inpat_id` 连住院表落实医院／有效性范围，元数据／签名不替代可读正文。 | S |
| `cpoe_inpat_medical_record_content` | `id`、`record_id`、`record_text`、`file_version`、`record_text_md5`、`oper_time`。 | LEFT JOIN `record_id → medical_record.id`；一文书可能多内容行，保留 `recordId:contentId` 身份，文本 NULL／空是不可读，不证明无文书。 | S |

MedicalDocument 源码还使用模型属性 `RecordFile`，并经 `RecordBase64` 引用对象存储内容；原生 FormV2 字段可能另存。这些来源不会因三个查表工具自动具备；先按实际 `record_text` 覆盖读取并报告缺口，增加文件／表单／报告适配属于后续明确范围变更。检验、检查、手术及给药执行在物理映射和证据语义单独核实前保持未支持。

<a id="joins"></a>
## 关联规则与查询口径

以下规则防止看似合理、实际错误的关联和统计，落实在固定工具代码及来源标签，不交给模型编写 SQL。

| 主题 | 必须采用的解释 |
| --- | --- |
| 范围及 schema | 显式落实获准医院和已批准共享／标准医院规则；SQL 不会继承模型 EF 查询过滤。启用工具前核对 schema／search path 和必要列。 |
| 定义状态 | 业务枚举为 0 未审核、1 审核中、2 不通过、3 已审核、4 已发布。现有列表用 `is_deleted IS NULL`，映射注释却把 false／null 都称未删除；先核真实数据再选择过滤，并报告采用规则。 |
| 住院及时间口径 | 所查模型中状态 4／5 为在院，6／7 为出院／离院；明确选择入院、出院或入径时间，使用声明清楚的半开区间 `[start,end)` 和数据库／时区含义。当前科室与出院科室是不同条件。指定路径 `EXISTS` 或执行时间筛选会排除没有对应记录／时间的住院；未入径比较人群另按入院／出院窗口定义并分别报告分母，状态 0 记录仍按其未纳入含义解释。 |
| 诊断类别 | 已核含义包含 10 入院、14 目前、31 出院诊断；主诊断／疑似／删除／当前均为明确筛选，用 `EXISTS` 避免多诊断放大住院数。 |
| 入径成员 | 不用 `is_clinical_pathway=true` 查历史，退出／完成会清除此当前标志；区分无记录、未纳入、非路径治疗、执行中、退出和系统标记完成。 |
| 执行状态 | 枚举为 0 未纳入、1 执行中、2 退出、3 完成、4 非路径治疗。这是来源状态计数，`status != 0` 或入径减退出都不是已验证的临床完成分母。 |
| 执行时间 | `create_time` 是创建入径／未纳入记录的时间，`oper_time` 是退出／完成也会修改的操作时间，不是独立终点字段，不能推导未支持的完成时长。 |
| 原因父级 | 类型 0／1／2／4 分别是患者侧不纳入／退出／路径外医嘱变异／患者变异，关联执行记录；类型 3 是审核退回，可指定义 ID。先过滤类型再关联，`is_variation` NULL 保持未知。更新原因会删除旧行，表内是当前保留记录，不是完整事件流；记录数不能称历史累计变异次数。 |
| 医嘱／模板关联 | 优先用已核 `cp_exec_id/cp_node_id/cp_source_project_id`；所查项目执行写入中 `item_id` 是医嘱 ID，原因类型 2 的 `execution_item_id` 也使用医嘱 ID。其他类别需要自己的证据，不能猜外键。 |
| 准入评估 | 路径服务实际枚举 0 纳入、1 排除，与映射注释冲突；保留条件及声明类型，不只按注释重新解释。 |
| 项目／节点语义 | `item_type`：0 医嘱、1 文书、2 护理；`node_attribute`：0 住院日、1 手术日、2 出院日。记录存在及 UI `ExecStatus` 不证明任务已实际执行。 |
| 定义一对多 | 诊断、准入、节点、分支、项目及整方分别有界读取；全部展开连接会重复记录并破坏计数。限制分支深度／数量，保留成组和药味顺序。 |
| 文书与版本 | 保留所有返回的文书／内容身份及状态，不在缺少已核版本规则时按字符串排序 `file_version` 选最新版。文本缺失不自动触发对象存储或 FormV2 访问。 |
| 一致性与覆盖 | 兼容时复用单次调用的 `REPEATABLE READ READ ONLY`；不同分页／工具可能看到不同快照，显示读取时间、条件、返回数、截断及来源变化，不承诺全局快照。 |

### 必要统计项

`history_query` 分别返回去重住院数、路径执行记录数、声明的各来源执行状态数及已记录原因／缺证数。每个比例说明分子／分母及未入径、非路径治疗的处理；来源完成数可称“系统标记完成”，临床任务完成率需要当前读取器尚未证实的实际执行依据。既有 XLSX 公式不作为新统计的权威口径。

<a id="tasks"></a>
## 实施任务

下表保留本仓库实施任务及完成条件，实际状态见[依赖与进度](#status)；排除 EMR／后端 schema 迁移和写接口开发。

| 任务 | 范围及代码锚点 | 依赖及验收证据 | 失败恢复及协调 |
| --- | --- | --- | --- |
| T0：核对只读目标与数据含义 | 核对确切数据库／schema、只读角色、获准历史范围、来源映射、可选表、nullable 状态及时间／科室定义，证据绑定源码／包版本。 | 真实读取的首个依赖，交付已核 schema／字段矩阵和获准样本／统计范围；识别元数据不需要读取患者行。 | 可选来源缺失则未支持，必要列缺失则阻塞对应工具；按已获准范围连接；新增账号／权限配置独立处理，不自动修复 schema。 |
| T1：接入作用域固定查询提供方 | 复用或小范围提取 [database.ts](../../packages/experimental/emr-reader-broker/src/database.ts)，保留只读事务、参数绑定、限额、超时／取消及服务端凭据；只在路径 preset 注册可选工具。 | 依赖 T0 的配置约定，真实访问前可用合成数据推进；证明不能输入任意 SQL／标识符和越权范围，写入无法执行。 | 保持现有医保查询／权限不变，卸载取消未完成工作，拒绝／不可用读取返回有界错误且不输出凭据。 |
| T2：实现 `pathway_read` | 用定义清单及独立查询模块，组装确切版本、分支、手术详情和支持的整方内容。 | 依赖 T1 及已核定义子集，只有查询模块／fixture 分离时才与 T3 并行；版本、顺序、成组及可选缺口在测试中往返一致。 | 定义部分／未支持内容明确标识，不换其他版本兜底，不无限递归查询。 |
| T3：实现 `history_query` 和 `case_read` | 人群／汇总与依据采用独立查询模块，兼容时复用 [sql.ts](../../packages/experimental/emr-reader-broker/src/sql.ts) 语义，补历史范围、类别选择及有界读取。 | 依赖 T1 及已核来源子集，耦合的队列／就诊身份逻辑由单一负责人维护；验证去重、实际版本、重载 ID、文本限额及未支持类别。 | 失败／部分读取不覆盖旧依据，也不变成零计数或临床缺失；不降级任意 SQL 或切来源。 |
| T4：组合参考分析 | 更新 [preset 指令](../../deploy/hosted-workspaces/clinical-pathway.preset.yml)、工具展示、Session 记录／投影及最小路径／参考稿视图，保留筛选、依据、稿件修订及仅参考标识。 | 依赖 T2／T3 及共同工具样例，非耦合展示可先按合成结果推进；能分析已有版本、生成／编辑新参考稿而不发生业务写入。 | 切换上下文不污染其他目标，失败／刷新保留旧产物；先复用 UI 控件／slots，再决定是否补中性扩展。 |
| T5：验证与文档 | 定向提供方／工具测试、真实 Loader／preset 组合、无密钥 Session 回放，UI 改动时验证浏览器流程，执行相关构建／类型／lint／文档检查并更新包文档／JSDoc／指南。 | 依赖 T1—T4，用合成 fixture 覆盖 PRD 场景，包括非法读取、关联放大、错误 ID、文本缺失及来源状态与完成判断区别。 | 对后端／API 保持只读兼容，不声称覆盖未支持执行／报告来源，记录确切命令／结果和缺口。 |
| T6：获准只读验收 | 核对部署组合与读取配置，再用获准开发样本演示指定路径分析及新建／修订参考方案生成。 | 依赖 T5、部署授权、满足只读检查的连接和独立验收人，记录预期／实际／通过理由及覆盖。 | 关闭可选功能即可撤回访问，保留私有 Session／参考稿；未写业务库，因此无需业务回滚。 |

共同查询接口确定、编辑归属分离后，T2／T3 可以并行；T4 状态／稿件逻辑指定单一负责人，共同审阅测试样例后再使用。医院 API 修改及未来写入语义不是本阶段验收前置。

<a id="validation"></a>
## 验证与验收

查询行为和分析价值分别验证；计划代码检查只有在确切获准目标执行后才构成真实数据库支持的证据。

| 验证组 | 必要证据 |
| --- | --- |
| 只读约束 | 真实关系数据库测试连接拒绝修改，固定工具拒绝 SQL 片段／表名、错误医院／范围、超限、超时及已取消读取。 |
| 定义组装 | 多诊断／准入／项目、分支／环、成组、手术详情及可选整方 fixture 保留确切版本和顺序，不放大记录。 |
| 历史关联 | fixture 包含未入径、多诊断／多次执行、来源状态 0—4、审核原因类型 3、医嘱 ID 项目记录及科室／时间边界；计数和关联符合明确预期。 |
| 依据覆盖 | 多内容版本、缺失／空文本及支持的未签名／草稿／删除／疑似状态可区分，未支持报告／执行不能变成编造的缺失或完成。 |
| DSH 组合及回放 | 真实 Loader／profile 只给路径 preset 注册三个工具，记录模型可见结果，刷新后恢复引用、卸载撤销注册、拒绝错目标／分叉权限；回放和 GUI 录制均用合成资料。 |
| 参考质量 | 用户可查范围／依据并编辑标记清楚的参考稿，不出现医院草案／版本，不调用写入／审核／发布接口；缺指南时提出问题而非虚构规范。 |

实施后运行最小受影响行为测试、必要录制快照、`build:artifacts` 后的 `build:check` 及相关 lint／文档检查；真实数据／模型集成、合成测试、部署和人工验收分别报告。本轮运行固定 SQL 的隔离 PostgreSQL、真实 HTTP／Loader、脚本模型多轮参考修订、跨进程 Session 恢复和快照回放；另外通过真实开发提供方／HTTP 客户端验证取数及受限文书片段，报告仅保留计数、覆盖及摘要。下方交付证据单列本地真实模型演示，临床质量和独立用户验收分别确认。

<a id="future"></a>
## 兼容与未来接入

业务表、既有 EMR 接口、已发布路径版本及医保核查行为保持不变；新增持久内容仅限 DSH 自有依据／参考记录。新插件记录携带 schema 版本，实现若改变共享类型则补持久化／SDK 影响声明，不重写已发布 Session 文件代际；关闭可选插件保留既有私有参考产物及其他 preset。

未来写工具可在重新评审范围后消费目标／基线、参考稿修订、差异和证据，另行落实确认、权限、保存／版本语义、冲突、重试及原系统交接。本阶段不实现该客户端、服务端接口、医院迁移或提交回执存储；现在生成参考方案不需要先改 API。

<a id="status"></a>
## 依赖与进度

T1—T4 已实现，技术证据覆盖只读取数、权限撤销、参考稿 v1→用户修改→v2、目标切换及跨进程持久恢复；T5 记录相应检查，T6 已有本地部署和真实入口演示，下表列明剩余验收范围。T0 已核开发来源表列及用户选择的测试科室／最近一年；用户确认开发复用现有账号，保持固定 SQL 和强制只读事务，六次提供方／客户端读取通过，未写来源或修改角色。未验证类别保持显式限制，接入可靠执行／检验／表单／文件来源需独立核对映射及范围。

EMR 侧需要配合的是数据结构解释和获准读取，不是交付代码；清单来自固定 SQL、模型依赖包、可选表 DDL 及实际开发库只读元数据检查；这些证据不替代真实样本分析或临床验证。已批准产物只有参考分析及方案生成。

| 交付证据 | 实际结果 |
| --- | --- |
| 定向回归及包覆盖 | 241 项测试通过；新包语句、分支、函数和行覆盖均为 100%，11 项 PostgreSQL 场景独立执行。 |
| 隔离 PostgreSQL | 11 项通过，包含开发角色读取及拒绝 DML、源值保持不变。 |
| 开发来源 | 获准范围内六次有界提供方／客户端请求通过，包含按长度／摘要校验的文书片段；未写来源或修改授权。 |
| 参考流程与界面 | 两个 Session 回放和一个真实 Web 回归通过；覆盖三轮参考稿修订及跨进程恢复。 |
| 本地真实入口演示 | 真实模型读取定义及历史汇总／队列，保存 v1 管理核对参考稿，并在同一对话中按演示编辑收敛为三项核对任务的 v2。v1 文件保留，第二轮未再次调用工具、查库或文件；刷新后两轮对话及 v1 文件仍在。 |
| 构建及 lint | 产物构建和两套聚合检查通过；lint 通过，保留功能外既有 unused-disable 警告。 |
| 仓库检查 | 文档 42 项通过，保留既有 uv.lock 提交引用失败；hygiene 19 项通过，保留既有主题引用约束及 vendor-rescope 失败；重复检查保留一处未改动的旧客户端包装代码重复。 |
| 交付限制 | 已本地部署，未提交或推送；新建诊疗路径方案、模型调用 `case_read`、临床质量及独立用户验收仍待验证。 |

<a id="dev-note"></a>
## 开发备注

取证覆盖本项目 [SQL](../../packages/experimental/emr-reader-broker/src/sql.ts)、[读取覆盖](../../packages/experimental/emr-reader-broker/src/reader.ts)、[只读事务](../../packages/experimental/emr-reader-broker/src/database.ts)，以及路径服务[执行读写](http://git.sy/Apollo/emr/backend/synyi-emr-clinicalpathway/-/blob/pg_develop/src/Synyi.Emr.ClinicalPathway.Dal/Dal/ClinicalPathwayExecuteDal.cs)、[历史统计](http://git.sy/Apollo/emr/backend/synyi-emr-clinicalpathway/-/blob/pg_develop/src/Synyi.Emr.ClinicalPathway.Dal/Dal/VariationImmunityItemDal.cs)和[状态枚举](http://git.sy/Apollo/emr/backend/synyi-emr-clinicalpathway/-/tree/pg_develop/src/Synyi.Emr.ClinicalPathway.Model/Enums)。NuGet 来源身份和文档验证保留在本机记录，本轮核对开发元数据并验证有界来源读取，凭据未输出，报告不保留患者标识／正文，业务表和角色权限未修改。
