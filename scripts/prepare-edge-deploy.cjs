#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { builtinModules } = require("node:module");

const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const sourceExtensions = new Set([".cjs", ".css", ".html", ".js", ".json", ".map", ".mjs"]);
const jsSourceExtensions = new Set([".cjs", ".js", ".mjs"]);
const importPatterns = [
  /\bimport\s+(?:[^'";\n()]*?\s+from\s*)?['"]([^'"]+)['"]/g,
  /\bexport\s+[^'";\n()]*?\s+from\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]/g,
];

function usage(exitCode = 1) {
  console.error("usage: node scripts/prepare-edge-deploy.cjs [--package-manager pnpm|npm] -- SOURCE_DIR");
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = [...argv];
  const options = {
    packageManager: null,
    sourceDir: null,
  };

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--") break;
    if (arg === "--package-manager") {
      options.packageManager = args.shift();
      continue;
    }
    if (arg === "--help" || arg === "-h") usage(0);
    if (arg.startsWith("-")) usage();
    options.sourceDir = arg;
  }

  if (args.length > 0) {
    if (options.sourceDir != null) usage();
    options.sourceDir = args.shift();
  }
  if (args.length > 0 || options.sourceDir == null) usage();
  if (options.packageManager != null && !["pnpm", "npm"].includes(options.packageManager)) usage();

  return options;
}

const options = parseArgs(process.argv.slice(2));
const appRoot = path.resolve(options.sourceDir);
const deployDir = path.join(appRoot, ".deploy");
const stagingDir = path.join(appRoot, ".deploy-package-manager");
const nodeModulesDir = path.join(deployDir, "node_modules");
const virtualStoreDir = path.join(nodeModulesDir, ".pnpm");

function detectPackageManager() {
  if (options.packageManager != null) return options.packageManager;
  if (fs.existsSync(path.join(appRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (
    fs.existsSync(path.join(appRoot, "package-lock.json")) ||
    fs.existsSync(path.join(appRoot, "npm-shrinkwrap.json"))
  ) {
    return "npm";
  }
  return "npm";
}

const packageManager = detectPackageManager();

function run(command, args, runOptions = {}) {
  const result = spawnSync(command, args, {
    cwd: appRoot,
    stdio: "inherit",
    shell: false,
    ...runOptions,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function packageNameFromSpecifier(specifier) {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("file:") ||
    specifier.startsWith("node:") ||
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier) ||
    builtins.has(specifier)
  ) {
    return null;
  }
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function packagePathInNodeModules(modulesDir, packageName) {
  return path.join(modulesDir, ...packageName.split("/"));
}

function scanBareSpecifiersFromSource(source) {
  const specs = new Set();
  for (const pattern of importPatterns) {
    let match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(source)) !== null) {
      const name = packageNameFromSpecifier(match[1]);
      if (name) specs.add(name);
    }
  }
  return specs;
}

function scanServerBareSpecifiers() {
  const specs = new Set();
  const serverDir = path.join(deployDir, "dist", "server");

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(file);
        continue;
      }
      if (!jsSourceExtensions.has(path.extname(entry.name))) continue;
      const source = fs.readFileSync(file, "utf8");
      for (const name of scanBareSpecifiersFromSource(source)) {
        specs.add(name);
      }
    }
  }

  walk(serverDir);
  return [...specs].sort();
}

function findVirtualStorePackage(packageName) {
  if (!fs.existsSync(virtualStoreDir)) return null;
  for (const entry of fs.readdirSync(virtualStoreDir)) {
    const candidate = packagePathInNodeModules(path.join(virtualStoreDir, entry, "node_modules"), packageName);
    if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
  }
  return null;
}

function findPackageFrom(startDir, packageName) {
  let current = path.resolve(startDir);
  const root = path.resolve(deployDir);

  for (;;) {
    const candidate = packagePathInNodeModules(path.join(current, "node_modules"), packageName);
    try {
      if (fs.statSync(candidate).isDirectory()) {
        return fs.realpathSync(candidate);
      }
    } catch {
      // Try the parent directory.
    }

    if (current === root || current === path.dirname(current)) break;
    if (!current.startsWith(`${root}${path.sep}`)) break;
    current = path.dirname(current);
  }

  const topLevelPath = packagePathInNodeModules(nodeModulesDir, packageName);
  try {
    if (fs.statSync(topLevelPath).isDirectory()) {
      return fs.realpathSync(topLevelPath);
    }
  } catch {
    // Fall through to pnpm virtual-store lookup.
  }
  return findVirtualStorePackage(packageName);
}

function findRuntimePackageTarget(packageName, importerPath = deployDir) {
  return findPackageFrom(importerPath, packageName);
}

function ensureTopLevelLinkToTarget(packageName, target) {
  const linkPath = packagePathInNodeModules(nodeModulesDir, packageName);
  if (fs.existsSync(linkPath)) return false;

  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  const relativeTarget = path.relative(path.dirname(linkPath), fs.realpathSync(target));
  fs.symlinkSync(relativeTarget, linkPath, "junction");
  return true;
}

function ensureTopLevelPackage(packageName) {
  const linkPath = packagePathInNodeModules(nodeModulesDir, packageName);
  if (fs.existsSync(linkPath)) return false;

  const target = findRuntimePackageTarget(packageName, deployDir);
  if (target == null) {
    console.warn(`warning: could not find ${packageName} in production node_modules`);
    return false;
  }
  return ensureTopLevelLinkToTarget(packageName, target);
}

function isDirectoryLike(entryPath, entry) {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;

  try {
    return fs.statSync(entryPath).isDirectory();
  } catch {
    return false;
  }
}

function packageEntriesInNodeModules(modulesDir) {
  const packageEntries = [];
  if (!fs.existsSync(modulesDir)) return packageEntries;

  for (const entry of fs.readdirSync(modulesDir, { withFileTypes: true })) {
    if (entry.name === ".bin" || entry.name.startsWith(".")) continue;
    const entryPath = path.join(modulesDir, entry.name);
    if (entry.name.startsWith("@") && isDirectoryLike(entryPath, entry)) {
      for (const scopedEntry of fs.readdirSync(entryPath, { withFileTypes: true })) {
        packageEntries.push({
          name: `${entry.name}/${scopedEntry.name}`,
          path: path.join(entryPath, scopedEntry.name),
        });
      }
      continue;
    }
    packageEntries.push({ name: entry.name, path: entryPath });
  }

  return packageEntries;
}

function topLevelPackagePaths() {
  return packageEntriesInNodeModules(nodeModulesDir).map((entry) => entry.path);
}

function scanPackageBareSpecifiers(packagePath) {
  const specs = new Set();

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(file);
        continue;
      }
      if (!entry.isFile() || !jsSourceExtensions.has(path.extname(entry.name))) {
        continue;
      }
      const source = fs.readFileSync(file, "utf8");
      for (const name of scanBareSpecifiersFromSource(source)) {
        specs.add(name);
      }
    }
  }

  walk(packagePath);
  return [...specs].sort();
}

