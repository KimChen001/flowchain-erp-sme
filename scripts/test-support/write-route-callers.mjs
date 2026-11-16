// Finds the write (POST, PUT, PATCH, DELETE) routes the server answers under
// server/routes, and the write requests the app under src/ sends, so a test
// can check that every write route has a caller in the app or a stated reason
// why it has none (server/routes/write-route-callers.test.mjs).
//
// Both sides are read with the TypeScript parser; nothing is run.
//
// Server side. A route file answers a write when a check on the request
// method (`req.method === "POST"`, `!== "POST"`, `["POST"].includes(method)`,
// `ACTIONS[req.method]`) is governed by a check on the path: `path ===
// "/api/..."`, a `path.match(/^\/api\/...$/)` result or a `/re/.test(path)`,
// or the keys of an object indexed by the path. Those checks are read from
// the method check's own condition, the `if`, `&&` and `?:` conditions around
// it, the early returns before it, and boolean constants such as
// `const create = method === "POST" && path === "/api/x"`. A path regex
// becomes one route per alternative; conditions on a captured group
// (`action === "submit"`, `!action`, `["a", "b"].includes(action)`) keep the
// matching alternatives. A method check with no path found is reported, so a
// new way of writing a route fails the test instead of passing unseen.
//
// App side. A write request is a "POST" (or PUT, PATCH, DELETE) literal given
// as `method:` or as an argument, followed out to the call it configures:
// `apiJson(url, { method: "POST" })` or `apiJson(url, json("POST", body))`;
// the url is that call's first argument. A helper that adds the method
// (`const post = (url, body) => apiJson(url, { method: "POST" })`) counts at
// each place it is called. The url is resolved through string and template
// literals, constants and later assignments (`let path = ""; path = "x"`),
// lookup tables (`{ transfer: { url } }[kind].url`), small local functions
// that build paths or return `{ url }`, function parameters (from the calls of
// that function in its file) and component props (from the JSX that renders
// the component). An encoded id (`encodeURIComponent(id)`) stays within one
// path segment; anything else left unknown becomes `*`.
//
// A route is called when a request with its method has a url that matches
// it: the url's unknown parts may stand for any text of the route, and a
// route parameter for any one segment of the url. When an unknown part
// covers a fixed word of the route (an action such as "approve"), that word
// must appear as a string in a file the url was read from, so
// `/api/orders/${id}/${action}` counts for the actions those files name, not
// for every action under the path.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

export const WRITE_METHODS = Object.freeze(["POST", "PUT", "PATCH", "DELETE"]);
const WRITE = new Set(WRITE_METHODS);
export const PARAM = ":id";
const SEGMENT = "\u0001"; // unknown text that stays within one path segment
const MAX_PATTERNS = 64; // a cap on the patterns built by joining pieces
const MAX_URLS = 512; // a cap on the urls a request can take

const posix = (path) => path.split("\\").join("/");

function parse(file, text) {
  const kind = /\.(tsx|jsx)$/.test(file) ? ts.ScriptKind.TSX : /\.ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

const isStringy = (node) => Boolean(node) && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));
function unwrap(node) {
  let current = node;
  while (current && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current) || ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current))) current = current.expression;
  return current;
}
const isFunctionLike = (node) => ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node);
const lineOf = (node) => node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;
const contains = (outer, inner) => Boolean(outer) && outer.getStart() <= inner.getStart() && inner.getEnd() <= outer.getEnd();
const isOperator = (node, ...kinds) => ts.isBinaryExpression(node) && kinds.includes(node.operatorToken.kind);
const EQUAL = [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken];
const NOT_EQUAL = [ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken];

// `{ ... }` or `Object.freeze({ ... })`
function objectLiteralOf(node) {
  let target = unwrap(node);
  if (target && ts.isCallExpression(target) && target.expression.getText() === "Object.freeze") target = unwrap(target.arguments[0]);
  return target && ts.isObjectLiteralExpression(target) ? target : null;
}
const propertyName = (property) => property.name && (ts.isIdentifier(property.name) || isStringy(property.name)) ? property.name.text : "";

// ---------------------------------------------------------------------------
// Path regexes. /^\/api\/x\/([^/]+)(?:\/(submit|approve))?$/ expands to
// /api/x/:id, /api/x/:id/submit and /api/x/:id/approve. Each expansion keeps
// its pieces (text, or a parameter tagged with its capture group) and the
// value of every capture group (null when an optional group is absent).

const PIECE_PARAM = "param";

