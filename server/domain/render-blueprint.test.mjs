import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { validateProductionRuntimeConfig } from "../config/production-runtime-config.mjs";
import { capabilityRegistryForEnvironment } from "./capability-registry.mjs";

const repoFile = (relativePath) => readFileSync(resolve(import.meta.dirname, "../..", relativePath), "utf8");

// No YAML library is installed, so this reads only the strict subset that
// render.yaml uses: block mappings, block sequences, quoted or plain scalars
// and comments. Anything else (flow collections, anchors, multi-line scalars,
// tabs, duplicate keys, YAML 1.1 on/off/yes/no) is rejected, so the file
// cannot drift into syntax this check would misread.
function parseStrictYaml(source) {
  const lines = [];
  source.split(/\r?\n/).forEach((raw, index) => {
    if (raw.includes("\t")) throw new Error(`line ${index + 1}: tabs are not allowed`);
    const content = stripComment(raw, index + 1).trimEnd();
    if (!content.trim()) return;
    lines.push({ indent: content.length - content.trimStart().length, text: content.trim(), number: index + 1 });
  });
  let position = 0;

  function stripComment(raw, number) {
    let quote = null;
    for (let index = 0; index < raw.length; index += 1) {
      const char = raw[index];
      if (quote) { if (char === quote) quote = null; continue; }
      if (char === "\"" || char === "'") quote = char;
      else if (char === "#" && (index === 0 || raw[index - 1] === " ")) return raw.slice(0, index);
    }
    if (quote) throw new Error(`line ${number}: unterminated quoted string`);
    return raw;
  }

  function scalar(text, number) {
    const quoted = text.match(/^"([^"\\]*)"$/) || text.match(/^'([^']*)'$/);
    if (quoted) return quoted[1];
    if (/^["'[\]{}&*!|>%@`]/.test(text) || text.includes(": ")) throw new Error(`line ${number}: unsupported scalar ${text}`);
    if (/^(on|off|yes|no|y|n|null|~)$/i.test(text)) throw new Error(`line ${number}: ambiguous scalar ${text}; quote it`);
    if (text === "true" || text === "false") return text === "true";
    if (/^-?\d+$/.test(text)) return Number(text);
    return text;
  }

  function entry(text, number) {
    const match = text.match(/^([A-Za-z_][\w.-]*):(?: (.*))?$/);
    if (!match) throw new Error(`line ${number}: expected "key: value", got ${text}`);
    return { key: match[1], rest: match[2] ?? "" };
  }

  function block(indent) {
    const first = lines[position];
    if (!first || first.indent !== indent) throw new Error(`line ${first?.number ?? "EOF"}: bad indentation`);
    return first.text === "-" || first.text.startsWith("- ") ? sequence(indent) : mapping(indent);
  }

  function valueAfter(rest, indent, number) {
    if (rest) return scalar(rest, number);
    const next = lines[position];
    if (!next || next.indent <= indent) throw new Error(`line ${number}: missing value`);
    return block(next.indent);
  }

  function mapping(indent) {
    const result = {};
    while (position < lines.length && lines[position].indent === indent) {
      const { text, number } = lines[position];
      if (text.startsWith("- ")) throw new Error(`line ${number}: sequence item inside a mapping`);
      const { key, rest } = entry(text, number);
      if (Object.hasOwn(result, key)) throw new Error(`line ${number}: duplicate key ${key}`);
      position += 1;
      result[key] = valueAfter(rest, indent, number);
    }
    if (position < lines.length && lines[position].indent > indent) throw new Error(`line ${lines[position].number}: bad indentation`);
    return result;
  }

  function sequence(indent) {
    const result = [];
    while (position < lines.length && lines[position].indent === indent && lines[position].text.startsWith("- ")) {
      const line = lines[position];
      const itemText = line.text.slice(2).trim();
      if (/^[A-Za-z_][\w.-]*:(?: |$)/.test(itemText)) {
        // "- key: value" opens a mapping whose remaining keys sit two columns in.
        lines[position] = { ...line, indent: indent + 2, text: itemText };
        result.push(mapping(indent + 2));
      } else {
        position += 1;
        result.push(scalar(itemText, line.number));
      }
    }
    return result;
  }

  const document = block(0);
  if (position !== lines.length) throw new Error(`line ${lines[position].number}: unexpected content`);
  return document;
}

const blueprint = parseStrictYaml(repoFile("render.yaml"));
const environments = blueprint.projects?.[0]?.environments ?? [];
const RENDER_SHA = "0123456789abcdef0123456789abcdef01234567";
// What the release image and Render itself put in the environment. Render
// variables override the image's ENV defaults; RENDER_* are set on every deploy.
const IMAGE_ENV = { NODE_ENV: "production", FLOWCHAIN_DEPLOYMENT_PROFILE: "production", SCM_API_PORT: "8787", FLOWCHAIN_COMMIT_SHA: "unknown", FLOWCHAIN_BRANCH: "unknown" };
const RENDER_PLATFORM_ENV = { RENDER: "true", RENDER_GIT_COMMIT: RENDER_SHA, RENDER_GIT_BRANCH: "main" };
// Keys the guard requires that Render satisfies without a Blueprint entry.
const PLATFORM_SATISFIED = { FLOWCHAIN_COMMIT_SHA: "RENDER_GIT_COMMIT" };
const SECRET_KEYS = ["POSTMARK_SERVER_TOKEN", "RESEND_API_KEY", "OPENAI_API_KEY"];
const OPERATOR_KEYS = ["FLOWCHAIN_DEFAULT_TENANT_ID", "FLOWCHAIN_MAIL_PROVIDER", "FLOWCHAIN_MAIL_FROM", "FLOWCHAIN_PUBLIC_BASE_URL"];

// Every key the production guard reports when nothing is configured.
function guardRequiredKeys() {
  try {
    validateProductionRuntimeConfig({ FLOWCHAIN_DEPLOYMENT_PROFILE: "production" });
  } catch (error) {
    return ["FLOWCHAIN_DEPLOYMENT_PROFILE", ...error.issues.map((entry) => entry.key)];
  }
  throw new Error("The production guard accepted an empty environment.");
}

// The environment the running service would see, with a stand-in for each
// value Render generates, links or prompts for.
function simulatedRenderEnv(service, database) {
  const env = { ...IMAGE_ENV, ...RENDER_PLATFORM_ENV };
  for (const variable of service.envVars) {
    if (variable.fromDatabase) {
      assert.equal(variable.fromDatabase.name, database.name, `${service.name} ${variable.key} database`);
      assert.equal(variable.fromDatabase.property, "connectionString");
      env[variable.key] = `postgresql://${database.user}:generated@${database.name}.internal:5432/${database.databaseName}`;
    } else if (variable.generateValue === true) {
      env[variable.key] = randomBytes(32).toString("base64");
    } else if (variable.sync === false) {
      env[variable.key] = variable.key === "FLOWCHAIN_DEFAULT_TENANT_ID" ? "tenant-render-blueprint" : "operator-supplied";
    } else {
      env[variable.key] = variable.value;
    }
  }
  return env;
}

const parseExample = (relativePath) => Object.fromEntries(
  repoFile(relativePath).split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);
const enabledCapabilities = (env) => capabilityRegistryForEnvironment(env).filter((entry) => entry.enabled).map((entry) => entry.id).sort();

test("the strict YAML reader rejects syntax it does not understand", () => {
  assert.deepEqual(parseStrictYaml("a:\n  - b: \"1\"\n    c: 2\n  - d\n"), { a: [{ b: "1", c: 2 }, "d"] });
  for (const source of ["a: [1, 2]\n", "a: off\n", "a: 1\na: 2\n", "a:\n\tb: 1\n", "a: &x 1\n", "a: |\n  text\n"]) {
    assert.throws(() => parseStrictYaml(source), undefined, JSON.stringify(source));
  }
});

test("render.yaml defines a staging and a production environment", () => {
  assert.equal(blueprint.projects.length, 1);
  assert.deepEqual(environments.map((environment) => environment.name), ["staging", "production"]);
  for (const environment of environments) {
    assert.equal(environment.services.length, 1, environment.name);
    assert.equal(environment.databases.length, 1, environment.name);
  }
});

for (const environment of environments) {
  const [service] = environment.services;
  const [database] = environment.databases;

  test(`${environment.name}: one Virginia Docker web service with health check, migrations and an attachment disk`, () => {
    assert.equal(service.type, "web");
    assert.equal(service.runtime, "docker");
    assert.equal(service.dockerfilePath, "./Dockerfile");
    assert.equal(service.region, "virginia");
    assert.notEqual(service.plan, "free", "disks and preDeployCommand need a paid plan");
    // Attachments live on the instance's disk: never more than one instance.
    assert.equal(service.numInstances, 1);
    assert.equal(service.scaling, undefined);
    assert.equal(service.healthCheckPath, "/api/health");
    assert.match(service.preDeployCommand, /^npx prisma migrate deploy$/);
    assert.equal(service.dockerCommand, undefined, "the image CMD starts the server");
    const env = Object.fromEntries(service.envVars.filter((entry) => "value" in entry).map((entry) => [entry.key, entry.value]));
    assert.equal(service.disk.mountPath, env.FLOWCHAIN_UPLOAD_STORAGE_DIR);
    assert.ok(Number.isInteger(service.disk.sizeGB) && service.disk.sizeGB >= 1);
    assert.equal(env.PORT, env.SCM_API_PORT);
  });

  test(`${environment.name}: managed PostgreSQL 16 in Virginia on a plan with backups`, () => {
    assert.equal(database.region, "virginia");
    assert.equal(database.postgresMajorVersion, "16");
    assert.notEqual(database.plan, "free", "the free plan has no point-in-time recovery");
    assert.ok(database.diskSizeGB === 1 || database.diskSizeGB % 5 === 0);
  });

  test(`${environment.name}: every variable the production guard requires is supplied, and the guard passes`, () => {
    const keys = service.envVars.map((entry) => entry.key);
    assert.equal(new Set(keys).size, keys.length, "duplicate envVars");
    for (const key of guardRequiredKeys()) {
      if (PLATFORM_SATISFIED[key]) assert.ok(!keys.includes(key), `${key} comes from ${PLATFORM_SATISFIED[key]}`);
      else assert.ok(keys.includes(key), `render.yaml ${environment.name} is missing ${key}`);
    }
    const env = simulatedRenderEnv(service, database);
    const result = validateProductionRuntimeConfig(env);
    assert.equal(result.production, true);
    assert.equal(result.commitSha, RENDER_SHA);
    assert.equal(result.branch, "main");
    assert.notEqual(String(env.FLOWCHAIN_ALLOW_TEST_IDENTITY_HEADERS).toLowerCase(), "true");
  });

  test(`${environment.name}: secrets are prompted or generated, never written in the file`, () => {
    for (const variable of service.envVars) {
      const sources = ["value", "fromDatabase", "generateValue", "sync"].filter((field) => field in variable);
      assert.equal(sources.length, 1, `${variable.key} must have exactly one source`);
      if ("value" in variable) assert.equal(typeof variable.value, "string", `${variable.key} value must be a quoted string`);
      if ("sync" in variable) assert.equal(variable.sync, false);
      if (/SECRET|TOKEN|API_KEY|PASSWORD/.test(variable.key)) assert.ok(!("value" in variable), `${variable.key} is a secret`);
    }
    const byKey = Object.fromEntries(service.envVars.map((entry) => [entry.key, entry]));
    assert.equal(byKey.FLOWCHAIN_LOCAL_SESSION_SECRET.generateValue, true);
    for (const key of [...SECRET_KEYS, ...OPERATOR_KEYS]) assert.equal(byKey[key]?.sync, false, key);
  });

  test(`${environment.name}: the US trial capability set matches deploy/env.production.example`, () => {
    const env = simulatedRenderEnv(service, database);
    assert.deepEqual(enabledCapabilities(env), enabledCapabilities(parseExample("deploy/env.production.example")));
  });
}

test("staging and production differ only in names, plans, sizes and deploy trigger", () => {
  const shape = (environment) => {
    const [service] = environment.services;
    return service.envVars.map(({ fromDatabase, ...rest }) => ({ ...rest, fromDatabase: fromDatabase?.property }));
  };
  const [staging, production] = environments;
  assert.deepEqual(shape(production), shape(staging));
  assert.equal(staging.services[0].autoDeployTrigger, "checksPass");
  assert.equal(production.services[0].autoDeployTrigger, "off", "production deploys only by hand");
});
