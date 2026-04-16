import { describe, it, expect } from 'vitest';
import { JsonSchemaToEPackageConverter } from '../src/converter/JsonSchemaToEPackageConverter';
import { EPackageToJsonSchemaConverter } from '../src/converter/EPackageToJsonSchemaConverter';

describe('Round-trip conversion', () => {
  it('should preserve class structure through JSON Schema -> EPackage -> JSON Schema', () => {
    const originalSchema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'http://example.com/roundtrip',
      title: 'RoundTrip',
      $defs: {
        Person: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            age: { type: 'integer' },
            active: { type: 'boolean' },
          },
          required: ['name'],
        },
      },
    };

    const toEPackage = new JsonSchemaToEPackageConverter();
    const ePackage = toEPackage.convert(originalSchema);

    const toSchema = new EPackageToJsonSchemaConverter();
    const resultSchema = toSchema.convert(ePackage);

    expect(resultSchema['$defs']).toBeDefined();
    expect(resultSchema['$defs']['Person']).toBeDefined();

    const personDef = resultSchema['$defs']['Person'];
    expect(personDef.type).toBe('object');
    expect(personDef.properties.name.type).toBe('string');
    expect(personDef.properties.age.type).toBe('integer');
    expect(personDef.properties.active.type).toBe('boolean');
    expect(personDef.required).toContain('name');
  });

  it('should preserve enum values through round-trip', () => {
    const originalSchema = {
      $defs: {
        Priority: {
          enum: ['low', 'medium', 'high'],
        },
      },
    };

    const toEPackage = new JsonSchemaToEPackageConverter();
    const ePackage = toEPackage.convert(originalSchema);

    const toSchema = new EPackageToJsonSchemaConverter();
    const resultSchema = toSchema.convert(ePackage);

    expect(resultSchema['$defs']['Priority']).toBeDefined();
    expect(resultSchema['$defs']['Priority'].type).toBe('string');
    expect(resultSchema['$defs']['Priority'].enum).toEqual(['low', 'medium', 'high']);
  });

  it('should preserve $ref relationships through round-trip', () => {
    const originalSchema = {
      $defs: {
        Address: {
          type: 'object',
          properties: {
            city: { type: 'string' },
          },
        },
        Company: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            headquarters: { $ref: '#/$defs/Address' },
          },
        },
      },
    };

    const toEPackage = new JsonSchemaToEPackageConverter();
    const ePackage = toEPackage.convert(originalSchema);

    const toSchema = new EPackageToJsonSchemaConverter();
    const resultSchema = toSchema.convert(ePackage);

    const companyProps = resultSchema['$defs']['Company']?.properties;
    expect(companyProps).toBeDefined();
    // The forward converter creates a containment EReference for $ref,
    // so the reverse converter should produce a $ref back.
    // If non-containment, it becomes uri-reference instead.
    const hq = companyProps.headquarters;
    expect(hq).toBeDefined();
    const isRef = hq['$ref'] === '#/$defs/Address';
    const isUriRef = hq.type === 'string' && hq.format === 'uri-reference';
    expect(isRef || isUriRef).toBe(true);
  });
});