function readPackageManifest(packagePath) {
  const manifestPath = path.join(packagePath, "package.json");
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

function isRequiredRuntimeManifestDependency(packagePath, dependencyName) {
  const manifest = readPackageManifest(packagePath);
  if (manifest == null) return false;
  if (manifest.dependencies?.[dependencyName] != null) return true;
  if (manifest.optionalDependencies?.[dependencyName] != null) return false;
  if (manifest.peerDependencies?.[dependencyName] != null) {
    return manifest.peerDependenciesMeta?.[dependencyName]?.optional !== true;
  }
  return false;
}

function warnMissingRuntimePackages(missing) {
  if (missing.length === 0) return;

  console.warn("warning: deploy runtime package closure saw unresolved declared runtime imports:");
  for (const { importer, dependency } of missing) {
    console.warn(`  ${importer} imports ${dependency}, but ${dependency} is not in the production deploy graph`);
  }
  console.warn("If one is used while rendering, move it from devDependencies to dependencies.");
}

function ensureImportedRuntimePackageLinks(initialPackageNames) {
  const included = new Set(initialPackageNames);
  const linked = [];
  const scanned = new Set();
  const missing = [];

  for (;;) {
    let changed = false;

    for (const packageName of [...included].sort()) {
      if (scanned.has(packageName)) continue;
      scanned.add(packageName);

      const realPackagePath = findRuntimePackageTarget(packageName, deployDir);
      if (realPackagePath == null) {
        missing.push({ importer: "server bundle", dependency: packageName });
        continue;
      }

      let realPackageStats;
      try {
        realPackageStats = fs.statSync(realPackagePath);
      } catch {
        continue;
      }
      if (!realPackageStats.isDirectory()) continue;

      for (const dependencyName of scanPackageBareSpecifiers(realPackagePath)) {
        const dependencyTarget = findRuntimePackageTarget(dependencyName, realPackagePath);
        if (dependencyTarget == null) {
          if (isRequiredRuntimeManifestDependency(realPackagePath, dependencyName)) {
            missing.push({ importer: packageName, dependency: dependencyName });
          }
          continue;
        }

        if (!included.has(dependencyName)) {
          included.add(dependencyName);
          changed = true;
        }
        if (ensureTopLevelLinkToTarget(dependencyName, dependencyTarget)) {
          linked.push(dependencyName);
        }
      }
    }

    if (!changed) break;
  }

  warnMissingRuntimePackages(missing);

  return {
    included,
    linked: [...new Set(linked)].sort(),
  };
}

function pruneUnimportedTopLevelPackages(includedPackageNames) {
  const pruned = [];

  for (const entry of packageEntriesInNodeModules(nodeModulesDir)) {
    if (includedPackageNames.has(entry.name)) continue;

    fs.rmSync(entry.path, { recursive: true, force: true });
    pruned.push(entry.name);
  }

  for (const entry of fs.readdirSync(nodeModulesDir, { withFileTypes: true })) {
    if (!entry.name.startsWith("@") || !entry.isDirectory()) continue;

    const scopePath = path.join(nodeModulesDir, entry.name);
    if (fs.readdirSync(scopePath).length === 0) {
      fs.rmSync(scopePath, { recursive: true, force: true });
    }
  }

  return pruned.sort();
}

function copyPackageWithoutNestedNodeModules(source, destination) {
  fs.mkdirSync(destination, { recursive: true });

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;

    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);

    if (entry.isSymbolicLink()) {
      const realPath = fs.realpathSync(sourcePath);
      const stats = fs.statSync(realPath);
      if (stats.isDirectory()) {
        copyPackageWithoutNestedNodeModules(realPath, destinationPath);
      } else {
        fs.copyFileSync(realPath, destinationPath);
      }
      continue;
    }

    if (entry.isDirectory()) {
      copyPackageWithoutNestedNodeModules(sourcePath, destinationPath);
      continue;
    }

    if (entry.isFile()) {
      fs.copyFileSync(sourcePath, destinationPath);
    }
  }
}

