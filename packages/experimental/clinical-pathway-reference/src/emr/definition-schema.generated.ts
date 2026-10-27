/* Generated from definition.schema.json. Do not edit; run scripts/clinical-pathway/generate-definition.cjs. */

/** Draft 07 共享定义的纯 JSON Schema；读取器不补默认值或转换来源值。 */
export const definitionSchema = {
  '$schema': 'http://json-schema.org/draft-07/schema#',
  '$id': 'urn:synyi:emr:clinical-pathway-definition:1',
  'title': 'DefinitionDocument',
  'description': 'EMR 拥有的纯数据路径定义。缺省不代表空，null 保留未知；不包含患者执行、审核或医院写动作。',
  'type': 'object',
  'additionalProperties': false,
  'properties': {
    'format': {
      'const': 'emr-clinical-pathway-definition',
    },
    'schemaVersion': {
      'const': 1,
    },
    'clinicalPathway': {
      '$ref': '#/definitions/ClinicalPathwayDefinition',
    },
  },
  'required': [
    'format',
    'schemaVersion',
    'clinicalPathway',
  ],
  'definitions': {
    'CodeName': {
      'title': 'CodeName',
      'description': '字典编码与显示名称；任一项可未知，不把名称替代编码。',
      'type': 'object',
      'additionalProperties': false,
      'properties': {
        'code': {
          'type': [
            'string',
            'number',
            'null',
          ],
        },
        'name': {
          'type': [
            'string',
            'null',
          ],
        },
      },
      'required': [
        'code',
        'name',
      ],
    },
    'DefinitionRange': {
      'title': 'DefinitionRange',
      'anyOf': [
        {
          'type': 'array',
          'items': [
            {
              'type': [
                'number',
                'null',
              ],
            },
            {
              'type': [
                'number',
                'null',
              ],
            },
          ],
          'minItems': 2,
          'maxItems': 2,
        },
        {
          'type': 'null',
        },
      ],
      'description': '下限、上限；null 保留未知，不填默认值。',
    },
    'DepartmentDefinition': {
      'title': 'DepartmentDefinition',
      'description': '路径适用科室及本地身份；医院关联身份可暂缺。',
      'type': 'object',
      'additionalProperties': false,
      'properties': {
        'localId': {
          'type': 'string',
          'minLength': 1,
          'maxLength': 128,
          'description': '稳定本地身份；不是医院业务 ID。',
        },
        'id': {
          'type': [
            'integer',
            'null',
          ],
          'minimum': 0,
          'maximum': 9007199254740991,
          'description': '原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。',
        },
        'deptCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'deptName': {
          'type': [
            'string',
            'null',
          ],
        },
      },
      'required': [
        'localId',
        'deptCode',
        'deptName',
      ],
    },
    'DiagnosisDefinition': {
      'title': 'DiagnosisDefinition',
      'description': '路径关联诊断及本地身份。',
      'type': 'object',
      'additionalProperties': false,
      'properties': {
        'localId': {
          'type': 'string',
          'minLength': 1,
          'maxLength': 128,
          'description': '稳定本地身份；不是医院业务 ID。',
        },
        'id': {
          'type': [
            'integer',
            'null',
          ],
          'minimum': 0,
          'maximum': 9007199254740991,
          'description': '原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。',
        },
        'code': {
          'type': [
            'string',
            'null',
          ],
        },
        'name': {
          'type': [
            'string',
            'null',
          ],
        },
        'codingSystem': {
          'type': [
            'string',
            'null',
          ],
        },
        'sort': {
          'type': [
            'integer',
            'null',
          ],
        },
        'copyId': {
          'type': [
            'integer',
            'null',
          ],
          'minimum': 0,
          'maximum': 9007199254740991,
          'description': '原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。',
        },
      },
      'required': [
        'localId',
        'code',
        'name',
      ],
    },
    'InclusionAssessmentDefinition': {
      'title': 'InclusionAssessmentDefinition',
      'description': '路径准入或排除条目；isInclude 为 null 表示纳排性质未知。',
      'type': 'object',
      'additionalProperties': false,
      'properties': {
        'localId': {
          'type': 'string',
          'minLength': 1,
          'maxLength': 128,
          'description': '稳定本地身份；不是医院业务 ID。',
        },
        'id': {
          'type': [
            'integer',
            'null',
          ],
          'minimum': 0,
          'maximum': 9007199254740991,
          'description': '原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。',
        },
        'inclusionItem': {
          'type': [
            'string',
            'null',
          ],
        },
        'isInclude': {
          'type': [
            'boolean',
            'null',
          ],
          'description': 'true 为纳入，false 为排除，null 为未知；不复用旧 HTTP 转换器的布尔取反。',
        },
        'required': {
          'type': [
            'boolean',
            'null',
          ],
        },
        'basisKind': {
          'type': [
            'string',
            'null',
          ],
        },
        'basisKindName': {
          'type': [
            'string',
            'null',
          ],
        },
        'sort': {
          'type': [
            'integer',
            'null',
          ],
        },
      },
      'required': [
        'localId',
        'inclusionItem',
        'isInclude',
        'required',
      ],
    },
    'HerbalRecipeDefinition': {
      'title': 'HerbalRecipeDefinition',
      'description': '整张中草药处方的定义参数与有序药味，不含患者执行状态。',
      'type': 'object',
      'additionalProperties': false,
      'properties': {
        'localId': {
          'type': 'string',
          'minLength': 1,
          'maxLength': 128,
          'description': '稳定本地身份；不是医院业务 ID。',
        },
        'id': {
          'type': [
            'integer',
            'null',
          ],
          'minimum': 0,
          'maximum': 9007199254740991,
          'description': '原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。',
        },
        'orderName': {
          'type': [
            'string',
            'null',
          ],
        },
        'orderTypeCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'execDeptCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'execDeptName': {
          'type': [
            'string',
            'null',
          ],
        },
        'usageCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'usageName': {
          'type': [
            'string',
            'null',
          ],
        },
        'usageCode2': {
          'type': [
            'string',
            'null',
          ],
        },
        'usageName2': {
          'type': [
            'string',
            'null',
          ],
        },
        'frequencyCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'frequencyName': {
          'type': [
            'string',
            'null',
          ],
        },
        'decoctionCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'decoctionName': {
          'type': [
            'string',
            'null',
          ],
        },
        'rulesTreatmentName': {
          'type': [
            'string',
            'null',
          ],
        },
        'note': {
          'type': [
            'string',
            'null',
          ],
        },
        'specialUsageCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'specialUsageName': {
          'type': [
            'string',
            'null',
          ],
        },
        'herbTypeCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'rateCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'rateName': {
          'type': [
            'string',
            'null',
          ],
        },
        'drugCount': {
          'type': [
            'number',
            'null',
          ],
        },
        'decoctCount': {
          'type': [
            'number',
            'null',
          ],
        },
        'decoctionDosage': {
          'type': [
            'number',
            'null',
          ],
        },
        'decoctionTimes': {
          'type': [
            'number',
            'null',
          ],
        },
        'isOutPat': {
          'type': [
            'number',
            'null',
          ],
        },
        'isDecoction': {
          'type': [
            'boolean',
            'null',
          ],
        },
        'isPrescription': {
          'type': [
            'boolean',
            'null',
          ],
        },
        'detail': {
          'anyOf': [
            {
              'type': 'array',
              'items': {
                '$ref': '#/definitions/HerbalDetailDefinition',
              },
            },
            {
              'type': 'null',
            },
          ],
        },
      },
      'required': [
        'localId',
        'orderName',
        'detail',
      ],
    },
    'HerbalDetailDefinition': {
      'title': 'HerbalDetailDefinition',
      'description': '整方中的一味药及剂量、单位和用法。',
      'type': 'object',
      'additionalProperties': false,
      'properties': {
        'localId': {
          'type': 'string',
          'minLength': 1,
          'maxLength': 128,
          'description': '稳定本地身份；不是医院业务 ID。',
        },
        'id': {
          'type': [
            'integer',
            'null',
          ],
          'minimum': 0,
          'maximum': 9007199254740991,
          'description': '原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。',
        },
        'drugId': {
          'type': [
            'integer',
            'null',
          ],
          'minimum': 0,
          'maximum': 9007199254740991,
          'description': '原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。',
        },
        'drugCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'drugName': {
          'type': [
            'string',
            'null',
          ],
        },
        'orderSubClassCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'orderSubClassName': {
          'type': [
            'string',
            'null',
          ],
        },
        'specs': {
          'type': [
            'string',
            'null',
          ],
        },
        'doseUnitCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'doseUnitName': {
          'type': [
            'string',
            'null',
          ],
        },
        'dosageCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'dosageName': {
          'type': [
            'string',
            'null',
          ],
        },
        'baseUnitCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'baseUnitName': {
          'type': [
            'string',
            'null',
          ],
        },
        'sendUnitCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'sendUnitName': {
          'type': [
            'string',
            'null',
          ],
        },
        'usageCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'usageName': {
          'type': [
            'string',
            'null',
          ],
        },
        'usageCode2': {
          'type': [
            'string',
            'null',
          ],
        },
        'usageName2': {
          'type': [
            'string',
            'null',
          ],
        },
        'minUnitCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'minUnitName': {
          'type': [
            'string',
            'null',
          ],
        },
        'packUnitCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'packUnitName': {
          'type': [
            'string',
            'null',
          ],
        },
        'note': {
          'type': [
            'string',
            'null',
          ],
        },
        'herbTypeCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'qty': {
          'type': [
            'number',
            'null',
          ],
        },
        'onceDose': {
          'type': [
            'number',
            'null',
          ],
        },
        'baseDose': {
          'type': [
            'number',
            'null',
          ],
        },
        'sendPackQty': {
          'type': [
            'number',
            'null',
          ],
        },
        'packQty': {
          'type': [
            'number',
            'null',
          ],
        },
        'unitSort': {
          'type': [
            'number',
            'null',
          ],
        },
        'sort': {
          'type': [
            'number',
            'null',
          ],
        },
      },
      'required': [
        'localId',
        'drugCode',
        'drugName',
        'onceDose',
        'doseUnitCode',
        'doseUnitName',
      ],
    },
    'OperationDefinition': {
      'title': 'OperationDefinition',
      'description': '医嘱关联的手术或操作项目。',
      'type': 'object',
      'additionalProperties': false,
      'properties': {
        'localId': {
          'type': 'string',
          'minLength': 1,
          'maxLength': 128,
          'description': '稳定本地身份；不是医院业务 ID。',
        },
        'id': {
          'type': [
            'integer',
            'null',
          ],
          'minimum': 0,
          'maximum': 9007199254740991,
          'description': '原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。',
        },
        'operationCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'operationCode2': {
          'type': [
            'string',
            'null',
          ],
        },
        'operationName': {
          'type': [
            'string',
            'null',
          ],
        },
      },
      'required': [
        'localId',
        'operationCode',
        'operationName',
      ],
    },
    'ApplicationItemDefinition': {
      'title': 'ApplicationItemDefinition',
      'description': '申请单内的定义项目，不含患者申请状态。',
      'type': 'object',
      'additionalProperties': false,
      'properties': {
        'localId': {
          'type': 'string',
          'minLength': 1,
          'maxLength': 128,
          'description': '稳定本地身份；不是医院业务 ID。',
        },
        'itemCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'itemName': {
          'type': [
            'string',
            'null',
          ],
        },
        'specimenId': {
          'type': [
            'string',
            'number',
            'null',
          ],
        },
        'specimenName': {
          'type': [
            'string',
            'null',
          ],
        },
      },
      'required': [
        'localId',
        'itemCode',
        'itemName',
      ],
    },
    'SurgeryOperationDefinition': {
      'title': 'SurgeryOperationDefinition',
      'description': '手术申请模板中的操作项目。',
      'type': 'object',
      'additionalProperties': false,
      'properties': {
        'localId': {
          'type': 'string',
          'minLength': 1,
          'maxLength': 128,
          'description': '稳定本地身份；不是医院业务 ID。',
        },
        'id': {
          'type': [
            'integer',
            'null',
          ],
          'minimum': 0,
          'maximum': 9007199254740991,
          'description': '原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。',
        },
        'code': {
          'type': [
            'string',
            'null',
          ],
        },
        'code2': {
          'type': [
            'string',
            'null',
          ],
        },
        'name': {
          'type': [
            'string',
            'null',
          ],
        },
        'operationLevelCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'operationLevelName': {
          'type': [
            'string',
            'null',
          ],
        },
        'operationPrefix': {
          'type': [
            'string',
            'null',
          ],
        },
        'operationSuffix': {
          'type': [
            'string',
            'null',
          ],
        },
      },
      'required': [
        'localId',
        'code',
        'name',
      ],
    },
    'SurgeryApplicationDefinition': {
      'title': 'SurgeryApplicationDefinition',
      'description': '无患者的手术申请模板参数。',
      'type': 'object',
      'additionalProperties': false,
      'properties': {
        'beforeDiagCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'beforeDiagName': {
          'type': [
            'string',
            'null',
          ],
        },
        'operationTypeCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'operationTypeName': {
          'type': [
            'string',
            'null',
          ],
        },
        'proposedOperationCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'proposedOperationCode2': {
          'type': [
            'string',
            'null',
          ],
        },
        'proposedOperationName': {
          'type': [
            'string',
            'null',
          ],
        },
        'operationInitLevelCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'operationInitLevelName': {
          'type': [
            'string',
            'null',
          ],
        },
        'operationLevelShowName': {
          'type': [
            'string',
            'null',
          ],
        },
        'operationPartCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'operationPartName': {
          'type': [
            'string',
            'null',
          ],
        },
        'incisionLevelCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'incisionLevelName': {
          'type': [
            'string',
            'null',
          ],
        },
        'operationLevelCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'operationLevelName': {
          'type': [
            'string',
            'null',
          ],
        },
        'positionCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'positionName': {
          'type': [
            'string',
            'null',
          ],
        },
        'operationSideCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'operationSideName': {
          'type': [
            'string',
            'null',
          ],
        },
        'anesthesiaCategoryCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'anesthesiaCategoryName': {
          'type': [
            'string',
            'null',
          ],
        },
        'anesthesiaMethodCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'anesthesiaMethodName': {
          'type': [
            'string',
            'null',
          ],
        },
        'operationRoomCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'operationRoomName': {
          'type': [
            'string',
            'null',
          ],
        },
        'memo': {
          'type': [
            'string',
            'null',
          ],
        },
        'operationContent': {
          'type': [
            'string',
            'null',
          ],
        },
        'antibiotic': {
          'type': [
            'string',
            'null',
          ],
        },
        'antibioticcategory': {
          'type': [
            'string',
            'null',
          ],
        },
        'antibioticcategoryCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'antibiotictime': {
          'type': [
            'string',
            'null',
          ],
        },
        'equipment': {
          'type': [
            'string',
            'null',
          ],
        },
        'operationCodes': {
          'anyOf': [
            {
              'type': 'array',
              'items': {
                '$ref': '#/definitions/SurgeryOperationDefinition',
              },
            },
            {
              'type': 'null',
            },
          ],
        },
        'operationDurationTime': {
          'type': [
            'number',
            'null',
          ],
        },
      },
      'required': [],
    },
    'OrderApplicationDefinition': {
      'title': 'OrderApplicationDefinition',
      'description': '医嘱申请模板的定义参数，不含执行和审核状态。',
      'type': 'object',
      'additionalProperties': false,
      'properties': {
        'levelType': {
          'enum': [
            1,
            2,
            3,
            null,
          ],
        },
        'groupCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'groupName': {
          'type': [
            'string',
            'null',
          ],
        },
        'testIsGroup': {
          'type': [
            'boolean',
            'null',
          ],
        },
        'items': {
          'anyOf': [
            {
              'type': 'array',
              'items': {
                '$ref': '#/definitions/ApplicationItemDefinition',
              },
            },
            {
              'type': 'null',
            },
          ],
        },
        'operationApply': {
          'anyOf': [
            {
              '$ref': '#/definitions/SurgeryApplicationDefinition',
            },
            {
              'type': 'null',
            },
          ],
        },
      },
      'required': [
        'levelType',
      ],
    },
    'WorkDefinition': {
      'title': 'WorkDefinition',
      'description': '记录或护理项目；projectType 区分所属工作类别。',
      'type': 'object',
      'additionalProperties': false,
      'properties': {
        'localId': {
          'type': 'string',
          'minLength': 1,
          'maxLength': 128,
          'description': '稳定本地身份；不是医院业务 ID。',
        },
        'id': {
          'type': [
            'integer',
            'null',
          ],
          'minimum': 0,
          'maximum': 9007199254740991,
          'description': '原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。',
        },
        'projectType': {
          'enum': [
            1,
            2,
          ],
        },
        'code': {
          'type': [
            'string',
            'number',
            'null',
          ],
        },
        'name': {
          'type': [
            'string',
            'null',
          ],
        },
        'dictionaryId': {
          'type': [
            'string',
            'number',
            'null',
          ],
        },
        'templateCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'sort': {
          'type': [
            'integer',
            'null',
          ],
        },
        'required': {
          'type': [
            'boolean',
            'null',
          ],
        },
        'repeatable': {
          'type': [
            'boolean',
            'null',
          ],
        },
      },
      'required': [
        'localId',
        'projectType',
        'code',
        'name',
        'required',
      ],
    },
    'SingleOrderDefinition': {
      'title': 'SingleOrderDefinition',
      'description': '单项医嘱的定义参数；医院身份与稳定本地身份分开保存。',
      'type': 'object',
      'additionalProperties': false,
      'properties': {
        'localId': {
          'type': 'string',
          'minLength': 1,
          'maxLength': 128,
          'description': '稳定本地身份；不是医院业务 ID。',
        },
        'id': {
          'type': [
            'integer',
            'null',
          ],
          'minimum': 0,
          'maximum': 9007199254740991,
          'description': '原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。',
        },
        'projectType': {
          'const': 0,
        },
        'levelType': {
          'const': 1,
        },
        'code': {
          'type': [
            'string',
            'number',
            'null',
          ],
        },
        'name': {
          'type': [
            'string',
            'null',
          ],
        },
        'sort': {
          'type': [
            'integer',
            'null',
          ],
        },
        'orderClass': {
          'anyOf': [
            {
              '$ref': '#/definitions/CodeName',
            },
            {
              'type': 'null',
            },
          ],
        },
        'orderSubClass': {
          'anyOf': [
            {
              '$ref': '#/definitions/CodeName',
            },
            {
              'type': 'null',
            },
          ],
        },
        'orderTermType': {
          'anyOf': [
            {
              '$ref': '#/definitions/CodeName',
            },
            {
              'type': 'null',
            },
          ],
        },
        'unit': {
          'anyOf': [
            {
              '$ref': '#/definitions/CodeName',
            },
            {
              'type': 'null',
            },
          ],
        },
        'frequency': {
          'anyOf': [
            {
              '$ref': '#/definitions/CodeName',
            },
            {
              'type': 'null',
            },
          ],
        },
        'usage': {
          'anyOf': [
            {
              '$ref': '#/definitions/CodeName',
            },
            {
              'type': 'null',
            },
          ],
        },
        'execDept': {
          'anyOf': [
            {
              '$ref': '#/definitions/CodeName',
            },
            {
              'type': 'null',
            },
          ],
        },
        'usageType': {
          'anyOf': [
            {
              '$ref': '#/definitions/CodeName',
            },
            {
              'type': 'null',
            },
          ],
        },
        'onceDose': {
          'anyOf': [
            {
              'title': 'OnceDose',
              'description': '单次剂量及是否允许调整；数值或调整性质未知时保留 null。',
              'type': 'object',
              'additionalProperties': false,
              'properties': {
                'value': {
                  'type': [
                    'number',
                    'null',
                  ],
                },
                'adjustable': {
                  'type': [
                    'boolean',
                    'null',
                  ],
                },
              },
              'required': [
                'value',
                'adjustable',
              ],
            },
            {
              'type': 'null',
            },
          ],
        },
        'drugId': {
          'type': [
            'integer',
            'null',
          ],
          'minimum': 0,
          'maximum': 9007199254740991,
          'description': '原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。',
        },
        'drugCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'specs': {
          'type': [
            'string',
            'null',
          ],
        },
        'orderTypeCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'templateCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'groupCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'baseUnitName': {
          'type': [
            'string',
            'null',
          ],
        },
        'baseUnitName1': {
          'type': [
            'string',
            'null',
          ],
        },
        'sendUnit': {
          'type': [
            'string',
            'null',
          ],
        },
        'minUnitName': {
          'type': [
            'string',
            'null',
          ],
        },
        'packUnitName': {
          'type': [
            'string',
            'null',
          ],
        },
        'remark': {
          'type': [
            'string',
            'null',
          ],
        },
        'allergyCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'antibioticLevel': {
          'type': [
            'string',
            'null',
          ],
        },
        'seminalAnestheticCls': {
          'type': [
            'string',
            'null',
          ],
        },
        'excludeGroupCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'regularName': {
          'type': [
            'string',
            'null',
          ],
        },
        'packQty': {
          'type': [
            'number',
            'null',
          ],
        },
        'excludeType': {
          'type': [
            'number',
            'null',
          ],
        },
        'days': {
          'type': [
            'number',
            'null',
          ],
        },
        'baseDose': {
          'type': [
            'number',
            'null',
          ],
        },
        'baseDose1': {
          'type': [
            'number',
            'null',
          ],
        },
        'unitPrice': {
          'type': [
            'number',
            'null',
          ],
        },
        'singleUse': {
          'type': [
            'boolean',
            'null',
          ],
        },
        'isApplyOrder': {
          'type': [
            'boolean',
            'null',
          ],
        },
        'required': {
          'type': [
            'boolean',
            'null',
          ],
        },
        'repeatable': {
          'type': [
            'boolean',
            'null',
          ],
        },
        'skinTestFlag': {
          'type': [
            'boolean',
            'null',
          ],
        },
        'isStop': {
          'type': [
            'boolean',
            'null',
          ],
        },
        'testIsGroup': {
          'type': [
            'boolean',
            'null',
          ],
        },
        'isSelf': {
          'type': [
            'boolean',
            'null',
          ],
        },
        'producerInfo': {
          'anyOf': [
            {
              'title': 'ProducerInfo',
              'description': '药品生产厂商的编码与名称，不含库存标识或库存状态。',
              'type': 'object',
              'additionalProperties': false,
              'properties': {
                'producerCode': {
                  'type': [
                    'string',
                    'null',
                  ],
                },
                'producerName': {
                  'type': [
                    'string',
                    'null',
                  ],
                },
              },
              'required': [],
            },
            {
              'type': 'null',
            },
          ],
        },
        'operations': {
          'anyOf': [
            {
              'type': 'array',
              'items': {
                '$ref': '#/definitions/OperationDefinition',
              },
            },
            {
              'type': 'null',
            },
          ],
        },
        'applyData': {
          'anyOf': [
            {
              '$ref': '#/definitions/OrderApplicationDefinition',
            },
            {
              'type': 'null',
            },
          ],
        },
        'herbalRecipe': {
          'anyOf': [
            {
              '$ref': '#/definitions/HerbalRecipeDefinition',
            },
            {
              'type': 'null',
            },
          ],
        },
      },
      'required': [
        'localId',
        'projectType',
        'levelType',
        'name',
      ],
    },
    'OrderGroupDefinition': {
      'title': 'OrderGroupDefinition',
      'description': '成组医嘱的定义容器；成员只能为单项医嘱。',
      'type': 'object',
      'additionalProperties': false,
      'properties': {
        'localId': {
          'type': 'string',
          'minLength': 1,
          'maxLength': 128,
          'description': '稳定本地身份；不是医院业务 ID。',
        },
        'id': {
          'type': [
            'integer',
            'null',
          ],
          'minimum': 0,
          'maximum': 9007199254740991,
          'description': '原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。',
        },
        'projectType': {
          'const': 0,
        },
        'levelType': {
          'const': 2,
        },
        'name': {
          'type': [
            'string',
            'null',
          ],
        },
        'sort': {
          'type': [
            'integer',
            'null',
          ],
        },
        'required': {
          'type': [
            'boolean',
            'null',
          ],
        },
        'repeatable': {
          'type': [
            'boolean',
            'null',
          ],
        },
        'singleUse': {
          'type': [
            'boolean',
            'null',
          ],
        },
        'children': {
          'anyOf': [
            {
              'type': 'array',
              'items': {
                '$ref': '#/definitions/SingleOrderDefinition',
              },
            },
            {
              'type': 'null',
            },
          ],
        },
      },
      'required': [
        'localId',
        'projectType',
        'levelType',
        'name',
        'children',
      ],
    },
    'OrderBundleDefinition': {
      'title': 'OrderBundleDefinition',
      'description': '组包医嘱的定义容器；成员只能为单项医嘱或成组。',
      'type': 'object',
      'additionalProperties': false,
      'properties': {
        'localId': {
          'type': 'string',
          'minLength': 1,
          'maxLength': 128,
          'description': '稳定本地身份；不是医院业务 ID。',
        },
        'id': {
          'type': [
            'integer',
            'null',
          ],
          'minimum': 0,
          'maximum': 9007199254740991,
          'description': '原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。',
        },
        'projectType': {
          'const': 0,
        },
        'levelType': {
          'const': 3,
        },
        'name': {
          'type': [
            'string',
            'null',
          ],
        },
        'sort': {
          'type': [
            'integer',
            'null',
          ],
        },
        'required': {
          'type': [
            'boolean',
            'null',
          ],
        },
        'repeatable': {
          'type': [
            'boolean',
            'null',
          ],
        },
        'singleUse': {
          'type': [
            'boolean',
            'null',
          ],
        },
        'children': {
          'anyOf': [
            {
              'type': 'array',
              'items': {
                'anyOf': [
                  {
                    '$ref': '#/definitions/SingleOrderDefinition',
                  },
                  {
                    '$ref': '#/definitions/OrderGroupDefinition',
                  },
                ],
              },
            },
            {
              'type': 'null',
            },
          ],
        },
      },
      'required': [
        'localId',
        'projectType',
        'levelType',
        'name',
        'children',
      ],
    },
    'OrderDefinition': {
      'title': 'OrderDefinition',
      'description': '按 levelType 区分单项、成组和组包的医嘱定义。',
      'anyOf': [
        {
          '$ref': '#/definitions/SingleOrderDefinition',
        },
        {
          '$ref': '#/definitions/OrderGroupDefinition',
        },
        {
          '$ref': '#/definitions/OrderBundleDefinition',
        },
      ],
    },
    'BranchDefinition': {
      'title': 'BranchDefinition',
      'description': '阶段到相关路径的分支引用；本地引用与医院引用分别保留。',
      'type': 'object',
      'additionalProperties': false,
      'properties': {
        'localId': {
          'type': 'string',
          'minLength': 1,
          'maxLength': 128,
          'description': '稳定本地身份；不是医院业务 ID。',
        },
        'id': {
          'type': [
            'integer',
            'null',
          ],
          'minimum': 0,
          'maximum': 9007199254740991,
          'description': '原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。',
        },
        'name': {
          'type': [
            'string',
            'null',
          ],
        },
        'parentTreatmentId': {
          'type': [
            'integer',
            'null',
          ],
          'minimum': 0,
          'maximum': 9007199254740991,
          'description': '原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。',
        },
        'relatedClinicalPathwayId': {
          'type': [
            'integer',
            'null',
          ],
          'minimum': 0,
          'maximum': 9007199254740991,
          'description': '原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。',
        },
        'relatedClinicalPathwayLocalId': {
          'anyOf': [
            {
              'type': 'string',
              'minLength': 1,
              'maxLength': 128,
              'description': '稳定本地身份；不是医院业务 ID。',
            },
            {
              'type': 'null',
            },
          ],
        },
        'relatedClinicalPathwayCode': {
          'type': [
            'string',
            'null',
          ],
        },
        'relatedClinicalPathwayVersion': {
          'type': [
            'string',
            'number',
            'null',
          ],
        },
        'clinicalProperties': {
          'type': [
            'string',
            'null',
          ],
        },
      },
      'required': [
        'localId',
        'name',
        'relatedClinicalPathwayId',
        'relatedClinicalPathwayLocalId',
      ],
    },
    'TreatmentDefinition': {
      'title': 'TreatmentDefinition',
      'description': '路径阶段的日期基准、前驱引用、三类项目与分支定义。',
      'type': 'object',
      'additionalProperties': false,
      'properties': {
        'localId': {
          'type': 'string',
          'minLength': 1,
          'maxLength': 128,
          'description': '稳定本地身份；不是医院业务 ID。',
        },
        'id': {
          'type': [
            'integer',
            'null',
          ],
          'minimum': 0,
          'maximum': 9007199254740991,
          'description': '原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。',
        },
        'name': {
          'type': [
            'string',
            'null',
          ],
        },
        'sort': {
          'type': [
            'integer',
            'null',
          ],
        },
        'clinicalAttributes': {
          'type': [
            'string',
            'null',
          ],
        },
        'nodeAttribute': {
          'enum': [
            0,
            1,
            2,
            null,
          ],
          'description': '0 住院日、1 手术日、2 出院日；未知为 null。',
        },
        'inpatDayRange': {
          '$ref': '#/definitions/DefinitionRange',
        },
        'parentTreatmentId': {
          'type': [
            'integer',
            'null',
          ],
          'minimum': 0,
          'maximum': 9007199254740991,
          'description': '原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。',
        },
        'parentTreatmentLocalId': {
          'anyOf': [
            {
              'type': 'string',
              'minLength': 1,
              'maxLength': 128,
              'description': '稳定本地身份；不是医院业务 ID。',
            },
            {
              'type': 'null',
            },
          ],
        },
        'branchs': {
          'anyOf': [
            {
              'type': 'array',
              'items': {
                '$ref': '#/definitions/BranchDefinition',
              },
            },
            {
              'type': 'null',
            },
          ],
        },
        'recordTreatmentProjects': {
          'anyOf': [
            {
              'type': 'array',
              'items': {
                '$ref': '#/definitions/WorkDefinition',
              },
            },
            {
              'type': 'null',
            },
          ],
        },
        'nursingTreatmentProjects': {
          'anyOf': [
            {
              'type': 'array',
              'items': {
                '$ref': '#/definitions/WorkDefinition',
              },
            },
            {
              'type': 'null',
            },
          ],
        },
        'orderTreatmentProjects': {
          'anyOf': [
            {
              'type': 'array',
              'items': {
                '$ref': '#/definitions/OrderDefinition',
              },
            },
            {
              'type': 'null',
            },
          ],
        },
      },
      'required': [
        'localId',
        'name',
        'nodeAttribute',
        'inpatDayRange',
        'parentTreatmentLocalId',
        'branchs',
        'recordTreatmentProjects',
        'nursingTreatmentProjects',
        'orderTreatmentProjects',
      ],
    },
    'ClinicalPathwayDefinition': {
      'title': 'ClinicalPathwayDefinition',
      'description': 'EMR 权威路径定义正文；未读集合和未知参数允许为 null。',
      'type': 'object',
      'additionalProperties': false,
      'properties': {
        'localId': {
          'type': 'string',
          'minLength': 1,
          'maxLength': 128,
          'description': '稳定本地身份；不是医院业务 ID。',
        },
        'id': {
          'type': [
            'integer',
            'null',
          ],
          'minimum': 0,
          'maximum': 9007199254740991,
          'description': '原医院数字身份；未入库对象省略或为 null，不放入本地字符串身份。',
        },
        'code': {
          'type': [
            'string',
            'null',
          ],
        },
        'name': {
          'type': [
            'string',
            'null',
          ],
        },
        'description': {
          'type': [
            'string',
            'null',
          ],
        },
        'version': {
          'type': [
            'string',
            'number',
            'null',
          ],
        },
        'isTreatmentPackage': {
          'type': [
            'boolean',
            'null',
          ],
        },
        'isBranchPath': {
          'type': [
            'boolean',
            'null',
          ],
        },
        'createDept': {
          'anyOf': [
            {
              '$ref': '#/definitions/CodeName',
            },
            {
              'type': 'null',
            },
          ],
        },
        'deptInfos': {
          'anyOf': [
            {
              'type': 'array',
              'items': {
                '$ref': '#/definitions/DepartmentDefinition',
              },
            },
            {
              'type': 'null',
            },
          ],
        },
        'feesRange': {
          '$ref': '#/definitions/DefinitionRange',
        },
        'feeCurrency': {
          'type': [
            'string',
            'null',
          ],
        },
        'inpatDayRange': {
          '$ref': '#/definitions/DefinitionRange',
        },
        'diagnoseGroup': {
          'anyOf': [
            {
              'type': 'array',
              'items': {
                '$ref': '#/definitions/DiagnosisDefinition',
              },
            },
            {
              'type': 'null',
            },
          ],
        },
        'inclusionAssessment': {
          'anyOf': [
            {
              'type': 'array',
              'items': {
                '$ref': '#/definitions/InclusionAssessmentDefinition',
              },
            },
            {
              'type': 'null',
            },
          ],
        },
        'treatments': {
          'anyOf': [
            {
              'type': 'array',
              'items': {
                '$ref': '#/definitions/TreatmentDefinition',
              },
            },
            {
              'type': 'null',
            },
          ],
        },
      },
      'required': [
        'localId',
        'name',
        'feesRange',
        'inpatDayRange',
        'diagnoseGroup',
        'inclusionAssessment',
        'treatments',
      ],
    },
  },
}
