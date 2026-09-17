import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { compile } from "json-schema-to-typescript";

const here = path.dirname(fileURLToPath(import.meta.url));
const protocolRoot = path.resolve(here, "..");
const schemaDir = path.join(protocolRoot, "schemas");
const outputPath = path.join(protocolRoot, "generated", "types.ts");

const rootSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "ProtocolTypes",
  type: "object",
  additionalProperties: false,
  required: ["invocation", "result", "error", "capability"],
  properties: {
    invocation: { $ref: "invocation.schema.json" },
    result: { $ref: "result.schema.json" },
    error: { $ref: "error.schema.json" },
    capability: { $ref: "capability.schema.json" },
  },
};

const output = await compile(rootSchema, "ProtocolTypes", {
  cwd: schemaDir,
  bannerComment: "/* Generated from Tetherplane JSON Schemas. Do not edit. */",
  style: { singleQuote: false, semi: true },
});

for (const requiredType of ["InvocationEnvelope", "ResultEnvelope", "CapabilityError"]) {
  if (!output.includes(requiredType)) {
    throw new Error(`Generated output is missing ${requiredType}`);
  }
}

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, output, "utf8");