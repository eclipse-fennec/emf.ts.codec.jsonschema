/**
 * Enhanced converter from JSON Schema to EMF EPackage.
 *
 * Supports:
 * - JSON Schema document -> EPackage with $id -> nsURI, title -> name
 * - object type -> EClass
 * - string type with enum -> EEnum
 * - primitive types -> EDataType / EAttribute
 * - $ref -> EReference
 * - allOf -> ESuperTypes (inheritance)
 * - anyOf/oneOf -> abstract parent with subclasses
 * - Discriminated unions (minProperties/maxProperties = 1)
 * - Context-specific variants
 * - Namespace paths (e.g., configs/kafka)
 * - Multi-type properties
 * - Top-level properties -> rootClass
 * - $anchor -> anchor-based reference resolution
 */

import {
  EPackage, EClass, EClassifier, EDataType, EStructuralFeature,
  EAnnotation, EModelElement,
  BasicEPackage, BasicEClass, BasicEAttribute, BasicEReference, BasicEDataType,
  getEcorePackage,
} from '@emfts/core';
import { BasicEEnum } from '@emfts/core';
import { BasicEEnumLiteral } from '@emfts/core';
import { BasicEAnnotation } from '@emfts/core';
import { JsonSchemaConversionDiagnostic } from './JsonSchemaConversionDiagnostic';
import { checkForUnsupportedKeywords } from './JsonSchemaKeywords';
import * as AnnotationSources from './AnnotationSources';
import type { DeferredTypeReference, DeferredConfigReference, DeferredReference } from './types';

const ARTIFICIAL_CLASSIFIER_PREFIX = 'ArtificialClassifier';
const SIMILARITY_THRESHOLD = 0.3;

type JsonObj = Record<string, any>;

interface PropertySchema {
  schema: JsonObj;
}

interface VariantSchema {
  title: string;
  schema: JsonObj;
}

interface InternalStructuralAnalysis {
  commonProperties: Map<string, PropertySchema>;
  commonRequiredProperties: Set<string>;
  commonPropertyRatio: number;
}

export class JsonSchemaToEPackageConverter {
  private classifierMap!: Map<string, EClassifier>;
  private schemaDefinitions!: Map<string, JsonObj>;
  private missingRefMap!: Map<BasicEReference, string>;
  private anyOfRefMap!: Map<EClassifier, string[]>;
  private allOfRefMap!: Map<BasicEClass, string[]>;
  private cachedClassifiers!: Map<string, EClassifier>;
  private parentClassMaps!: Map<string, BasicEClass>;
  private anchorMap!: Map<string, EClassifier>;
  private deferredReferences!: DeferredReference[];
  private diagnostics_!: JsonSchemaConversionDiagnostic[];
  private artificialClassifierCounter!: number;
  private schemaFeature!: string | null;

  /**
   * Converts a parsed JSON Schema object to an EPackage.
   */
  convert(rootNode: JsonObj, schemaFeature?: string | null): EPackage {
    this.schemaFeature = schemaFeature ?? null;
    this.resetState();
    return this.convertNode(rootNode);
  }

  /**
   * Converts a JSON Schema string to an EPackage.
   */
  convertFromString(jsonString: string, schemaFeature?: string | null): EPackage {
    const rootNode = JSON.parse(jsonString);
    return this.convert(rootNode, schemaFeature);
  }

  /**
   * Converts a JSON Schema to a single EClass.
   */
  convertToEClass(schemaNode: JsonObj, name?: string | null): EClass | null {
    this.resetState();
    if (!name) {
      name = schemaNode.title ?? 'EClass';
    }
    const classifier = this.processSchemaDefinition(schemaNode, name!, name!);
    this.resolveDeferredReferences();
    this.resolveMissingReferences();
    this.resolveAnyOfReferences();
    this.resolveAllOfReferences();
    if (!(classifier instanceof BasicEClass)) {
      return null;
    }

    const eClass = classifier as BasicEClass;

    if (schemaNode.$schema) {
      this.addEAnnotation(eClass, AnnotationSources.JSONSCHEMA, 'schema', schemaNode.$schema);
    }
    if (schemaNode.$id) {
      this.addEAnnotation(eClass, AnnotationSources.JSONSCHEMA, 'id', schemaNode.$id);
    }
    if (schemaNode.title) {
      this.addEAnnotation(eClass, AnnotationSources.JSONSCHEMA, 'originalTitle', schemaNode.title);
    }

    return eClass;
  }

  getDiagnostics(): JsonSchemaConversionDiagnostic[] {
    return this.diagnostics_ ? [...this.diagnostics_] : [];
  }

  private resetState(): void {
    this.classifierMap = new Map();
    this.schemaDefinitions = new Map();
    this.missingRefMap = new Map();
    this.anyOfRefMap = new Map();
    this.allOfRefMap = new Map();
    this.cachedClassifiers = new Map();
    this.parentClassMaps = new Map();
    this.anchorMap = new Map();
    this.deferredReferences = [];
    this.diagnostics_ = [];
    this.artificialClassifierCounter = 0;
  }

  private convertNode(rootNode: JsonObj): EPackage {
    const ePackage = new BasicEPackage();

    if (rootNode.$schema) {
      this.addEAnnotation(ePackage, AnnotationSources.JSONSCHEMA, 'schema', rootNode.$schema);
    }

    if (rootNode.$id) {
      ePackage.setNsURI(rootNode.$id);
    }

    if (rootNode.title) {
      this.addEAnnotation(ePackage, AnnotationSources.JSONSCHEMA, 'originalTitle', rootNode.title);
      ePackage.setName(this.sanitizeName(rootNode.title));
    }

    if (rootNode.description) {
      this.addEAnnotation(ePackage, AnnotationSources.GEN_MODEL, 'documentation', rootNode.description);
    }

    // Process definitions section
    if (this.schemaFeature) {
      const defsNode = rootNode[this.schemaFeature];
      if (defsNode) {
        this.processDefinitions(defsNode, ePackage, '');
      }
    } else {
      let foundDefinitions = false;
      for (const feature of ['definitions', '$defs', 'schemas']) {
        const defsNode = rootNode[feature];
        if (defsNode) {
          this.schemaFeature = feature;
          this.processDefinitions(defsNode, ePackage, '');
          foundDefinitions = true;
          break;
        }
      }

      if (!foundDefinitions && this.isDirectDefinitionsNode(rootNode)) {
        this.processDefinitions(rootNode, ePackage, '');
      }
    }

    // Process top-level properties (creates rootClass)
    if (rootNode.properties) {
      this.processTopLevelProperties(rootNode.properties, rootNode, ePackage);
    }

    // Resolve deferred references
    this.resolveDeferredReferences();
    this.resolveMissingReferences();
    this.resolveAnyOfReferences();
    this.resolveAllOfReferences();

    // Add all classifiers from classifierMap to the package
    for (const classifier of this.classifierMap.values()) {
      if (!ePackage.getEClassifiers().includes(classifier)) {
        ePackage.getEClassifiers().push(classifier);
      }
    }

    return ePackage;
  }