function materializeTopLevelPackages() {
  const materialized = [];

  for (const packagePath of topLevelPackagePaths()) {
    let stats;
    try {
      stats = fs.lstatSync(packagePath);
    } catch {
      continue;
    }

    const target = stats.isSymbolicLink() ? fs.realpathSync(packagePath) : packagePath;
    const targetStats = fs.statSync(target);
    if (!targetStats.isDirectory()) continue;

    const stagingPath = `${packagePath}.materialized-${process.pid}`;
    copyPackageWithoutNestedNodeModules(target, stagingPath);
    fs.rmSync(packagePath, { recursive: true, force: true });
    fs.renameSync(stagingPath, packagePath);
    materialized.push(path.relative(nodeModulesDir, packagePath));
  }

  return materialized.sort();
}

function assertNoTopLevelPackageSymlinks() {
  const remaining = topLevelPackagePaths().filter((packagePath) => {
    try {
      return fs.lstatSync(packagePath).isSymbolicLink();
    } catch {
      return false;
    }
  });

  if (remaining.length === 0) return;

  console.error("error: deploy package still contains top-level package symlinks:");
  for (const packagePath of remaining) {
    console.error(`  ${path.relative(deployDir, packagePath)}`);
  }
  process.exit(1);
}

function rewritePnpmStoreImports() {
  const rewritten = [];
  const pnpmStoreImportPattern =
    /(node_modules\/)\.pnpm\/[^/'"`\s]+\/node_modules\/((?:@[^/'"`\s]+\/[^/'"`\s]+)|[^/'"`\s]+)/g;

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(file);
        continue;
      }
      if (!entry.isFile() || !sourceExtensions.has(path.extname(entry.name))) {
        continue;
      }

      const source = fs.readFileSync(file, "utf8");
      const updated = source.replace(pnpmStoreImportPattern, "$1$2");
      if (updated === source) continue;

      fs.writeFileSync(file, updated);
      rewritten.push(path.relative(deployDir, file));
    }
  }

  walk(deployDir);
  return rewritten.sort();
}

