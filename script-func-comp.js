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
const componentInstancesJSX = {}; // Track JSX usage (<Component />)
const componentInstancesFunc = {}; // Track function calls (Component())

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
  // Reset regex indices for each file
  namedImportPattern.lastIndex = 0;
  defaultImportPattern.lastIndex = 0;
  namespaceImportPattern.lastIndex = 0;
  requirePattern.lastIndex = 0;
  requireDefaultPattern.lastIndex = 0;

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
 * Extract actual JSX component instances while avoiding double counting
 * @param {string} content - File content to search
 * @param {string} component - Component name to look for
 * @returns {RegExpMatchArray[]} - Array of matches
 */
function extractJSXUsage(content, component) {
  // This regex matches either:
  // 1. Self-closing tags: <Component ... />
  // 2. Opening tags: <Component ...>
  // But ignores closing tags: </Component>
  const jsxPattern = new RegExp(
    `<${component}(?![\\w-])(?![\\w-])[^>]*?(?:>|/>)`,
    "g"
  );
  let matches = [];
  let match;

  while ((match = jsxPattern.exec(content)) !== null) {
    matches.push(match);
  }

  return matches;
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

      // Get all namespace component usages in the file
      const namespaceComponents = new Set();
      const namespaceJSXPattern = new RegExp(
        `<${namespaceAlias}\\.([A-Za-z0-9_]+)(?![\\w-])[^>]*?(?:>|/>)`,
        "g"
      );
      let nsJSXMatch;

      while ((nsJSXMatch = namespaceJSXPattern.exec(content)) !== null) {
        const componentName = nsJSXMatch[1];
        const fullComponentName = `${namespaceAlias}.${componentName}`;
        namespaceComponents.add(fullComponentName);

        if (!componentInstancesJSX[fullComponentName]) {
          componentInstancesJSX[fullComponentName] = [];
        }
        componentInstancesJSX[fullComponentName].push(filePath);
      }

      // Look for function calls with namespace: NamespaceAlias.Component(...)
      const namespaceFuncPattern = new RegExp(
        `${namespaceAlias}\\.([A-Za-z0-9_]+)\\s*\\(`,
        "g"
      );
      let nsFuncMatch;

      while ((nsFuncMatch = namespaceFuncPattern.exec(content)) !== null) {
        const componentName = nsFuncMatch[1];
        const fullComponentName = `${namespaceAlias}.${componentName}`;

        // Skip if this component was already counted as JSX
        if (namespaceComponents.has(fullComponentName)) {
          continue;
        }

        if (!componentInstancesFunc[fullComponentName]) {
          componentInstancesFunc[fullComponentName] = [];
        }
        componentInstancesFunc[fullComponentName].push(filePath);
      }

      continue;
    }

    // Extract JSX usages for this component
    const jsxMatches = extractJSXUsage(content, component);

    if (jsxMatches.length > 0) {
      if (!componentInstancesJSX[component]) {
        componentInstancesJSX[component] = [];
      }
      // Add this file once per JSX instance
      for (let i = 0; i < jsxMatches.length; i++) {
        componentInstancesJSX[component].push(filePath);
      }
    }

    // Look for function calls: Component(...)
    // Only count if the component wasn't used as JSX in this file
    if (componentInstancesJSX[component]?.includes(filePath)) {
      continue;
    }

    const functionCallPattern = new RegExp(
      `(?<![.<])\\b${component}\\s*\\(`,
      "g"
    );
    let funcMatch;
    let funcMatches = 0;

    while ((funcMatch = functionCallPattern.exec(content)) !== null) {
      funcMatches++;
    }

    if (funcMatches > 0) {
      if (!componentInstancesFunc[component]) {
        componentInstancesFunc[component] = [];
      }
      // Add this file once per function call instance
      for (let i = 0; i < funcMatches; i++) {
        componentInstancesFunc[component].push(filePath);
      }
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

  // Calculate totals
  const totalImportedComponents = Object.keys(componentUsage).length;
  const totalJSXInstances = Object.values(componentInstancesJSX).reduce(
    (sum, instances) => sum + instances.length,
    0
  );
  const totalFuncInstances = Object.values(componentInstancesFunc).reduce(
    (sum, instances) => sum + instances.length,
    0
  );
  const totalAllInstances = totalJSXInstances + totalFuncInstances;

  // Generate summary
  report += `SUMMARY\n`;
  report += `------------------------------------------\n`;
  report += `Total imported components: ${totalImportedComponents}\n`;
  report += `Total component instances: ${totalAllInstances}\n`;
  report += `  - JSX usage (<Component/>): ${totalJSXInstances}\n`;
  report += `  - Function calls (Component()): ${totalFuncInstances}\n\n`;

  // List imported components
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

  // Generate JSX usage report
  report += `JSX COMPONENT USAGE (<Component />)\n`;
  report += `------------------------------------------\n`;

  if (Object.keys(componentInstancesJSX).length === 0) {
    report += `No JSX usage found.\n\n`;
  } else {
    // Sort components by JSX usage count (descending)
    const sortedJSXComponents = Object.keys(componentInstancesJSX).sort(
      (a, b) =>
        componentInstancesJSX[b].length - componentInstancesJSX[a].length
    );

    for (const component of sortedJSXComponents) {
      const instances = componentInstancesJSX[component];
      report += `${component}:\n`;
      report += `  Used as JSX ${instances.length} time(s) in:\n`;

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
  }

  // Generate function call usage report
  report += `FUNCTION CALL USAGE (Component())\n`;
  report += `------------------------------------------\n`;

  if (Object.keys(componentInstancesFunc).length === 0) {
    report += `No function call usage found.\n\n`;
  } else {
    // Sort components by function call usage count (descending)
    const sortedFuncComponents = Object.keys(componentInstancesFunc).sort(
      (a, b) =>
        componentInstancesFunc[b].length - componentInstancesFunc[a].length
    );

    for (const component of sortedFuncComponents) {
      const instances = componentInstancesFunc[component];
      report += `${component}:\n`;
      report += `  Called as function ${instances.length} time(s) in:\n`;

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
  }

  // List unused components
  report += `COMPONENTS WITH NO USAGE FOUND\n`;
  report += `------------------------------------------\n`;
  const usedComponentsSet = new Set([
    ...Object.keys(componentInstancesJSX),
    ...Object.keys(componentInstancesFunc),
  ]);

  const unusedComponents = Object.keys(componentUsage).filter(
    (c) => !usedComponentsSet.has(c) && !c.startsWith("*")
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

  // Calculate totals for console output
  const totalJSXInstances = Object.values(componentInstancesJSX).reduce(
    (sum, instances) => sum + instances.length,
    0
  );
  const totalFuncInstances = Object.values(componentInstancesFunc).reduce(
    (sum, instances) => sum + instances.length,
    0
  );

  console.log(`Report generated: ${reportPath}`);
  console.log(
    `Found ${Object.keys(componentUsage).length} imported components`
  );
  console.log(`JSX usage: ${totalJSXInstances} instances`);
  console.log(`Function call usage: ${totalFuncInstances} instances`);
}

// Run the script
main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
