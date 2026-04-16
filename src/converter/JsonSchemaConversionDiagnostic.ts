/**
 * Diagnostic for JSON Schema conversion warnings and errors.
 */

export enum DiagnosticCode {
  UNRESOLVED_REFERENCE = 'UNRESOLVED_REFERENCE',
  COMPLEX_ANYOF = 'COMPLEX_ANYOF',
  UNSUPPORTED_FEATURE = 'UNSUPPORTED_FEATURE',
  PARTIAL_SUPPORT = 'PARTIAL_SUPPORT',
  GENERAL_WARNING = 'GENERAL_WARNING',
  GENERAL_ERROR = 'GENERAL_ERROR',
}

export class JsonSchemaConversionDiagnostic {
  readonly message: string;
  readonly location: string;
  readonly line: number;
  readonly column: number;
  readonly code: DiagnosticCode;

  constructor(
    message: string,
    location: string,
    code: DiagnosticCode,
    line: number = -1,
    column: number = -1
  ) {
    this.message = message;
    this.location = location;
    this.code = code;
    this.line = line;
    this.column = column;
  }

  toString(): string {
    let s = `[${this.code}] ${this.message}`;
    if (this.location) {
      s += ` at ${this.location}`;
    }
    if (this.line !== -1) {
      s += ` (line ${this.line}`;
      if (this.column !== -1) {
        s += `, column ${this.column}`;
      }
      s += ')';
    }
    return s;
  }

  static unresolvedReference(refPath: string): JsonSchemaConversionDiagnostic {
    return new JsonSchemaConversionDiagnostic(
      `Could not resolve reference: ${refPath}`,
      refPath,
      DiagnosticCode.UNRESOLVED_REFERENCE
    );
  }

  static complexAnyOf(location: string): JsonSchemaConversionDiagnostic {
    return new JsonSchemaConversionDiagnostic(
      'Complex anyOf with different schemas detected. May require manual modeling.',
      location,
      DiagnosticCode.COMPLEX_ANYOF
    );
  }

  static unsupportedFeature(keyword: string, location: string): JsonSchemaConversionDiagnostic {
    return new JsonSchemaConversionDiagnostic(
      `Unsupported JSON Schema keyword '${keyword}' - cannot be mapped to EMF`,
      location,
      DiagnosticCode.UNSUPPORTED_FEATURE
    );
  }

  static partialSupport(keyword: string, location: string, detail: string): JsonSchemaConversionDiagnostic {
    return new JsonSchemaConversionDiagnostic(
      `Keyword '${keyword}' is partially supported: ${detail}`,
      location,
      DiagnosticCode.PARTIAL_SUPPORT
    );
  }
}
