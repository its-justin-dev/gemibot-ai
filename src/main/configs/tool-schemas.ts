import { Type, type FunctionDeclaration, type Schema } from '@google/genai'

import type { SchemaSpec, SchemaTypeName, ToolDecl } from '../../shared/constants/tool-definitions'

const TYPE_BY_NAME: Record<SchemaTypeName, Type> = {
  STRING: Type.STRING,
  INTEGER: Type.INTEGER,
  BOOLEAN: Type.BOOLEAN,
  NUMBER: Type.NUMBER,
  ARRAY: Type.ARRAY,
  OBJECT: Type.OBJECT
}

export function toSchema(spec: SchemaSpec): Schema {
  const schema: Schema = { type: TYPE_BY_NAME[spec.type] }
  if (spec.description !== undefined) schema.description = spec.description
  if (spec.items !== undefined) schema.items = toSchema(spec.items)
  if (spec.properties !== undefined) {
    const properties: Record<string, Schema> = {}
    for (const [name, child] of Object.entries(spec.properties)) properties[name] = toSchema(child)
    schema.properties = properties
  }
  if (spec.required !== undefined && spec.required.length > 0) schema.required = [...spec.required]
  return schema
}

export function toFunctionDeclaration(decl: ToolDecl): FunctionDeclaration {
  return {
    name: decl.name,
    description: decl.description,
    parameters: toSchema(decl.parameters)
  }
}

export function toFunctionDeclarations(decls: ToolDecl[]): FunctionDeclaration[] {
  return decls.map(toFunctionDeclaration)
}