export function expandPathRegex(literal) {
  const source = literal.startsWith("/") ? literal.slice(1, literal.lastIndexOf("/")) : literal;
  let index = 0;
  let groupCount = 0;
  const peek = () => source[index];

  function parseAlternation() {
    const branches = [parseSequence()];
    while (peek() === "|") {
      index += 1;
      branches.push(parseSequence());
    }
    return { type: "alt", branches };
  }
  function parseSequence() {
    const items = [];
    while (index < source.length && peek() !== "|" && peek() !== ")") {
      let atom = parseAtom();
      if (!atom) continue;
      const quantifier = peek();
      if (quantifier === "?" || quantifier === "*" || quantifier === "+") {
        index += 1;
        if (peek() === "?") index += 1;
        if (atom.type === "char" || atom.type === "class") atom = { type: "param" };
        else if (quantifier !== "+") atom = { type: "optional", atom };
      } else if (quantifier === "{") {
        index = source.indexOf("}", index) + 1;
        if (atom.type === "char" || atom.type === "class") atom = { type: "param" };
      } else if (atom.type === "class") {
        atom = { type: "param" };
      }
      items.push(atom);
    }
    return { type: "seq", items };
  }
  function parseAtom() {
    const char = peek();
    if (char === "^" || char === "$") {
      index += 1;
      return null;
    }
    if (char === "\\") {
      const next = source[index + 1];
      index += 2;
      return /[dDwWsS]/.test(next) ? { type: "class" } : { type: "char", value: next };
    }
    if (char === "[") {
      let end = index + 1;
      if (source[end] === "^") end += 1;
      if (source[end] === "]") end += 1;
      while (end < source.length && source[end] !== "]") end += source[end] === "\\" ? 2 : 1;
      index = end + 1;
      return { type: "class" };
    }
    if (char === ".") {
      index += 1;
      return { type: "class" };
    }
    if (char === "(") {
      index += 1;
      let group = 0;
      if (peek() === "?") index += 2; // (?: - route paths use no lookarounds
      else group = groupCount += 1;
      const inner = parseAlternation();
      index += 1;
      return { type: "group", group, inner };
    }
    index += 1;
    return { type: "char", value: char };
  }
  function groupsIn(node) {
    if (!node) return [];
    if (node.type === "group") return [...(node.group ? [node.group] : []), ...groupsIn(node.inner)];
    if (node.type === "alt") return node.branches.flatMap(groupsIn);
    if (node.type === "seq") return node.items.flatMap(groupsIn);
    if (node.type === "optional") return groupsIn(node.atom);
    return [];
  }
  function expand(node) {
    if (node.type === "char") return [{ pieces: [node.value], groups: {} }];
    if (node.type === "param" || node.type === "class") return [{ pieces: [{ kind: PIECE_PARAM, group: 0 }], groups: {} }];
    if (node.type === "alt") return node.branches.flatMap(expand);
    if (node.type === "optional") {
      const absent = Object.fromEntries(groupsIn(node.atom).map((group) => [group, null]));
      return [{ pieces: [], groups: absent }, ...expand(node.atom)];
    }
    if (node.type === "group") {
      return expand(node.inner).map((option) => {
        if (!node.group) return option;
        const lone = option.pieces.length === 1 && typeof option.pieces[0] === "object";
        const pieces = lone ? [{ kind: PIECE_PARAM, group: node.group }] : option.pieces;
        return { pieces, groups: { ...option.groups, [node.group]: render(pieces) } };
      });
    }
    let results = [{ pieces: [], groups: {} }];
    for (const item of node.items) {
      results = results.flatMap((left) => expand(item).map((right) => ({ pieces: [...left.pieces, ...right.pieces], groups: { ...left.groups, ...right.groups } })));
    }
    return results;
  }
  return expand(parseAlternation()).map((option) => ({ ...option, path: render(option.pieces) }));
}

function render(pieces, values = {}) {
  return pieces.map((piece) => (typeof piece === "string" ? piece : values[piece.group] ?? PARAM)).join("").replace(/(?::id)+/g, PARAM);
}

// ---------------------------------------------------------------------------
// Names declared in a file: `const x = value` (plain), `const [, a] = value`
// (element 1), `const { url } = value` (property "url") and function
// declarations (hoisted).
function bindingsOf(sourceFile) {
  const byName = new Map();
  const add = (name, entry) => byName.set(name, [...(byName.get(name) || []), entry]);
  walk(sourceFile, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) add(node.name.text, { node, initializer: node, hoisted: true });
    if (!ts.isVariableDeclaration(node) || !node.initializer) return;
    if (ts.isIdentifier(node.name)) add(node.name.text, { node, initializer: node.initializer });
    else if (ts.isArrayBindingPattern(node.name)) {
      node.name.elements.forEach((element, position) => {
        if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) add(element.name.text, { node, initializer: node.initializer, element: position });
      });
    } else if (ts.isObjectBindingPattern(node.name)) {
      for (const element of node.name.elements) {
        if (ts.isIdentifier(element.name)) add(element.name.text, { node, initializer: node.initializer, property: (element.propertyName || element.name).getText() });
      }
    }
  });
  return byName;
}
const isPlain = (binding) => Boolean(binding) && binding.element === undefined && binding.property === undefined && !binding.hoisted;

function enclosingScope(node) {
  let current = node.parent;
  while (current && !isFunctionLike(current) && !ts.isSourceFile(current)) current = current.parent;
  return current;
}

