/**
 * Utility for JSON Schema keyword classification and validation.
 */

import { JsonSchemaConversionDiagnostic, DiagnosticCode } from './JsonSchemaConversionDiagnostic';

// Fully Supported Keywords

export const CORE_SUPPORTED = new Set([
  '$schema', '$id', '$ref', '$defs', 'definitions', '$anchor',
]);

export const TYPE_SUPPORTED = new Set([
  'type', 'enum', 'const',
]);

export const OBJECT_SUPPORTED = new Set([
  'properties', 'required', 'additionalProperties',
  'minProperties', 'maxProperties',
]);

export const ARRAY_SUPPORTED = new Set([
  'items', 'minItems', 'maxItems', 'uniqueItems',
]);

export const COMPOSITION_SUPPORTED = new Set([
  'allOf', 'anyOf', 'oneOf',
]);

export const VALIDATION_SUPPORTED = new Set([
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'multipleOf', 'minLength', 'maxLength', 'pattern', 'format',
]);

export const ANNOTATION_SUPPORTED = new Set([
  'title', 'description', 'default', 'examples',
  'readOnly', 'writeOnly', 'deprecated', '$comment',
]);

export const CONTENT_SUPPORTED = new Set([
  'contentEncoding', 'contentMediaType',
]);

// Partially Supported Keywords

export const PARTIALLY_SUPPORTED = new Set([
  'patternProperties',
  'unevaluatedProperties',
]);

// Unsupported Keywords

export const UNSUPPORTED = new Set([
  'not',
  'if', 'then', 'else',
  'prefixItems',
  'contains', 'minContains', 'maxContains',
  'propertyNames',
  'dependentRequired', 'dependentSchemas',
  '$dynamicRef', '$dynamicAnchor',
  'unevaluatedItems',
  'contentSchema',
  '$vocabulary',
]);

export enum SupportLevel {
  FULL = 'FULL',
  PARTIAL = 'PARTIAL',
  NONE = 'NONE',
  UNKNOWN = 'UNKNOWN',
}

export function checkForUnsupportedKeywords(
  schemaNode: Record<string, any> | null,
  location: string
): JsonSchemaConversionDiagnostic[] {
  if (!schemaNode || typeof schemaNode !== 'object') {
    return [];
  }

  const diagnostics: JsonSchemaConversionDiagnostic[] = [];

  for (const keyword of UNSUPPORTED) {
    if (keyword in schemaNode) {
      diagnostics.push(JsonSchemaConversionDiagnostic.unsupportedFeature(keyword, location));
    }
  }

  if ('patternProperties' in schemaNode) {
    diagnostics.push(
      JsonSchemaConversionDiagnostic.partialSupport(
        'patternProperties',
        location,
        'preserved as annotation but no EMF equivalent'
      )
    );
  }

  return diagnostics;
}

export function isFullySupported(keyword: string): boolean {
  return (
    CORE_SUPPORTED.has(keyword) ||
    TYPE_SUPPORTED.has(keyword) ||
    OBJECT_SUPPORTED.has(keyword) ||
    ARRAY_SUPPORTED.has(keyword) ||
    COMPOSITION_SUPPORTED.has(keyword) ||
    VALIDATION_SUPPORTED.has(keyword) ||
    ANNOTATION_SUPPORTED.has(keyword) ||
    CONTENT_SUPPORTED.has(keyword)
  );
}

export function isPartiallySupported(keyword: string): boolean {
  return PARTIALLY_SUPPORTED.has(keyword);
}

export function isUnsupported(keyword: string): boolean {
  return UNSUPPORTED.has(keyword);
}

export function getSupportLevel(keyword: string): SupportLevel {
  if (isFullySupported(keyword)) return SupportLevel.FULL;
  if (isPartiallySupported(keyword)) return SupportLevel.PARTIAL;
  if (isUnsupported(keyword)) return SupportLevel.NONE;
  return SupportLevel.UNKNOWN;
}
