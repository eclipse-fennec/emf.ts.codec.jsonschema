# emf.ts.codec.jsonschema

JSON Schema codec for [emf.ts](https://github.com/eclipse-fennec/emf.ts) - bidirectional conversion between JSON Schema and EMF metamodels.

Implements [JSON Schema](https://json-schema.org/specification) Draft 2020-12.

## Features

- Convert JSON Schema (Draft 2020-12) to EMF EPackage metamodels
- Convert EMF EPackage metamodels to JSON Schema
- Support for `$ref`, `allOf`, `anyOf`, `oneOf`, enums, discriminated unions
- Namespace path handling (e.g., `configs/kafka`)
- Annotation preservation (GenModel documentation, JSON Schema metadata)
- Context-specific variants and multi-type properties

## Installation

```bash
npm install @emfts/codec.jsonschema
```

## Usage

### JSON Schema to EPackage

```typescript
import { JsonSchemaToEPackageConverter } from '@emfts/codec.jsonschema';

const converter = new JsonSchemaToEPackageConverter();
const ePackage = converter.convert(jsonSchemaObject);
```

### EPackage to JSON Schema

```typescript
import { EPackageToJsonSchemaConverter } from '@emfts/codec.jsonschema';

const converter = new EPackageToJsonSchemaConverter();
const schema = converter.convert(ePackage);
const schemaString = converter.convertToString(ePackage);
```

## Deployment & Artifacts

| | |
|---|---|
| Registry | [npmjs.com](https://www.npmjs.com/package/@emfts/codec.jsonschema) |
| Package | [`@emfts/codec.jsonschema`](https://www.npmjs.com/package/@emfts/codec.jsonschema) (public) |
| Build output | `dist/` (ESM, `tsc`) — only `dist` is published (see `files` in `package.json`) |
| Source | <https://github.com/eclipse-fennec/emf.ts.codec.jsonschema> (default branch `main`) |
| Project | [Eclipse Fennec](https://projects.eclipse.org/projects/modeling.fennec) |

Releases are published to the npm registry under the `@emfts` scope.

## License

[EPL-2.0](https://www.eclipse.org/legal/epl-2.0/) — see [`LICENSE`](./LICENSE).