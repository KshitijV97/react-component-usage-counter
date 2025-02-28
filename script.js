#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);

// Configuration (customize these values)
const targetPackageName = "your-package-name"; // Replace with the actual npm package name
const fileExtensions = [".ts", ".tsx", ".js", ".jsx"]; // Extensions to scan
const ignorePatterns = ["node_modules", "dist", "build", ".git"]; // Directories to ignore

// Regex patterns for different import styles
const namedImportPattern = new RegExp(
  `import\\s+{([^}]*)}\\s+from\\s+['"]${targetPackageName}['"]`,
  "g"
);
const defaultImportPattern = new RegExp(
  `import\\s+([^{\\s]+)\\s+from\\s+['"]${targetPackageName}['"]`,
  "g"
);
const namespaceImportPattern = new RegExp(
  `import\\s+\\*\\s+as\\s+([^\\s]+)\\s+from\\s+['"]${targetPackageName}['"]`,
  "g"
);
const requirePattern = new RegExp(
  `(?:const|let|var)\\s+{([^}]*)}\\s+=\\s+require\\s*\\(\\s*['"]${targetPackageName}['"]\\s*\\)`,
  "g"
);
const requireDefaultPattern = new RegExp(
  `(?:const|let|var)\\s+([^{\\s]+)\\s+=\\s+require\\s*\\(\\s*['"]${targetPackageName}['"]\\s*\\)`,
  "g"
);

// Track component usage
const componentUsage = {};
const componentInstances = {};

/**
 * Recursively walk a directory and process files
 */
async function walkDirectory(dirPath) {
  try {
    const entries = await readdir(dirPath);

    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry);

      // Skip ignored directories
      if (ignorePatterns.some((pattern) => entryPath.includes(pattern))) {
        continue;
      }

      const entryStats = await stat(entryPath);

      if (entryStats.isDirectory()) {
        await walkDirectory(entryPath);
      } else if (
        entryStats.isFile() &&
        fileExtensions.includes(path.extname(entryPath))
      ) {
        await processFile(entryPath);
      }
    }
  } catch (error) {
    console.error(`Error walking directory ${dirPath}:`, error);
  }
}

/**
 * Process a single file to find component imports and usages
 */
async function processFile(filePath) {
  try {
    const content = await readFile(filePath, "utf8");
    const fileRelativePath = path.relative(process.cwd(), filePath);

    // Find all imports from the target package
    findImports(content, fileRelativePath);

    // Find component usages in the file content
    if (Object.keys(componentUsage).length > 0) {
      findComponentUsages(content, fileRelativePath);
    }
  } catch (error) {
    console.error(`Error processing file ${filePath}:`, error);
  }
}

/**
 * Extract imported components from the target package
 */
function findImports(content, filePath) {
  // Process named imports: import { Component1, Component2 } from 'package'
  let match;
  while ((match = namedImportPattern.exec(content)) !== null) {
    const importedComponents = match[1]
      .split(",")
      .map((s) => s.trim().split(" as ")[0].trim());
    importedComponents.forEach((component) => {
      if (!componentUsage[component]) {
        componentUsage[component] = new Set();
      }
      componentUsage[component].add(filePath);
    });
  }

  // Process default imports: import DefaultComponent from 'package'
  while ((match = defaultImportPattern.exec(content)) !== null) {
    const defaultComponent = match[1].trim();
    if (defaultComponent !== targetPackageName) {
      // Skip if it's the package name itself
      if (!componentUsage[defaultComponent]) {
        componentUsage[defaultComponent] = new Set();
      }
      componentUsage[defaultComponent].add(filePath);
    }
  }

  // Process namespace imports: import * as Components from 'package'
  while ((match = namespaceImportPattern.exec(content)) !== null) {
    const namespaceAlias = match[1].trim();
    if (!componentUsage[`*${namespaceAlias}`]) {
      componentUsage[`*${namespaceAlias}`] = new Set();
    }
    componentUsage[`*${namespaceAlias}`].add(filePath);
  }

  // Process require syntax: const { Component1, Component2 } = require('package')
  while ((match = requirePattern.exec(content)) !== null) {
    const importedComponents = match[1]
      .split(",")
      .map((s) => s.trim().split(" as ")[0].split(":")[0].trim());
    importedComponents.forEach((component) => {
      if (!componentUsage[component]) {
        componentUsage[component] = new Set();
      }
      componentUsage[component].add(filePath);
    });
  }

  // Process require default: const Package = require('package')
  while ((match = requireDefaultPattern.exec(content)) !== null) {
    const defaultComponent = match[1].trim();
    if (!componentUsage[defaultComponent]) {
      componentUsage[defaultComponent] = new Set();
    }
    componentUsage[defaultComponent].add(filePath);
  }
}