  private processDefinitions(defsNode: JsonObj, parentPackage: BasicEPackage, namespacePrefix: string): void {
    for (const defName of Object.keys(defsNode)) {
      const defNode = defsNode[defName];
      const qualifiedName = namespacePrefix ? `${namespacePrefix}/${defName}` : defName;

      if (this.isOrganizationalNamespace(defNode)) {
        this.processDefinitions(defNode, parentPackage, qualifiedName);
      } else {
        this.schemaDefinitions.set(qualifiedName, defNode);
        const classifier = this.processSchemaDefinition(defNode, defName, qualifiedName);
        if (classifier) {
          this.classifierMap.set(qualifiedName, classifier);
          if (!parentPackage.getEClassifiers().includes(classifier)) {
            parentPackage.getEClassifiers().push(classifier);
          }
        }
      }
    }
  }

  private isOrganizationalNamespace(node: any): boolean {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false;

    const schemaKeywords = ['type', 'properties', 'oneOf', 'anyOf', 'allOf',
      '$ref', 'enum', 'items', 'required', 'additionalProperties'];
    for (const keyword of schemaKeywords) {
      if (keyword in node) return false;
    }

    for (const childName of Object.keys(node)) {
      if (!node[childName] || typeof node[childName] !== 'object' || Array.isArray(node[childName])) {
        return false;
      }
    }

    return true;
  }

  private isDirectDefinitionsNode(node: JsonObj): boolean {
    if (typeof node !== 'object' || Array.isArray(node)) return false;

    const keys = Object.keys(node);
    if (keys.length === 0) return false;

    const rootSchemaKeywords = ['$schema', '$id', 'title', 'description'];
    for (const keyword of rootSchemaKeywords) {
      if (keyword in node) return false;
    }

    for (const childName of keys) {
      const child = node[childName];
      if (!child || typeof child !== 'object' || Array.isArray(child)) return false;
      if (!this.looksLikeSchemaDefinition(child)) return false;
    }

    return true;
  }

  private looksLikeSchemaDefinition(node: JsonObj): boolean {
    const schemaKeywords = ['type', 'properties', 'oneOf', 'anyOf', 'allOf',
      '$ref', 'enum', 'items', 'required', 'additionalProperties'];
    for (const keyword of schemaKeywords) {
      if (keyword in node) return true;
    }
    return false;
  }

  private processSchemaDefinition(schemaNode: JsonObj, name: string, qualifiedName: string): EClassifier | null {
    this.diagnostics_.push(...checkForUnsupportedKeywords(schemaNode, qualifiedName));

    // Handle oneOf - discriminated union or variants
    if (schemaNode.oneOf) {
      return this.processOneOf(schemaNode, name, qualifiedName);
    }

    // Handle enum
    if (schemaNode.enum) {
      return this.createEEnum(schemaNode, name, qualifiedName);
    }

    // Handle allOf composition
    if (schemaNode.allOf) {
      return this.createClassWithAllOf(schemaNode, name, qualifiedName);
    }

    // Handle type-based schemas
    if (schemaNode.type) {
      if (typeof schemaNode.type === 'string') {
        const type = schemaNode.type;
        if (type === 'object') {
          return this.createEClass(schemaNode, name, qualifiedName);
        } else if (type === 'array') {
          return this.createArrayWrapperClass(schemaNode, name, qualifiedName);
        } else {
          return this.createEDataType(schemaNode, name);
        }
      } else {
        // Array of types
        return this.createEDataType(schemaNode, name);
      }
    }

    return null;
  }

  private processOneOf(schemaNode: JsonObj, name: string, qualifiedName: string): EClassifier {
    const oneOfArray = schemaNode.oneOf as JsonObj[];

    if (this.isDiscriminatedUnion(schemaNode)) {
      return this.createDiscriminatedUnion(schemaNode, oneOfArray, name, qualifiedName);
    } else {
      return this.createContextSpecificVariants(schemaNode, oneOfArray, name, qualifiedName);
    }
  }

  private isDiscriminatedUnion(schemaNode: JsonObj): boolean {
    return schemaNode.minProperties === 1 && schemaNode.maxProperties === 1;
  }

  private createDiscriminatedUnion(schemaNode: JsonObj, oneOfArray: JsonObj[],
    name: string, qualifiedName: string): BasicEClass {
    const abstractBase = new BasicEClass();
    const capitalizedName = this.capitalizeFirst(name);
    abstractBase.setName(capitalizedName);
    abstractBase.setAbstract(true);
    abstractBase.setInterface(false);

    if (name !== capitalizedName) {
      this.addEAnnotation(abstractBase, AnnotationSources.JSONSCHEMA, 'originalName', name);
      this.addEAnnotation(abstractBase, AnnotationSources.EXTENDED_METADATA, 'name', name);
    }

    const namespacePath = this.extractNamespacePath(qualifiedName);
    if (namespacePath) {
      this.addEAnnotation(abstractBase, AnnotationSources.JSONSCHEMA, 'namespacePath', namespacePath);
    }

    if (schemaNode.description) {
      this.addEAnnotation(abstractBase, AnnotationSources.GEN_MODEL, 'documentation', schemaNode.description);
    }

    this.addEAnnotation(abstractBase, AnnotationSources.JSONSCHEMA, 'discriminatedUnion', 'true');
    this.classifierMap.set(qualifiedName, abstractBase);

    for (const option of oneOfArray) {
      const discriminatorKey = this.extractDiscriminatorKey(option);
      if (!discriminatorKey) continue;

      const propertiesNode = option.properties;
      if (!propertiesNode || !(discriminatorKey in propertiesNode)) continue;

      const propertySchema = propertiesNode[discriminatorKey];
      const subclassName = this.capitalizeFirst(discriminatorKey) + this.capitalizeFirst(name);

      const subclass = this.createConcreteSubclass(propertySchema, subclassName,
        discriminatorKey, abstractBase, qualifiedName);
      if (subclass) {
        const subclassQualifiedName = `${qualifiedName}/${discriminatorKey}`;
        this.classifierMap.set(subclassQualifiedName, subclass);
      }
    }

    this.addCodecTypeAnnotationsForDiscriminatedUnion(abstractBase);

    return abstractBase;
  }

  private extractDiscriminatorKey(option: JsonObj): string | null {
    if (!option.required || !Array.isArray(option.required)) return null;
    if (option.required.length !== 1) return null;
    return option.required[0];
  }

  private createConcreteSubclass(propertySchema: JsonObj, subclassName: string,
    discriminatorKey: string, abstractBase: BasicEClass,
    parentQualifiedName: string): BasicEClass | null {
    if (propertySchema.$ref) {
      const refPath = propertySchema.$ref;
      const referencedSchemaName = this.extractSchemaNameFromRef(refPath);

      const subclass = new BasicEClass();
      subclass.setName(subclassName);
      subclass.getESuperTypes().push(abstractBase);

      this.addEAnnotation(subclass, AnnotationSources.JSONSCHEMA, 'discriminatorKey', discriminatorKey);
      this.addEAnnotation(subclass, AnnotationSources.JSONSCHEMA, 'configRef', refPath);

      this.deferredReferences.push({
        kind: 'config',
        targetSchemaName: referencedSchemaName,
        owningClass: subclass,
        featureName: 'config',
      } as DeferredConfigReference);

      this.classifierMap.set(subclassName, subclass);
      return subclass;
    }

    return null;
  }

