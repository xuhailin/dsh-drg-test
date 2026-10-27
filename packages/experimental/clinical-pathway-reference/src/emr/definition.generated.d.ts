/* Generated from definition.schema.json. Do not edit; run scripts/clinical-pathway/generate-definition.cjs. */

/**
 * 下限、上限；null 保留未知，不填默认值。
 *
 * This interface was referenced by `DefinitionDocument`'s JSON-Schema
 * via the `definition` "DefinitionRange".
 */
export type DefinitionRange = [number | null, number | null] | null
/**
 * 按 levelType 区分单项、成组和组包的医嘱定义。
 *
 * This interface was referenced by `DefinitionDocument`'s JSON-Schema
 * via the `definition` "OrderDefinition".
 */
export type OrderDefinition = SingleOrderDefinition | OrderGroupDefinition | OrderBundleDefinition

/**
 * EMR 拥有的纯数据路径定义。缺省不代表空，null 保留未知；不包含患者执行、审核或医院写动作。
 */
export interface DefinitionDocument {
  format: 'emr-clinical-pathway-definition'
  schemaVersion: 1
  clinicalPathway: ClinicalPathwayDefinition
}
/**
 * EMR 权威路径定义正文；未读集合和未知参数允许为 null。
 *
 * This interface was referenced by `DefinitionDocument`'s JSON-Schema
 * via the `definition` "ClinicalPathwayDefinition".
 */
export interface ClinicalPathwayDefinition {
  /**
   * 稳定本地身份；不是医院业务 ID。
   */
  localId: string
  /**
   * 原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。
   */
  id?: number | null
  code?: string | null
  name: string | null
  description?: string | null
  version?: string | number | null
  isTreatmentPackage?: boolean | null
  isBranchPath?: boolean | null
  createDept?: CodeName | null
  deptInfos?: DepartmentDefinition[] | null
  feesRange: DefinitionRange
  feeCurrency?: string | null
  inpatDayRange: DefinitionRange
  diagnoseGroup: DiagnosisDefinition[] | null
  inclusionAssessment: InclusionAssessmentDefinition[] | null
  treatments: TreatmentDefinition[] | null
}
/**
 * 字典编码与显示名称；任一项可未知，不把名称替代编码。
 *
 * This interface was referenced by `DefinitionDocument`'s JSON-Schema
 * via the `definition` "CodeName".
 */
export interface CodeName {
  code: string | number | null
  name: string | null
}
/**
 * 路径适用科室及本地身份；医院关联身份可暂缺。
 *
 * This interface was referenced by `DefinitionDocument`'s JSON-Schema
 * via the `definition` "DepartmentDefinition".
 */
export interface DepartmentDefinition {
  /**
   * 稳定本地身份；不是医院业务 ID。
   */
  localId: string
  /**
   * 原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。
   */
  id?: number | null
  deptCode: string | null
  deptName: string | null
}
/**
 * 路径关联诊断及本地身份。
 *
 * This interface was referenced by `DefinitionDocument`'s JSON-Schema
 * via the `definition` "DiagnosisDefinition".
 */
export interface DiagnosisDefinition {
  /**
   * 稳定本地身份；不是医院业务 ID。
   */
  localId: string
  /**
   * 原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。
   */
  id?: number | null
  code: string | null
  name: string | null
  codingSystem?: string | null
  sort?: number | null
  /**
   * 原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。
   */
  copyId?: number | null
}
/**
 * 路径准入或排除条目；isInclude 为 null 表示纳排性质未知。
 *
 * This interface was referenced by `DefinitionDocument`'s JSON-Schema
 * via the `definition` "InclusionAssessmentDefinition".
 */
export interface InclusionAssessmentDefinition {
  /**
   * 稳定本地身份；不是医院业务 ID。
   */
  localId: string
  /**
   * 原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。
   */
  id?: number | null
  inclusionItem: string | null
  /**
   * true 为纳入，false 为排除，null 为未知；不复用旧 HTTP 转换器的布尔取反。
   */
  isInclude: boolean | null
  required: boolean | null
  basisKind?: string | null
  basisKindName?: string | null
  sort?: number | null
}
/**
 * 路径阶段的日期基准、前驱引用、三类项目与分支定义。
 *
 * This interface was referenced by `DefinitionDocument`'s JSON-Schema
 * via the `definition` "TreatmentDefinition".
 */
