import { describe, it, expect, beforeEach } from 'vitest';
import { EPackageToJsonSchemaConverter } from '../src/converter/EPackageToJsonSchemaConverter';
import {
  BasicEPackage, BasicEClass, BasicEAttribute, BasicEReference,
  BasicEEnum, BasicEEnumLiteral, BasicEAnnotation,
  getEcorePackage,
} from '@emfts/core';

function createAnnotation(source: string, key: string, value: string): BasicEAnnotation {
  const annotation = new BasicEAnnotation();
  annotation.setSource(source);
  annotation.getDetails().putByKey(key, value);
  return annotation;
}

describe('EPackageToJsonSchemaConverter', () => {
  let converter: EPackageToJsonSchemaConverter;
  const ecore = getEcorePackage();

  beforeEach(() => {
    converter = new EPackageToJsonSchemaConverter();
  });

  it('should produce a valid JSON Schema envelope', () => {
    const pkg = new BasicEPackage();
    pkg.setNsURI('http://example.com/test');
    pkg.setName('TestPackage');

    const schema = converter.convert(pkg);

    expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema['$id']).toBe('http://example.com/test');
    expect(schema['title']).toBe('TestPackage');
    expect(schema['type']).toBe('object');
  });

  it('should convert an EClass to a $defs entry', () => {
    const pkg = new BasicEPackage();
    pkg.setName('TestPkg');

    const cls = new BasicEClass();
    cls.setName('Person');
    pkg.getEClassifiers().push(cls);

    const nameAttr = new BasicEAttribute();
    nameAttr.setName('name');
    nameAttr.setEType(ecore.getEString());
    nameAttr.setLowerBound(1);
    cls.getEStructuralFeatures().push(nameAttr);

    const ageAttr = new BasicEAttribute();
    ageAttr.setName('age');
    ageAttr.setEType(ecore.getEInt());
    cls.getEStructuralFeatures().push(ageAttr);

    const schema = converter.convert(pkg);

    expect(schema['$defs']).toBeDefined();
    expect(schema['$defs']['Person']).toBeDefined();

    const personDef = schema['$defs']['Person'];
    expect(personDef.type).toBe('object');
    expect(personDef.properties.name).toEqual({ type: 'string' });
    expect(personDef.properties.age).toEqual({ type: 'integer' });
    expect(personDef.required).toContain('name');
    expect(personDef.required).not.toContain('age');
  });

  it('should map primitive EDataTypes to JSON Schema types', () => {
    const pkg = new BasicEPackage();
    pkg.setName('TypePkg');

    const cls = new BasicEClass();
    cls.setName('Types');
    pkg.getEClassifiers().push(cls);

    const mappings: [string, any, string][] = [
      ['strField', ecore.getEString(), 'string'],
      ['intField', ecore.getEInt(), 'integer'],
      ['doubleField', ecore.getEDouble(), 'number'],
      ['boolField', ecore.getEBoolean(), 'boolean'],
      ['longField', ecore.getELong(), 'integer'],
    ];

    for (const [name, eType, _] of mappings) {
      const attr = new BasicEAttribute();
      attr.setName(name);
      attr.setEType(eType);
      cls.getEStructuralFeatures().push(attr);
    }

    const schema = converter.convert(pkg);
    const props = schema['$defs']['Types']['properties'];

    for (const [name, _, expectedType] of mappings) {
      expect(props[name].type).toBe(expectedType);
    }
  });

  it('should convert EEnum to string enum in $defs', () => {
    const pkg = new BasicEPackage();
    pkg.setName('EnumPkg');

    const eEnum = new BasicEEnum();
    eEnum.setName('Status');

    for (const [i, literal] of ['ACTIVE', 'INACTIVE', 'PENDING'].entries()) {
      const lit = new BasicEEnumLiteral();
      lit.setName(literal);
      lit.setLiteral(literal);
      lit.setValue(i);
      eEnum.getELiterals().push(lit);
    }

    pkg.getEClassifiers().push(eEnum);

    const schema = converter.convert(pkg);

    expect(schema['$defs']['Status']).toBeDefined();
    expect(schema['$defs']['Status'].type).toBe('string');
    expect(schema['$defs']['Status'].enum).toEqual(['ACTIVE', 'INACTIVE', 'PENDING']);
  });

  it('should convert containment EReference to $ref', () => {
    const pkg = new BasicEPackage();
    pkg.setName('RefPkg');

    const addressClass = new BasicEClass();
    addressClass.setName('Address');
    pkg.getEClassifiers().push(addressClass);

    const personClass = new BasicEClass();
    personClass.setName('Person');
    pkg.getEClassifiers().push(personClass);

    const ref = new BasicEReference();
    ref.setName('address');
    ref.setEType(addressClass);
    ref.setContainment(true);
    personClass.getEStructuralFeatures().push(ref);

    const schema = converter.convert(pkg);
    const personProps = schema['$defs']['Person']['properties'];

    expect(personProps.address).toEqual({ '$ref': '#/$defs/Address' });
  });

  it('should convert non-containment EReference to uri-reference', () => {
    const pkg = new BasicEPackage();
    pkg.setName('CrossRefPkg');

    const targetClass = new BasicEClass();
    targetClass.setName('Target');
    pkg.getEClassifiers().push(targetClass);

    const sourceClass = new BasicEClass();
    sourceClass.setName('Source');
    pkg.getEClassifiers().push(sourceClass);

    const ref = new BasicEReference();
    ref.setName('target');
    ref.setEType(targetClass);
    ref.setContainment(false);
    sourceClass.getEStructuralFeatures().push(ref);

    const schema = converter.convert(pkg);
    const sourceProps = schema['$defs']['Source']['properties'];

    expect(sourceProps.target).toEqual({ type: 'string', format: 'uri-reference' });
  });

  it('should convert multi-valued features to arrays', () => {
    const pkg = new BasicEPackage();
    pkg.setName('ArrayPkg');

    const cls = new BasicEClass();
    cls.setName('Container');
    pkg.getEClassifiers().push(cls);

    const attr = new BasicEAttribute();
    attr.setName('tags');
    attr.setEType(ecore.getEString());
    attr.setUpperBound(-1);
    cls.getEStructuralFeatures().push(attr);

    const schema = converter.convert(pkg);
    const props = schema['$defs']['Container']['properties'];

    expect(props.tags).toEqual({ type: 'array', items: { type: 'string' } });
  });

  it('should handle abstract classes', () => {
    const pkg = new BasicEPackage();
    pkg.setName('AbstractPkg');

    const abstractCls = new BasicEClass();
    abstractCls.setName('BaseClass');
    abstractCls.setAbstract(true);
    pkg.getEClassifiers().push(abstractCls);

    const schema = converter.convert(pkg);

    expect(schema['$defs']['BaseClass']['abstract']).toBe(true);
  });

  it('should convert supertypes to allOf', () => {
    const pkg = new BasicEPackage();
    pkg.setName('InheritPkg');

    const baseClass = new BasicEClass();
    baseClass.setName('Animal');
    pkg.getEClassifiers().push(baseClass);

    const subClass = new BasicEClass();
    subClass.setName('Dog');
    subClass.getESuperTypes().push(baseClass);
    pkg.getEClassifiers().push(subClass);

    const schema = converter.convert(pkg);

    expect(schema['$defs']['Dog']['allOf']).toBeDefined();
    expect(schema['$defs']['Dog']['allOf']).toContainEqual({ '$ref': '#/$defs/Animal' });
  });

  it('should set root properties referencing first concrete class', () => {
    const pkg = new BasicEPackage();
    pkg.setName('RootPkg');

    const abstractCls = new BasicEClass();
    abstractCls.setName('AbstractBase');
    abstractCls.setAbstract(true);
    pkg.getEClassifiers().push(abstractCls);

    const concreteCls = new BasicEClass();
    concreteCls.setName('Config');
    pkg.getEClassifiers().push(concreteCls);

    const schema = converter.convert(pkg);

    expect(schema['properties']).toBeDefined();
    expect(schema['properties']['Config']).toEqual({ '$ref': '#/$defs/Config' });
  });

  it('should preserve GenModel documentation as description', () => {
    const pkg = new BasicEPackage();
    pkg.setName('DocPkg');

    const cls = new BasicEClass();
    cls.setName('Documented');
    const annotation = createAnnotation(
      'http://www.eclipse.org/emf/2002/GenModel',
      'documentation',
      'This is a documented class'
    );
    cls.getEAnnotations().push(annotation);
    pkg.getEClassifiers().push(cls);

    const schema = converter.convert(pkg);

    expect(schema['$defs']['Documented']['description']).toBe('This is a documented class');
  });

  it('should produce valid JSON string output', () => {
    const pkg = new BasicEPackage();
    pkg.setName('StringPkg');
    pkg.setNsURI('http://example.com/string-test');

    const result = converter.convertToString(pkg);
    expect(() => JSON.parse(result)).not.toThrow();

    const parsed = JSON.parse(result);
    expect(parsed['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
  });
});