  private addCodecTypeAnnotationsForDiscriminatedUnion(unionClass: BasicEClass): void {
    const discriminatedAnnotation = unionClass.getEAnnotation(AnnotationSources.JSONSCHEMA);
    if (!discriminatedAnnotation || discriminatedAnnotation.getDetails().getByKey('discriminatedUnion') !== 'true') {
      return;
    }

    const typeMap = new Map<string, string>();
    for (const classifier of this.classifierMap.values()) {
      if (classifier instanceof BasicEClass) {
        if (classifier.getESuperTypes().includes(unionClass)) {
          const childAnnotation = classifier.getEAnnotation(AnnotationSources.JSONSCHEMA);
          if (childAnnotation) {
            const discriminatorKey = childAnnotation.getDetails().getByKey('discriminatorKey');
            if (discriminatorKey) {
              typeMap.set(discriminatorKey, classifier.getName()!);
            }
          }
        }
      }
    }

    if (typeMap.size > 0) {
      const codecTypeAnnotation = new BasicEAnnotation();
      codecTypeAnnotation.setSource('codec.type');
      codecTypeAnnotation.getDetails().putByKey('typeKey', '*');
      codecTypeAnnotation.getDetails().putByKey('strategy', 'NAME');

      for (const [key, value] of typeMap) {
        codecTypeAnnotation.getDetails().putByKey(key, value);
      }

      unionClass.getEAnnotations().push(codecTypeAnnotation);
    }
  }

  private createContextSpecificVariants(schemaNode: JsonObj, oneOfArray: JsonObj[],
    name: string, qualifiedName: string): BasicEClass {
    const variants: VariantSchema[] = [];

    for (let i = 0; i < oneOfArray.length; i++) {
      const variantNode = oneOfArray[i];
      const title = variantNode.title ?? `Variant${i}`;
      variants.push({ title, schema: variantNode });
    }

    const analysis = this.analyzeStructuralSimilarity(variants);

    // Create base class
    const baseClass = new BasicEClass();
    const baseClassName = this.capitalizeFirst(name) + 'Base';
    baseClass.setName(baseClassName);
    baseClass.setAbstract(true);

    if (name !== baseClassName) {
      this.addEAnnotation(baseClass, AnnotationSources.JSONSCHEMA, 'originalName', name);
      this.addEAnnotation(baseClass, AnnotationSources.EXTENDED_METADATA, 'name', name);
    }

    const namespacePath = this.extractNamespacePath(qualifiedName);
    if (namespacePath) {
      this.addEAnnotation(baseClass, AnnotationSources.JSONSCHEMA, 'namespacePath', namespacePath);
    }

    // Add common properties to base if there are enough
    const hasCommonProperties = analysis.commonPropertyRatio >= SIMILARITY_THRESHOLD && analysis.commonProperties.size > 0;
    if (hasCommonProperties) {
      for (const [propName, propSchema] of analysis.commonProperties) {
        const feature = this.createStructuralFeature(propSchema.schema, propName, qualifiedName);
        if (feature) {
          if (analysis.commonRequiredProperties.has(propName)) {
            feature.setLowerBound(1);
          }
          baseClass.getEStructuralFeatures().push(feature);
        }
      }
    }

    this.addEAnnotation(baseClass, AnnotationSources.JSONSCHEMA, 'commonBase', 'true');
    this.classifierMap.set(qualifiedName + 'Base', baseClass);

    // Create variant-specific classes
    for (const variant of variants) {
      const variantClass = new BasicEClass();
      const variantName = this.capitalizeFirst(name) + this.sanitizeName(variant.title);
      variantClass.setName(variantName);

      if (name !== variantName) {
        this.addEAnnotation(variantClass, AnnotationSources.JSONSCHEMA, 'originalName', name);
        this.addEAnnotation(variantClass, AnnotationSources.EXTENDED_METADATA, 'name', name);
      }

      if (namespacePath) {
        this.addEAnnotation(variantClass, AnnotationSources.JSONSCHEMA, 'namespacePath', namespacePath);
      }

      variantClass.getESuperTypes().push(baseClass);

      const propertiesNode = variant.schema.properties;
      if (propertiesNode) {
        for (const propName of Object.keys(propertiesNode)) {
          if (hasCommonProperties && analysis.commonProperties.has(propName)) {
            continue;
          }

          const feature = this.createStructuralFeature(propertiesNode[propName], propName, qualifiedName);
          if (feature) {
            if (variant.schema.required && Array.isArray(variant.schema.required) &&
              variant.schema.required.includes(propName)) {
              feature.setLowerBound(1);
            }
            variantClass.getEStructuralFeatures().push(feature);
          }
        }
      } else {
        this.handleVariantWithoutProperties(variant.schema, variantClass, qualifiedName);
      }

      if (variant.schema.additionalProperties !== undefined) {
        const val = variant.schema.additionalProperties;
        this.addEAnnotation(variantClass, AnnotationSources.JSONSCHEMA, 'additionalProperties',
          typeof val === 'boolean' ? String(val) : JSON.stringify(val, null, 2));
      }

      this.addEAnnotation(variantClass, AnnotationSources.JSONSCHEMA, 'variant', variant.title);
      this.classifierMap.set(`${qualifiedName}/${variant.title}`, variantClass);
    }

    return baseClass;
  }

  private handleVariantWithoutProperties(schema: JsonObj, variantClass: BasicEClass, contextPath: string): void {
    if (schema.type && typeof schema.type === 'string') {
      const type = schema.type;

      if (type === 'object') {
        if (schema.additionalProperties !== undefined) {
          this.addEAnnotation(variantClass, AnnotationSources.JSONSCHEMA,
            'additionalProperties', JSON.stringify(schema.additionalProperties));

          const mapAttribute = new BasicEAttribute();
          mapAttribute.setName('entries');
          mapAttribute.setEType(getEcorePackage().getEJavaObject());
          mapAttribute.setLowerBound(0);
          mapAttribute.setUpperBound(-1);
          this.addEAnnotation(mapAttribute, AnnotationSources.JSONSCHEMA,
            'mapEntryType', JSON.stringify(schema.additionalProperties));
          variantClass.getEStructuralFeatures().push(mapAttribute);
        }
      } else if (type === 'array') {
        if (schema.items) {
          this.addEAnnotation(variantClass, AnnotationSources.JSONSCHEMA,
            'arrayItems', JSON.stringify(schema.items));
        }

        const arrayAttribute = new BasicEAttribute();
        arrayAttribute.setName('items');
        arrayAttribute.setEType(getEcorePackage().getEJavaObject());
        arrayAttribute.setLowerBound(0);
        arrayAttribute.setUpperBound(-1);
        variantClass.getEStructuralFeatures().push(arrayAttribute);

        this.addEAnnotation(variantClass, AnnotationSources.JSONSCHEMA, 'arrayType', 'true');
      } else {
        const valueAttribute = new BasicEAttribute();
        valueAttribute.setName('value');
        valueAttribute.setEType(this.mapJsonTypeToEcore(type));
        valueAttribute.setLowerBound(1);
        variantClass.getEStructuralFeatures().push(valueAttribute);

        if (schema.default !== undefined) {
          this.addEAnnotation(valueAttribute, AnnotationSources.JSONSCHEMA,
            'default', JSON.stringify(schema.default));
        }
      }
    }
  }