export interface TreatmentDefinition {
  /**
   * 稳定本地身份；不是医院业务 ID。
   */
  localId: string
  /**
   * 原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。
   */
  id?: number | null
  name: string | null
  sort?: number | null
  clinicalAttributes?: string | null
  /**
   * 0 住院日、1 手术日、2 出院日；未知为 null。
   */
  nodeAttribute: 0 | 1 | 2 | null
  inpatDayRange: DefinitionRange
  /**
   * 原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。
   */
  parentTreatmentId?: number | null
  parentTreatmentLocalId: string | null
  branchs: BranchDefinition[] | null
  recordTreatmentProjects: WorkDefinition[] | null
  nursingTreatmentProjects: WorkDefinition[] | null
  orderTreatmentProjects: OrderDefinition[] | null
}
/**
 * 阶段到相关路径的分支引用；本地引用与医院引用分别保留。
 *
 * This interface was referenced by `DefinitionDocument`'s JSON-Schema
 * via the `definition` "BranchDefinition".
 */
export interface BranchDefinition {
  /**
   * 稳定本地身份；不是医院业务 ID。
   */
  localId: string
  /**
   * 原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。
   */
  id?: number | null
  name: string | null
  /**
   * 原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。
   */
  parentTreatmentId?: number | null
  /**
   * 原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。
   */
  relatedClinicalPathwayId: number | null
  relatedClinicalPathwayLocalId: string | null
  relatedClinicalPathwayCode?: string | null
  relatedClinicalPathwayVersion?: string | number | null
  clinicalProperties?: string | null
}
/**
 * 记录或护理项目；projectType 区分所属工作类别。
 *
 * This interface was referenced by `DefinitionDocument`'s JSON-Schema
 * via the `definition` "WorkDefinition".
 */
export interface WorkDefinition {
  /**
   * 稳定本地身份；不是医院业务 ID。
   */
  localId: string
  /**
   * 原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。
   */
  id?: number | null
  projectType: 1 | 2
  code: string | number | null
  name: string | null
  dictionaryId?: string | number | null
  templateCode?: string | null
  sort?: number | null
  required: boolean | null
  repeatable?: boolean | null
}
/**
 * 单项医嘱的定义参数；医院身份与稳定本地身份分开保存。
 *
 * This interface was referenced by `DefinitionDocument`'s JSON-Schema
 * via the `definition` "SingleOrderDefinition".
 */
export interface SingleOrderDefinition {
  /**
   * 稳定本地身份；不是医院业务 ID。
   */
  localId: string
  /**
   * 原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。
   */
  id?: number | null
  projectType: 0
  levelType: 1
  code?: string | number | null
  name: string | null
  sort?: number | null
  orderClass?: CodeName | null
  orderSubClass?: CodeName | null
  orderTermType?: CodeName | null
  unit?: CodeName | null
  frequency?: CodeName | null
  usage?: CodeName | null
  execDept?: CodeName | null
  usageType?: CodeName | null
  onceDose?: OnceDose | null
  /**
   * 原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。
   */
  drugId?: number | null
  drugCode?: string | null
  specs?: string | null
  orderTypeCode?: string | null
  templateCode?: string | null
  groupCode?: string | null
  baseUnitName?: string | null
  baseUnitName1?: string | null
  sendUnit?: string | null
  minUnitName?: string | null
  packUnitName?: string | null
  remark?: string | null
  allergyCode?: string | null
  antibioticLevel?: string | null
  seminalAnestheticCls?: string | null
  excludeGroupCode?: string | null
  regularName?: string | null
  packQty?: number | null
  excludeType?: number | null
  days?: number | null
  baseDose?: number | null
  baseDose1?: number | null
  unitPrice?: number | null
  singleUse?: boolean | null
  isApplyOrder?: boolean | null
  required?: boolean | null
  repeatable?: boolean | null
  skinTestFlag?: boolean | null
  isStop?: boolean | null
  testIsGroup?: boolean | null
  isSelf?: boolean | null
  producerInfo?: ProducerInfo | null
  operations?: OperationDefinition[] | null
  applyData?: OrderApplicationDefinition | null
  herbalRecipe?: HerbalRecipeDefinition | null
}
/**
 * 单次剂量及是否允许调整；数值或调整性质未知时保留 null。
 */