function assertNoPnpmStoreImports() {
  const offenders = [];
  const pnpmStoreImportPattern =
    /node_modules\/\.pnpm\/[^/'"`\s]+\/node_modules\/((?:@[^/'"`\s]+\/[^/'"`\s]+)|[^/'"`\s]+)/;

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(file);
        continue;
      }
      if (!entry.isFile() || !sourceExtensions.has(path.extname(entry.name))) {
        continue;
      }
      if (pnpmStoreImportPattern.test(fs.readFileSync(file, "utf8"))) {
        offenders.push(path.relative(deployDir, file));
      }
    }
  }

  walk(deployDir);
  if (offenders.length === 0) return;

  console.error("error: deploy sources still import pnpm virtual-store paths:");
  for (const file of offenders) {
    console.error(`  ${file}`);
  }
  process.exit(1);
}

function removePackageManagerScaffolding() {
  fs.rmSync(path.join(nodeModulesDir, ".bin"), { recursive: true, force: true });
  fs.rmSync(virtualStoreDir, { recursive: true, force: true });
}

function assertSingleNodeModulesLayout() {
  const nestedNodeModules = [];

  if (fs.existsSync(virtualStoreDir)) {
    nestedNodeModules.push(path.relative(deployDir, virtualStoreDir));
  }

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const file = path.join(dir, entry.name);
      if (entry.name === "node_modules" && path.resolve(file) !== nodeModulesDir) {
        nestedNodeModules.push(path.relative(deployDir, file));
        continue;
      }
      walk(file);
    }
  }

  walk(deployDir);
  if (nestedNodeModules.length === 0) return;

  console.error("error: deploy package contains nested module stores:");
  for (const file of nestedNodeModules) {
    console.error(`  ${file}`);
  }
  process.exit(1);
}

function assertNoSymlinks(root) {
  const remaining = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        remaining.push(path.relative(root, file));
        continue;
      }
      if (entry.isDirectory()) walk(file);
    }
  }

  walk(root);
  if (remaining.length === 0) return;

  console.error("error: deploy package still contains symlinks:");
  for (const file of remaining) {
    console.error(`  ${file}`);
  }
  process.exit(1);
}

function copyIfExists(fileName) {
  const source = path.join(appRoot, fileName);
  if (fs.existsSync(source)) {
    fs.copyFileSync(source, path.join(deployDir, fileName));
  }
}

function copyManifestToStaging(fileName) {
  const source = path.join(appRoot, fileName);
  if (fs.existsSync(source)) {
    fs.copyFileSync(source, path.join(stagingDir, fileName));
  }
}