  private analyzeStructuralSimilarity(variants: VariantSchema[]): InternalStructuralAnalysis {
    const analysis: InternalStructuralAnalysis = {
      commonProperties: new Map(),
      commonRequiredProperties: new Set(),
      commonPropertyRatio: 0,
    };

    if (variants.length === 0) return analysis;

    const allProperties: Map<string, PropertySchema>[] = [];
    for (const variant of variants) {
      allProperties.push(this.extractProperties(variant.schema));
    }

    let intersection = allProperties[0];
    for (let i = 1; i < allProperties.length; i++) {
      intersection = this.findPropertyIntersection(intersection, allProperties[i]);
    }

    analysis.commonProperties = intersection;

    const requiredSets: Set<string>[] = [];
    for (const variant of variants) {
      const required = new Set<string>();
      if (Array.isArray(variant.schema.required)) {
        for (const req of variant.schema.required) {
          required.add(req);
        }
      }
      requiredSets.push(required);
    }

    if (requiredSets.length > 0) {
      const commonRequired = new Set(requiredSets[0]);
      for (let i = 1; i < requiredSets.length; i++) {
        for (const item of commonRequired) {
          if (!requiredSets[i].has(item)) {
            commonRequired.delete(item);
          }
        }
      }
      analysis.commonRequiredProperties = commonRequired;
    }

    let totalPropertyCount = 0;
    for (const props of allProperties) {
      totalPropertyCount += props.size;
    }
    const commonPropertyCount = intersection.size * variants.length;
    analysis.commonPropertyRatio = totalPropertyCount > 0 ? commonPropertyCount / totalPropertyCount : 0;

    return analysis;
  }

  private extractProperties(schema: JsonObj): Map<string, PropertySchema> {
    const properties = new Map<string, PropertySchema>();
    if (!schema.properties) return properties;

    for (const propName of Object.keys(schema.properties)) {
      properties.set(propName, { schema: schema.properties[propName] });
    }

    return properties;
  }

  private findPropertyIntersection(
    map1: Map<string, PropertySchema>,
    map2: Map<string, PropertySchema>
  ): Map<string, PropertySchema> {
    const intersection = new Map<string, PropertySchema>();

    for (const [key, prop1] of map1) {
      if (map2.has(key)) {
        const prop2 = map2.get(key)!;
        if (JSON.stringify(prop1.schema) === JSON.stringify(prop2.schema)) {
          intersection.set(key, prop1);
        }
      }
    }

    return intersection;
  }

  private createEClass(classNode: JsonObj, name: string, qualifiedName: string): BasicEClass {
    const cacheKey = JSON.stringify(classNode);
    if (this.cachedClassifiers.has(cacheKey) && name.startsWith(ARTIFICIAL_CLASSIFIER_PREFIX)) {
      return this.cachedClassifiers.get(cacheKey) as BasicEClass;
    }

    const eClass = new BasicEClass();
    const capitalizedName = this.capitalizeFirst(name);
    eClass.setName(capitalizedName);

    if (name !== capitalizedName) {
      this.addEAnnotation(eClass, AnnotationSources.JSONSCHEMA, 'originalName', name);
      this.addEAnnotation(eClass, AnnotationSources.EXTENDED_METADATA, 'name', name);
    }

    const namespacePath = this.extractNamespacePath(qualifiedName);
    if (namespacePath) {
      this.addEAnnotation(eClass, AnnotationSources.JSONSCHEMA, 'namespacePath', namespacePath);
    }

    if (classNode.description) {
      this.addEAnnotation(eClass, AnnotationSources.GEN_MODEL, 'documentation', classNode.description);
    }

    const requiredNode = classNode.required;
    const propertiesNode = classNode.properties;

    if (propertiesNode) {
      for (const property of Object.keys(propertiesNode)) {
        const feature = this.createStructuralFeature(propertiesNode[property], property, qualifiedName);
        if (feature) {
          if (requiredNode && Array.isArray(requiredNode) && requiredNode.includes(feature.getName())) {
            feature.setLowerBound(1);
          }
          eClass.getEStructuralFeatures().push(feature);
        }
      }
    }

    if (classNode.additionalProperties !== undefined) {
      const val = classNode.additionalProperties;
      const value = typeof val === 'boolean' ? String(val) : JSON.stringify(val, null, 2);
      this.addEAnnotation(eClass, AnnotationSources.JSONSCHEMA, 'additionalProperties', value);
    }

    // Handle anyOf constraint
    if (classNode.anyOf) {
      this.handleAnyOf(classNode, eClass, qualifiedName);
    }

    // Preserve additional schema properties
    this.preserveAdditionalSchemaProperties(classNode, eClass);

    // Capture $anchor
    if (classNode.$anchor) {
      const anchor = classNode.$anchor;
      this.anchorMap.set(anchor, eClass);
      this.classifierMap.set(anchor, eClass);
      this.addEAnnotation(eClass, AnnotationSources.JSONSCHEMA, 'anchor', anchor);
    }

    this.cachedClassifiers.set(cacheKey, eClass);
    return eClass;
  }

  private createClassWithAllOf(classNode: JsonObj, name: string, qualifiedName: string): BasicEClass {
    const allOfNode = classNode.allOf;
    const parentNames: string[] = [];
    let eClass: BasicEClass | null = null;

    if (Array.isArray(allOfNode)) {
      for (const allOf of allOfNode) {
        if (allOf.$ref) {
          const refPath = allOf.$ref;
          const referencedSchemaName = this.extractSchemaNameFromRef(refPath);
          parentNames.push(referencedSchemaName);
        } else {
          if (!eClass) {
            eClass = this.createEClass(allOf, name, qualifiedName);
          }
        }
      }
    }

    if (!eClass) {
      eClass = new BasicEClass();
      const capitalizedName = this.capitalizeFirst(name);
      eClass.setName(capitalizedName);

      if (name !== capitalizedName) {
        this.addEAnnotation(eClass, AnnotationSources.JSONSCHEMA, 'originalName', name);
        this.addEAnnotation(eClass, AnnotationSources.EXTENDED_METADATA, 'name', name);
      }

      const namespacePath = this.extractNamespacePath(qualifiedName);
      if (namespacePath) {
        this.addEAnnotation(eClass, AnnotationSources.JSONSCHEMA, 'namespacePath', namespacePath);
      }
    }

    if (parentNames.length > 0) {
      this.allOfRefMap.set(eClass, parentNames);
    }

    this.addEAnnotation(eClass, AnnotationSources.JSONSCHEMA, 'allOf', JSON.stringify(allOfNode));

    return eClass;
  }