export interface OnceDose {
  value: number | null
  adjustable: boolean | null
}
/**
 * 药品生产厂商的编码与名称，不含库存标识或库存状态。
 */
export interface ProducerInfo {
  producerCode?: string | null
  producerName?: string | null
}
/**
 * 医嘱关联的手术或操作项目。
 *
 * This interface was referenced by `DefinitionDocument`'s JSON-Schema
 * via the `definition` "OperationDefinition".
 */
export interface OperationDefinition {
  /**
   * 稳定本地身份；不是医院业务 ID。
   */
  localId: string
  /**
   * 原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。
   */
  id?: number | null
  operationCode: string | null
  operationCode2?: string | null
  operationName: string | null
}
/**
 * 医嘱申请模板的定义参数，不含执行和审核状态。
 *
 * This interface was referenced by `DefinitionDocument`'s JSON-Schema
 * via the `definition` "OrderApplicationDefinition".
 */
export interface OrderApplicationDefinition {
  levelType: 1 | 2 | 3 | null
  groupCode?: string | null
  groupName?: string | null
  testIsGroup?: boolean | null
  items?: ApplicationItemDefinition[] | null
  operationApply?: SurgeryApplicationDefinition | null
}
/**
 * 申请单内的定义项目，不含患者申请状态。
 *
 * This interface was referenced by `DefinitionDocument`'s JSON-Schema
 * via the `definition` "ApplicationItemDefinition".
 */
export interface ApplicationItemDefinition {
  /**
   * 稳定本地身份；不是医院业务 ID。
   */
  localId: string
  itemCode: string | null
  itemName: string | null
  specimenId?: string | number | null
  specimenName?: string | null
}
/**
 * 无患者的手术申请模板参数。
 *
 * This interface was referenced by `DefinitionDocument`'s JSON-Schema
 * via the `definition` "SurgeryApplicationDefinition".
 */
export interface SurgeryApplicationDefinition {
  beforeDiagCode?: string | null
  beforeDiagName?: string | null
  operationTypeCode?: string | null
  operationTypeName?: string | null
  proposedOperationCode?: string | null
  proposedOperationCode2?: string | null
  proposedOperationName?: string | null
  operationInitLevelCode?: string | null
  operationInitLevelName?: string | null
  operationLevelShowName?: string | null
  operationPartCode?: string | null
  operationPartName?: string | null
  incisionLevelCode?: string | null
  incisionLevelName?: string | null
  operationLevelCode?: string | null
  operationLevelName?: string | null
  positionCode?: string | null
  positionName?: string | null
  operationSideCode?: string | null
  operationSideName?: string | null
  anesthesiaCategoryCode?: string | null
  anesthesiaCategoryName?: string | null
  anesthesiaMethodCode?: string | null
  anesthesiaMethodName?: string | null
  operationRoomCode?: string | null
  operationRoomName?: string | null
  memo?: string | null
  operationContent?: string | null
  antibiotic?: string | null
  antibioticcategory?: string | null
  antibioticcategoryCode?: string | null
  antibiotictime?: string | null
  equipment?: string | null
  operationCodes?: SurgeryOperationDefinition[] | null
  operationDurationTime?: number | null
}
/**
 * 手术申请模板中的操作项目。
 *
 * This interface was referenced by `DefinitionDocument`'s JSON-Schema
 * via the `definition` "SurgeryOperationDefinition".
 */