// The declaration of `name` in force at `at`: the nearest one before it (any
// function declaration) whose enclosing function also encloses `at`.
function bindingAt(bindings, name, at) {
  return (bindings.get(name) || [])
    .filter((entry) => (entry.hoisted || entry.node.getStart() <= at.getStart()) && contains(enclosingScope(entry.node), at))
    .sort((left, right) => right.node.getStart() - left.node.getStart())[0] || null;
}

// ---------------------------------------------------------------------------
// Server side.

const isMethodExpression = (node) => /(^|\.)method$/.test(unwrap(node)?.getText() || "");
const isPathExpression = (node) => /(^|\.)(path|pathname)$/.test(unwrap(node)?.getText() || "");
const writeLiteral = (node) => (isStringy(unwrap(node)) && WRITE.has(unwrap(node).text) ? unwrap(node).text : null);

function methodChecks(sourceFile, bindings) {
  const checks = [];
  walk(sourceFile, (node) => {
    if (isOperator(node, ...EQUAL, ...NOT_EQUAL)) {
      const method = (isMethodExpression(node.left) && writeLiteral(node.right)) || (isMethodExpression(node.right) && writeLiteral(node.left));
      if (method) checks.push({ node, methods: [method], negated: NOT_EQUAL.includes(node.operatorToken.kind) });
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "includes" && node.arguments.length === 1 && isMethodExpression(node.arguments[0])) {
      const list = unwrap(node.expression.expression);
      const methods = ts.isArrayLiteralExpression(list) ? list.elements.map(writeLiteral).filter(Boolean) : [];
      if (methods.length) checks.push({ node, methods, negated: false });
    } else if (ts.isElementAccessExpression(node) && isMethodExpression(node.argumentExpression) && ts.isIdentifier(node.expression)) {
      // ACTIONS[req.method] with ACTIONS = { GET: ..., POST: ... }
      const binding = bindingAt(bindings, node.expression.text, node);
      const object = binding && objectLiteralOf(binding.initializer);
      const methods = object ? object.properties.map(propertyName).filter((name) => WRITE.has(name)) : [];
      if (methods.length) checks.push({ node, methods, negated: false });
    }
  });
  return checks;
}

// The conditions known where `check` runs, innermost first, each
// { node, positive } (positive false: the condition is known to be false).
function conditionsAround(check) {
  const found = [];
  let current = check.node;
  while (current.parent) {
    const parent = current.parent;
    if (isOperator(parent, ts.SyntaxKind.AmpersandAmpersandToken)) {
      found.push({ node: parent.left === current ? parent.right : parent.left, positive: true });
    } else if (isOperator(parent, ts.SyntaxKind.BarBarToken) && check.negated) {
      // `if (method !== "POST" || !match) return`: the route is where both are false.
      found.push({ node: parent.left === current ? parent.right : parent.left, positive: false });
    } else if (ts.isConditionalExpression(parent)) {
      // `method === "POST" ? path.match(/re/) : null` - the match holds for POST.
      if (parent.condition === current) found.push({ node: parent.whenTrue, positive: true });
      else found.push({ node: parent.condition, positive: parent.whenTrue === current });
    } else if (ts.isIfStatement(parent)) {
      if (parent.expression !== current) found.push({ node: parent.expression, positive: parent.thenStatement === current });
    } else if (ts.isBlock(parent) || ts.isSourceFile(parent) || ts.isCaseClause(parent)) {
      // Early returns before this statement: `if (!match) return false`.
      const statements = parent.statements;
      for (let position = statements.indexOf(current) - 1; position >= 0; position -= 1) {
        const statement = statements[position];
        if (ts.isIfStatement(statement) && !statement.elseStatement && exits(statement.thenStatement)) found.push({ node: statement.expression, positive: false });
      }
    }
    if (isFunctionLike(parent)) break;
    current = parent;
  }
  return found;
}
function exits(statement) {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true;
  return ts.isBlock(statement) && statement.statements.some((inner) => ts.isReturnStatement(inner) || ts.isThrowStatement(inner));
}

const newFacts = () => ({ paths: [], matches: [], groups: [], excluded: new Set() });
const pathCount = (facts) => facts.paths.length + facts.matches.length;

