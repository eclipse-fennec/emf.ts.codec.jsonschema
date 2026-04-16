/**
 * Converter from EMF EPackage to JSON Schema Draft 2020-12.
 *
 * Produces a JSON Schema document with:
 * - EClasses as object definitions in $defs
 * - EEnums as string enums in $defs
 * - EAttributes mapped to primitive JSON Schema types
 * - EReferences (containment) as $ref
 * - EReferences (non-containment) as uri-reference strings
 * - ESuperTypes as allOf inheritance
 * - Required array from lowerBound >= 1
 * - Annotations preserved (GenModel documentation, JSON Schema metadata)
 */

import type {
  EPackage, EClassifier, EClass, EEnum, EDataType,
  EStructuralFeature, EAttribute, EReference,
} from '@emfts/core';
import { getEcorePackage } from '@emfts/core';
import * as AnnotationSources from './AnnotationSources';

type JsonObj = Record<string, any>;

export class EPackageToJsonSchemaConverter {

  /**
   * Convert an EPackage to a JSON Schema object (Draft 2020-12).
   */
  convert(ePackage: EPackage): JsonObj {
    const schema: JsonObj = {
      '$schema': 'https://json-schema.org/draft/2020-12/schema',
    };

    // $id from nsURI
    const nsURI = ePackage.getNsURI();
    if (nsURI) {
      schema['$id'] = nsURI;
    }

    // title from package name
    const name = ePackage.getName();
    if (name) {
      schema['title'] = name;
    }

    // description from GenModel annotation
    const description = this.getDocumentation(ePackage);
    if (description) {
      schema['description'] = description;
    }

    schema['type'] = 'object';

    // Build $defs from all classifiers
    const defs: JsonObj = {};
    const classifiers = ePackage.getEClassifiers();

    let firstConcreteClass: EClass | null = null;

    for (const classifier of classifiers) {
      const classifierName = classifier.getName();
      if (!classifierName) continue;

      if (this.isEClass(classifier)) {
        const eClass = classifier as EClass;
        defs[classifierName] = this.convertEClass(eClass);
        if (!firstConcreteClass && !eClass.isAbstract() && !eClass.isInterface()) {
          firstConcreteClass = eClass;
        }
      } else if (this.isEEnum(classifier)) {
        defs[classifierName] = this.convertEEnum(classifier as EEnum);
      }
    }

    if (Object.keys(defs).length > 0) {
      schema['$defs'] = defs;
    }

    // Root properties: ref to first non-abstract EClass
    if (firstConcreteClass) {
      const rootName = firstConcreteClass.getName()!;
      schema['properties'] = {
        [rootName]: { '$ref': `#/$defs/${rootName}` },
      };
    }

    return schema;
  }

  /**
   * Convert an EPackage to a formatted JSON Schema string.
   */
  convertToString(ePackage: EPackage, indent: number = 2): string {
    return JSON.stringify(this.convert(ePackage), null, indent);
  }

  // ---- EClass conversion ----

  private convertEClass(eClass: EClass): JsonObj {
    const def: JsonObj = { type: 'object' };

    // Description from GenModel
    const doc = this.getDocumentation(eClass);
    if (doc) {
      def['description'] = doc;
    }

    // Abstract marker (custom extension)
    if (eClass.isAbstract()) {
      def['abstract'] = true;
    }

    // Supertypes via allOf
    const superTypes = eClass.getESuperTypes();
    if (superTypes.length > 0) {
      def['allOf'] = superTypes
        .filter(st => st.getName())
        .map(st => ({ '$ref': `#/$defs/${st.getName()}` }));
    }

    // Properties from direct structural features
    const properties: JsonObj = {};
    const required: string[] = [];
    const features = eClass.getEStructuralFeatures();

    for (const feature of features) {
      const featureName = feature.getName();
      if (!featureName) continue;

      const propSchema = this.convertFeature(feature);
      if (propSchema) {
        properties[featureName] = propSchema;

        if (feature.getLowerBound() >= 1) {
          required.push(featureName);
        }
      }
    }

    if (Object.keys(properties).length > 0) {
      def['properties'] = properties;
    }

    if (required.length > 0) {
      def['required'] = required;
    }

    // Write back JSONSCHEMA annotations (format, pattern, minLength, etc.)
    this.writeBackJsonSchemaAnnotations(eClass, def);

    return def;
  }