  private createArrayWrapperClass(schemaNode: JsonObj, name: string, qualifiedName: string): BasicEClass {
    const eClass = new BasicEClass();
    eClass.setName(this.capitalizeFirst(name));

    this.addEAnnotation(eClass, AnnotationSources.JSONSCHEMA, 'arrayWrapper', 'true');
    this.addEAnnotation(eClass, AnnotationSources.JSONSCHEMA, 'source', 'TopLevelArray');
    this.addEAnnotation(eClass, AnnotationSources.JSONSCHEMA, 'artificial', 'true');

    if (schemaNode.description) {
      this.addEAnnotation(eClass, AnnotationSources.GEN_MODEL, 'documentation', schemaNode.description);
    }

    if (schemaNode.items) {
      const itemsFeature = this.createStructuralFeature(schemaNode.items, 'items', qualifiedName);
      if (itemsFeature) {
        itemsFeature.setLowerBound(0);
        itemsFeature.setUpperBound(-1);
        eClass.getEStructuralFeatures().push(itemsFeature);
      }
    }

    return eClass;
  }

  private createEEnum(enumNode: JsonObj, name: string, qualifiedName: string): BasicEEnum {
    const cacheKey = JSON.stringify(enumNode);
    if (this.cachedClassifiers.has(cacheKey)) {
      return this.cachedClassifiers.get(cacheKey) as BasicEEnum;
    }

    const eEnum = new BasicEEnum();
    const capitalizedName = this.capitalizeFirst(name);
    eEnum.setName(capitalizedName);

    if (name !== capitalizedName) {
      this.addEAnnotation(eEnum, AnnotationSources.JSONSCHEMA, 'originalName', name);
      this.addEAnnotation(eEnum, AnnotationSources.EXTENDED_METADATA, 'name', name);
    }

    const namespacePath = this.extractNamespacePath(qualifiedName);
    if (namespacePath) {
      this.addEAnnotation(eEnum, AnnotationSources.JSONSCHEMA, 'namespacePath', namespacePath);
    }

    const enumValues = enumNode.enum;
    for (let e = 0; e < enumValues.length; e++) {
      const literal = new BasicEEnumLiteral();
      const literalName = String(enumValues[e]);
      literal.setLiteral(literalName);
      literal.setName(literalName);
      literal.setValue(e);
      eEnum.addLiteral(literal);
    }

    if (enumNode.description) {
      this.addEAnnotation(eEnum, AnnotationSources.GEN_MODEL, 'documentation', enumNode.description);
    }

    this.cachedClassifiers.set(cacheKey, eEnum);
    return eEnum;
  }

  private createEDataType(dtNode: JsonObj, name: string): BasicEDataType {
    const cacheKey = JSON.stringify(dtNode);
    if (this.cachedClassifiers.has(cacheKey)) {
      return this.cachedClassifiers.get(cacheKey) as BasicEDataType;
    }

    const dt = new BasicEDataType();
    dt.setName(this.capitalizeFirst(name));

    if (dtNode.description) {
      this.addEAnnotation(dt, AnnotationSources.GEN_MODEL, 'documentation', dtNode.description);
    }

    const typeNode = dtNode.type;
    if (Array.isArray(typeNode)) {
      const typesStr = typeNode.join(',');
      this.addEAnnotation(dt, AnnotationSources.JSONSCHEMA, 'dataType', typesStr);
      dt.setInstanceClassName('java.lang.Object');
    } else if (typeNode) {
      switch (typeNode) {
        case 'string':
          dt.setInstanceClassName('java.lang.String');
          break;
        case 'integer':
          dt.setInstanceClassName('java.lang.Integer');
          break;
        case 'number':
          dt.setInstanceClassName('java.lang.Double');
          break;
        case 'boolean':
          dt.setInstanceClassName('java.lang.Boolean');
          break;
        default:
          dt.setInstanceClassName('java.lang.Object');
          break;
      }
    }

    this.cachedClassifiers.set(cacheKey, dt);
    return dt;
  }

  private createStructuralFeature(propertyNode: JsonObj, name: string, contextPath: string): EStructuralFeature | null {
    let feature: EStructuralFeature | null = null;

    if (propertyNode.$ref) {
      feature = this.createRefFeature(propertyNode, name);
    } else if (propertyNode.type) {
      feature = this.createTypedFeature(propertyNode, name, contextPath);
    } else if (propertyNode.enum) {
      feature = this.createEnumFeature(propertyNode, name, contextPath);
    } else if (propertyNode.const !== undefined) {
      const inferredType = this.getJsonTypeFromConstValue(propertyNode.const);
      feature = this.createFeatureFromJsonType(inferredType, name, propertyNode, contextPath);
    } else if (propertyNode.anyOf) {
      feature = this.createMultiValueReference(propertyNode.anyOf, name, contextPath);
      if (feature) {
        this.addEAnnotation(feature, AnnotationSources.JSONSCHEMA, 'source', 'anyOf');
      }
    } else if (propertyNode.oneOf) {
      feature = this.createOneOfFeature(propertyNode, name, contextPath);
    }

    if (feature) {
      this.addCommonAnnotations(feature, propertyNode, false);
    }

    return feature;
  }

  private createRefFeature(propertyNode: JsonObj, name: string): BasicEReference {
    const reference = new BasicEReference();
    reference.setName(name);
    reference.setContainment(false);

    const refPath = propertyNode.$ref;
    this.addEAnnotation(reference, AnnotationSources.JSONSCHEMA, 'ref', refPath);

    const refName = this.extractSchemaNameFromRef(refPath);

    if (this.classifierMap.has(refName)) {
      reference.setEType(this.classifierMap.get(refName)!);
    } else {
      this.deferredReferences.push({
        kind: 'type',
        targetSchemaName: refName,
        feature: reference,
      } as DeferredTypeReference);
    }

    return reference;
  }

  private createTypedFeature(propertyNode: JsonObj, name: string, contextPath: string): EStructuralFeature | null {
    const typeNode = propertyNode.type;

    if (typeof typeNode === 'string') {
      return this.createFeatureFromJsonType(typeNode, name, propertyNode, contextPath);
    } else {
      // Multiple types -> multi-type property
      return this.handleMultiTypeProperty(propertyNode, typeNode, name, contextPath);
    }
  }

  private createEnumFeature(propertyNode: JsonObj, name: string, contextPath: string): EStructuralFeature | null {
    return this.createFeatureFromJsonType('string', name, propertyNode, contextPath);
  }

