// Which reader a set of picked files needs: dbt (YAML), Power BI (TMDL or .bim), or a refusal for a
// .pbix / .pbit, whose model is a compressed binary. The page reads only these text files; it never
// opens a dbt connection profile (profiles.yml).

import { isDbtFile, readDbt } from './dbt.ts';
import { emptyRead, type ModelFile, type ModelRead, type ModelTool } from './model-import.ts';
import { PBIX_REFUSAL, readPowerBi } from './powerbi.ts';

/** Picked files the page should read as text (by name); everything else is left unread. */
export function wantedModelFile(path: string): boolean {
  const p = path.replace(/\\/g, '/');
  return isDbtFile(p) || /\.(tmdl|bim)$/i.test(p) || (/\.json$/i.test(p) && !/(^|\/)(\.pbi|node_modules|target)\//i.test(p));
}

/** A .pbix or .pbit among the picked names. */
export function binaryPowerBi(paths: readonly string[]): string | undefined {
  return paths.find((p) => /\.(pbix|pbit)$/i.test(p));
}

/** What the files look like: dbt, Power BI, or neither. */
export function detectModelTool(files: readonly ModelFile[]): ModelTool | null {
  if (files.some((f) => /\.(tmdl|bim)$/i.test(f.path))) return 'powerbi';
  if (files.some((f) => /\.json$/i.test(f.path) && /"model"\s*:\s*\{/.test(f.text.slice(0, 5000)))) return 'powerbi';
  if (files.some((f) => isDbtFile(f.path))) return 'dbt';
  return null;
}

/**
 * Reads the picked files with the reader `want` names, or the one they look like when they are the
 * other kind. `names` lists every picked file, read or not, so a .pbix is refused by name.
 */
export function readModelFiles(want: ModelTool, files: readonly ModelFile[], names: readonly string[] = files.map((f) => f.path)): ModelRead & { refused?: string; switched?: boolean } {
  const pbix = binaryPowerBi(names);
  if (pbix && !files.some((f) => /\.(tmdl|bim)$/i.test(f.path))) {
    const read = emptyRead('powerbi', pbix.replace(/^.*[\\/]/, ''));
    return { ...read, refused: `${pbix.replace(/^.*[\\/]/, '')}: ${PBIX_REFUSAL}` };
  }
  const seen = detectModelTool(files);
  const tool = seen ?? want;
  const read = tool === 'dbt' ? readDbt(files) : readPowerBi(files);
  if (pbix) read.warnings.unshift(`${pbix.replace(/^.*[\\/]/, '')} was left unread (a binary .pbix); the text model files were read.`);
  return seen && seen !== want ? { ...read, switched: true } : read;
}