function prepareProductionNodeModules() {
  function moveOrCreateNodeModules() {
    const stagedNodeModules = path.join(stagingDir, "node_modules");
    if (fs.existsSync(stagedNodeModules)) {
      fs.renameSync(stagedNodeModules, nodeModulesDir);
    } else {
      fs.mkdirSync(nodeModulesDir, { recursive: true });
    }
  }

  if (packageManager === "pnpm") {
    run("pnpm", ["--filter", ".", "deploy", "--prod", "--legacy", stagingDir]);
    moveOrCreateNodeModules();
    return;
  }

  fs.mkdirSync(stagingDir, { recursive: true });
  copyManifestToStaging("package.json");
  copyManifestToStaging("package-lock.json");
  copyManifestToStaging("npm-shrinkwrap.json");
  copyManifestToStaging(".npmrc");

  const hasLockfile =
    fs.existsSync(path.join(stagingDir, "package-lock.json")) ||
    fs.existsSync(path.join(stagingDir, "npm-shrinkwrap.json"));
  const installArgs = hasLockfile
    ? ["ci", "--omit=dev", "--ignore-scripts"]
    : ["install", "--omit=dev", "--ignore-scripts"];
  run("npm", installArgs, { cwd: stagingDir });
  moveOrCreateNodeModules();
}

function main() {
  if (!fs.existsSync(path.join(appRoot, "package.json"))) {
    console.error(`error: SOURCE_DIR does not contain package.json: ${appRoot}`);
    process.exit(1);
  }

  fs.rmSync(deployDir, { recursive: true, force: true });
  fs.rmSync(stagingDir, { recursive: true, force: true });

  console.log(`Preparing Edge deploy from ${appRoot} using ${packageManager}`);
  if (packageManager === "pnpm") {
    run("pnpm", ["build"]);
  } else {
    run("npm", ["run", "build"]);
  }

  const distDir = path.join(appRoot, "dist");
  if (!fs.existsSync(distDir)) {
    console.error(`error: build did not produce dist directory: ${distDir}`);
    process.exit(1);
  }

  fs.mkdirSync(deployDir, { recursive: true });
  fs.cpSync(distDir, path.join(deployDir, "dist"), { recursive: true });
  copyIfExists("wasmer.toml");
  copyIfExists("app.yaml");
  fs.copyFileSync(path.join(appRoot, "package.json"), path.join(deployDir, "package.json"));
  prepareProductionNodeModules();
  fs.rmSync(stagingDir, { recursive: true, force: true });

  const serverRuntimePackages = scanServerBareSpecifiers();
  const linked = serverRuntimePackages.filter(ensureTopLevelPackage);
  if (linked.length > 0) {
    console.log(`Linked server runtime packages: ${linked.join(", ")}`);
  }

  const { included: importedRuntimePackages, linked: transitiveLinked } =
    ensureImportedRuntimePackageLinks(serverRuntimePackages);
  if (transitiveLinked.length > 0) {
    console.log(`Linked ${transitiveLinked.length} imported transitive runtime packages`);
  }
  console.log(`Runtime package closure: ${importedRuntimePackages.size} package(s)`);

  const pruned = pruneUnimportedTopLevelPackages(importedRuntimePackages);
  if (pruned.length > 0) {
    console.log(`Pruned ${pruned.length} unimported top-level packages`);
  }

  const materialized = materializeTopLevelPackages();
  if (materialized.length > 0) {
    console.log(`Materialized ${materialized.length} package(s)`);
  }
  assertNoTopLevelPackageSymlinks();

  removePackageManagerScaffolding();

  const rewritten = rewritePnpmStoreImports();
  if (rewritten.length > 0) {
    console.log(`Rewrote pnpm store imports in: ${rewritten.join(", ")}`);
  }
  assertNoPnpmStoreImports();
  assertSingleNodeModulesLayout();
  assertNoSymlinks(deployDir);

  run("du", ["-sh", deployDir]);
}

main();
