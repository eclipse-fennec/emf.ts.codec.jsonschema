import { describe, it, expect, beforeEach } from 'vitest';
import { JsonSchemaToEPackageConverter } from '../src/converter/JsonSchemaToEPackageConverter';
import { BasicEClass, BasicEAttribute, BasicEReference, BasicEEnum } from '@emfts/core';

describe('JsonSchemaToEPackageConverter', () => {
  let converter: JsonSchemaToEPackageConverter;

  beforeEach(() => {
    converter = new JsonSchemaToEPackageConverter();
  });

  describe('convert', () => {
    it('should convert a minimal schema to an EPackage', () => {
      const schema = {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $id: 'http://example.com/test',
        title: 'TestPackage',
      };

      const ePackage = converter.convert(schema);

      expect(ePackage).toBeDefined();
      expect(ePackage.getNsURI()).toBe('http://example.com/test');
      expect(ePackage.getName()).toBe('TestPackage');
    });

    it('should convert $defs object types to EClasses', () => {
      const schema = {
        $defs: {
          Person: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              age: { type: 'integer' },
            },
            required: ['name'],
          },
        },
      };

      const ePackage = converter.convert(schema);
      const classifiers = ePackage.getEClassifiers();

      expect(classifiers.length).toBeGreaterThanOrEqual(1);
      const personClass = classifiers.find(c => c.getName() === 'Person');
      expect(personClass).toBeDefined();
      expect(personClass).toBeInstanceOf(BasicEClass);

      const eClass = personClass as BasicEClass;
      const features = eClass.getEStructuralFeatures();
      const nameAttr = features.find(f => f.getName() === 'name');
      const ageAttr = features.find(f => f.getName() === 'age');

      expect(nameAttr).toBeDefined();
      expect(ageAttr).toBeDefined();
      expect(nameAttr!.getLowerBound()).toBe(1); // required
      expect(ageAttr!.getLowerBound()).toBe(0); // optional
    });

    it('should convert definitions (legacy) to EClasses', () => {
      const schema = {
        definitions: {
          Item: {
            type: 'object',
            properties: {
              id: { type: 'string' },
            },
          },
        },
      };

      const ePackage = converter.convert(schema);
      const item = ePackage.getEClassifiers().find(c => c.getName() === 'Item');
      expect(item).toBeDefined();
    });

    it('should convert string enums to EEnums', () => {
      const schema = {
        $defs: {
          Color: {
            enum: ['red', 'green', 'blue'],
          },
        },
      };

      const ePackage = converter.convert(schema);
      const color = ePackage.getEClassifiers().find(c => c.getName() === 'Color');
      expect(color).toBeDefined();
      expect(color).toBeInstanceOf(BasicEEnum);

      const eEnum = color as BasicEEnum;
      const literals = eEnum.getELiterals();
      expect(literals.length).toBe(3);
    });

    it('should resolve $ref references between definitions', () => {
      const schema = {
        $defs: {
          Address: {
            type: 'object',
            properties: {
              street: { type: 'string' },
            },
          },
          Person: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              address: { $ref: '#/$defs/Address' },
            },
          },
        },
      };

      const ePackage = converter.convert(schema);
      const personClass = ePackage.getEClassifiers().find(c => c.getName() === 'Person') as BasicEClass;
      expect(personClass).toBeDefined();

      const features = personClass.getEStructuralFeatures();
      const addressFeature = features.find(f => f.getName() === 'address');
      expect(addressFeature).toBeDefined();
      expect(addressFeature).toBeInstanceOf(BasicEReference);

      const ref = addressFeature as BasicEReference;
      expect(ref.getEType()?.getName()).toBe('Address');
    });

    it('should handle allOf for inheritance', () => {
      const schema = {
        $defs: {
          Animal: {
            type: 'object',
            properties: {
              name: { type: 'string' },
            },
          },
          Dog: {
            allOf: [
              { $ref: '#/$defs/Animal' },
              {
                type: 'object',
                properties: {
                  breed: { type: 'string' },
                },
              },
            ],
          },
        },
      };

      const ePackage = converter.convert(schema);
      const dogClass = ePackage.getEClassifiers().find(c => c.getName() === 'Dog') as BasicEClass;
      expect(dogClass).toBeDefined();

      const superTypes = dogClass.getESuperTypes();
      expect(superTypes.length).toBeGreaterThanOrEqual(1);
      expect(superTypes.some(st => st.getName() === 'Animal')).toBe(true);
    });

    it('should map primitive types correctly', () => {
      const schema = {
        $defs: {
          TypeTest: {
            type: 'object',
            properties: {
              str: { type: 'string' },
              num: { type: 'number' },
              int: { type: 'integer' },
              bool: { type: 'boolean' },
            },
          },
        },
      };

      const ePackage = converter.convert(schema);
      const typeTest = ePackage.getEClassifiers().find(c => c.getName() === 'TypeTest') as BasicEClass;
      expect(typeTest).toBeDefined();

      const features = typeTest.getEStructuralFeatures();
      expect(features.length).toBe(4);

      for (const f of features) {
        expect(f).toBeInstanceOf(BasicEAttribute);
        expect(f.getEType()).toBeDefined();
      }
    });

    it('should handle array properties', () => {
      const schema = {
        $defs: {
          ShoppingList: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                items: { type: 'string' },
              },
            },
          },
        },
      };

      const ePackage = converter.convert(schema);
      const listClass = ePackage.getEClassifiers().find(c => c.getName() === 'ShoppingList') as BasicEClass;
      expect(listClass).toBeDefined();

      const itemsFeature = listClass.getEStructuralFeatures().find(f => f.getName() === 'items');
      expect(itemsFeature).toBeDefined();
      expect(itemsFeature!.getUpperBound()).toBe(-1); // many
    });

    it('should preserve description as GenModel annotation', () => {
      const schema = {
        $defs: {
          Documented: {
            type: 'object',
            description: 'A well-documented class',
            properties: {},
          },
        },
      };

      const ePackage = converter.convert(schema);
      const cls = ePackage.getEClassifiers().find(c => c.getName() === 'Documented') as BasicEClass;
      expect(cls).toBeDefined();

      const genModelAnnotation = cls.getEAnnotation('http://www.eclipse.org/emf/2002/GenModel');
      expect(genModelAnnotation).toBeDefined();
      expect(genModelAnnotation!.getDetails().getByKey('documentation')).toBe('A well-documented class');
    });

    it('should handle top-level properties as rootClass', () => {
      const schema = {
        $id: 'http://example.com/root',
        title: 'RootSchema',
        type: 'object',
        properties: {
          config: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
            },
          },
        },
      };

      const ePackage = converter.convert(schema);
      const classifiers = ePackage.getEClassifiers();
      expect(classifiers.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle discriminated unions (minProperties/maxProperties = 1)', () => {
      const schema = {
        $defs: {
          Transport: {
            minProperties: 1,
            maxProperties: 1,
            oneOf: [
              {
                properties: {
                  kafka: { $ref: '#/$defs/KafkaConfig' },
                },
                required: ['kafka'],
              },
              {
                properties: {
                  nats: { $ref: '#/$defs/NatsConfig' },
                },
                required: ['nats'],
              },
            ],
          },
          KafkaConfig: {
            type: 'object',
            properties: {
              brokers: { type: 'string' },
            },
          },
          NatsConfig: {
            type: 'object',
            properties: {
              url: { type: 'string' },
            },
          },
        },
      };

      const ePackage = converter.convert(schema);
      const transportClass = ePackage.getEClassifiers().find(c => c.getName() === 'Transport') as BasicEClass;
      expect(transportClass).toBeDefined();
      expect(transportClass.isAbstract()).toBe(true);
    });
  });

  describe('convertFromString', () => {
    it('should parse JSON string and convert', () => {
      const jsonString = JSON.stringify({
        $id: 'http://example.com/test',
        title: 'FromString',
        $defs: {
          Foo: {
            type: 'object',
            properties: {
              bar: { type: 'string' },
            },
          },
        },
      });

      const ePackage = converter.convertFromString(jsonString);
      expect(ePackage.getNsURI()).toBe('http://example.com/test');

      const foo = ePackage.getEClassifiers().find(c => c.getName() === 'Foo');
      expect(foo).toBeDefined();
    });
  });

  describe('convertToEClass', () => {
    it('should convert a single schema to an EClass', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          value: { type: 'integer' },
        },
      };

      const eClass = converter.convertToEClass(schema, 'TestClass');
      expect(eClass).toBeDefined();
      expect(eClass!.getName()).toBe('TestClass');
      expect(eClass!.getEStructuralFeatures().length).toBe(2);
    });

    it('should use title as name when name is not provided', () => {
      const schema = {
        title: 'MyTitle',
        type: 'object',
        properties: {
          x: { type: 'number' },
        },
      };

      const eClass = converter.convertToEClass(schema);
      expect(eClass).toBeDefined();
      expect(eClass!.getName()).toBe('MyTitle');
    });
  });

  describe('getDiagnostics', () => {
    it('should report unsupported keywords', () => {
      const schema = {
        $defs: {
          Complex: {
            type: 'object',
            properties: {},
            if: { properties: { x: { const: 1 } } },
            then: { required: ['y'] },
          },
        },
      };

      converter.convert(schema);
      const diagnostics = converter.getDiagnostics();
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics.some(d => d.message.includes('if'))).toBe(true);
    });

    it('should report unresolved references', () => {
      const schema = {
        $defs: {
          Broken: {
            type: 'object',
            properties: {
              missing: { $ref: '#/$defs/DoesNotExist' },
            },
          },
        },
      };

      converter.convert(schema);
      const diagnostics = converter.getDiagnostics();
      expect(diagnostics.some(d => d.code === 'UNRESOLVED_REFERENCE')).toBe(true);
    });
  });
});