  // ---- EEnum conversion ----

  private convertEEnum(eEnum: EEnum): JsonObj {
    const def: JsonObj = { type: 'string' };

    const doc = this.getDocumentation(eEnum);
    if (doc) {
      def['description'] = doc;
    }

    const literals = eEnum.getELiterals();
    const enumValues: string[] = [];
    for (const literal of literals) {
      const litStr = literal.getLiteral() ?? literal.getName();
      if (litStr) {
        enumValues.push(litStr);
      }
    }

    if (enumValues.length > 0) {
      def['enum'] = enumValues;
    }

    return def;
  }

  // ---- Feature conversion ----

  private convertFeature(feature: EStructuralFeature): JsonObj | null {
    const isMany = feature.getUpperBound() === -1 || feature.getUpperBound() > 1;

    if (this.isEReference(feature)) {
      return this.convertReference(feature as EReference, isMany);
    } else if (this.isEAttribute(feature)) {
      return this.convertAttribute(feature as EAttribute, isMany);
    }

    return null;
  }

  private convertAttribute(attr: EAttribute, isMany: boolean): JsonObj {
    const eType = attr.getEType();
    let typeSchema = this.mapDataTypeToSchema(eType as EDataType | null);

    // Description
    const doc = this.getDocumentation(attr);
    if (doc) {
      typeSchema['description'] = doc;
    }

    // Write back JSONSCHEMA annotations on the attribute
    this.writeBackJsonSchemaAnnotations(attr, typeSchema);

    if (isMany) {
      return { type: 'array', items: typeSchema };
    }

    return typeSchema;
  }

  private convertReference(ref: EReference, isMany: boolean): JsonObj {
    let refSchema: JsonObj;

    if (ref.isContainment()) {
      // Containment → $ref to the referenced type
      const refType = ref.getEType();
      const refName = refType?.getName();
      if (refName) {
        refSchema = { '$ref': `#/$defs/${refName}` };
      } else {
        refSchema = { type: 'object' };
      }
    } else {
      // Non-containment → URI reference (ID-based)
      refSchema = { type: 'string', format: 'uri-reference' };
    }

    // Description
    const doc = this.getDocumentation(ref);
    if (doc) {
      refSchema['description'] = doc;
    }

    if (isMany) {
      return { type: 'array', items: refSchema };
    }

    return refSchema;
  }

  // ---- Data type mapping ----