// Facts in one condition: paths compared, regex matches tested, and values of
// captured groups. `positive` is whether the condition holds.
function factsIn(condition, positive, bindings, facts, depth = 0) {
  const node = unwrap(condition);
  if (!node || depth > 6) return;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) return factsIn(node.operand, !positive, bindings, facts, depth);
  if (isOperator(node, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken)) {
    const kind = node.operatorToken.kind;
    const operands = [];
    const flatten = (part) => (isOperator(unwrap(part), kind) ? (flatten(unwrap(part).left), flatten(unwrap(part).right)) : operands.push(part));
    flatten(node);
    if ((kind === ts.SyntaxKind.AmpersandAmpersandToken) === positive) {
      // Every operand holds (a && b), or every operand fails (!(a || b)).
      for (const operand of operands) factsIn(operand, positive, bindings, facts, depth);
    } else {
      // Either operand: a || b, or !(a && b). Paths count only when every operand names one.
      const sides = operands.map((side) => {
        const own = newFacts();
        factsIn(side, positive, bindings, own, depth);
        return own;
      });
      if (sides.every((side) => pathCount(side) > 0)) {
        for (const side of sides) {
          facts.paths.push(...side.paths);
          facts.matches.push(...side.matches.filter((match) => !facts.excluded.has(match.key)));
        }
      }
      const valued = sides.map((side) => side.groups.filter((group) => group.values));
      if (valued.every((groups) => groups.length === 1) && valued.every((groups) => groups[0].key === valued[0][0].key && groups[0].group === valued[0][0].group)) {
        facts.groups.push({ ...valued[0][0], values: valued.flatMap((groups) => groups[0].values) });
      }
    }
    return;
  }
  if (isOperator(node, ...EQUAL, ...NOT_EQUAL)) {
    const holds = EQUAL.includes(node.operatorToken.kind) === positive;
    const [subject, literal] = isStringy(unwrap(node.right)) ? [node.left, unwrap(node.right)] : isStringy(unwrap(node.left)) ? [node.right, unwrap(node.left)] : [null, null];
    if (!subject) return;
    if (isPathExpression(subject)) {
      if (holds && literal.text.startsWith("/api/")) facts.paths.push(literal.text);
      return;
    }
    const group = groupOf(subject, bindings);
    if (group) facts.groups.push({ ...group, [holds ? "values" : "notValues"]: [literal.text] });
    return;
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const name = node.expression.name.text;
    const [argument] = node.arguments;
    if (name === "includes" && node.arguments.length === 1 && positive) {
      const list = unwrap(node.expression.expression);
      const group = groupOf(argument, bindings);
      if (group && ts.isArrayLiteralExpression(list) && list.elements.every((element) => isStringy(unwrap(element)))) {
        facts.groups.push({ ...group, values: list.elements.map((element) => unwrap(element).text) });
      }
      return;
    }
    // path.match(/re/) or /re/.test(path), written in the condition itself
    const regex = regexOfCall(node);
    if (regex) {
      if (positive) facts.matches.push({ key: node, regex });
      return;
    }
  }
  if (ts.isElementAccessExpression(node) && isPathExpression(node.argumentExpression) && ts.isIdentifier(node.expression)) {
    // ROUTES[url.pathname] with ROUTES = { "/api/x": ... }
    const binding = bindingAt(bindings, node.expression.text, node);
    const object = binding && objectLiteralOf(binding.initializer);
    if (object && positive) for (const property of object.properties) if (propertyName(property).startsWith("/api/")) facts.paths.push(propertyName(property));
    return;
  }
  if (ts.isElementAccessExpression(node)) {
    // { "cancel-preview": "cancel", ... }[action]: the action is one of the keys.
    const table = ts.isIdentifier(unwrap(node.expression)) ? bindingAt(bindings, unwrap(node.expression).text, node) : null;
    const object = objectLiteralOf(table && isPlain(table) ? table.initializer : node.expression);
    const group = object ? groupOf(node.argumentExpression, bindings) : null;
    if (group) {
      if (positive) facts.groups.push({ ...group, values: object.properties.map(propertyName).filter(Boolean) });
      return;
    }
  }
  const match = matchOf(node, bindings);
  if (match) {
    if (positive && !facts.excluded.has(match.key)) facts.matches.push(match);
    if (!positive) facts.excluded.add(match.key);
    return;
  }
  const group = groupOf(node, bindings);
  if (group) {
    facts.groups.push({ ...group, present: positive });
    return;
  }
  // A boolean constant: const create = method === "POST" && path === "/api/x".
  if (ts.isIdentifier(node)) {
    const binding = bindingAt(bindings, node.text, node);
    if (isPlain(binding)) factsIn(binding.initializer, positive, bindings, facts, depth + 1);
  }
}

function regexOfCall(call) {
  const node = unwrap(call);
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null;
  const name = node.expression.name.text;
  const target = unwrap(node.expression.expression);
  if (name === "match" && node.arguments[0] && ts.isRegularExpressionLiteral(node.arguments[0])) return node.arguments[0].text;
  if ((name === "exec" || name === "test") && ts.isRegularExpressionLiteral(target)) return target.text;
  return null;
}

// `m` where `const m = path.match(/re/)`, `/re/.exec(path)`, or
// `method === "PATCH" ? path.match(/re/) : null`.
function matchOf(node, bindings) {
  const target = unwrap(node);
  if (!ts.isIdentifier(target)) return null;
  const binding = bindingAt(bindings, target.text, target);
  if (!isPlain(binding)) return null;
  let initializer = unwrap(binding.initializer);
  if (isOperator(initializer, ts.SyntaxKind.AmpersandAmpersandToken)) initializer = unwrap(initializer.right);
  if (ts.isConditionalExpression(initializer)) initializer = unwrap(initializer.whenTrue);
  const regex = regexOfCall(initializer);
  return regex ? { key: binding.node, regex } : null;
}