export interface SurgeryOperationDefinition {
  /**
   * 稳定本地身份；不是医院业务 ID。
   */
  localId: string
  /**
   * 原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。
   */
  id?: number | null
  code: string | null
  code2?: string | null
  name: string | null
  operationLevelCode?: string | null
  operationLevelName?: string | null
  operationPrefix?: string | null
  operationSuffix?: string | null
}
/**
 * 整张中草药处方的定义参数与有序药味，不含患者执行状态。
 *
 * This interface was referenced by `DefinitionDocument`'s JSON-Schema
 * via the `definition` "HerbalRecipeDefinition".
 */
export interface HerbalRecipeDefinition {
  /**
   * 稳定本地身份；不是医院业务 ID。
   */
  localId: string
  /**
   * 原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。
   */
  id?: number | null
  orderName: string | null
  orderTypeCode?: string | null
  execDeptCode?: string | null
  execDeptName?: string | null
  usageCode?: string | null
  usageName?: string | null
  usageCode2?: string | null
  usageName2?: string | null
  frequencyCode?: string | null
  frequencyName?: string | null
  decoctionCode?: string | null
  decoctionName?: string | null
  rulesTreatmentName?: string | null
  note?: string | null
  specialUsageCode?: string | null
  specialUsageName?: string | null
  herbTypeCode?: string | null
  rateCode?: string | null
  rateName?: string | null
  drugCount?: number | null
  decoctCount?: number | null
  decoctionDosage?: number | null
  decoctionTimes?: number | null
  isOutPat?: number | null
  isDecoction?: boolean | null
  isPrescription?: boolean | null
  detail: HerbalDetailDefinition[] | null
}
/**
 * 整方中的一味药及剂量、单位和用法。
 *
 * This interface was referenced by `DefinitionDocument`'s JSON-Schema
 * via the `definition` "HerbalDetailDefinition".
 */
export interface HerbalDetailDefinition {
  /**
   * 稳定本地身份；不是医院业务 ID。
   */
  localId: string
  /**
   * 原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。
   */
  id?: number | null
  /**
   * 原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。
   */
  drugId?: number | null
  drugCode: string | null
  drugName: string | null
  orderSubClassCode?: string | null
  orderSubClassName?: string | null
  specs?: string | null
  doseUnitCode: string | null
  doseUnitName: string | null
  dosageCode?: string | null
  dosageName?: string | null
  baseUnitCode?: string | null
  baseUnitName?: string | null
  sendUnitCode?: string | null
  sendUnitName?: string | null
  usageCode?: string | null
  usageName?: string | null
  usageCode2?: string | null
  usageName2?: string | null
  minUnitCode?: string | null
  minUnitName?: string | null
  packUnitCode?: string | null
  packUnitName?: string | null
  note?: string | null
  herbTypeCode?: string | null
  qty?: number | null
  onceDose: number | null
  baseDose?: number | null
  sendPackQty?: number | null
  packQty?: number | null
  unitSort?: number | null
  sort?: number | null
}
/**
 * 成组医嘱的定义容器；成员只能为单项医嘱。
 *
 * This interface was referenced by `DefinitionDocument`'s JSON-Schema
 * via the `definition` "OrderGroupDefinition".
 */
export interface OrderGroupDefinition {
  /**
   * 稳定本地身份；不是医院业务 ID。
   */
  localId: string
  /**
   * 原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。
   */
  id?: number | null
  projectType: 0
  levelType: 2
  name: string | null
  sort?: number | null
  required?: boolean | null
  repeatable?: boolean | null
  singleUse?: boolean | null
  children: SingleOrderDefinition[] | null
}
/**
 * 组包医嘱的定义容器；成员只能为单项医嘱或成组。
 *
 * This interface was referenced by `DefinitionDocument`'s JSON-Schema
 * via the `definition` "OrderBundleDefinition".
 */
export interface OrderBundleDefinition {
  /**
   * 稳定本地身份；不是医院业务 ID。
   */
  localId: string
  /**
   * 原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。
   */
  id?: number | null
  projectType: 0
  levelType: 3
  name: string | null
  sort?: number | null
  required?: boolean | null
  repeatable?: boolean | null
  singleUse?: boolean | null
  children: (SingleOrderDefinition | OrderGroupDefinition)[] | null
}