  private mapDataTypeToSchema(dataType: EDataType | null): JsonObj {
    if (!dataType) {
      return { type: 'string' };
    }

    // Check if it's an EEnum
    if (this.isEEnum(dataType)) {
      const enumName = dataType.getName();
      if (enumName) {
        return { '$ref': `#/$defs/${enumName}` };
      }
    }

    const ecore = getEcorePackage();
    const name = dataType.getName();

    // Match against known Ecore types
    if (dataType === ecore.getEString()) {
      return { type: 'string' };
    }
    if (dataType === ecore.getEInt()) {
      return { type: 'integer' };
    }
    if (dataType === ecore.getEDouble() || dataType === ecore.getEFloat()) {
      return { type: 'number' };
    }
    if (dataType === ecore.getEBoolean()) {
      return { type: 'boolean' };
    }
    if (dataType === ecore.getEBigDecimal()) {
      return { type: 'number' };
    }
    if (dataType === ecore.getEBigInteger()) {
      return { type: 'integer' };
    }
    if (dataType === ecore.getELong()) {
      return { type: 'integer' };
    }
    if (dataType === ecore.getEShort()) {
      return { type: 'integer' };
    }
    if (dataType === ecore.getEByte()) {
      return { type: 'integer' };
    }
    if (dataType === ecore.getEDate()) {
      return { type: 'string', format: 'date-time' };
    }

    // Fallback: match by name
    switch (name) {
      case 'EString': return { type: 'string' };
      case 'EInt': case 'ELong': case 'EShort': case 'EByte':
      case 'EBigInteger':
        return { type: 'integer' };
      case 'EDouble': case 'EFloat': case 'EBigDecimal':
        return { type: 'number' };
      case 'EBoolean':
        return { type: 'boolean' };
      case 'EDate':
        return { type: 'string', format: 'date-time' };
      case 'EChar':
        return { type: 'string', minLength: 1, maxLength: 1 };
      default:
        // For unknown/custom data types, use instanceClassName as hint
        const instanceClass = dataType.getInstanceClassName?.();
        if (instanceClass) {
          if (instanceClass.includes('String')) return { type: 'string' };
          if (instanceClass.includes('Integer') || instanceClass.includes('int') || instanceClass.includes('Long') || instanceClass.includes('long'))
            return { type: 'integer' };
          if (instanceClass.includes('Double') || instanceClass.includes('double') || instanceClass.includes('Float') || instanceClass.includes('float'))
            return { type: 'number' };
          if (instanceClass.includes('Boolean') || instanceClass.includes('boolean'))
            return { type: 'boolean' };
        }
        return { type: 'string' };
    }
  }

  // ---- Annotation helpers ----

  private getDocumentation(element: { getEAnnotation?(source: string): any; getEAnnotations?(): any[] }): string | null {
    const annotation = element.getEAnnotation?.(AnnotationSources.GEN_MODEL);
    if (!annotation) return null;
    const details = annotation.getDetails();
    return this.getDetailValue(details, 'documentation');
  }

  /**
   * Write back JSONSCHEMA annotation details (format, pattern, minLength, etc.)
   * as top-level properties on the schema object.
   */
  private writeBackJsonSchemaAnnotations(element: { getEAnnotation?(source: string): any }, schema: JsonObj): void {
    const annotation = element.getEAnnotation?.(AnnotationSources.JSONSCHEMA);
    if (!annotation) return;

    const details = annotation.getDetails();
    const passThrough = [
      'format', 'pattern', 'minLength', 'maxLength',
      'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
      'multipleOf', 'contentEncoding', 'contentMediaType',
    ];

    for (const key of passThrough) {
      const value = this.getDetailValue(details, key);
      if (value !== undefined && value !== null) {
        // Try to parse as JSON for numeric values
        try {
          schema[key] = JSON.parse(value);
        } catch {
          schema[key] = value;
        }
      }
    }
  }

  /** Get a value from annotation details, supporting both Map and EMap */
  private getDetailValue(details: any, key: string): string | null {
    if (typeof details.getByKey === 'function') {
      return details.getByKey(key) ?? null;
    }
    if (typeof details.get === 'function') {
      return details.get(key) ?? null;
    }
    return null;
  }

  // ---- Type guards (duck-typing, same approach as the forward converter) ----

  private isEClass(classifier: EClassifier): classifier is EClass {
    return typeof (classifier as any).getESuperTypes === 'function'
      && typeof (classifier as any).getEAllStructuralFeatures === 'function';
  }

  private isEEnum(classifier: any): classifier is EEnum {
    return typeof classifier?.getELiterals === 'function'
      && typeof classifier?.getEEnumLiteral === 'function';
  }

  private isEAttribute(feature: EStructuralFeature): feature is EAttribute {
    return typeof (feature as any).isID === 'function'
      && typeof (feature as any).getEAttributeType === 'function';
  }

  private isEReference(feature: EStructuralFeature): feature is EReference {
    return typeof (feature as any).isContainment === 'function'
      && typeof (feature as any).getEOpposite === 'function';
  }
}