// A captured group: `m[2]`, `const action = m[2] || ""`,
// `const id = m[3] ? decodeURIComponent(m[3]) : null`, `const [, id, action] = m`.
function groupOf(node, bindings, depth = 0) {
  const target = unwrap(node);
  if (!target || depth > 3) return null;
  if (ts.isElementAccessExpression(target) && ts.isNumericLiteral(target.argumentExpression)) {
    const match = matchOf(target.expression, bindings);
    return match ? { key: match.key, regex: match.regex, group: Number(target.argumentExpression.text) } : null;
  }
  if (!ts.isIdentifier(target)) return null;
  const binding = bindingAt(bindings, target.text, target);
  if (!binding || binding.property !== undefined || binding.hoisted) return null;
  if (binding.element !== undefined) {
    const match = matchOf(binding.initializer, bindings);
    return match ? { key: match.key, regex: match.regex, group: binding.element } : null;
  }
  let initializer = unwrap(binding.initializer);
  if (isOperator(initializer, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken)) initializer = unwrap(initializer.left);
  if (ts.isConditionalExpression(initializer)) initializer = unwrap(initializer.condition);
  if (ts.isCallExpression(initializer) && initializer.arguments.length === 1) initializer = unwrap(initializer.arguments[0]);
  return ts.isElementAccessExpression(initializer) ? groupOf(initializer, bindings, depth + 1) : null;
}

function routesForCheck(check, bindings) {
  const facts = newFacts();
  for (const condition of conditionsAround(check)) {
    const before = pathCount(facts);
    factsIn(condition.node, condition.positive, bindings, facts);
    // The innermost path check wins.
    if (pathCount(facts) > before) break;
  }
  const routes = [];
  for (const method of check.methods) {
    for (const path of new Set(facts.paths)) routes.push({ method, path });
    for (const match of facts.matches) {
      const groups = facts.groups.filter((group) => group.key === match.key);
      for (const option of expandPathRegex(match.regex)) {
        const fits = groups.every((group) => {
          const value = option.groups[group.group];
          if (group.values) return value === PARAM || group.values.includes(value);
          if (group.notValues) return !group.notValues.includes(value);
          return group.present ? value !== null && value !== undefined : value === null || value === undefined;
        });
        if (!fits) continue;
        // A generic ([^/]+) group narrowed to named values: one route per value.
        let variants = [{}];
        for (const group of groups) {
          if (!group.values || option.groups[group.group] !== PARAM) continue;
          variants = variants.flatMap((variant) => group.values.map((value) => ({ ...variant, [group.group]: value })));
        }
        for (const values of variants) routes.push({ method, path: render(option.pieces, values) });
      }
    }
  }
  return routes;
}

export function readServerWriteRoutes(root, { directory = "server/routes" } = {}) {
  const routes = new Map();
  const unresolved = [];
  const folder = join(root, directory);
  for (const name of readdirSync(folder).sort()) {
    if (!name.endsWith(".mjs") || name.endsWith(".test.mjs")) continue;
    const file = posix(join(directory, name));
    const sourceFile = parse(file, readFileSync(join(folder, name), "utf8"));
    const bindings = bindingsOf(sourceFile);
    for (const check of methodChecks(sourceFile, bindings)) {
      const found = routesForCheck(check, bindings);
      if (!found.length) unresolved.push({ file, line: lineOf(check.node), methods: check.methods, text: check.node.getText() });
      for (const route of found) {
        const key = `${route.method} ${route.path}`;
        if (!routes.has(key)) routes.set(key, { key, method: route.method, path: route.path, sources: [] });
        routes.get(key).sources.push(`${file}:${lineOf(check.node)}`);
      }
    }
  }
  return { routes: [...routes.values()].sort((left, right) => left.path.localeCompare(right.path) || left.method.localeCompare(right.method)), unresolved };
}

// ---------------------------------------------------------------------------
// App side.

function listSourceFiles(folder) {
  const files = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(path));
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name) && !/\.(test|spec)\.[a-z]+$/.test(entry.name) && !entry.name.endsWith(".d.ts")) files.push(path);
  }
  return files;
}

function functionName(fn) {
  if (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) return fn.name?.getText() || "";
  const parent = fn.parent;
  if ((ts.isVariableDeclaration(parent) || ts.isBindingElement(parent) || ts.isParameter(parent)) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyAssignment(parent)) return propertyName(parent);
  // const Panel = memo(function Panel() {}) or forwardRef((props) => ...)
  if (ts.isCallExpression(parent) && ts.isVariableDeclaration(parent.parent) && ts.isIdentifier(parent.parent.name)) return parent.parent.name.text;
  return "";
}

