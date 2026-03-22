const pad = (n: number) => String(n).padStart(3, "0");

export function generateProgram(n: number): string {
  const lines: string[] = [
    "name: bench",
    "runtime: yaml",
    "resources:",
  ];

  for (let i = 1; i <= n; i += 1) {
    const id = pad(i);
    lines.push(`  str-${id}:`);
    lines.push("    type: random:index:RandomString");
    lines.push("    properties:");
    lines.push("      length: 16");
    lines.push("      special: false");
  }

  return `${lines.join("\n")}\n`;
}

export function generateSecretsProgram(n: number): string {
  const lines: string[] = [
    "name: bench-secrets",
    "runtime: yaml",
    "resources:",
  ];

  for (let i = 1; i <= n; i += 1) {
    const id = pad(i);
    lines.push(`  str-${id}:`);
    lines.push("    type: random:index:RandomString");
    lines.push("    properties:");
    lines.push("      length: 16");
    lines.push("      special: false");
  }

  lines.push("outputs:");
  lines.push("  secretOut:");
  lines.push("    fn::secret: ${str-001.result}");

  return `${lines.join("\n")}\n`;
}
