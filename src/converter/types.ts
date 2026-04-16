/**
 * Internal types used by the JSON Schema converters.
 */

import type { EStructuralFeature, EClass, EClassifier } from '@emfts/core';

/** Base class for deferred reference resolution */
export interface DeferredReference {
  kind: 'type' | 'config';
  targetSchemaName: string;
}

/** A deferred type reference on a structural feature */
export interface DeferredTypeReference extends DeferredReference {
  kind: 'type';
  feature: EStructuralFeature;
}

/** A deferred config reference for feature creation */
export interface DeferredConfigReference extends DeferredReference {
  kind: 'config';
  owningClass: EClass;
  featureName: string;
}

/** Variant schema for oneOf / anyOf handling */
export interface VariantSchema {
  title: string;
  schema: Record<string, any>;
}

/** Result of structural analysis for oneOf variants */
export interface StructuralAnalysis {
  commonProperties: string[];
  commonRequiredProperties: string[];
  commonPropertyRatio: number;
}

/** Namespace tree node for hierarchical grouping */
export interface NamespaceNode {
  name: string;
  classifiers: EClassifier[];
  children: Map<string, NamespaceNode>;
}