  private createOneOfFeature(propertyNode: JsonObj, name: string, contextPath: string): EStructuralFeature | null {
    const unionName = ARTIFICIAL_CLASSIFIER_PREFIX + (this.artificialClassifierCounter++);
    const unionClass = this.processOneOf(propertyNode, unionName, `${contextPath}/${unionName}`) as BasicEClass;
    if (unionClass) {
      this.addEAnnotation(unionClass, AnnotationSources.JSONSCHEMA, 'artificial', 'true');

      if (propertyNode.default !== undefined) {
        this.addEAnnotation(unionClass, AnnotationSources.JSONSCHEMA, 'default', JSON.stringify(propertyNode.default));
      }

      // Mark variant subclasses as artificial too
      for (const classifier of this.classifierMap.values()) {
        if (classifier instanceof BasicEClass) {
          if (classifier.getESuperTypes().includes(unionClass)) {
            this.addEAnnotation(classifier, AnnotationSources.JSONSCHEMA, 'artificial', 'true');
          }
        }
      }

      const reference = new BasicEReference();
      reference.setName(name);
      reference.setEType(unionClass);
      reference.setContainment(true);
      return reference;
    }
    return null;
  }

  private createFeatureFromJsonType(type: string, name: string, propertyNode: JsonObj, contextPath: string): EStructuralFeature | null {
    switch (type) {
      case 'array':
        return this.createArrayFeature(propertyNode, name, contextPath);
      case 'string':
        return this.createStringFeature(propertyNode, name, contextPath);
      case 'object':
        return this.createObjectFeature(propertyNode, name, contextPath);
      default: {
        const feature = new BasicEAttribute();
        feature.setName(name);
        feature.setEType(this.mapJsonTypeToEcore(type));
        this.preserveAdditionalSchemaProperties(propertyNode, feature);
        return feature;
      }
    }
  }

  private createArrayFeature(propertyNode: JsonObj, name: string, contextPath: string): EStructuralFeature | null {
    let feature: EStructuralFeature | null = null;

    if (propertyNode.items) {
      feature = this.createStructuralFeature(propertyNode.items, name, contextPath);
      if (feature) {
        this.addEAnnotation(feature, AnnotationSources.JSONSCHEMA, 'items', 'true');
      }
    } else if (propertyNode.const !== undefined) {
      if (Array.isArray(propertyNode.const) && propertyNode.const.length > 0) {
        const inferredType = this.getJsonTypeFromConstValue(propertyNode.const[0]);
        feature = this.createFeatureFromJsonType(inferredType, name, propertyNode.const, contextPath);
      }
    }

    if (feature) {
      if (propertyNode.minItems !== undefined) {
        feature.setLowerBound(propertyNode.minItems);
      } else {
        feature.setLowerBound(0);
      }
      if (propertyNode.maxItems !== undefined) {
        feature.setUpperBound(propertyNode.maxItems);
      } else {
        feature.setUpperBound(-1);
      }
    }

    return feature;
  }

  private createStringFeature(propertyNode: JsonObj, name: string, contextPath: string): EStructuralFeature {
    if (propertyNode.enum) {
      const eEnum = this.createEEnum(
        propertyNode,
        ARTIFICIAL_CLASSIFIER_PREFIX + (this.artificialClassifierCounter++),
        contextPath
      );
      this.addEAnnotation(eEnum, AnnotationSources.JSONSCHEMA, 'artificial', 'true');
      this.classifierMap.set(`${contextPath}/${eEnum.getName()}`, eEnum);

      const feature = new BasicEAttribute();
      feature.setName(name);
      feature.setEType(eEnum);
      this.preserveAdditionalSchemaProperties(propertyNode, feature);
      return feature;
    } else {
      const feature = new BasicEAttribute();
      feature.setName(name);
      feature.setEType(getEcorePackage().getEString());
      this.preserveAdditionalSchemaProperties(propertyNode, feature);
      return feature;
    }
  }

  private createObjectFeature(propertyNode: JsonObj, name: string, contextPath: string): BasicEReference {
    const artificialName = ARTIFICIAL_CLASSIFIER_PREFIX + (this.artificialClassifierCounter++);
    const eClass = this.createEClass(propertyNode, artificialName, `${contextPath}/${artificialName}`);
    this.addEAnnotation(eClass, AnnotationSources.JSONSCHEMA, 'artificial', 'true');
    this.classifierMap.set(`${contextPath}/${artificialName}`, eClass);

    const reference = new BasicEReference();
    reference.setName(name);
    reference.setEType(eClass);
    reference.setContainment(true);

    if (propertyNode.default !== undefined) {
      this.addEAnnotation(reference, AnnotationSources.JSONSCHEMA, 'default', JSON.stringify(propertyNode.default));
    }

    return reference;
  }

  private createMultiValueReference(jsonNode: any[], name: string, contextPath: string): BasicEReference | null {
    if (!Array.isArray(jsonNode)) {
      throw new Error(`anyOf node for property ${name} expected to be an array`);
    }

    const reference = new BasicEReference();
    reference.setName(name);
    reference.setContainment(false);

    const refPaths: string[] = [];
    const refClassesNodes = new Map<string, JsonObj>();

    for (const subNode of jsonNode) {
      if (subNode.$ref) {
        const refPath = subNode.$ref;
        refPaths.push(refPath);
        const refClassName = this.extractSchemaNameFromRef(refPath);
        const schemaNode = this.schemaDefinitions.get(refClassName);
        if (schemaNode) {
          refClassesNodes.set(refClassName, schemaNode);
        }
      }
    }

    if (refPaths.length > 0) {
      this.addEAnnotation(reference, AnnotationSources.JSONSCHEMA, 'ref', refPaths.join(','));
    }

    const parent = this.createParentFromCommonProperties(refClassesNodes, contextPath);
    reference.setEType(parent);

    return reference;
  }

  private createParentFromCommonProperties(refClassesNodes: Map<string, JsonObj>, contextPath: string): BasicEClass {
    const haveAllProperties = [...refClassesNodes.values()].every(jn => jn.properties);

    let commonProperties = new Map<string, JsonObj>();
    let commonRequiredProperties: string[] = [];

    if (haveAllProperties) {
      const propertiesNodes = [...refClassesNodes.values()].map(jn => jn.properties);
      commonProperties = this.getCommonSubNodes(propertiesNodes);

      const requiredNodes = [...refClassesNodes.values()]
        .filter(jn => jn.required)
        .map(jn => jn.required as string[]);
      commonRequiredProperties = this.getCommonRequiredFields(requiredNodes);
    }

    // Check if we already have a parent for these common properties
    const commonKey = JSON.stringify([...commonProperties.entries()]);
    if (commonProperties.size > 0 && this.parentClassMaps.has(commonKey)) {
      return this.parentClassMaps.get(commonKey)!;
    }

    const parent = new BasicEClass();
    let parentName = this.getCommonSuffix([...refClassesNodes.keys()]);
    if (!parentName) {
      parentName = ARTIFICIAL_CLASSIFIER_PREFIX + (this.artificialClassifierCounter++);
    }
    parent.setName(parentName);
    this.addEAnnotation(parent, AnnotationSources.JSONSCHEMA, 'artificial', 'true');

    for (const [propName, propNode] of commonProperties) {
      const feature = this.createStructuralFeature(propNode, propName, contextPath);
      if (feature) {
        if (commonRequiredProperties.includes(feature.getName()!)) {
          feature.setLowerBound(1);
        }
        parent.getEStructuralFeatures().push(feature);
      }
    }

    if (commonProperties.size > 0) {
      this.parentClassMaps.set(commonKey, parent);
    }
    this.classifierMap.set(parent.getName()!, parent);

    return parent;
  }