class AppIndex {
  constructor(root, folders) {
    this.sources = new Map();
    this.jsx = new Map();
    for (const path of folders.flatMap((folder) => listSourceFiles(join(root, folder)))) {
      const file = posix(relative(root, path));
      const sourceFile = parse(file, readFileSync(path, "utf8"));
      this.sources.set(file, { file, sourceFile, bindings: bindingsOf(sourceFile), strings: null, calls: null });
    }
  }
  sourceOf(node) {
    return this.sources.get(node.getSourceFile().fileName);
  }
  // Every string in a file, and each /-separated piece of it.
  stringsIn(source) {
    if (!source.strings) {
      const strings = new Set();
      const add = (text) => [text, ...text.split("/")].forEach((piece) => piece && strings.add(piece));
      walk(source.sourceFile, (node) => {
        if (isStringy(node)) add(node.text);
        else if (ts.isTemplateExpression(node)) [node.head, ...node.templateSpans.map((span) => span.literal)].forEach((part) => add(part.text));
      });
      source.strings = strings;
    }
    return source.strings;
  }
  callsOf(node, name) {
    const source = this.sourceOf(node);
    if (!source.calls) {
      source.calls = new Map();
      walk(source.sourceFile, (call) => {
        if (!ts.isCallExpression(call)) return;
        const callee = unwrap(call.expression);
        const calleeName = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
        if (calleeName) source.calls.set(calleeName, [...(source.calls.get(calleeName) || []), call]);
      });
    }
    return name ? source.calls.get(name) || [] : [];
  }
  // `name = value` assignments in a file.
  assignmentsOf(source, name) {
    if (!source.assignments) {
      source.assignments = new Map();
      walk(source.sourceFile, (node) => {
        if (isOperator(node, ts.SyntaxKind.EqualsToken) && ts.isIdentifier(node.left)) {
          source.assignments.set(node.left.text, [...(source.assignments.get(node.left.text) || []), node]);
        }
      });
    }
    return source.assignments.get(name) || [];
  }
  // JSX elements, anywhere in the app, that render the component `name`.
  jsxUses(name) {
    if (!this.jsx.size) {
      for (const source of this.sources.values()) {
        walk(source.sourceFile, (node) => {
          if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
            const tag = node.tagName.getText();
            this.jsx.set(tag, [...(this.jsx.get(tag) || []), node]);
          }
        });
      }
    }
    return this.jsx.get(name) || [];
  }
}

const cartesian = (lefts, rights) => lefts.flatMap((left) => rights.map((right) => left + right)).slice(0, MAX_PATTERNS);

// Every url a request can go to, as patterns with * for unknown text and
// SEGMENT for unknown text within one path segment (an encoded id). Each file
// read on the way is noted in index.trace: the words a * may stand for.
function resolveUrl(index, node, env, depth = 0) {
  const target = unwrap(node);
  if (!target || depth > 8) return ["*"];
  index.trace?.add(target.getSourceFile().fileName);
  if (isStringy(target)) return [target.text];
  if (ts.isTemplateExpression(target)) {
    let results = [target.head.text];
    for (const span of target.templateSpans) results = cartesian(cartesian(results, resolveUrl(index, span.expression, env, depth + 1)), [span.literal.text]);
    return results;
  }
  if (ts.isConditionalExpression(target)) return [...resolveUrl(index, target.whenTrue, env, depth + 1), ...resolveUrl(index, target.whenFalse, env, depth + 1)].slice(0, MAX_URLS);
  if (isOperator(target, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken)) return [...resolveUrl(index, target.left, env, depth + 1), ...resolveUrl(index, target.right, env, depth + 1)];
  if (isOperator(target, ts.SyntaxKind.PlusToken)) return cartesian(resolveUrl(index, target.left, env, depth + 1), resolveUrl(index, target.right, env, depth + 1));
  if (ts.isIdentifier(target)) return resolveIdentifier(index, target, env, depth);
  if (ts.isCallExpression(target)) {
    const callee = unwrap(target.expression);
    // An encoded id is one path segment: it has no "/".
    if (ts.isIdentifier(callee) && callee.text === "encodeURIComponent") return [SEGMENT];
    // config.url.replace("/workbench", `/${action}`)
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "replace" && target.arguments.length === 2 && isStringy(unwrap(target.arguments[0]))) {
      const from = unwrap(target.arguments[0]).text;
      const replacements = resolveUrl(index, target.arguments[1], env, depth + 1);
      return resolveUrl(index, callee.expression, env, depth + 1).flatMap((subject) => replacements.map((to) => subject.replace(from, to))).slice(0, MAX_PATTERNS);
    }
    // A small local function that builds a path: path(id, "/activate").
    if (ts.isIdentifier(callee)) {
      const binding = bindingAt(index.sourceOf(target).bindings, callee.text, target);
      const fn = binding && unwrap(binding.initializer);
      if (fn && ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) {
        const local = new Map(env);
        fn.parameters.forEach((parameter, position) => {
          if (ts.isIdentifier(parameter.name)) local.set(parameter.name.text, target.arguments[position] || parameter.initializer || null);
        });
        return resolveUrl(index, fn.body, local, depth + 1);
      }
    }
    return ["*"];
  }
  if (ts.isPropertyAccessExpression(target)) {
    // props.endpoint inside a component
    const objectNode = unwrap(target.expression);
    const fn = ts.isIdentifier(objectNode) ? enclosingFunctionWith(target, objectNode.text) : null;
    if (fn) return resolveProp(index, fn, target.name.text, depth);
    // config.url with config = { url: "/api/..." } or { transfer: { url }, count: { url } }[kind]
    const values = objectsOf(index, objectNode, env, depth).flatMap((found) => propertyUrls(index, found, target.name.text, depth));
    if (values.length) return values.slice(0, MAX_URLS);
  }
  return ["*"];
}

