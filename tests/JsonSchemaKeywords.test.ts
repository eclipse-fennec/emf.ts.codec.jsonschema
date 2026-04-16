import { describe, it, expect } from 'vitest';
import {
  checkForUnsupportedKeywords,
  isFullySupported,
  isPartiallySupported,
  isUnsupported,
  getSupportLevel,
  SupportLevel,
} from '../src/converter/JsonSchemaKeywords';

describe('JsonSchemaKeywords', () => {
  describe('isFullySupported', () => {
    it('should report core keywords as fully supported', () => {
      expect(isFullySupported('$schema')).toBe(true);
      expect(isFullySupported('$id')).toBe(true);
      expect(isFullySupported('$ref')).toBe(true);
      expect(isFullySupported('$defs')).toBe(true);
    });

    it('should report type keywords as fully supported', () => {
      expect(isFullySupported('type')).toBe(true);
      expect(isFullySupported('enum')).toBe(true);
    });

    it('should report composition keywords as fully supported', () => {
      expect(isFullySupported('allOf')).toBe(true);
      expect(isFullySupported('anyOf')).toBe(true);
      expect(isFullySupported('oneOf')).toBe(true);
    });
  });

  describe('isPartiallySupported', () => {
    it('should detect patternProperties', () => {
      expect(isPartiallySupported('patternProperties')).toBe(true);
    });
  });

  describe('isUnsupported', () => {
    it('should detect unsupported keywords', () => {
      expect(isUnsupported('not')).toBe(true);
      expect(isUnsupported('if')).toBe(true);
      expect(isUnsupported('then')).toBe(true);
      expect(isUnsupported('else')).toBe(true);
    });
  });

  describe('getSupportLevel', () => {
    it('should return correct support levels', () => {
      expect(getSupportLevel('type')).toBe(SupportLevel.FULL);
      expect(getSupportLevel('patternProperties')).toBe(SupportLevel.PARTIAL);
      expect(getSupportLevel('not')).toBe(SupportLevel.NONE);
      expect(getSupportLevel('unknownKeyword')).toBe(SupportLevel.UNKNOWN);
    });
  });

  describe('checkForUnsupportedKeywords', () => {
    it('should return diagnostics for unsupported keywords', () => {
      const schema = {
        type: 'object',
        if: { properties: { x: { const: 1 } } },
        then: { required: ['y'] },
      };

      const diagnostics = checkForUnsupportedKeywords(schema, 'test');
      expect(diagnostics.length).toBe(2);
    });

    it('should return diagnostics for partially supported keywords', () => {
      const schema = {
        type: 'object',
        patternProperties: { '^x-': { type: 'string' } },
      };

      const diagnostics = checkForUnsupportedKeywords(schema, 'test');
      expect(diagnostics.length).toBe(1);
      expect(diagnostics[0].message).toContain('partially supported');
    });

    it('should return empty for fully supported schemas', () => {
      const schema = {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      };

      const diagnostics = checkForUnsupportedKeywords(schema, 'test');
      expect(diagnostics.length).toBe(0);
    });

    it('should handle null/undefined input', () => {
      expect(checkForUnsupportedKeywords(null, 'test')).toEqual([]);
    });
  });
});