  private handleMultiTypeProperty(propertySchema: JsonObj, typeArray: string[],
    name: string, contextPath: string): BasicEReference {
    const unionBaseName = ARTIFICIAL_CLASSIFIER_PREFIX + (this.artificialClassifierCounter++);
    const unionQualifiedName = `${contextPath}/${unionBaseName}`;

    const unionBase = new BasicEClass();
    unionBase.setName(unionBaseName);
    unionBase.setAbstract(true);
    unionBase.setInterface(false);

    this.addEAnnotation(unionBase, AnnotationSources.JSONSCHEMA, 'artificial', 'true');
    this.addEAnnotation(unionBase, AnnotationSources.JSONSCHEMA, 'multiType', 'true');
    this.addEAnnotation(unionBase, AnnotationSources.JSONSCHEMA, 'typeArray', JSON.stringify(typeArray));

    if (propertySchema.default !== undefined) {
      this.addEAnnotation(unionBase, AnnotationSources.JSONSCHEMA, 'default', JSON.stringify(propertySchema.default));
    }

    this.preserveAdditionalSchemaProperties(propertySchema, unionBase);

    this.classifierMap.set(unionQualifiedName, unionBase);

    for (let i = 0; i < typeArray.length; i++) {
      const variantType = typeArray[i];
      const variantName = `${unionBaseName}Variant${i}`;

      const variantClass = new BasicEClass();
      variantClass.setName(variantName);
      variantClass.getESuperTypes().push(unionBase);

      this.addEAnnotation(variantClass, AnnotationSources.JSONSCHEMA, 'artificial', 'true');
      this.addEAnnotation(variantClass, AnnotationSources.JSONSCHEMA, 'variant', variantType);
      this.addEAnnotation(variantClass, AnnotationSources.JSONSCHEMA, 'variantIndex', String(i));

      const valueAttr = new BasicEAttribute();
      valueAttr.setName('value');
      valueAttr.setEType(this.mapJsonTypeToEcore(variantType));
      valueAttr.setLowerBound(1);
      variantClass.getEStructuralFeatures().push(valueAttr);

      this.classifierMap.set(`${unionQualifiedName}/Variant${i}`, variantClass);
    }

    const reference = new BasicEReference();
    reference.setName(name);
    reference.setEType(unionBase);
    reference.setContainment(true);

    return reference;
  }

  private processTopLevelProperties(propertiesNode: JsonObj, rootSchema: JsonObj, ePackage: BasicEPackage): void {
    let rootClassName = ePackage.getName();
    if (!rootClassName) rootClassName = 'Root';

    const rootClass = new BasicEClass();
    rootClass.setName(this.capitalizeFirst(rootClassName));

    const requiredProps = new Set<string>();
    if (Array.isArray(rootSchema.required)) {
      for (const req of rootSchema.required) {
        requiredProps.add(req);
      }
    }

    if (rootSchema.description) {
      this.addEAnnotation(rootClass, AnnotationSources.GEN_MODEL, 'documentation', rootSchema.description);
    }

    if (rootSchema.additionalProperties !== undefined) {
      this.addEAnnotation(rootClass, AnnotationSources.JSONSCHEMA,
        'additionalProperties', JSON.stringify(rootSchema.additionalProperties));
    }

    for (const propName of Object.keys(propertiesNode)) {
      const propertySchema = propertiesNode[propName];
      const feature = this.createStructuralFeature(propertySchema, propName, '');
      if (feature) {
        if (requiredProps.has(propName)) {
          feature.setLowerBound(1);
        }
        rootClass.getEStructuralFeatures().push(feature);
      }
    }

    this.addEAnnotation(rootClass, AnnotationSources.JSONSCHEMA, 'rootClass', 'true');

    ePackage.getEClassifiers().push(rootClass);
    this.classifierMap.set('', rootClass);
  }

  private handleAnyOf(schemaNode: JsonObj, eClass: BasicEClass, qualifiedName: string): void {
    const anyOfArray = schemaNode.anyOf;

    let onlyRequiredConstraints = true;
    for (const option of anyOfArray) {
      if (option.properties || option.type || option.$ref) {
        onlyRequiredConstraints = false;
        break;
      }
    }

    this.addEAnnotation(eClass, AnnotationSources.JSONSCHEMA, 'anyOf', JSON.stringify(anyOfArray));
    if (!onlyRequiredConstraints) {
      this.diagnostics_.push(JsonSchemaConversionDiagnostic.complexAnyOf(qualifiedName));
    }
  }

  // Resolution methods

  private resolveDeferredReferences(): void {
    for (const deferredRef of this.deferredReferences) {
      const referencedType = this.classifierMap.get(deferredRef.targetSchemaName);

      if (referencedType) {
        if (deferredRef.kind === 'config') {
          const configRef = deferredRef as DeferredConfigReference;
          if (configRef.owningClass && configRef.featureName) {
            const configReference = new BasicEReference();
            configReference.setName(configRef.featureName);
            configReference.setEType(referencedType);
            configReference.setContainment(true);
            configReference.setLowerBound(1);
            configReference.setUpperBound(1);
            (configRef.owningClass as BasicEClass).getEStructuralFeatures().push(configReference);
          }
        } else if (deferredRef.kind === 'type') {
          const typeRef = deferredRef as DeferredTypeReference;
          if (typeRef.feature) {
            typeRef.feature.setEType(referencedType);
          }
        }
      } else {
        this.diagnostics_.push(JsonSchemaConversionDiagnostic.unresolvedReference(deferredRef.targetSchemaName));
      }
    }
  }

  private resolveMissingReferences(): void {
    for (const [ref, refTypeName] of this.missingRefMap) {
      if (this.classifierMap.has(refTypeName)) {
        ref.setEType(this.classifierMap.get(refTypeName)!);
      }
    }
  }

  private resolveAnyOfReferences(): void {
    for (const [superType, subTypesClassNames] of this.anyOfRefMap) {
      for (const clName of subTypesClassNames) {
        const cl = this.classifierMap.get(clName);
        if (cl instanceof BasicEClass) {
          cl.getESuperTypes().push(superType as EClass);
        }
      }
    }
  }

  private resolveAllOfReferences(): void {
    for (const [eClass, superTypeNames] of this.allOfRefMap) {
      for (const superTypeName of superTypeNames) {
        const cl = this.classifierMap.get(superTypeName);
        if (cl instanceof BasicEClass) {
          eClass.getESuperTypes().push(cl);
        }
      }
    }
  }