// The object literals an expression can be, each { object, env } with the
// parameter values in force where it was written: a constant,
// Object.freeze({...}), one entry of a lookup table indexed by a value not
// known here, or what a local function returns.
function objectsOf(index, node, env, depth) {
  const target = unwrap(node);
  if (!target || depth > 8) return [];
  const object = objectLiteralOf(target);
  if (object) return [{ object, env }];
  if (ts.isIdentifier(target)) {
    if (env.has(target.text)) return env.get(target.text) ? objectsOf(index, env.get(target.text), new Map(), depth + 1) : [];
    const binding = bindingAt(index.sourceOf(target).bindings, target.text, target);
    return isPlain(binding) ? objectsOf(index, binding.initializer, new Map(), depth + 1) : [];
  }
  if (ts.isElementAccessExpression(target)) {
    const key = unwrap(target.argumentExpression);
    return objectsOf(index, target.expression, env, depth + 1).flatMap((table) => table.object.properties
      .filter((property) => ts.isPropertyAssignment(property) && (!isStringy(key) || propertyName(property) === key.text))
      .flatMap((property) => objectsOf(index, property.initializer, table.env, depth + 1)));
  }
  if (ts.isCallExpression(target) && ts.isIdentifier(unwrap(target.expression))) {
    // const { url } = recordActionRequest(record, action): the objects it returns.
    const binding = bindingAt(index.sourceOf(target).bindings, unwrap(target.expression).text, target);
    const fn = binding && (binding.hoisted ? binding.initializer : isPlain(binding) ? unwrap(binding.initializer) : null);
    if (!fn || !isFunctionLike(fn) || !fn.body) return [];
    const local = new Map();
    fn.parameters.forEach((parameter, position) => {
      if (ts.isIdentifier(parameter.name)) local.set(parameter.name.text, target.arguments[position] || parameter.initializer || null);
    });
    const returned = [];
    if (!ts.isBlock(fn.body)) returned.push(fn.body);
    else {
      const visit = (child) => {
        if (ts.isReturnStatement(child) && child.expression) returned.push(child.expression);
        else if (!isFunctionLike(child)) ts.forEachChild(child, visit);
      };
      ts.forEachChild(fn.body, visit);
    }
    return returned.flatMap((value) => objectsOf(index, value, local, depth + 1));
  }
  return [];
}
function propertyUrls(index, { object, env }, name, depth) {
  const property = object.properties.find((entry) => propertyName(entry) === name);
  if (property && ts.isPropertyAssignment(property)) return resolveUrl(index, property.initializer, env, depth + 1);
  if (property && ts.isShorthandPropertyAssignment(property)) return resolveUrl(index, property.name, env, depth + 1);
  return [];
}

