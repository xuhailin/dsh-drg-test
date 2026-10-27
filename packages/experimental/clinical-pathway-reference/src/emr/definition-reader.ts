import Ajv from 'ajv';
import { definitionSchema } from './definition-schema.generated.ts';
import type { DefinitionDocument, TreatmentDefinition } from './definition.generated.d.ts';

/** 路径字段或本地引用的结构错误，不包含患者内容。 */
export interface DefinitionIssue {
  path: string;
  code: string;
  message: string;
}

/** 共享格式读取失败；调用方保留原稿并按 issues 定位，不能用默认值修补。 */
export class DefinitionValidationError extends Error {
  /** 结构错误的 JSON 路径、稳定分类与定位说明；原稿仍由调用方保留。 */
  public readonly issues: ReadonlyArray<DefinitionIssue>;

  constructor(issues: DefinitionIssue[]) {
    super('临床路径共享定义结构无效。');
    this.name = 'DefinitionValidationError';
    this.issues = issues;
  }
}

const validator = new Ajv({
  allErrors: true,
  jsonPointers: true,
  strictNumbers: true,
  useDefaults: false,
  coerceTypes: false,
  removeAdditional: false,
}).compile(definitionSchema);

function matchesSchema(input: unknown): input is DefinitionDocument {
  return validator(input) === true;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

function pointer(part: string): string {
  return part.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * 验证同版纯 JSON 数据与本地引用，原样返回，不填值、不转换数字、不构造 Angular 实例。
 * @param input 来源解析后的 JSON 或待检查的参考定义。
 * @returns 通过结构检查的同一数据对象；临床质量与医院写入条件仍须另行判断。
 */
export function readDefinition(input: unknown): DefinitionDocument {
  if (!matchesSchema(input)) {
    const errors = validator.errors || [];
    throw new DefinitionValidationError(errors.map(error => ({
      path: error.dataPath || '/',
      code: 'schema/' + error.keyword,
      message: error.message || '不符合共享字段要求。',
    })));
  }
  const issues: DefinitionIssue[] = [];
  const identities = new Map<string, string>();
  function walk(value: unknown, path: string): void {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') { return; }
    if (typeof value === 'number' && Number.isFinite(value)) { return; }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, path + '/' + index));
      return;
    }
    if (!isRecord(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
      issues.push({ path, code: 'non-json-value', message: '只接受纯 JSON 值，不接受未序列化实例或 undefined。' });
      return;
    }
    if (typeof value.localId === 'string') {
      const previous = identities.get(value.localId);
      if (previous !== undefined) {
        issues.push({ path: path + '/localId', code: 'duplicate-local-id', message: '本地身份与 ' + previous + ' 重复。' });
      } else {
        identities.set(value.localId, path);
      }
    }
    for (const [key, item] of Object.entries(value)) {
      const location = path + '/' + pointer(key);
      if ((key === 'feesRange' || key === 'inpatDayRange') && Array.isArray(item)) {
        const [lower, upper] = item;
        if (typeof lower === 'number' && typeof upper === 'number' && lower > upper) {
          issues.push({ path: location, code: 'inverted-range', message: '下限不能大于上限。' });
        }
      }
      walk(item, location);
    }
  }
  walk(input, '');
  const treatments = input.clinicalPathway.treatments || [];
  const byId = new Map<string, TreatmentDefinition>();
  for (const treatment of treatments) { byId.set(treatment.localId, treatment); }
  for (const [index, treatment] of treatments.entries()) {
    const location = '/clinicalPathway/treatments/' + index;
    const parent = treatment.parentTreatmentLocalId;
    if (parent !== null && !byId.has(parent)) {
      issues.push({ path: location + '/parentTreatmentLocalId', code: 'missing-predecessor', message: '本地前驱必须指向本定义中的阶段。' });
    }
    const parentTreatment = parent === null ? undefined : byId.get(parent);
    if (parentTreatment && treatment.parentTreatmentId != null && treatment.parentTreatmentId > 0
      && parentTreatment.id != null && treatment.parentTreatmentId !== parentTreatment.id) {
      issues.push({ path: location + '/parentTreatmentId', code: 'predecessor-identity-mismatch', message: '医院前驱身份与本地前驱指向不同阶段。' });
    }
    for (const [collection, expected] of [['recordTreatmentProjects', 1], ['nursingTreatmentProjects', 2]] as const) {
      const projects = treatment[collection] || [];
      for (const [item, project] of projects.entries()) {
        if (project.projectType !== expected) {
          issues.push({ path: location + '/' + collection + '/' + item + '/projectType', code: 'work-category-mismatch', message: '工作类别与所属集合不一致。' });
        }
      }
    }
    const branches = treatment.branchs || [];
    for (const [branch, link] of branches.entries()) {
      if (link.relatedClinicalPathwayLocalId === input.clinicalPathway.localId) {
        issues.push({ path: location + '/branchs/' + branch, code: 'self-pathway-branch', message: '阶段分支不能引用本路径自身。' });
      }
    }
  }
  const states = new Map<string, number>();
  for (const [index, treatment] of treatments.entries()) {
    let current: TreatmentDefinition | undefined = treatment;
    const chain: string[] = [];
    while (current !== undefined && states.get(current.localId) !== 2) {
      if (states.get(current.localId) === 1) {
        issues.push({ path: '/clinicalPathway/treatments/' + index + '/parentTreatmentLocalId', code: 'predecessor-cycle', message: '阶段前驱包含环或自引用。' });
        break;
      }
      states.set(current.localId, 1);
      chain.push(current.localId);
      current = current.parentTreatmentLocalId === null ? undefined : byId.get(current.parentTreatmentLocalId);
    }
    for (const id of chain) { states.set(id, 2); }
  }
  if (issues.length !== 0) { throw new DefinitionValidationError(issues); }
  return input;
}