  // Helper methods

  private addCommonAnnotations(feature: EStructuralFeature, propertyNode: JsonObj, isArrayItems: boolean): void {
    if (propertyNode.description) {
      this.addEAnnotation(feature, AnnotationSources.GEN_MODEL, 'documentation', propertyNode.description);
    }
    if (propertyNode.format) {
      this.addEAnnotation(feature, AnnotationSources.JSONSCHEMA, 'format', propertyNode.format);
    }
    if (propertyNode.const !== undefined) {
      const constValue = typeof propertyNode.const === 'string'
        ? propertyNode.const
        : JSON.stringify(propertyNode.const, null, 2);
      this.addEAnnotation(feature, AnnotationSources.JSONSCHEMA, 'const', constValue);
      const constType = Array.isArray(propertyNode.const)
        ? typeof propertyNode.const[0]
        : typeof propertyNode.const;
      this.addEAnnotation(feature, AnnotationSources.JSONSCHEMA, 'constType', constType.toUpperCase());
    }
    if (!propertyNode.type) {
      this.addEAnnotation(feature, AnnotationSources.JSONSCHEMA,
        isArrayItems ? 'noArrayItemsTypeInfo' : 'noTypeInfo', 'true');
    }
    if (propertyNode.uniqueItems !== undefined) {
      this.addEAnnotation(feature, AnnotationSources.JSONSCHEMA, 'uniqueItems', String(propertyNode.uniqueItems));
    }
    if (propertyNode.writeOnly !== undefined) {
      this.addEAnnotation(feature, AnnotationSources.JSONSCHEMA, 'writeOnly', String(propertyNode.writeOnly));
    }
    if (propertyNode.readOnly !== undefined) {
      this.addEAnnotation(feature, AnnotationSources.JSONSCHEMA, 'readOnly', String(propertyNode.readOnly));
    }
  }

  private preserveAdditionalSchemaProperties(schema: JsonObj, element: EModelElement): void {
    const schemaProperties = [
      'default', 'minItems', 'maxItems', 'uniqueItems',
      'minLength', 'maxLength', 'pattern', 'format',
      'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
      'multipleOf', 'const', 'title', 'description', 'examples',
      'contentEncoding', 'contentMediaType',
    ];

    for (const propertyName of schemaProperties) {
      if (schema[propertyName] !== undefined) {
        const value = schema[propertyName];
        this.addEAnnotation(element, AnnotationSources.JSONSCHEMA, propertyName, JSON.stringify(value));
      }
    }

    if (schema.$comment) {
      this.addEAnnotation(element, AnnotationSources.JSONSCHEMA, 'comment', schema.$comment);
    }

    if (schema.deprecated === true) {
      this.addEAnnotation(element, AnnotationSources.GEN_MODEL, 'deprecated', 'true');
    }
  }

  private addEAnnotation(element: EModelElement, source: string, detailKey: string, detailValue: string): void {
    let annotation = element.getEAnnotation(source);
    if (!annotation) {
      annotation = new BasicEAnnotation();
      annotation.setSource(source);
      element.getEAnnotations().push(annotation);
    }
    annotation.getDetails().putByKey(detailKey, detailValue);
  }

  private getJsonTypeFromConstValue(value: any): string {
    if (typeof value === 'string') return 'string';
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'number') {
      if (Number.isInteger(value)) return 'integer';
      return 'number';
    }
    if (Array.isArray(value)) return 'array';
    return 'javaObject';
  }

  private mapJsonTypeToEcore(jsonType: string): EDataType {
    const ecore = getEcorePackage();
    switch (jsonType) {
      case 'string': return ecore.getEString();
      case 'integer': return ecore.getEInt();
      case 'number': return ecore.getEDouble();
      case 'boolean': return ecore.getEBoolean();
      case 'bigDecimal': return ecore.getEBigDecimal();
      case 'bigInteger': return ecore.getEBigInteger();
      case 'binary': return ecore.getEByte();
      default: return ecore.getEJavaObject();
    }
  }

  private extractSchemaNameFromRef(refPath: string): string {
    // Handle anchor refs: #anchorName (no slash after #)
    if (refPath.startsWith('#') && !refPath.startsWith('#/')) {
      return refPath.substring(1);
    }

    // Handle JSON Pointer refs: #/definitions/Name
    if (refPath.startsWith('#/')) {
      refPath = refPath.substring(2);
    }

    if (this.schemaFeature && refPath.startsWith(this.schemaFeature + '/')) {
      refPath = refPath.substring(this.schemaFeature.length + 1);
    }

    return refPath;
  }

  private extractNamespacePath(qualifiedName: string): string | null {
    if (!qualifiedName || !qualifiedName.includes('/')) return null;
    const lastSlash = qualifiedName.lastIndexOf('/');
    return qualifiedName.substring(0, lastSlash);
  }

  private sanitizeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_]/g, '_');
  }

  private capitalizeFirst(str: string): string {
    if (!str) return str;
    return str.charAt(0).toUpperCase() + str.substring(1);
  }

  private getCommonSuffix(strings: string[]): string | null {
    if (!strings || strings.length === 0) return null;

    const first = strings[0];
    if (!first) return null;

    let minLength = first.length;
    for (const str of strings) {
      if (!str) return null;
      minLength = Math.min(minLength, str.length);
    }

    let suffixLength = 0;
    while (suffixLength < minLength) {
      const currentChar = first.charAt(first.length - 1 - suffixLength);
      let allMatch = true;
      for (const str of strings) {
        if (str.charAt(str.length - 1 - suffixLength) !== currentChar) {
          allMatch = false;
          break;
        }
      }
      if (!allMatch) break;
      suffixLength++;
    }

    return suffixLength === 0 ? null : first.substring(first.length - suffixLength);
  }

  private getCommonRequiredFields(requiredNodes: string[][]): string[] {
    if (!requiredNodes || requiredNodes.length === 0) return [];

    let commonSet: Set<string> | null = null;
    for (const required of requiredNodes) {
      const currentSet = new Set(required);
      if (commonSet === null) {
        commonSet = currentSet;
      } else {
        for (const item of commonSet) {
          if (!currentSet.has(item)) {
            commonSet.delete(item);
          }
        }
      }
    }

    return commonSet ? [...commonSet] : [];
  }

  private getCommonSubNodes(nodes: JsonObj[]): Map<string, JsonObj> {
    const commonFields = new Map<string, JsonObj>();
    if (!nodes || nodes.length === 0) return commonFields;

    const reference = nodes[0];
    for (const fieldName of Object.keys(reference)) {
      const referenceValue = reference[fieldName];
      let isCommon = true;
      for (let i = 1; i < nodes.length; i++) {
        const otherValue = nodes[i][fieldName];
        if (otherValue === undefined || JSON.stringify(referenceValue) !== JSON.stringify(otherValue)) {
          isCommon = false;
          break;
        }
      }
      if (isCommon) {
        commonFields.set(fieldName, referenceValue);
      }
    }

    return commonFields;
  }
}