function enclosingFunctionWith(node, parameterName) {
  for (let current = node.parent; current; current = current.parent) {
    if (isFunctionLike(current) && current.parameters.some((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === parameterName)) return current;
  }
  return null;
}

function resolveIdentifier(index, identifier, env, depth) {
  const name = identifier.text;
  if (env.has(name)) return env.get(name) ? resolveUrl(index, env.get(name), new Map(), depth + 1) : [""];
  for (let current = identifier.parent; current; current = current.parent) {
    if (!isFunctionLike(current)) continue;
    // A helper's parameter: the arguments given where the helper is called.
    const position = current.parameters.findIndex((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name);
    if (position >= 0) {
      const calls = index.callsOf(current, functionName(current));
      return calls.length ? calls.flatMap((call) => (call.arguments[position] ? resolveUrl(index, call.arguments[position], new Map(), depth + 1) : ["*"])).slice(0, MAX_URLS) : ["*"];
    }
    // A component prop: function Panel({ endpoint }) { ... }
    for (const parameter of current.parameters) {
      if (!ts.isObjectBindingPattern(parameter.name)) continue;
      const element = parameter.name.elements.find((entry) => ts.isIdentifier(entry.name) && entry.name.text === name);
      if (element) return resolveProp(index, current, (element.propertyName || element.name).getText(), depth);
    }
  }
  const source = index.sourceOf(identifier);
  const binding = bindingAt(source.bindings, name, identifier);
  if (binding?.property !== undefined) {
    // const { url } = request(...): that property of the object it is.
    const values = objectsOf(index, binding.initializer, new Map(), depth).flatMap((found) => propertyUrls(index, found, binding.property, depth));
    return values.length ? values.slice(0, MAX_URLS) : ["*"];
  }
  if (!isPlain(binding)) return ["*"];
  // let path = ""; ... path = "shipments/preview": the declared value and every value assigned later.
  const scope = enclosingScope(binding.node);
  const assigned = index.assignmentsOf(source, name).filter((assignment) => enclosingScope(assignment) === scope);
  return [binding.initializer, ...assigned.map((assignment) => assignment.right)]
    .flatMap((value) => resolveUrl(index, value, new Map(), depth + 1))
    .slice(0, MAX_URLS);
}

// A component prop: the values given to it where the component is rendered.
function resolveProp(index, fn, prop, depth) {
  const values = [];
  for (const element of index.jsxUses(functionName(fn))) {
    for (const attribute of element.attributes.properties) {
      if (!ts.isJsxAttribute(attribute) || attribute.name.getText() !== prop || !attribute.initializer) continue;
      values.push(...resolveUrl(index, ts.isJsxExpression(attribute.initializer) ? attribute.initializer.expression : attribute.initializer, new Map(), depth + 1));
    }
  }
  return values.length ? values.slice(0, MAX_URLS) : ["*"];
}

// The requests a method literal configures, followed out through request-init
// helpers (json("POST", body)) and helpers that add the method (post(url)):
// each { call, url } with url the request's first argument.
function requestsFor(index, start, depth = 0, seen = new Set()) {
  if (depth > 4) return [];
  for (let current = start; current.parent; current = current.parent) {
    const parent = current.parent;
    if (ts.isCallExpression(parent) && parent.arguments.indexOf(current) > 0) return [{ call: parent, url: parent.arguments[0] }];
    if (isFunctionLike(parent)) {
      if (seen.has(parent)) return [];
      seen.add(parent);
      return index.callsOf(parent, functionName(parent)).flatMap((call) => requestsFor(index, call, depth + 1, seen));
    }
  }
  return [];
}

export function readAppWriteRequests(root, { folders = ["src"] } = {}) {
  const index = new AppIndex(root, folders);
  const requests = [];
  for (const source of index.sources.values()) {
    walk(source.sourceFile, (node) => {
      if (!isStringy(node) || !WRITE.has(node.text)) return;
      // Method values only: method: "POST", method: isNew ? "POST" : "PATCH", init("POST", body).
      let holder = node;
      while (ts.isConditionalExpression(holder.parent) && holder.parent.condition !== holder) holder = holder.parent;
      const parent = holder.parent;
      const isMethodProperty = ts.isPropertyAssignment(parent) && propertyName(parent) === "method";
      if (!isMethodProperty && !(ts.isCallExpression(parent) && parent.arguments.includes(holder))) return;
      for (const request of requestsFor(index, holder)) {
        index.trace = new Set([request.call.getSourceFile().fileName]);
        const urls = [...new Set(resolveUrl(index, request.url, new Map()).map((url) => url.split(/[?#]/)[0]))].filter((url) => url.startsWith("/api/"));
        const strings = new Set([...index.trace].flatMap((file) => [...index.stringsIn(index.sources.get(file))]));
        index.trace = null;
        if (urls.length) requests.push({ method: node.text, urls, file: source.file, line: lineOf(request.call), strings });
      }
    });
  }
  return requests;
}

// Does a request url pattern (with *) reach the route path (with :id)?
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function urlReachesRoute(url, routePath, strings = new Set()) {
  // The url's unknown parts cover part of the route: a parameter, or a fixed
  // word that must then be among `strings` (/api/orders/${id}/${action} and "approve").
  const routeText = routePath.split(PARAM).join("\u0000");
  const urlPattern = url.split(/([*\u0001])/).map((piece) => (piece === "*" ? "(.+?)" : piece === SEGMENT ? "([^/]+?)" : escapeRegex(piece))).join("");
  const covered = new RegExp(`^${urlPattern}$`).exec(routeText);
  if (covered && covered.slice(1).every((captured) => captured.split(/[/\u0000]/).filter(Boolean).every((word) => strings.has(word)))) return true;
  // A route parameter covers fixed text of the url: /api/inventory/transfers/:id/:id
  // takes /api/inventory/transfers/${id}/post.
  return new RegExp(`^${routePath.split(PARAM).map(escapeRegex).join("[^/]+")}$`).test(url.replace(/[*\u0001]/g, "\u0000"));
}

// Every write route with the app's requests that reach it. `extraRoutes` adds
// routes written out by hand ({ key: "POST /api/x", source }) for checks the
// reader cannot place.
export function findWriteRouteCallers(root, { extraRoutes = [], ...options } = {}) {
  const server = readServerWriteRoutes(root, options);
  const requests = readAppWriteRequests(root, options);
  const known = new Set(server.routes.map((route) => route.key));
  const added = extraRoutes.filter((route) => !known.has(route.key)).map((route) => {
    const [method, path] = route.key.split(" ");
    return { key: route.key, method, path, sources: [route.source] };
  });
  const routes = [...server.routes, ...added].map((route) => ({
    ...route,
    callers: requests
      .filter((request) => request.method === route.method && request.urls.some((url) => urlReachesRoute(url, route.path, request.strings)))
      .map((request) => `${request.file}:${request.line}`),
  }));
  return { routes, unresolved: server.unresolved, requests };
}
