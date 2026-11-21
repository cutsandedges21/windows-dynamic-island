// Store apps (from Microsoft Store, run out of the WindowsApps folder): telling one app by its package.

/**
 * A Store app's package family (`microsoft.windowsterminal_8wekyb3d8bbwe`) from its Start id
 * (`shell:AppsFolder\Microsoft.WindowsTerminal_8wekyb3d8bbwe!App`) or its program's path inside
 * WindowsApps (`...\WindowsApps\Microsoft.WindowsTerminal_1.25.3131.0_x64__8wekyb3d8bbwe\WindowsTerminal.exe`,
 * which changes with every update); null for anything else.
 */
export function packageFamily(target: string): string | null {
  const id = /^shell:appsfolder\\([^!\\]+_[a-z0-9]{13})!/i.exec(target);
  if (id) return id[1].toLowerCase();
  const dir = /\\windowsapps\\([^\\]+)\\/i.exec(target);
  if (!dir) return null;
  const parts = dir[1].split('_');
  return parts.length >= 5 ? `${parts[0]}_${parts[parts.length - 1]}`.toLowerCase() : null;
}

/**
 * An app that updates itself into a new folder per version (Squirrel's `app-<version>`: the Claude
 * desktop app, Discord, Slack...), by its program's path with the version folder taken out:
 * `...\AnthropicClaude\app-6.6395.0\claude.exe` and `...\AnthropicClaude\app-6.28899.2\claude.exe` are
 * both `...\anthropicclaude\claude.exe` (Squirrel's own starter for it, there too). Null for any other path.
 */
export function versionlessPath(target: string): string | null {
  if (/^shell:/i.test(target)) return null;
  const m = /^(.*[\\/])app-\d+(?:\.\d+)*(?:-[\w.]+)?[\\/]([^\\/]+\.exe)$/i.exec(target);
  return m ? `${m[1]}${m[2]}`.toLowerCase() : null;
}

/**
 * A list of apps with each Store app that was saved by its program's path inside WindowsApps (how
 * older lists kept them: no icon, a name like WindowsTerminal, and gone with the app's next update)
 * kept by Start's id for it instead, under Start's name. Null when there is nothing to change.
 */
export function storeTargets<T extends { name: string; target: string }>(apps: readonly T[], installed: readonly { name: string; target: string }[]): T[] | null {
  let changed = false;
  const out = apps.map((a) => {
    if (/^shell:/i.test(a.target)) return a;
    const family = packageFamily(a.target);
    if (!family) return a;
    const same = installed.filter((i) => /^shell:/i.test(i.target) && packageFamily(i.target) === family);
    const exe = (a.target.split(/[\\/]/).pop() ?? '').replace(/\.exe$/i, '').toLowerCase();
    const pick = same.find((i) => i.name.toLowerCase() === a.name.toLowerCase()) ?? same.find((i) => i.name.toLowerCase().replace(/\s+/g, '') === exe) ?? same[0];
    if (!pick) return a;
    changed = true;
    return { ...a, name: pick.name, target: pick.target };
  });
  return changed ? out : null;
}
