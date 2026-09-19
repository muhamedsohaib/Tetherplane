import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import Ajv from "ajv";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

function loadJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.join(root, relativePath), "utf8"),
  ) as Record<string, unknown>;
}

const schemaPaths = {
  invocation: "schemas/invocation.schema.json",
  result: "schemas/result.schema.json",
  error: "schemas/error.schema.json",
  capability: "schemas/capability.schema.json",
};

const fixturePaths = {
  invocation: "fixtures/invocation-device-status.json",
  result: "fixtures/result-device-status.json",
  error: "fixtures/error-capability-unavailable.json",
};test("canonical fixtures validate and required fields are enforced", () => {
  const ajv = new Ajv({ allErrors: true, strict: true });
  const schemas = Object.fromEntries(
    Object.entries(schemaPaths).map(([name, file]) => [name, loadJson(file)]),
  );

  for (const schema of Object.values(schemas)) {
    ajv.addSchema(schema);
  }

  const validateInvocation = ajv.compile(schemas.invocation);
  const validateResult = ajv.compile(schemas.result);
  const validateError = ajv.compile(schemas.error);
  ajv.compile(schemas.capability);

  const invocation = loadJson(fixturePaths.invocation);
  const result = loadJson(fixturePaths.result);
  const error = loadJson(fixturePaths.error);

  assert.equal(validateInvocation(invocation), true, ajv.errorsText(validateInvocation.errors));
  assert.equal(validateResult(result), true, ajv.errorsText(validateResult.errors));
  assert.equal(validateError(error), true, ajv.errorsText(validateError.errors));

  const invalidInvocation = { ...invocation };
  delete invalidInvocation.request_id;
  assert.equal(validateInvocation(invalidInvocation), false);

  const invalidResult = { ...result };
  delete invalidResult.status;
  assert.equal(validateResult(invalidResult), false);
});
test("invocation accepts authenticated principal context", () => {
  const ajv = new Ajv({ allErrors: true, strict: true });
  const schema = loadJson(schemaPaths.invocation);
  const validateInvocation = ajv.compile(schema);
  const invocation = {
    ...loadJson(fixturePaths.invocation),
    principal_id: "model:deepseek-engineer",
  };

  assert.equal(
    validateInvocation(invocation),
    true,
    ajv.errorsText(validateInvocation.errors),
  );
});

test("invocation accepts optional durable job context", () => {
  const ajv = new Ajv({ allErrors: true, strict: true });
  const schema = loadJson(schemaPaths.invocation);
  const validateInvocation = ajv.compile(schema);
  const invocation = {
    ...loadJson(fixturePaths.invocation),
    principal_id: "model:deepseek-engineer",
    job_id: "job_01HZXMODELNEUTRAL",
  };

  assert.equal(
    validateInvocation(invocation),
    true,
    ajv.errorsText(validateInvocation.errors),
  );
});