/**
 * Find actual component usages in the file content
 */
function findComponentUsages(content, filePath) {
  // For each imported component, count usages
  for (const component of Object.keys(componentUsage)) {
    // Skip namespace imports for direct counting
    if (component.startsWith("*")) {
      const namespaceAlias = component.substring(1);
      // Look for patterns like: NamespaceAlias.Component
      const namespacePattern = new RegExp(
        `${namespaceAlias}\\.([A-Za-z0-9_]+)`,
        "g"
      );
      let nsMatch;

      while ((nsMatch = namespacePattern.exec(content)) !== null) {
        const usedComponent = `${namespaceAlias}.${nsMatch[1]}`;
        if (!componentInstances[usedComponent]) {
          componentInstances[usedComponent] = [];
        }
        componentInstances[usedComponent].push(filePath);
      }
      continue;
    }

    // For normal components, look for JSX usage: <Component> or <Component.SubComponent>
    // and function calls: Component(...)
    const jsxPattern = new RegExp(
      `<${component}[\\s/>]|<${component}\\.[A-Za-z0-9_]+[\\s/>]`,
      "g"
    );
    const functionCallPattern = new RegExp(`\\b${component}\\(`, "g");

    let jsxMatch;
    while ((jsxMatch = jsxPattern.exec(content)) !== null) {
      if (!componentInstances[component]) {
        componentInstances[component] = [];
      }
      componentInstances[component].push(filePath);
    }

    let funcMatch;
    while ((funcMatch = functionCallPattern.exec(content)) !== null) {
      if (!componentInstances[component]) {
        componentInstances[component] = [];
      }
      componentInstances[component].push(filePath);
    }
  }
}

/**
 * Generate a report of component usage
 */
function generateReport() {
  let report = `Component Usage Report for "${targetPackageName}" package\n`;
  report += `Generated on: ${new Date().toISOString()}\n`;
  report += `==========================================\n\n`;

  report += `SUMMARY\n`;
  report += `------------------------------------------\n`;
  report += `Total imported components: ${
    Object.keys(componentUsage).length
  }\n`;

  const totalInstances = Object.values(componentInstances).reduce(
    (sum, instances) => sum + instances.length,
    0
  );

  report += `Total component instances: ${totalInstances}\n\n`;

  report += `IMPORTED COMPONENTS\n`;
  report += `------------------------------------------\n`;

  for (const component of Object.keys(componentUsage).sort()) {
    const files = Array.from(componentUsage[component]);
    report += `${component}:\n`;
    report += `  Imported in ${files.length} file(s):\n`;
    files.forEach((file) => {
      report += `    - ${file}\n`;
    });
    report += "\n";
  }

  report += `COMPONENT INSTANCES\n`;
  report += `------------------------------------------\n`;

  // Sort components by usage count (descending)
  const sortedComponents = Object.keys(componentInstances).sort(
    (a, b) => componentInstances[b].length - componentInstances[a].length
  );

  for (const component of sortedComponents) {
    const instances = componentInstances[component];
    report += `${component}:\n`;
    report += `  Used ${instances.length} time(s) in:\n`;

    // Group by file path
    const fileGroups = {};
    instances.forEach((file) => {
      if (!fileGroups[file]) {
        fileGroups[file] = 0;
      }
      fileGroups[file]++;
    });

    Object.keys(fileGroups)
      .sort()
      .forEach((file) => {
        report += `    - ${file} (${fileGroups[file]} instance(s))\n`;
      });
    report += "\n";
  }

  report += `COMPONENTS WITH NO INSTANCES FOUND\n`;
  report += `------------------------------------------\n`;
  const unusedComponents = Object.keys(componentUsage).filter(
    (c) => !componentInstances[c]
  );

  if (unusedComponents.length === 0) {
    report += `All imported components are used.\n\n`;
  } else {
    unusedComponents.sort().forEach((component) => {
      report += `${component}\n`;
    });
    report += "\n";
  }

  return report;
}

/**
 * Main function
 */
async function main() {
  // Get the target directory from command line args or use current directory
  const targetDir = process.argv[2] || process.cwd();

  console.log(
    `Scanning ${targetDir} for components from ${targetPackageName}...`
  );

  // Process files
  await walkDirectory(targetDir);

  // Generate and save report
  const report = generateReport();
  const reportPath = path.join(process.cwd(), `component-usage-report.txt`);

  await writeFile(reportPath, report);

  console.log(`Report generated: ${reportPath}`);
  console.log(
    `Found ${
      Object.keys(componentUsage).length
    } imported components with ${Object.values(componentInstances).reduce(
      (sum, instances) => sum + instances.length,
      0
    )} total instances.`
  );
}

// Run the script
main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
